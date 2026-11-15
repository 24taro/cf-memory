// issue #93: the 活動ログ (GET /activity) screen — an admin-only HTML render of
// the caller's OWN events op-log with friendly actor attribution across the 4
// actor kinds / 3 actor_ref shapes. Gate + per-caller bind mirror /api/v1/audit
// (callerIsAdmin, WHERE e.user_id = principal.userId), plus a caller-scoped
// LEFT JOIN that resolves an agent row's actor_ref (an api_key prefix) to the
// key NAME. Drives the REAL Hono app on a Miniflare D1 with the full migration
// set, mirroring test/audit-authz.test.ts + test/memory-library.test.ts. The
// pure actorAttribution helper is unit-tested directly.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { actorAttribution } from "../src/web/pages";
import { accessEnvVars, bearerKeyFixture, mintTestToken, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_activity_owner";
const OWNER_HANDLE = "activity-owner";
const OWNER_EMAIL = "activity-owner@example.com";
let OWNER_BEARER = ""; // admin-scope Bearer
const AGENT_KEY_PREFIX = "eg_agentpfx1"; // the my-cli-key prefix an agent event points at
const MEMBER = "u_activity_member";
const MEMBER_HANDLE = "activity-member";
const MEMBER_EMAIL = "activity-member@example.com";
let MEMBER_BEARER = ""; // notes:read + notes:write (non-admin) Bearer
const ADMIN2 = "u_activity_admin2";
const ADMIN2_HANDLE = "activity-admin2";
const ADMIN2_EMAIL = "activity-admin2@example.com";
const ADMIN3 = "u_activity_admin3"; // admin-scope Bearer key, with ZERO events → exercises the empty state
const ADMIN3_HANDLE = "activity-admin3";
const ADMIN3_EMAIL = "activity-admin3@example.com";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
// Access resolves ONLY to the single owner (OWNER_HANDLE) — a second admin
// (ADMIN2/ADMIN3) can no longer reach admin-gated routes via the human door,
// so they get their own admin-scope Bearer key instead (mirrors the owner's
// pre-existing Bearer admin key one line below).
let ADMIN2_BEARER: string;
let ADMIN3_BEARER: string;

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

// The owner's Access-JWT cookie door (Task 3) — replaces the old password
// login + web-session-cookie flow. Access resolves ONLY to OWNER_HANDLE, so
// this is exclusively for the owner persona; non-owner admins use Bearer.
async function ownerCookie(): Promise<string> {
  return `CF_Authorization=${await jwtFor(OWNER_EMAIL)}`;
}

async function seedEvent(id: string, userId: string, actor: string, actorRef: string | null, verb: string, summary: string, createdAt: number): Promise<void> {
  await db
    .prepare("INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,summary,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, userId, actor, actorRef, verb, "note", `t_${id}`, summary, createdAt)
    .run();
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);

  // Owner: Access-resolved admin (OWNER_EMAIL), also holds a Bearer admin-scope key.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "activity owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await mintTestToken(OWNER, "admin");
  // Member: non-admin, holds only a notes:write Bearer key (Bearer-non-admin).
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(MEMBER, MEMBER_HANDLE, "activity member", MEMBER_EMAIL, "", 0, 0)
    .run();
  // notes:read too (2026-11-14): without it the read-scope gate answers this GET
  // before the admin gate under test is reached.
  MEMBER_BEARER = await mintTestToken(MEMBER, "notes:read,notes:write");

  // Second admin (admin-scope Bearer key): proves per-caller scoping — their
  // event must not leak into the owner's /activity, and vice versa.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(ADMIN2, ADMIN2_HANDLE, "activity admin2", ADMIN2_EMAIL, "", 0, 0)
    .run();

  // Third admin (admin-scope Bearer key) with NO events — exercises the empty-state branch.
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(ADMIN3, ADMIN3_HANDLE, "activity admin3", ADMIN3_EMAIL, "", 0, 0)
    .run();

  // Owner's op-log: a human note-create, an agent action (actor_ref = the key
  // prefix), and a curator maintenance event (actor_ref = null).
  await seedEvent("ev_owner_human", OWNER, "human", OWNER_HANDLE, "note.created", "OWNER-HUMAN-NOTE", 1);
  await seedEvent("ev_owner_agent", OWNER, "agent", AGENT_KEY_PREFIX, "note.updated", "OWNER-AGENT-ACTION", 2);
  await seedEvent("ev_owner_curator", OWNER, "curator", null, "note.updated", "OWNER-CURATOR-TIDY", 3);
  // Second admin's private event — must never appear on the owner's page.
  await seedEvent("ev_admin2", ADMIN2, "human", ADMIN2_HANDLE, "note.created", "ADMIN2-SECRET-EVENT", 4);

  jwtFor = await setupAccessAuth();
  ADMIN2_BEARER = await bearerKeyFixture(db, ADMIN2, "admin");
  ADMIN3_BEARER = await bearerKeyFixture(db, ADMIN3, "admin");
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("GET /activity — actor attribution rendering", () => {
  it("an Access-authenticated admin sees @handle (human), the agent's subject, and 自動（キュレーター） (curator)", async () => {
    const res = await req("/activity", { headers: { cookie: await ownerCookie() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Human row → 👤 @handle (actor_ref is the handle, inline).
    expect(html).toContain(`@${OWNER_HANDLE}`);
    expect(html).toContain("👤");
    // Agent row → 🤖 {key name}, resolved via the caller-scoped LEFT JOIN.
    // The api_keys join is retired: actor_ref carries the token subject, which
    // is already the readable identity a key name used to supply.
    expect(html).toContain(AGENT_KEY_PREFIX);
    expect(html).toContain("🤖");
    // The old rule was "show the key NAME, never the raw prefix". There is no key
    // to name any more: actor_ref is the token subject, which is the identity
    // itself rather than an opaque handle to one, so showing it IS the friendly
    // rendering.
    // Curator row → 🔧 自動（キュレーター） regardless of the null actor_ref.
    expect(html).toContain("自動（キュレーター）");
    expect(html).toContain("🔧");
    // The verb label renders (note.created → opLabel("created") → "作成").
    expect(html).toContain("作成");
    // Heading + intro present.
    expect(html).toContain("活動ログ");
    expect(html).toContain("あなたのアカウントで起きた操作の記録です");
  });

  it("an admin sees ONLY their own events, never another admin's (per-caller scoping)", async () => {
    const html = await (await req("/activity", { headers: { get authorization() { return `Bearer ${ADMIN2_BEARER}`; } } })).text();
    // ADMIN2 sees their own event...
    expect(html).toContain("ADMIN2-SECRET-EVENT");
    // ...but NOT the owner's events (per-caller WHERE user_id scoping).
    expect(html).not.toContain("OWNER-HUMAN-NOTE");
    expect(html).not.toContain("OWNER-AGENT-ACTION");
  });

  it("shows the empty state for an admin with ZERO events", async () => {
    const res = await req("/activity", { headers: { get authorization() { return `Bearer ${ADMIN3_BEARER}`; } } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("まだ活動がありません。");
  });
});

describe("GET /activity — authorization (callerIsAdmin gate)", () => {
  it("an anonymous caller is denied — the fail-closed gate 401s before the admin gate (decision 9)", async () => {
    const res = await req("/activity");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("unauthorized");
  });

  // Merged with the former "a session-authenticated NON-admin is denied"
  // scenario (pre-migration): Access resolves ONLY to the owner, so there is
  // no way to construct a human/non-Bearer non-admin principal anymore — the
  // two scenarios collapsed onto the identical code path (callerIsAdmin ==
  // false -> adminDenied), so this single test now carries both assertions.
  it("a Bearer non-admin key is denied (403 adminDenied)", async () => {
    const res = await req("/activity", { headers: { get authorization() { return `Bearer ${MEMBER_BEARER}`; } } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("アクセスできません");
  });

  it("a Bearer admin-scope key is allowed (200) — mirrors /audit's callerIsAdmin", async () => {
    const res = await req("/activity", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Bound to the owner's user_id → sees the owner's own agent-key name.
    // The api_keys join is retired: actor_ref carries the token subject, which
    // is already the readable identity a key name used to supply.
    expect(html).toContain(AGENT_KEY_PREFIX);
  });
});

describe("GET /activity — per-caller scoping (WHERE e.user_id = principal.userId)", () => {
  it("a second admin's event does NOT appear in the owner's /activity, and vice versa", async () => {
    const ownerHtml = await (await req("/activity", { headers: { cookie: await ownerCookie() } })).text();
    expect(ownerHtml).toContain("OWNER-HUMAN-NOTE");
    expect(ownerHtml).not.toContain("ADMIN2-SECRET-EVENT");

    const admin2Html = await (await req("/activity", { headers: { get authorization() { return `Bearer ${ADMIN2_BEARER}`; } } })).text();
    expect(admin2Html).toContain("ADMIN2-SECRET-EVENT");
    expect(admin2Html).not.toContain("OWNER-HUMAN-NOTE");
  });
});


describe("actorAttribution (pure helper)", () => {
  it("human → 👤 @handle from actor_ref", () => {
    expect(actorAttribution("human", "alice", null)).toEqual({ icon: "👤", label: "@alice" });
  });
  it("human with null actor_ref → @?", () => {
    expect(actorAttribution("human", null, null)).toEqual({ icon: "👤", label: "@?" });
  });
  it("agent → 🤖 the resolved key name when present", () => {
    expect(actorAttribution("agent", "eg_pfx", "my-cli-key")).toEqual({ icon: "🤖", label: "my-cli-key" });
  });
  it("agent with a DELETED key (keyName null) → falls back to the prefix", () => {
    expect(actorAttribution("agent", "eg_pfx", null)).toEqual({ icon: "🤖", label: "eg_pfx" });
  });
  it("agent with neither name nor ref → generic エージェント", () => {
    expect(actorAttribution("agent", null, null)).toEqual({ icon: "🤖", label: "エージェント" });
  });
  it("curator → 🔧 自動（キュレーター） regardless of actor_ref", () => {
    expect(actorAttribution("curator", null, null)).toEqual({ icon: "🔧", label: "自動（キュレーター）" });
  });
  it("import → 📥 取り込み", () => {
    expect(actorAttribution("import", null, null)).toEqual({ icon: "📥", label: "取り込み" });
  });
  it("unknown actor → neutral bullet + raw actor", () => {
    expect(actorAttribution("mystery", null, null)).toEqual({ icon: "•", label: "mystery" });
  });
});
