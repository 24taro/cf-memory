// Decision 9: the visibility axis is retired — cf-memory is owner-only and
// FAIL-CLOSED. The gate middleware (src/index.tsx) must answer every anonymous
// request before any route runs: JSON 401 for machine surfaces (/api/*, /mcp,
// or any request whose Accept lacks text/html), a 302 to /access/login?next=<path>
// for browser-ish HTML requests (Cloudflare Access SSO, Task 5 — the old
// password /login and /logout doors are gone), with only /healthz, /access*
// left open. Drives the REAL Hono app on a Miniflare D1
// with the full migration set.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { TEST_ISSUER, accessEnvVars, setupAccessAuth } from "./helpers";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;

async function applyMigrations(db: D1Database): Promise<void> {
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
      if (s) await db.prepare(s).run();
    }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind("u_gate_owner", "gate-owner", "owner", "gate-owner@example.com", "", 0, 0).run();
  jwtFor = await setupAccessAuth();
  env = { DB: db, OWNER_HANDLE: "gate-owner", ...accessEnvVars("gate-owner@example.com") } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("fail-closed gate (decision 9) — anonymous is stopped before any route", () => {
  it("401s /api/v1/notes and /mcp for anonymous with a JSON error body", async () => {
    const api = await req("/api/v1/notes");
    expect(api.status).toBe(401);
    expect(((await api.json()) as { error: string }).error).toContain("unauthorized");

    const mcp = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
    expect(((await mcp.json()) as { error: string }).error).toContain("unauthorized");
  });

  it("an invalid Bearer degrades to anonymous and is 401'd the same way", async () => {
    const res = await req("/api/v1/notes", { headers: { authorization: "Bearer eg_live_definitely_not_real" } });
    expect(res.status).toBe(401);
  });

  it("redirects browser-ish (Accept: text/html) requests for / and /@handle to /access/login?next=<path>", async () => {
    const home = await req("/", { headers: { accept: "text/html" } });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/access/login?next=%2F");

    const garden = await req("/@gate-owner", { headers: { accept: "text/html" } });
    expect(garden.status).toBe(302);
    expect(garden.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent("/@gate-owner")}`);
  });

  it("a non-HTML Accept on a web path gets the JSON 401, not a redirect (curl/agents see a clean fail-closed signal)", async () => {
    const res = await req("/@gate-owner/n/some-note.md", { headers: { accept: "text/markdown" } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("unauthorized");
  });

  it("leaves nothing open to anonymous except /access* and the metadata document", async () => {
    // /healthz was the third open path. Nothing polled it — not this repo, not
    // the other three, not the mini PC — so it was one more unauthenticated
    // surface with no reader, and it went with the host-wide Access change.
    expect((await req("/healthz")).status).toBe(401);

    // Owner initialization belongs to the verified credential paths.
    const boot = await req("/api/v1/bootstrap", { method: "POST" });
    expect(boot.status).toBe(401);
  });

  it("serves sign-in and anonymous denials without querying the owner database", async () => {
    const prepare = () => { throw new Error("unexpected D1 access"); };
    const noDatabase = { ...env!, DB: { prepare }, API_TOKEN: "a".repeat(32) } as Parameters<typeof app.request>[2];
    const anonymous = (path: string, init?: RequestInit) => app.request(`https://memory.test${path}`, init, noDatabase);
    expect((await anonymous("/api/v1/notes")).status).toBe(401);
    expect((await anonymous("/mcp", { headers: { authorization: `Bearer ${"b".repeat(32)}` } })).status).toBe(401);
    expect((await anonymous("/access/login")).status).toBe(403);
    expect((await anonymous("/", { headers: { accept: "text/html" } })).status).toBe(302);
  });

  it("seeds one owner for simultaneous valid first requests", async () => {
    const apiToken = "c".repeat(32);
    const fresh = { ...env!, OWNER_HANDLE: "first-owner", OWNER_EMAIL: "first-owner@example.com", API_TOKEN: apiToken };
    const request = () => app.request("https://memory.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
    }, fresh);
    expect((await app.request("https://memory.test/api/v1/whoami", {}, fresh)).status).toBe(401);
    expect(await db.prepare("SELECT id FROM users WHERE handle=?").bind(fresh.OWNER_HANDLE).first()).toBeNull();
    const responses = await Promise.all([request(), request()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const identities = await Promise.all(responses.map(async response => {
      const rpc = await response.json<{ result: { content: [{ text: string }] } }>();
      return JSON.parse(rpc.result.content[0].text) as { handle: string; user_id: string };
    }));
    expect(identities[0]).toMatchObject({ handle: "first-owner", user_id: expect.any(String) });
    expect(identities[0].user_id).toBe(identities[1].user_id);
  });

  // Regression guard: /access* must stay in OPEN_PATHS — dropping it would
  // redirect-loop every logged-out browser (/access/login → /access/login?next=…).
  it("GET /access/login is reachable by anonymous (403 page, NOT a redirect loop)", async () => {
    const res = await req("/access/login?next=%2F", { headers: { accept: "text/html" } });
    expect(res.status).toBe(403); // denied page, not 302
  });

  it("GET /access/login bounces an authenticated visitor to next (relative paths only)", async () => {
    const jwt = await jwtFor("gate-owner@example.com");
    const ok = await req("/access/login?next=%2F%40gate-owner", { headers: { cookie: `CF_Authorization=${jwt}` } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/@gate-owner");
    const evil = await req("/access/login?next=%2F%2Fevil.example", { headers: { cookie: `CF_Authorization=${jwt}` } });
    expect(evil.status).toBe(302);
    expect(evil.headers.get("location")).toBe("/"); // open-redirect guard
    // Review follow-up: browsers normalize `\` to `/` before resolving a
    // Location header, so `/\evil.example` is the same open-redirect class
    // as `//evil.example` and must be rejected too.
    const evilBackslash = await req("/access/login?next=%2F%5Cevil.example", { headers: { cookie: `CF_Authorization=${jwt}` } });
    expect(evilBackslash.status).toBe(302);
    expect(evilBackslash.headers.get("location")).toBe("/");
    // Final-review follow-up: a raw tab right after the leading slash decodes to
    // "/\t/evil.example" — browsers strip control chars (tabs included) when
    // parsing a URL, so this resolves to https://evil.example too, the same
    // open-redirect class as the `//` and `/\` cases just spelled differently.
    // The URL-normalization guard (src/index.tsx) closes this and the whole class.
    const evilTab = await req("/access/login?next=%2F%09%2Fevil.example", { headers: { cookie: `CF_Authorization=${jwt}` } });
    expect(evilTab.status).toBe(302);
    expect(evilTab.headers.get("location")).toBe("/");
  });

  it("the deleted password doors are gone: /login and /logout fall through the gate", async () => {
    const login = await req("/login", { headers: { accept: "text/html" } });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent("/login")}`);
  });

  // T3 review follow-up: the highest-value security property — a revoked/invalid
  // Bearer must short-circuit to invalidKey-anonymous and NEVER fall through to
  // the Access branch (no silent downgrade for revoked-key + stolen-cookie).
  it("an invalid Bearer plus a VALID Access cookie is still 401 (no credential downgrade)", async () => {
    const jwt = await jwtFor("gate-owner@example.com");
    const res = await req("/api/v1/notes", {
      headers: { authorization: "Bearer eg_live_definitely_not_real", cookie: `CF_Authorization=${jwt}` },
    });
    expect(res.status).toBe(401);
  });

  it("tells an invalid token where to go, and does not repeat retired policy", async () => {
    // 2026-08-18: this hint was two kinds of stale. It pointed at
    // ~/.cf-memory/config.json (the eg_live_ key file — those keys stopped
    // authorizing anything when api_keys was dropped in 0026) and it said the
    // instance is "read-only for non-owners", which was the single-user policy.
    // Anyone auth vouches for now gets their own writable space, so that line
    // sent people to self-host over a problem they did not have.
    const res = await req("/api/v1/notes", {
      method: "POST",
      headers: { authorization: "Bearer eg_live_definitely_not_real", "content-type": "application/json" },
      body: JSON.stringify({ slug: "x", body_md: "x" }),
    });
    expect(res.status).toBe(401);
    const hint = JSON.stringify(await res.json());
    // 設定された issuer を名乗ること(直書きだと dev で嘘になる)。
    expect(hint).toContain(TEST_ISSUER);
    expect(hint).not.toContain("config.json");
    expect(hint).not.toContain("read-only for non-owners");
  });

  it("the HTML redirect carries the correct ?next= for a deep path", async () => {
    const res = await req("/@gate-owner/n/deep/note", { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent("/@gate-owner/n/deep/note")}`);
  });
});

// W1: CSRF Origin backstop (defense-in-depth). CF_Authorization's SameSite is a
// Zero Trust dashboard setting, unverifiable from code, and several
// cookie-authenticated write sinks (/@:handle/keys, note/skill edit, ...) sit
// outside the /access* edge app boundary — so the Worker rejects a
// cross-origin state-changing request from an Access-cookie-authenticated
// caller outright, regardless of path (POST /access/keys, itself nominally
// "behind" the edge app, is exercised here as the sink and gets the same
// defense-in-depth backstop).
describe("W1: CSRF Origin check for Access-cookie-authenticated state-changing requests", () => {
  it("rejects a cross-origin POST (Origin present and mismatched) with 403", async () => {
    const jwt = await jwtFor("gate-owner@example.com");
    const res = await req("/access/keys", {
      method: "POST",
      headers: { cookie: `CF_Authorization=${jwt}`, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "name=csrf-cross-origin&scopes=notes:read",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("forbidden");
  });

  it("allows a same-origin POST (Origin matches the harness's own origin)", async () => {
    // 2026-08-21 修正: ここは /access/keys を叩いていたが、そのルートは存在しない。
    // 404 を「403 ではない」と確認していただけで、CSRF の許可側を何も試していなかった。
    // 実在する書き込み経路(ノートの作成)に向ける。
    const jwt = await jwtFor("gate-owner@example.com");
    const res = await req("/api/v1/notes", {
      method: "POST",
      headers: { cookie: `CF_Authorization=${jwt}`, "content-type": "application/json", origin: "https://memory.test" },
      body: JSON.stringify({ slug: "csrf-same-origin", body_md: "同一オリジン" }),
    });
    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status); // 実際に書けたこと
  });

  it("allows a POST with NO Origin header at all (non-browser callers: curl, wrangler dev, tests)", async () => {
    const jwt = await jwtFor("gate-owner@example.com");
    const res = await req("/api/v1/notes", {
      method: "POST",
      headers: { cookie: `CF_Authorization=${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "csrf-no-origin", body_md: "Origin なし" }),
    });
    expect(res.status).not.toBe(403);
  });
});
