// Two people, one instance: does either of them see anything of the other's?
//
// This is the test the multi-user change exists for, and it is written to FIND
// leaks rather than to confirm the happy path. Everything readable goes through
// one of a handful of surfaces, and a leak in any of them is a leak in all of
// them from the reader's point of view, so each gets a case:
//
//   - the note itself, by slug and by id
//   - listings (notes, tags)
//   - search (keyword and the hybrid default)
//   - the link mesh: backlinks, outgoing links, the graph
//   - skills, and a skill's bundle files
//   - the activity log
//   - the .md twins and the feed
//
// The ownership predicate (`isReadable`, `n.user_id = viewer`) predates this and
// is unchanged. What is new is that a second row can exist at all, so what these
// cases really check is whether every read path actually goes through that
// predicate — a query that forgot to is invisible until someone else has data.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { TEST_RESOURCE, accessEnvVars, bearerTokenFor, rsEnvVars, setupAccessAuth } from "./helpers";

const ALICE = { id: "u_alice", handle: "alice", email: "alice@example.com", account: "01KALICE0000000000000000000" };
const BOB = { id: "u_bob", handle: "bob", email: "bob@example.com", account: "01KBOB000000000000000000000" };

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let aliceToken: string;
let bobToken: string;
let jwtFor: (email: string, overrides?: { aud?: string; iss?: string; expiresInSeconds?: number }) => Promise<string>;
/** ids captured at write time: the REST door addresses notes by id, not slug. */
const id: Record<string, string> = {};

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of raw.split(";")) {
      const t = stmt.trim();
      if (t) await database.prepare(t).run();
    }
  }
}

async function seedPerson(p: typeof ALICE): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, handle, display_name, email, bio_md, created_at, updated_at, auth_user_id)
       VALUES (?, ?, ?, ?, '', 0, 0, ?)`,
    )
    .bind(p.id, p.handle, p.handle, p.email, p.account)
    .run();
}

async function req(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.request(`https://memory.test${path}`, { ...init, headers }, env);
}

async function put(token: string, body: unknown, path = "/api/v1/notes"): Promise<Response> {
  return req(path, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const text = async (r: Response) => await r.text();

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await seedPerson(ALICE);
  await seedPerson(BOB);
  env = {
    DB: db,
    OWNER_HANDLE: ALICE.handle,
    ...accessEnvVars(ALICE.email),
    ...rsEnvVars(),
  } as unknown as Parameters<typeof app.request>[2];

  jwtFor = await setupAccessAuth();
  aliceToken = await bearerTokenFor({ sub: `user:${ALICE.account}`, aud: TEST_RESOURCE });
  bobToken = await bearerTokenFor({ sub: `user:${BOB.account}`, aud: TEST_RESOURCE });

  // Alice writes something distinctive, with a tag and a wikilink.
  const secret = await put(aliceToken, {
    slug: "alice-secret",
    title: "Alice pangolin plan",
    body_md: "A private pangolin plan. See [[alice-followup]].",
    tags: ["alice-only-tag"],
  });
  id.aliceSecret = (await secret.json<{ id: string }>()).id;
  const followup = await put(aliceToken, {
    slug: "alice-followup",
    title: "Alice followup",
    body_md: "the target",
  });
  id.aliceFollowup = (await followup.json<{ id: string }>()).id;
  await put(
    aliceToken,
    { slug: "alice-skill", skill_md: "---\nname: alice-skill\ndescription: alice's private skill\n---\nbody" },
    "/api/v1/skills",
  );

  // Bob writes his own, so "empty" cannot be mistaken for "isolated".
  const bobNote = await put(bobToken, { slug: "bob-note", title: "Bob armadillo notes", body_md: "bob's own" });
  id.bobNote = (await bobNote.json<{ id: string }>()).id;
});

afterAll(async () => {
  await mf?.dispose();
});

describe("the note itself", () => {
  it("is not readable by the other person, even knowing its id", async () => {
    // 404 covers "absent" and "not yours" alike, so existence is not disclosed.
    expect((await req(`/api/v1/notes/${id.aliceSecret}`, bobToken)).status).toBe(404);
  });

  it("is readable by its owner", async () => {
    expect((await req(`/api/v1/notes/${id.aliceSecret}`, aliceToken)).status).toBe(200);
    expect((await req(`/api/v1/notes/${id.bobNote}`, bobToken)).status).toBe(200);
  });
});

describe("listings", () => {
  it("lists only your own notes", async () => {
    const mine = await text(await req("/api/v1/notes", bobToken));
    expect(mine).toContain("bob-note");
    expect(mine).not.toContain("alice-secret");
    expect(mine).not.toContain("pangolin");
  });
});

describe("search", () => {
  it("does not surface the other person's notes, in either mode", async () => {
    for (const mode of ["", "&mode=keyword", "&mode=hybrid", "&mode=semantic"]) {
      const body = await text(await req(`/api/v1/search?q=pangolin${mode}`, bobToken));
      expect(body).not.toContain("alice-secret");
      expect(body).not.toContain("pangolin plan");
    }
    // And it does find them for their owner, so the assertions above are not
    // passing because search is simply broken.
    expect(await text(await req("/api/v1/search?q=pangolin", aliceToken))).toContain("alice-secret");
  });

  it("does not surface the other person's skills", async () => {
    const body = await text(await req("/api/v1/search?q=private&scope=skills", bobToken));
    expect(body).not.toContain("alice-skill");
  });

  it("does not leak the other person's tags", async () => {
    // A tag list is an aggregate: it can leak names without leaking a single note.
    const body = await text(await req("/api/v1/notes?tag=alice-only-tag", bobToken));
    expect(body).not.toContain("alice-secret");
  });
});

describe("the link mesh", () => {
  it("does not expose backlinks into the other person's notes", async () => {
    const body = await text(await req(`/api/v1/notes/${id.aliceFollowup}/backlinks`, bobToken));
    expect(body).not.toContain("alice-secret");
  });

  it("does not expose the other person's outgoing links", async () => {
    // The riskiest of these: outgoing() scopes the link TARGET by viewer, and the
    // source note is named by an id the caller supplies.
    const res = await req(`/api/v1/notes/${id.aliceSecret}/links`, bobToken);
    const body = await text(res);
    expect(body).not.toContain("alice-followup");
  });
});

describe("skills and their files", () => {
  it("does not list the other person's skills", async () => {
    expect(await text(await req("/api/v1/skills", bobToken))).not.toContain("alice-skill");
  });
});

describe("the activity log", () => {
  it("shows only your own events", async () => {
    // 2026-08-21 修正: bob の既定トークンには admin scope が無いので、この経路は
    // そもそも 403 で、応答に alice の文字列が入る余地が無かった —— 分離が壊れて
    // いても合格する検査だった。admin を持たせて実際に中身を見る。
    const bobAdmin = await bearerTokenFor({
      sub: `user:${BOB.account}`,
      aud: TEST_RESOURCE,
      scopes: "notes:read notes:write admin",
      email: BOB.email,
    });
    const res = await req("/api/v1/audit", bobAdmin);
    expect(res.status).toBe(200); // 前提の確認。403 なら以下は何も試していない
    const body = await text(res);
    expect(body).not.toContain("alice-secret");
    expect(body).not.toContain("alice-skill");

    // 対照: bob 自身の出来事は出ること。出ないなら監査ログごと空で、
    // 上の「含まれない」は何も証明していない。
    await put(bobToken, { slug: "bob-audit-probe", body_md: "bob の記録" });
    expect(await text(await req("/api/v1/audit", bobAdmin))).toContain("bob-audit-probe");
  });
});

describe("the web garden", () => {
  it("does not render the other person's note under their handle", async () => {
    // The garden is addressed by handle, so the URL names whose it is. Being
    // signed in as Bob must not read Alice's page.
    const res = await req(`/@${ALICE.handle}/n/alice-secret`, bobToken);
    expect(res.status).not.toBe(200);
  });

  it("does not serve the .md twin or the feed of the other person's notes", async () => {
    expect((await req(`/@${ALICE.handle}/n/alice-secret.md`, bobToken)).status).not.toBe(200);
    const feed = await req(`/@${ALICE.handle}/feed.xml`, bobToken);
    if (feed.status === 200) expect(await text(feed)).not.toContain("pangolin");
  });
});

describe("accounts", () => {
  it("keys a person off the account id, not the address", async () => {
    // Alice's row already existed with her address; the first token carrying her
    // account id links them. After that the id is the key — which is the whole
    // point, because an address is a name she can change.
    const row = await db
      .prepare("SELECT auth_user_id FROM users WHERE id = ?")
      .bind(ALICE.id)
      .first<{ auth_user_id: string | null }>();
    expect(row?.auth_user_id).toBe(ALICE.account);
  });

  it("refuses a person auth vouches for who was never invited here", async () => {
    // 2026-08-19: cf-memory は招待制になった。auth が保証するのは「この人は本物」で、
    // 「cf-memory を使う人」ではない。行を作るのは招待だけ。
    const fresh = await bearerTokenFor({
      sub: "user:01KCAROL00000000000000000000",
      aud: TEST_RESOURCE,
      email: "carol@example.com",
    });
    expect((await req("/api/v1/notes", fresh)).status).toBe(401);
    const created = await db
      .prepare("SELECT handle FROM users WHERE auth_user_id = ?")
      .bind("01KCAROL00000000000000000000")
      .first<{ handle: string }>();
    expect(created).toBeNull();
  });

  it("links an invited row to the account id on the first token, then keys on the id", async () => {
    // 招待は住所しか知らない(Access が住所しか教えないため)。初回のトークンで
    // account id を結び、以後はそれが鍵になる — 改名で別人にならないように。
    await db
      .prepare("INSERT INTO users (id, handle, display_name, email, bio_md, created_at, updated_at) VALUES (?,?,?,?,'',0,0)")
      .bind("u_dave", "dave", "dave", "dave@example.com")
      .run();
    const tok = await bearerTokenFor({
      sub: "user:01KDAVE000000000000000000000",
      aud: TEST_RESOURCE,
      email: "dave@example.com",
    });
    expect((await req("/api/v1/notes", tok)).status).toBe(200);
    const linked = await db
      .prepare("SELECT id FROM users WHERE auth_user_id = ?")
      .bind("01KDAVE000000000000000000000")
      .first<{ id: string }>();
    expect(linked?.id).toBe("u_dave");
    // 招待された人も、他人のものは見えない。
    expect(await text(await req("/api/v1/notes", tok))).not.toContain("alice-secret");
  });

  it("refuses an account token with no email and no linked row", async () => {
    // Nothing to link by and nothing to name a handle after: creating a row would
    // mean inventing an identity.
    const nameless = await bearerTokenFor({ sub: "user:01KNOBODY0000000000000000000", aud: TEST_RESOURCE });
    expect((await req("/api/v1/notes", nameless)).status).toBe(401);
  });

  it("does not let a second account take over an existing person's space", async () => {
    // Alice's row is linked. Another account presenting her address must not be
    // able to claim it — that would hand over every note she has.
    const impostor = await bearerTokenFor({
      sub: "user:01KIMPOSTOR00000000000000000",
      aud: TEST_RESOURCE,
      email: ALICE.email,
    });
    const res = await req("/api/v1/notes", impostor);
    const body = res.status === 200 ? await text(res) : "";
    expect(body).not.toContain("alice-secret");
  });
});

// The browser door. Until 2026-08-18 this returned the OWNER row for anyone the
// allow-list let through — correct while that list held one address, and a
// complete handover of one person's store the moment it held two. Cloudflare
// Access provides only an address, so that is the key here; the token door's
// account id links to the same row and takes over from then on.
describe("notes:read は広告どおりに効く", () => {
  // 2026-08-21、監査が確定させた穴。`notes:read` は認可サーバが広告し、トークンに載り、
  // whoami にも出るのに、確認している場所が1つも無かった —— allows(p,"notes:read") の
  // 呼び出し元がゼロ。読み権限を与えていないトークンで空間全体が読めた。
  it("書き込みだけのトークンは読めない", async () => {
    const writeOnly = await bearerTokenFor({
      sub: `user:${ALICE.account}`,
      aud: TEST_RESOURCE,
      scopes: "notes:write",
      email: ALICE.email,
    });
    for (const path of ["/api/v1/notes", "/api/v1/search?q=x", "/api/v1/skills", "/api/v1/memory/blocks"]) {
      expect((await req(path, writeOnly)).status).toBe(403);
    }
    expect((await req(`/api/v1/notes/${id.aliceSecret}`, writeOnly)).status).toBe(403);
  });

  it("読み取りだけのトークンは読めるが書けない", async () => {
    // 対照。403 が「全部落ちている」のではなく、scope どおりに分かれていること。
    const readOnly = await bearerTokenFor({
      sub: `user:${ALICE.account}`,
      aud: TEST_RESOURCE,
      scopes: "notes:read",
      email: ALICE.email,
    });
    expect((await req("/api/v1/notes", readOnly)).status).toBe(200);
    expect((await put(readOnly, { slug: "should-fail", body_md: "x" })).status).toBe(403);
  });
});

describe("the browser door", () => {
  const browse = async (path: string, email: string) =>
    req(path, undefined, { headers: { cookie: `CF_Authorization=${await jwtFor(email)}`, accept: "application/json" } });

  it("signs a person in as themselves, not as the owner", async () => {
    const res = await browse("/api/v1/notes", BOB.email);
    expect(res.status).toBe(200);
    const body = await text(res);
    expect(body).toContain("bob-note");
    expect(body).not.toContain("alice-secret");
    expect(body).not.toContain("pangolin");
  });

  it("does not let a signed-in person read the owner's note by id", async () => {
    const res = await browse(`/api/v1/notes/${id.aliceSecret}`, BOB.email);
    expect(res.status).toBe(404);
  });

  it("gives the owner their own store", async () => {
    const body = await text(await browse("/api/v1/notes", ALICE.email));
    expect(body).toContain("alice-secret");
    expect(body).not.toContain("bob-note");
  });

  it("refuses a first-time signer-in who was never invited, and creates nothing", async () => {
    const res = await browse("/api/v1/notes", "carol@example.com");
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("NOT_INVITED");
    const created = await db
      .prepare("SELECT handle FROM users WHERE lower(email)=?")
      .bind("carol@example.com")
      .first<{ handle: string }>();
    expect(created).toBeNull();
  });

  it("lets an invited address in, with its own empty store", async () => {
    await db
      .prepare("INSERT INTO users (id, handle, display_name, email, bio_md, created_at, updated_at) VALUES (?,?,?,?,'',0,0)")
      .bind("u_erin", "erin", "erin", "erin@example.com")
      .run();
    const res = await browse("/api/v1/notes", "erin@example.com");
    expect(res.status).toBe(200);
    expect(await text(res)).not.toContain("alice-secret");
  });

  it("never hands an address-less owner row to a stranger", async () => {
    // 招待制になった今も、ensureOwner が owner 行の住所を埋め直すことは変わらない。
    // 2026-08-18: resolvePersonByEmail used to claim the owner row when it had no
    // address — harmless with one person, "the first stranger inherits the owner's
    // notes" with several. Deleting it is what holds this property, and a mutation
    // pass confirmed that: swapping ensureOwner and resolvePrincipal in the
    // middleware no longer breaks it. What this case pins is the OTHER half — that
    // ensureOwner still repairs the owner's own address, so the owner keeps their
    // row instead of being provisioned a second, empty one on their next visit.
    await db.prepare("UPDATE users SET email=NULL WHERE id=?").bind(ALICE.id).run();

    const res = await browse("/api/v1/notes", "eve@example.com");
    // 招待されていないので入れない。かつ owner 行を貰うこともない。
    expect(res.status).toBe(403);

    // The owner row went back to the owner, and Eve got nothing at all.
    const owner = await db.prepare("SELECT email FROM users WHERE id=?").bind(ALICE.id).first<{ email: string }>();
    expect(owner?.email).toBe(ALICE.email);
    const eve = await db.prepare("SELECT id FROM users WHERE lower(email)=?").bind("eve@example.com").first<{ id: string }>();
    expect(eve).toBeNull();
  });

  it("fails closed, rather than improvising an owner, when OWNER_EMAIL is unset", async () => {
    // The other half of the same guarantee: if the address ensureOwner would use
    // is missing, the request must die — not fall through to whoever is knocking.
    await db.prepare("UPDATE users SET email=NULL WHERE id=?").bind(ALICE.id).run();
    const crippled = { ...(env as Record<string, unknown>), OWNER_EMAIL: undefined };

    const res = await app.request(
      "https://memory.test/api/v1/notes",
      { headers: { cookie: `CF_Authorization=${await jwtFor("mallory@example.com")}` } },
      crippled as unknown as Parameters<typeof app.request>[2],
    );
    expect(res.status).toBeGreaterThanOrEqual(500);

    const stolen = await db.prepare("SELECT email FROM users WHERE id=?").bind(ALICE.id).first<{ email: string | null }>();
    expect(stolen?.email).toBeNull();

    await db.prepare("UPDATE users SET email=? WHERE id=?").bind(ALICE.email, ALICE.id).run();
  });

  it("refuses to seed an owner it has no address for", async () => {
    // The fresh-instance path: no owner row yet. Mutating this guard survived the
    // whole suite, which means nothing reached it — and tolerating a missing
    // OWNER_EMAIL here would INSERT the address-less owner row that the branch
    // above used to hand to strangers. Reached by pointing OWNER_HANDLE at a
    // handle that does not exist, so ensureOwner takes the seeding path.
    //
    // OWNER_EMAIL is "" and not undefined on purpose: with undefined, D1's bind
    // rejects the INSERT on its own and the request 500s whether the guard is
    // there or not — the test passed while the guard was mutated away. "" binds
    // fine, so only the guard stops an owner row with a blank address.
    const unseeded = { ...(env as Record<string, unknown>), OWNER_HANDLE: "nobody", OWNER_EMAIL: "" };
    const res = await app.request(
      "https://memory.test/api/v1/notes",
      { headers: { cookie: `CF_Authorization=${await jwtFor("trudy@example.com")}` } },
      unseeded as unknown as Parameters<typeof app.request>[2],
    );
    expect(res.status).toBeGreaterThanOrEqual(500);

    const seeded = await db.prepare("SELECT id FROM users WHERE handle=?").bind("nobody").first<{ id: string }>();
    expect(seeded).toBeNull();
  });

  it("refuses a forged assertion, and every way one can be wrong", async () => {
    // What actually stops an impostor now. Each of these is a valid-looking
    // request that must not become a session — checked through the app, not just
    // against the verifier, so a caller that skipped verification would show up.
    const good = await jwtFor(BOB.email);

    // tampered signature
    const tampered = `${good.slice(0, -6)}AAAAAA`;
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: `CF_Authorization=${tampered}` } })).status).toBe(401);

    // not a JWT at all
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: "CF_Authorization=not.a.jwt" } })).status).toBe(401);

    // right shape, wrong audience: a token minted for someone else's Access app
    const wrongAud = await jwtFor(BOB.email, { aud: "some-other-application" });
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: `CF_Authorization=${wrongAud}` } })).status).toBe(401);

    // right shape, wrong issuer: another Cloudflare team
    const wrongIss = await jwtFor(BOB.email, { iss: "https://evil.cloudflareaccess.com" });
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: `CF_Authorization=${wrongIss}` } })).status).toBe(401);

    // expired
    const expired = await jwtFor(BOB.email, { expiresInSeconds: -3600 });
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: `CF_Authorization=${expired}` } })).status).toBe(401);

    // and the unmodified one still works, so the assertions above are not passing
    // because the door is simply shut.
    expect((await req("/api/v1/notes", undefined, { headers: { cookie: `CF_Authorization=${good}` } })).status).toBe(200);
  });
});
