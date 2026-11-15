// Security regression fixture (notes sharing / note text). Dummy data only; local Miniflare D1.
// Mirrors the two-member fixture of test/shared-memory.test.ts without editing it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import app from "../../src/index";
import { makeServices } from "../../src/services";
import { TEST_RESOURCE, accessEnvVars, bearerTokenFor, principalFixture, rsEnvVars, setupAccessAuth } from "../helpers";

export const ALICE = { id: "u_alice", handle: "alice", email: "alice@example.com", account: "01KSPALICE00000000000000000" };
export const BOB = { id: "u_bob", handle: "bob", email: "bob@example.com", account: "01KSPBOB0000000000000000000" };

export interface Fixture {
  mf: Miniflare;
  db: D1Database;
  aliceToken: string;
  bobToken: string;
  services: ReturnType<typeof makeServices>;
  alice: ReturnType<typeof principalFixture>;
  bob: ReturnType<typeof principalFixture>;
  req: (path: string, token: string, init?: RequestInit) => Promise<Response>;
  put: (token: string, body: unknown) => Promise<Response>;
  /** tools/call through POST /mcp; returns the raw tool result (isError + text). */
  mcp: (token: string, name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;
  row: <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) => Promise<T | null>;
  rows: <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) => Promise<T[]>;
}

export async function makeFixture(): Promise<Fixture> {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const dir = join(process.cwd(), "migrations");
  const statements: D1PreparedStatement[] = [];
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => { const i = line.indexOf("--"); return i >= 0 ? line.slice(0, i) : line; })
      .join("\n");
    for (const stmt of raw.split(";")) { const t = stmt.trim(); if (t) statements.push(db.prepare(t)); }
  }
  // One batch: each D1 round trip is a loopback connection, and this fixture is
  // built once per file. Statements still run in file order.
  await db.batch(statements);
  await setupAccessAuth();
  for (const p of [ALICE, BOB]) {
    await db
      .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at,auth_user_id) VALUES (?,?,?,?,'',0,0,?)")
      .bind(p.id, p.handle, p.handle, p.email, p.account)
      .run();
  }
  const env = { DB: db, OWNER_HANDLE: ALICE.handle, ...accessEnvVars(ALICE.email), ...rsEnvVars() } as unknown as Parameters<typeof app.request>[2];
  const aliceToken = await bearerTokenFor({ sub: `user:${ALICE.account}`, aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: ALICE.email });
  const bobToken = await bearerTokenFor({ sub: `user:${BOB.account}`, aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: BOB.email });
  const req: Fixture["req"] = (path, token, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return app.request(`https://memory.test${path}`, { ...init, headers }, env) as Promise<Response>;
  };
  const put: Fixture["put"] = (token, body) =>
    req("/api/v1/notes", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const mcp: Fixture["mcp"] = async (token, name, args) => {
    const res = await req("/mcp", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
    const text = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* tool errors are plain text */ }
    return { isError: Boolean(body.result?.isError) || Boolean(body.error), text, json };
  };
  const scopes = new Set(["notes:read", "notes:write"]);
  return {
    mf, db, aliceToken, bobToken, req, put, mcp,
    services: makeServices(db),
    alice: principalFixture({ userId: ALICE.id, handle: ALICE.handle, scopes }),
    bob: principalFixture({ userId: BOB.id, handle: BOB.handle, scopes }),
    row: async (sql, ...binds) => (await db.prepare(sql).bind(...binds).first()) as any,
    rows: async (sql, ...binds) => ((await db.prepare(sql).bind(...binds).all()).results ?? []) as any,
  };
}
