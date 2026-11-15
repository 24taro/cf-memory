import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { mintTestToken, rsEnvVars } from "./helpers";

const OWNER = "u_owner";
let TOKEN = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];

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

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  // The 404 pages are only reachable by an authenticated caller now (decision 9:
  // anonymous is fail-closed at the gate before routing) — seed an owner + key.
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "owner@example.com", "", 0, 0).run();
  TOKEN = await mintTestToken(OWNER, "notes:read,notes:write");
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE: "owner", OWNER_EMAIL: "owner@example.com", RECALL_TOKEN_BUDGET: "2000" } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf.dispose();
});

const authed = { headers: { get authorization() { return `Bearer ${TOKEN}`; } } };

describe("custom not-found handler (issue #51)", () => {
  it("unknown handle -> Japanese HTML 404 inside the normal Layout", async () => {
    const res = await app.request("https://memory.test/@no-such-handle-xyz", authed, env);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain("見つかりませんでした");
    expect(html).toContain('lang="ja"');
  });

  it("unknown skill under a real handle -> Japanese HTML 404", async () => {
    const res = await app.request("https://memory.test/@owner/skills/no-such-skill-xyz", authed, env);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain("見つかりませんでした");
  });

  it("bogus unmapped path -> Japanese HTML 404", async () => {
    const res = await app.request("https://memory.test/totally/bogus/path", authed, env);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain("見つかりませんでした");
  });

  it("bogus /api/v1 path -> JSON 404 (REST contract unchanged by the human-door handler)", async () => {
    const res = await app.request("https://memory.test/api/v1/bogus", authed, env);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({ error: "not found" });
  });

  it("an ANONYMOUS caller never even reaches the 404 handler — the fail-closed gate answers first (decision 9)", async () => {
    const res = await app.request("https://memory.test/totally/bogus/path", {}, env);
    expect(res.status).toBe(401); // non-HTML accept → JSON 401, not a 404 that would map the route space
  });
});
