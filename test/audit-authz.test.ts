// issue #67: GET /api/v1/audit (and the former POST /api/v1/admin/reindex,
// removed with semantic search on 2026-10-31 — it now 404s) gate on
// callerIsAdmin(principal) instead of hasScope(admin), so a browser-SESSION-
// authenticated is_admin owner (whose adminness rides on principal.isAdminFlag,
// NOT as a scope) reaches them too — the prerequisite for the web 最近の活動
// screen. Bearer admin-scope keys keep working; non-admins keep getting 403.
// Drives the REAL Hono app on a Miniflare D1 with the full migration set,
// mirroring test/multiuser-auth.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { accessEnvVars, bearerKeyFixture, mintTestToken, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_audit_owner";
const OWNER_HANDLE = "audit-owner";
let OWNER_BEARER = "";
const MEMBER = "u_audit_member";
let MEMBER_BEARER = "";
const ADMIN2 = "u_audit_admin2";
const OWNER_EMAIL = "audit-owner@example.com";
const MEMBER_EMAIL = "audit-member@example.com";
const ADMIN2_EMAIL = "audit-admin2@example.com";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
// Access resolves ONLY to the single owner (OWNER_HANDLE) — a second admin
// (ADMIN2) can no longer reach admin-gated routes via the human door, so it
// gets its own admin-scope Bearer key instead (mirrors the owner's
// pre-existing Bearer admin key).
let admin2Bearer: string;

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

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  // Owner: Access-resolved admin (OWNER_EMAIL), also holds a Bearer admin-scope key.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "audit owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await mintTestToken(OWNER, "admin");
  // Member: non-admin, holds only a notes:write Bearer key.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(MEMBER, "audit-member", "audit member", MEMBER_EMAIL, "", 0, 0)
    .run();
  MEMBER_BEARER = await mintTestToken(MEMBER, "notes:write");
  // Second admin (admin-scope Bearer key, minted below): used to prove /audit's
  // per-caller bind — a second admin must see ONLY their own events, not the owner's.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(ADMIN2, "audit-admin2", "audit admin2", ADMIN2_EMAIL, "", 0, 0)
    .run();
  jwtFor = await setupAccessAuth();
  admin2Bearer = await bearerKeyFixture(db, ADMIN2, "admin");
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("issue #67: /api/v1/audit accepts an Access-authenticated admin", () => {
  it("an Access-authenticated is_admin owner can GET /api/v1/audit (was 403 under hasScope(admin))", async () => {
    const res = await req("/api/v1/audit", { headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("POST /api/v1/admin/reindex is gone with semantic search (404, even for the owner)", async () => {
    const res = await req("/api/v1/admin/reindex", { method: "POST", headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(404);
  });

  it("a Bearer admin-scope key still works (unchanged)", async () => {
    const headers = { get authorization() { return `Bearer ${OWNER_BEARER}`; } };
    expect((await req("/api/v1/audit", { headers })).status).toBe(200);
  });

  // Merged with the former "a session-authenticated NON-admin still gets 403"
  // scenario (pre-migration): Access resolves ONLY to the owner, so there is
  // no way to construct a human/non-Bearer non-admin principal anymore — the
  // two scenarios collapsed onto the identical code path (callerIsAdmin ==
  // false -> 403 on both routes, same MEMBER fixture), so this single test
  // now stands in for both.
  it("a Bearer notes:write (non-admin) key still gets 403", async () => {
    const headers = { get authorization() { return `Bearer ${MEMBER_BEARER}`; } };
    expect((await req("/api/v1/audit", { headers })).status).toBe(403);
  });

  it("/audit binds user_id = caller: a second admin sees ONLY their own events, never the owner's (guards must-fix #5)", async () => {
    // Owner creates a note -> a note-create event lands under OWNER's user_id.
    const ownerAccessCookie = await ownerCookie();
    const ownerNote = (await (await req("/api/v1/notes", {
      method: "POST",
      headers: { cookie: ownerAccessCookie, "content-type": "application/json" },
      body: JSON.stringify({ slug: "audit-owner-note", title: "audit-owner-note", body_md: "owner body" }),
    })).json()) as { id: string };

    // A DIFFERENT admin (Bearer, admin-scope) creates a note -> event lands
    // under ADMIN2's user_id.
    const admin2Headers = { get authorization() { return `Bearer ${admin2Bearer}`; } };
    const admin2Note = (await (await req("/api/v1/notes", {
      method: "POST",
      headers: { ...admin2Headers, "content-type": "application/json" },
      body: JSON.stringify({ slug: "audit-admin2-note", title: "audit-admin2-note", body_md: "admin2 body" }),
    })).json()) as { id: string };

    // ADMIN2's /audit must contain their OWN note event and NOT the owner's —
    // this is the assertion a hard-coded-owner bind (must-fix #5 regression)
    // would fail, since it would return the owner's rows to ADMIN2.
    const admin2Audit = (await (await req("/api/v1/audit", { headers: admin2Headers })).json()) as { events: Array<{ target_id?: string }> };
    const admin2Targets = admin2Audit.events.map((e) => e.target_id);
    expect(admin2Targets).toContain(admin2Note.id);
    expect(admin2Targets).not.toContain(ownerNote.id);

    // Symmetrically, the owner sees their own event and not ADMIN2's.
    const ownerAudit = (await (await req("/api/v1/audit", { headers: { cookie: ownerAccessCookie } })).json()) as { events: Array<{ target_id?: string }> };
    const ownerTargets = ownerAudit.events.map((e) => e.target_id);
    expect(ownerTargets).toContain(ownerNote.id);
    expect(ownerTargets).not.toContain(admin2Note.id);
  });
});
