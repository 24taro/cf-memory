// issue #71: three small Wave 0 UI additions, driven through the REAL Hono app
// on a Miniflare D1 with the full migration set (mirrors test/skill-web-actions
// .test.ts / test/multiuser-auth.test.ts):
//   1. 記憶プレビュー nav link, owner-gated (sessionHandle === handle).
//   2. Skill-edit `version` field -- optional: empty submit keeps the auto-patch
//      -bump (existing behavior), a filled value sets that exact version.
//   3. Search page mode + scope <select>s pre-selecting the active query params.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { accessEnvVars, mintTestToken, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_ui_polish_owner";
let OWNER_BEARER = "";
const OWNER_HANDLE = "ui-polish-owner";
const OWNER_EMAIL = "ui-polish-owner@example.com";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;

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

// The owner's Access-JWT cookie door (Task 3), replacing the old password
// login + web-session-cookie flow. Access resolves ONLY to OWNER_HANDLE.
async function ownerCookie(): Promise<string> {
  return `CF_Authorization=${await jwtFor(OWNER_EMAIL)}`;
}

async function createSkill(slug: string): Promise<void> {
  const res = await req("/api/v1/skills", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
    body: JSON.stringify({ slug, name: slug, description: "説明", instructions: "手順" }),
  });
  expect([200, 201]).toContain(res.status);
}

async function skillVersion(slug: string): Promise<string> {
  const res = await req(`/@${OWNER_HANDLE}/skills/${slug}`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
  const m = /<span class="pill">v([^<]+)<\/span>/.exec(await res.text());
  if (!m) throw new Error(`could not read version for ${slug}`);
  return m[1];
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await mintTestToken(OWNER, "notes:read,notes:write");
  jwtFor = await setupAccessAuth();
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("issue #71.1: 記憶プレビュー nav link (owner-gated)", () => {
  it("the owner viewing their own page sees the 記憶プレビュー nav link", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}`, { headers: { cookie: await ownerCookie() } })).text();
    expect(html).toContain(`/@${OWNER_HANDLE}/preview`);
    expect(html).toContain("記憶プレビュー");
  });

  it("an anonymous viewer never reaches the page (redirected to /access/login by the owner-only gate, decision 9)", async () => {
    const res = await req(`/@${OWNER_HANDLE}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent(`/@${OWNER_HANDLE}`)}`);
  });
});

describe("issue #71.2: skill-edit version field (optional; preserves auto-bump)", () => {
  it("the edit form shows the current version in the version field's placeholder", async () => {
    await createSkill("ui-polish-ver-form");
    const html = await (await req(`/@${OWNER_HANDLE}/skills/ui-polish-ver-form/edit`, { headers: { cookie: await ownerCookie() } })).text();
    expect(html).toContain('name="version"');
    expect(html).toMatch(/現在 v0\.1\.0/);
  });

  it("submitting the edit form with an EMPTY version still auto-bumps the patch (existing behavior preserved)", async () => {
    await createSkill("ui-polish-ver-empty");
    expect(await skillVersion("ui-polish-ver-empty")).toBe("0.1.0");
    const res = await req(`/@${OWNER_HANDLE}/skills/ui-polish-ver-empty/edit`, {
      method: "POST",
      headers: { cookie: await ownerCookie(), "content-type": "application/x-www-form-urlencoded" },
      body: "name=ui-polish-ver-empty&description=d&instructions=changed&version=",
    });
    expect(res.status).toBe(302);
    expect(await skillVersion("ui-polish-ver-empty")).toBe("0.1.1");
  });

  it("submitting an EXPLICIT version sets exactly that version", async () => {
    await createSkill("ui-polish-ver-explicit");
    const res = await req(`/@${OWNER_HANDLE}/skills/ui-polish-ver-explicit/edit`, {
      method: "POST",
      headers: { cookie: await ownerCookie(), "content-type": "application/x-www-form-urlencoded" },
      body: "name=ui-polish-ver-explicit&description=d&instructions=changed&version=9.9.9",
    });
    expect(res.status).toBe(302);
    expect(await skillVersion("ui-polish-ver-explicit")).toBe("9.9.9");
  });
});

describe("issue #71.3: search page scope selector (mode selector removed 2026-10-31)", () => {
  it("renders the scope <select> pre-selecting the active query param, and no mode selector", async () => {
    const html = await (await req("/search?q=test&mode=keyword&scope=notes", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
    // Semantic search is gone, so every mode is keyword search: no selector.
    expect(html).not.toContain('name="mode"');
    expect(html).toContain('name="scope"');
    expect(html).toMatch(/value="notes"\s+selected/);
    // Japanese labels present.
    expect(html).toContain("キーワード一致");
    expect(html).toContain("ノートのみ");
  });

  it("defaults to all when no scope is given", async () => {
    const html = await (await req("/search?q=test", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
    expect(html).toMatch(/value="all"\s+selected/);
  });

  it("falls back to all (not a phantom selection) for out-of-range mode/scope query params", async () => {
    const res = await req("/search?q=test&mode=garbage&scope=garbage", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/value="all"\s+selected/);
    // No option is rendered for the garbage values.
    expect(html).not.toContain('value="garbage"');
  });
});
