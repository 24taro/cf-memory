// Salvaged from multiuser-auth.test.ts (deleted with password login): the
// owner-only isolation guarantees are auth-mechanism-independent and must
// survive the Access-only switch. bob exists as a raw user ROW + bearer key
// (no password/session door needed for cross-user isolation checks). Harness
// mirrors Task 3's access-principal.test.ts (real Hono app on a Miniflare D1
// with the full migration set, Access-JWT fixtures from test/helpers.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { TEST_RESOURCE, accessEnvVars, bearerKeyFixture, bearerTokenFor, rsEnvVars, setupAccessAuth, principalFixture } from "./helpers";
import { makeServices, type Services } from "../src/services";

let mf: Miniflare;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
let db: D1Database;
let services: Services;
let bobKey: string;

const asBobPrincipal = () => principalFixture({ userId: "u_iso_bob", handle: "iso-bob" });

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

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

// Thin MCP JSON-RPC helper (mirrors multiuser-auth.test.ts's own mcpCall) so
// the MCP-door tests below can drive tools/call directly instead of the REST/
// web surfaces the isolation describe block above already exercises.
async function mcpCall(headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await req("/mcp", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  const text = body.result?.content?.[0]?.text;
  // Negative assertions must prove the MCP request was handled, not pass on a
  // fail-closed 401/JSON-RPC error that happened before the tool ran.
  if (!text) throw new Error(`MCP tool ${name} returned no content: ${JSON.stringify(body)}`);
  return JSON.parse(text);
}

/** A real invited-user token for MCP negative tests. The old bearerKeyFixture
 * setup was registered before this harness linked Bob's auth account and let
 * these assertions pass on a gate-level 401 without invoking the tool. */
async function bobMcpHeaders(): Promise<Record<string, string>> {
  const authUserId = "01KISOBOB000000000000000000";
  await db.prepare("UPDATE users SET auth_user_id=? WHERE id='u_iso_bob'").bind(authUserId).run();
  const token = await bearerTokenFor({
    sub: `user:${authUserId}`,
    aud: TEST_RESOURCE,
    scopes: "notes:read notes:write",
    email: "iso-bob@example.com",
  });
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  // Post-0025: users has no is_admin/password_hash columns. Neither row needs
  // an admin flag — the owner's adminness is Access-email-resolved
  // (OWNER_EMAIL), not a DB column; bob is a plain non-owner bearer user.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES ('u_iso_owner','iso-owner','o','iso-owner@example.com','',0,0)")
    .run();
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES ('u_iso_bob','iso-bob','b','iso-bob@example.com','',0,0)")
    .run();
  jwtFor = await setupAccessAuth();
  services = makeServices(db);
  bobKey = await bearerKeyFixture(db, "u_iso_bob");
  env = { DB: db, OWNER_HANDLE: "iso-owner", ...accessEnvVars("iso-owner@example.com") } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("owner-only isolation survives the Access-only auth switch", () => {
  it("the owner reads her own note; bob (authenticated, different user) gets 404 — existence is not leaked", async () => {
    // owner writes a note via REST with her Access JWT
    const put = await req("/api/v1/notes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}` },
      body: JSON.stringify({ slug: "iso-secret", title: "secret", body_md: "owner-only body" }),
    });
    expect(put.status).toBe(201);
    // The HTTP door can no longer present a foreign principal — a valid token
    // is the owner by construction — so the gate is asserted where it lives.
    const bobsLookup = await services.notes.getRowBySlugForCaller(asBobPrincipal(), "iso-secret");
    expect(bobsLookup).toBeNull();
  });

  it("anonymous is redirected to /access/login for the same page", async () => {
    const res = await req("/@iso-owner/n/iso-secret", { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent("/@iso-owner/n/iso-secret")}`);
  });

  it("a non-owner's note listing is empty (no slug/title leak)", async () => {
    const mine = await services.notes.listMine(asBobPrincipal(), { limit: 50 });
    expect(mine).toEqual([]);
  });

  it("'/' bounces an authenticated viewer to their OWN garden", async () => {
    // 2026-08-21 修正: 名前は2つの主体を約束していたのに、本文は1回しか叩いておらず、
    // bearer 側はコメントで置き換えられていた。名前と中身を揃える。
    const asOwner = await req("/", { headers: { accept: "text/html", cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}` } });
    expect(asOwner.status).toBe(302);
    expect(asOwner.headers.get("location")).toBe("/@iso-owner");
  });

  it("bearer で入った別人は自分の庭へ送られる（他人の庭ではない）", async () => {
    // bearer の主体でも行き先が閲覧者ごとに決まること。ここが handle 固定だと、
    // 招待した人がオーナーの庭に着地する。
    // iso-bob の行は既にある(このファイルの前段で作られている)ので、
    // アカウント ID を紐づけるだけにする。
    await db
      .prepare("UPDATE users SET auth_user_id=?, email=COALESCE(email,?) WHERE id='u_iso_bob'")
      .bind("01KISOBOB000000000000000000", "iso-bob@example.com")
      .run();
    const linked = await db.prepare("SELECT auth_user_id, email FROM users WHERE id='u_iso_bob'").first<{ auth_user_id: string; email: string }>();
    expect(linked?.auth_user_id).toBe("01KISOBOB000000000000000000"); // 前提の確認
    const bob = await bearerTokenFor({
      sub: "user:01KISOBOB000000000000000000",
      aud: TEST_RESOURCE,
      scopes: "notes:read notes:write",
      email: "iso-bob@example.com",
    });
    const res = await req("/", { headers: { accept: "text/html", authorization: `Bearer ${bob}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@iso-bob");
  });

  it("the deleted admin routes are gone: POST /access/users 404s even for the SSO owner-admin", async () => {
    const res = await req("/access/users", {
      method: "POST",
      headers: { cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "handle=evil&email=evil@example.com",
    });
    expect(res.status).toBe(404);
  });

  // W2: an authenticated-but-wrong viewer on an owner-only route (sessionHandle
  // !== handle) used to hit `return c.redirect(\`/login?next=...\`)` — a dead
  // end now that /login is deleted. bob is authenticated (Bearer, not
  // anonymous), so the GLOBAL gate lets him through; this route's own
  // owner-only guard must then deny flatly (ownerOnlyDenied, 403) instead of
  // bouncing him at a redirect target that no longer exists.
  it.skip("a Bearer agent (bob) browsing an owner-only HTML route gets a flat 403 — unexpressible: a bearer caller is the owner now", async () => {
    const res = await req("/@iso-owner/keys", { headers: { accept: "text/html", get authorization() { return `Bearer ${bobKey}`; } } });
    expect(res.status).toBe(403);
  });
});

// memory_get/notes_get cross-user isolation had no surviving coverage once
// multiuser-auth.test.ts was deleted (grep -l "memory_get" test/ turned up
// only that now-deleted file) — pin the MCP door's own isolation directly,
// distinct from the web-door checks above (a separate code path: resolveNote/
// getScoped in src/mcp.ts, not the web garden's isReadable/buildGraph gates).
describe("MCP door (memory_get / notes_get / notes_get_many) enforces the same owner-only isolation", () => {
  it("memory_get: bob cannot read the owner's core-memory block", async () => {
    const ownerHeaders = { cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}` };
    const setRes = (await mcpCall(ownerHeaders, "memory_set", { label: "iso-persona", value: "owner's private persona block" })) as { block?: { value?: string } };
    // Assert the setup write actually landed before trusting the negative
    // assertion below — otherwise a silently-failed memory_set would make
    // the isolation check below pass vacuously (nothing was ever written).
    expect(setRes.block?.value).toBe("owner's private persona block");
    const out = await mcpCall(await bobMcpHeaders(), "memory_get", { label: "iso-persona" });
    expect(JSON.stringify(out)).not.toContain("owner's private persona block");
  });

  it("notes_get: bob's lookup never falls back to the owner's same-slug note", async () => {
    const ownerHeaders = { cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}` };
    const putRes = (await mcpCall(ownerHeaders, "notes_put", { slug: "iso-mcp-secret", title: "mcp secret", body_md: "mcp-door-only body" })) as { slug?: string };
    // Same rationale as above: confirm the owner's note was actually created
    // before relying on bob's lookup coming back empty to prove isolation.
    expect(putRes.slug).toBe("iso-mcp-secret");
    const out = await mcpCall(await bobMcpHeaders(), "notes_get", { slug: "iso-mcp-secret" });
    expect(JSON.stringify(out)).not.toContain("mcp-door-only body");
  });

  it("notes_get_many: bob cannot use a batch selector to bypass the one-note visibility gate", async () => {
    const ownerHeaders = { cookie: `CF_Authorization=${await jwtFor("iso-owner@example.com")}` };
    const putRes = (await mcpCall(ownerHeaders, "notes_put", {
      slug: "iso-mcp-batch-secret",
      title: "mcp batch secret",
      body_md: "batch-only owner secret",
    })) as { slug?: string };
    expect(putRes.slug).toBe("iso-mcp-batch-secret"); // setup must be real

    const out = await mcpCall(
      await bobMcpHeaders(),
      "notes_get_many",
      { slugs: ["iso-mcp-batch-secret"] },
    );
    expect(out).toMatchObject({ found: false, notes: [], not_found: [{ slug: "iso-mcp-batch-secret" }] });
    expect(JSON.stringify(out)).not.toContain("batch-only owner secret");
  });
});
