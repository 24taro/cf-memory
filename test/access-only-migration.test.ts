// Migration regression test for 0025_access_only_auth: pins that the
// password/web-session auth schema (decision 7/8's is_admin, password_hash,
// web_sessions) is actually gone after applying the full migration set, not
// just that the SQL file parses. Harness mirrors Task 3's access-principal.
// test.ts (Miniflare D1 + the repo's full local applyMigrations sweep) but
// only needs the raw D1Database — no Hono app/env, since this checks schema
// shape, not request handling.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let db: D1Database;

async function applyMigrations(d: D1Database): Promise<void> {
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
      if (s) await d.prepare(s).run();
    }
  }
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("0025_access_only_auth: the password-auth schema is gone", () => {
  it("web_sessions table no longer exists", async () => {
    const t = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_sessions'").first();
    expect(t).toBeNull();
  });
  it("users has neither is_admin nor password_hash", async () => {
    const cols = await db.prepare("SELECT name FROM pragma_table_info('users')").all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    expect(names).not.toContain("is_admin");
    expect(names).not.toContain("password_hash");
    expect(names).toContain("email"); // sanity: the table itself is intact
  });
});
