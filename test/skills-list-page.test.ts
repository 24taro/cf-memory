// issue #89: the dedicated skills-list screen at GET /@handle/skills, fed by the
// owner-only skills.list (decision 9), and the スキル nav repointed to it. Drives
// the REAL Hono app on Miniflare D1 (mirrors test/memory-library.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { accessEnvVars, bearerKeyFixture, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_skills_list_owner";
let OWNER_BEARER = "";
const OWNER_HANDLE = "skills-list-owner";
const OWNER_EMAIL = "skills-list-owner@example.com";
const EMPTY_HANDLE = "skills-list-empty";
const EMPTY = "u_skills_list_empty";
let EMPTY_BEARER = "";

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

async function mkSkill(slug: string): Promise<void> {
  const res = await req("/api/v1/skills", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
    body: JSON.stringify({ slug, name: slug, description: `${slug} の説明`, instructions: "手順" }),
  });
  expect([200, 201]).toContain(res.status);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await bearerKeyFixture(db, OWNER, "notes:read,notes:write");
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(EMPTY, EMPTY_HANDLE, "empty", "skills-list-empty@example.com", "", 0, 0)
    .run();
  EMPTY_BEARER = await bearerKeyFixture(db, EMPTY, "notes:read,notes:write");
  jwtFor = await setupAccessAuth();
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];

  await mkSkill("sl-alpha");
  await mkSkill("sl-beta");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("GET /@handle/skills — dedicated skills list", () => {
  it("lists the owner's skills with version + link to the detail page (owner Access-JWT)", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}/skills`, { headers: { cookie: `CF_Authorization=${await jwtFor(OWNER_EMAIL)}` } })).text();
    expect(html).toContain("スキル");
    expect(html).toContain(`/@${OWNER_HANDLE}/skills/sl-alpha`);
    expect(html).toContain(`/@${OWNER_HANDLE}/skills/sl-beta`);
    expect(html).toContain("v0.1.0");
  });

  it("an anonymous viewer is redirected to /access/login (owner-only gate, decision 9)", async () => {
    const res = await req(`/@${OWNER_HANDLE}/skills`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent(`/@${OWNER_HANDLE}/skills`)}`);
  });

  it("an unrelated AUTHENTICATED viewer sees NONE of the owner's skills (owner-only list — the public branch is gone)", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}/skills`, { headers: { get authorization() { return `Bearer ${EMPTY_BEARER}`; } } })).text();
    expect(html).not.toContain("sl-alpha");
    expect(html).not.toContain("sl-beta");
    expect(html).toContain("まだスキルがありません。");
  });

  it("shows the empty-state for a handle with no skills (viewed by that handle's own user)", async () => {
    const html = await (await req(`/@${EMPTY_HANDLE}/skills`, { headers: { get authorization() { return `Bearer ${EMPTY_BEARER}`; } } })).text();
    expect(html).toContain("まだスキルがありません。");
  });

  it("404s for an unknown handle", async () => {
    const res = await req("/@no-such-handle-xyz/skills", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(res.status).toBe(404);
  });
});

describe("スキル nav link (issue #89)", () => {
  it("points at /@handle/skills, not the profile page", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } })).text();
    expect(html).toContain(`href="/@${OWNER_HANDLE}/skills"`);
  });
});
