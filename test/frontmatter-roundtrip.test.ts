// fidelity B1: frontmatter slug/date round-trip. The `.md` twin must emit a
// complete, re-parseable header (title/slug/tags/stage/date) and the
// write side must honor frontmatter `slug` (so a pulled note re-PUTs onto the SAME
// row, not a title-derived fork) and `date`/`created` on create (a re-imported
// note keeps its original date). The load-bearing property is IDEMPOTENCY:
// pull -> push (verbatim) -> pull yields the same bytes and the same note id.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { mintTestToken, principalFixture, rsEnvVars } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_fm_owner";
const OWNER_HANDLE = "fm-owner";
let OWNER_BEARER = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let services: Services;
const p = (): Principal => principalFixture({ userId: OWNER, handle: OWNER_HANDLE });

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of raw.split(";")) {
      const s = stmt.trim();
      if (s) await database.prepare(s).run();
    }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

async function insertUser(id: string, handle: string): Promise<string> {
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, handle, handle, `${handle}@example.com`, "", 0, 0)
    .run();
  return await mintTestToken(id, "notes:read,notes:write");
}

async function mdOf(slug: string): Promise<string> {
  // The .md twin is behind the owner-only gate (decision 9): pull as the owner.
  return (await req(`/@${OWNER_HANDLE}/n/${slug}.md`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  OWNER_BEARER = await insertUser(OWNER, OWNER_HANDLE);
  env = { DB: db, OWNER_HANDLE, ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
  services = makeServices(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("B1: the .md twin emits a complete, re-parseable frontmatter", () => {
  it("includes title, slug, tags, stage and an ISO date — and NO visibility line (axis retired, decision 9)", async () => {
    await services.notes.upsert(p(), { slug: "twin-note", title: "Twin Note", body_md: "hello", tags: ["alpha", "beta"] });
    const md = await mdOf("twin-note");
    expect(md).toContain("title: Twin Note");
    expect(md).toContain("slug: twin-note");
    expect(md).toContain("tags:");
    expect(md).toContain("- alpha");
    expect(md).toContain("- beta");
    expect(md).not.toContain("visibility:");
    expect(md).toContain("stage: seedling");
    expect(md).toMatch(/date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("omits the tags line when the note has no tags", async () => {
    await services.notes.upsert(p(), { slug: "untagged", title: "Untagged", body_md: "x" });
    const md = await mdOf("untagged");
    expect(md).not.toContain("tags:");
  });
});

describe("B1: the write side honors frontmatter slug + date", () => {
  it("uses frontmatter `slug` when no explicit slug is given", async () => {
    await services.notes.upsert(p(), { body_md: "---\nslug: custom-fm-slug\ntitle: From FM\n---\nbody text" });
    const row = await services.notes.getRowBySlug(OWNER, "custom-fm-slug");
    expect(row).not.toBeNull();
    expect(row?.title).toBe("From FM");
  });

  it("honors an ISO frontmatter `date` as created_at on create", async () => {
    const iso = "2020-01-15T00:00:00.000Z";
    await services.notes.upsert(p(), { body_md: `---\nslug: dated-iso\ndate: ${iso}\n---\nx` });
    const row = await services.notes.getRowBySlug(OWNER, "dated-iso");
    expect(row?.created_at).toBe(Date.parse(iso));
  });

  it("honors a numeric ms-epoch frontmatter `date`", async () => {
    await services.notes.upsert(p(), { body_md: "---\nslug: dated-ms\ndate: 1600000000000\n---\nx" });
    const row = await services.notes.getRowBySlug(OWNER, "dated-ms");
    expect(row?.created_at).toBe(1600000000000);
  });

  it("falls back to now() for an unparseable date, and never moves created_at on update", async () => {
    const before = Date.now();
    await services.notes.upsert(p(), { body_md: "---\nslug: dated-bad\ndate: not-a-date\n---\nx" });
    const created = (await services.notes.getRowBySlug(OWNER, "dated-bad"))?.created_at ?? 0;
    expect(created).toBeGreaterThanOrEqual(before - 1000);

    // update the same note; created_at must not move.
    await services.notes.upsert(p(), { slug: "dated-bad", body_md: "updated body" });
    expect((await services.notes.getRowBySlug(OWNER, "dated-bad"))?.created_at).toBe(created);
  });
});

describe("B1: pull -> push -> pull is idempotent and updates the same note", () => {
  it("re-PUTting the .md verbatim updates the same row and yields identical bytes", async () => {
    await services.notes.upsert(p(), { slug: "rt-note", title: "RT Note", body_md: "Round trip body", tags: ["gamma"] });
    const id1 = (await services.notes.getRowBySlug(OWNER, "rt-note"))?.id;
    const md1 = await mdOf("rt-note");

    // push the pulled markdown back verbatim, with NO explicit slug/title.
    await services.notes.upsert(p(), { body_md: md1 });
    const id2 = (await services.notes.getRowBySlug(OWNER, "rt-note"))?.id;
    expect(id2).toBe(id1); // same note — not a title-derived fork

    const md2 = await mdOf("rt-note");
    expect(md2).toBe(md1); // idempotent bytes (no trailing-newline growth, date preserved)
  });

  it("round-trips a tag that itself contains a comma (block-list emit, not inline)", async () => {
    // A comma-bearing tag would split into two under an inline `[a, b]` emit; the
    // YAML block list preserves it verbatim.
    await services.notes.upsert(p(), { slug: "comma-tag", title: "Comma Tag", body_md: "x", tags: ["needs, care"] });
    const md1 = await mdOf("comma-tag");
    await services.notes.upsert(p(), { body_md: md1 });
    const tags = await services.notes.tagsFor((await services.notes.getRowBySlug(OWNER, "comma-tag"))?.id ?? "");
    expect(tags).toContain("needs, care"); // survived the round-trip intact
    expect(await mdOf("comma-tag")).toBe(md1); // still idempotent
  });
});
