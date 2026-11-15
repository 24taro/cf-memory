// issue #95: a skill's usage_count is bumped + last_used_at stamped on INSTALL
// ONLY. The "use" signal is materializing the bundle into an agent — via the MCP
// `skills_install` tool OR the REST `GET /@handle/skills/:slug/install` door — NOT
// a plain get/view/SKILL.md fetch. recordUse() must NOT touch updated_at (a use is
// not an edit, so it must not reorder the updated_at-sorted skills list). These
// tests drive the REAL Hono app on a Miniflare D1 (mirroring skill-lineage.test.ts)
// so the 0014 migration, the actual UPDATE, and the detail page's 利用回数 render
// are all exercised end-to-end.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { handleMcp } from "../src/mcp";
import { makeServices, type Services } from "../src/services";
import { bearerKeyFixture, principalFixture, rsEnvVars } from "./helpers";

const OWNER = "u_usage_owner";
const OWNER_HANDLE = "usage-owner";
let OWNER_BEARER = "";
// A distinct second user, to prove the owner-only read rule (decision 9) also
// gates install: a reader can no longer install (or count against) another
// user's skill at all.
const READER = "u_usage_reader";
const READER_HANDLE = "usage-reader";
let READER_BEARER = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let services: Services;

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
  return await bearerKeyFixture(db, id, "notes:read,notes:write");
}

/** Create a skill via the REAL REST door (POST /api/v1/skills) under `bearer`. */
async function createSkill(bearer: string, slug: string, opts: { name?: string } = {}): Promise<{ id: string; slug: string }> {
  const res = await req("/api/v1/skills", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" },
    body: JSON.stringify({ slug, name: opts.name ?? slug, description: "説明", instructions: "手順" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

async function usageRow(id: string): Promise<{ usage_count: number; last_used_at: number | null; updated_at: number }> {
  const r = await db
    .prepare("SELECT usage_count, last_used_at, updated_at FROM skills WHERE id=?")
    .bind(id)
    .first<{ usage_count: number; last_used_at: number | null; updated_at: number }>();
  if (!r) throw new Error("skill not found");
  return r;
}

// MCP door: construct the same ToolCtx shape the real /mcp handler builds (see
// test/mcp.test.ts), then invoke a tool by name against the real services/D1.
async function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = { principal: principalFixture({ userId: OWNER, handle: OWNER_HANDLE }), services: services as never, budget: 2000 };
  const r = new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcp(r, ctx as never);
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  OWNER_BEARER = await insertUser(OWNER, OWNER_HANDLE);
  READER_BEARER = await insertUser(READER, READER_HANDLE);
  env = { DB: db, OWNER_HANDLE, ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
  services = makeServices(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("issue #95: skill usage recorded on install", () => {
  it("a freshly created skill starts at usage_count 0 with a null last_used_at", async () => {
    const s = await createSkill(OWNER_BEARER, "fresh-skill");
    const row = await usageRow(s.id);
    expect(row.usage_count).toBe(0);
    expect(row.last_used_at).toBeNull();
  });

  it("REST GET /install increments usage_count and stamps last_used_at, without bumping updated_at", async () => {
    const s = await createSkill(OWNER_BEARER, "rest-install");
    const before = await usageRow(s.id);

    const r1 = await req(`/api/v1/@${OWNER_HANDLE}/skills/rest-install/install`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(r1.status).toBe(200);
    const after1 = await usageRow(s.id);
    expect(after1.usage_count).toBe(1);
    expect(after1.last_used_at).not.toBeNull();
    // A use is not an edit: recordUse must leave updated_at untouched so it can't
    // reorder the updated_at-sorted skills list nor masquerade as a revision.
    expect(after1.updated_at).toBe(before.updated_at);

    const r2 = await req(`/api/v1/@${OWNER_HANDLE}/skills/rest-install/install`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(r2.status).toBe(200);
    expect((await usageRow(s.id)).usage_count).toBe(2);
  });

  it("a reader installing ANOTHER user's skill gets 404 and records nothing (owner-only, decision 9 — the public-install path is gone)", async () => {
    const s = await createSkill(OWNER_BEARER, "shared-public");
    const r = await req(`/api/v1/@${OWNER_HANDLE}/skills/shared-public/install`, { headers: { get authorization() { return `Bearer ${READER_BEARER}`; } } });
    expect(r.status).toBe(404);
    expect((await usageRow(s.id)).usage_count).toBe(0);
  });

  it("MCP skills_install increments usage_count", async () => {
    const s = await createSkill(OWNER_BEARER, "mcp-install");
    const out = await mcpCall("skills_install", { slug: "mcp-install" });
    expect(out.found).toBe(true);
    expect((await usageRow(s.id)).usage_count).toBe(1);
  });

  it("does NOT increment on skills_get, the web detail page, or the raw SKILL.md door", async () => {
    const s = await createSkill(OWNER_BEARER, "view-only");
    const got = await mcpCall("skills_get", { slug: "view-only" });
    expect(got.found).toBe(true);
    expect((await req(`/@${OWNER_HANDLE}/skills/view-only`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).status).toBe(200); // web detail
    expect((await req(`/@${OWNER_HANDLE}/skills/view-only/SKILL.md`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).status).toBe(200); // raw door
    const row = await usageRow(s.id);
    expect(row.usage_count).toBe(0);
    expect(row.last_used_at).toBeNull();
  });

  it("a 404 install (unknown skill) records nothing", async () => {
    const r = await req(`/api/v1/@${OWNER_HANDLE}/skills/does-not-exist/install`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(r.status).toBe(404);
  });

  it("surfaces 利用回数 and 最終利用 on the detail page after an install", async () => {
    await createSkill(OWNER_BEARER, "detail-usage");
    await req(`/api/v1/@${OWNER_HANDLE}/skills/detail-usage/install`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    const html = await (await req(`/@${OWNER_HANDLE}/skills/detail-usage`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
    expect(html).toContain("利用回数 1回");
    expect(html).toContain("最終利用");
  });

  it("shows 利用回数 0回 and omits 最終利用 for a never-installed skill", async () => {
    await createSkill(OWNER_BEARER, "never-used");
    const html = await (await req(`/@${OWNER_HANDLE}/skills/never-used`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
    expect(html).toContain("利用回数 0回");
    // last_used_at is null → the whole 最終利用 clause is omitted (that string
    // appears nowhere else on the page, so its absence is a clean assertion).
    expect(html).not.toContain("最終利用");
  });
});
