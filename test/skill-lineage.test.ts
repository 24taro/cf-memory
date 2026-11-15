// issue #65: skill fork lineage on the detail page — parent link (🔀 〇〇から
// フォーク), a muted 非公開 note when the parent isn't readable, and a reverse
// "このスキルをフォークした派生スキル" children section. The WHOLE point of this
// feature is the read gate: every parent/child surfaced MUST pass
// isReadable(row, principal) before ANY of its slug/name/owner-handle reaches the
// page, so a naive getById-and-render can't leak another user's skills. Since the
// visibility axis was retired (decision 9) "readable" means "owned by the viewer":
// any cross-user parent/child is hidden. These tests drive the REAL Hono app on a
// Miniflare D1 (mirroring test/skill-web-actions.test.ts) AND unit-test
// skills.parentOf/childrenOf so the centralized gate is exercised directly.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { bearerKeyFixture, principalFixture, rsEnvVars } from "./helpers";

// Three genuinely distinct users so cross-user lineage hiding is exercised
// (a parent/child may belong to a DIFFERENT user than the page's :handle). The
// handles are chosen so none is a substring of another — that makes the leak
// assertions (`not.toContain(parentHandle)`) unambiguous.
const ALICE = "u_lineage_alice";
const ALICE_HANDLE = "lineage-alice";
let ALICE_BEARER = "";
const BOB = "u_lineage_bob";
const BOB_HANDLE = "lineage-bob";
let BOB_BEARER = "";
const CAROL = "u_lineage_carol";
const CAROL_HANDLE = "lineage-carol";
let CAROL_BEARER = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let services: Services;

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

async function insertUser(id: string, handle: string): Promise<string> {
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, handle, handle, `${handle}@example.com`, "", 0, 0)
    .run();
  return await bearerKeyFixture(db, id, "notes:read,notes:write");
}

/** Create a skill via the REAL REST door (POST /api/v1/skills) under `bearer`. */
async function createSkill(
  bearer: string,
  slug: string,
  opts: { name?: string; description?: string; instructions?: string } = {},
): Promise<{ id: string; slug: string }> {
  const res = await req("/api/v1/skills", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      name: opts.name ?? slug,
      description: opts.description ?? "説明",
      instructions: opts.instructions ?? "手順",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

/** Record fork lineage the way fork() does (UPDATE parent_skill_id) — direct SQL
 * so a test can point a child at a parent of any ownership precisely. */
async function setParent(childId: string, parentId: string): Promise<void> {
  await db.prepare("UPDATE skills SET parent_skill_id=? WHERE id=?").bind(parentId, childId).run();
}

async function softDelete(id: string): Promise<void> {
  await db.prepare("UPDATE skills SET deleted_at=? WHERE id=?").bind(Date.now(), id).run();
}

function get(path: string, bearer?: string): Promise<Response> {
  return req(path, bearer ? { headers: { get authorization() { return `Bearer ${bearer}`; } } } : {});
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  ALICE_BEARER = await insertUser(ALICE, ALICE_HANDLE);
  BOB_BEARER = await insertUser(BOB, BOB_HANDLE);
  CAROL_BEARER = await insertUser(CAROL, CAROL_HANDLE);
  env = { DB: db, OWNER_HANDLE: "owner", ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
  services = makeServices(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("parent link (🔀 〇〇からフォーク) on GET /@handle/skills/:slug", () => {
  it("links to the parent when the viewer owns BOTH parent and child (self-fork lineage)", async () => {
    const parent = await createSkill(ALICE_BEARER, "s1-parent", { name: "自分の親スキルS1" });
    const child = await createSkill(ALICE_BEARER, "s1-child", { name: "派生スキルS1" });
    await setParent(child.id, parent.id);

    const html = await (await get(`/@${ALICE_HANDLE}/skills/s1-child`, ALICE_BEARER)).text();
    expect(html).toContain(`/@${ALICE_HANDLE}/skills/s1-parent`);
    expect(html).toContain("自分の親スキルS1");
    expect(html).toContain("からフォーク");
    expect(html).toContain("🔀");
  });
});

describe("a cross-user parent must never leak (owner-only, decision 9 — every other user's parent is now 'hidden')", () => {
  // The parent slug/name/owner-handle are DISTINCTIVE strings that appear nowhere
  // else on the child's page, so their absence proves nothing about the foreign
  // parent escaped — not the slug, not the name, not the owner handle.
  const PARENT_SLUG = "s2-secret-parent";
  const PARENT_NAME = "極秘の親スキル名S2";

  it("the child's owner sees the 非公開 note and NONE of the foreign parent's slug/name/handle; other viewers can't reach the page at all", async () => {
    const parent = await createSkill(ALICE_BEARER, PARENT_SLUG, { name: PARENT_NAME });
    const child = await createSkill(BOB_BEARER, "s2-child", { name: "派生スキルS2" });
    await setParent(child.id, parent.id);

    // (a) the child's OWNER (bob) is NOT the parent's owner — the leak surface.
    //     ABSENCE of the foreign parent's identifying strings is the load-bearing
    //     security assertion:
    const bobHtml = await (await get(`/@${BOB_HANDLE}/skills/s2-child`, BOB_BEARER)).text();
    expect(bobHtml).not.toContain(PARENT_SLUG);
    expect(bobHtml).not.toContain(PARENT_NAME);
    expect(bobHtml).not.toContain(ALICE_HANDLE);
    expect(bobHtml).toContain("🔀 フォーク元は非公開です");

    // (b) the parent's owner (alice) can no longer read bob's child page at all.
    expect((await get(`/@${BOB_HANDLE}/skills/s2-child`, ALICE_BEARER)).status).toBe(404);

    // (c) anonymous never reaches the route — the fail-closed gate 401s first.
    expect((await get(`/@${BOB_HANDLE}/skills/s2-child`)).status).toBe(401);
  });
});

describe("soft-deleted parent is neither linked nor leaked", () => {
  const PARENT_SLUG = "s3-deleted-parent";
  const PARENT_NAME = "削除された親スキルS3";

  it("even the parent's own owner sees only the 非公開 note (isReadable rejects any deleted_at row)", async () => {
    const parent = await createSkill(ALICE_BEARER, PARENT_SLUG, { name: PARENT_NAME });
    const child = await createSkill(ALICE_BEARER, "s3-child", { name: "派生スキルS3" });
    await setParent(child.id, parent.id);
    await softDelete(parent.id);

    const html = await (await get(`/@${ALICE_HANDLE}/skills/s3-child`, ALICE_BEARER)).text();
    expect(html).not.toContain(PARENT_SLUG);
    expect(html).not.toContain(PARENT_NAME);
    expect(html).toContain("🔀 フォーク元は非公開です");
  });
});

describe("child reverse-lookup (このスキルをフォークした派生スキル)", () => {
  const ALICE_CHILD_NAME = "アリスの派生S4";
  const BOB_CHILD_NAME = "ボブの派生S4";
  const CAROL_CHILD_NAME = "キャロルの派生S4";

  it("lists only the viewer's OWN children — another user's child never leaks (slug, name, handle)", async () => {
    const parent = await createSkill(ALICE_BEARER, "s4-parent", { name: "親スキルS4" });
    const aliceChild = await createSkill(ALICE_BEARER, "s4-child-alice", { name: ALICE_CHILD_NAME });
    const bobChild = await createSkill(BOB_BEARER, "s4-child-bob", { name: BOB_CHILD_NAME });
    const carolChild = await createSkill(CAROL_BEARER, "s4-child-carol", { name: CAROL_CHILD_NAME });
    await setParent(aliceChild.id, parent.id);
    await setParent(bobChild.id, parent.id);
    await setParent(carolChild.id, parent.id);

    // Alice (parent owner) sees exactly her own child; NEITHER foreign child leaks.
    const aliceHtml = await (await get(`/@${ALICE_HANDLE}/skills/s4-parent`, ALICE_BEARER)).text();
    expect(aliceHtml).toContain("このスキルをフォークした派生スキル");
    expect(aliceHtml).toContain(ALICE_CHILD_NAME);
    expect(aliceHtml).toContain(`/@${ALICE_HANDLE}/skills/s4-child-alice`);
    expect(aliceHtml).not.toContain(BOB_CHILD_NAME);
    expect(aliceHtml).not.toContain(CAROL_CHILD_NAME);
    expect(aliceHtml).not.toContain(BOB_HANDLE);
    expect(aliceHtml).not.toContain(CAROL_HANDLE);
  });

  it("omits the whole section when zero children are readable by the viewer", async () => {
    const parent = await createSkill(ALICE_BEARER, "s4b-parent", { name: "親スキルS4b" });
    const foreign = await createSkill(CAROL_BEARER, "s4b-only-foreign-child", { name: "唯一のよそ者の子S4b" });
    await setParent(foreign.id, parent.id);

    const aliceHtml = await (await get(`/@${ALICE_HANDLE}/skills/s4b-parent`, ALICE_BEARER)).text();
    expect(aliceHtml).not.toContain("このスキルをフォークした派生スキル");
    expect(aliceHtml).not.toContain("唯一のよそ者の子S4b");
  });
});

describe("skills.parentOf / skills.childrenOf (unit — the centralized gate)", () => {
  const alicePrincipal = principalFixture({ userId: ALICE, handle: ALICE_HANDLE });
  const bobPrincipal = principalFixture({ userId: BOB, handle: BOB_HANDLE });
  const carolPrincipal = principalFixture({ userId: CAROL, handle: CAROL_HANDLE });
  const anonPrincipal = principalFixture({ anonymous: true, userId: "anonymous" });

  it("parentOf: none / hidden(cross-user) / ok(own) / hidden(deleted→owner)", async () => {
    // no parent → "none"
    const orphan = await createSkill(BOB_BEARER, "u-orphan");
    const orphanRow = (await services.skills.getById(orphan.id))!;
    expect((await services.skills.parentOf(orphanRow, bobPrincipal)).status).toBe("none");

    // alice's parent with a child owned by bob
    const foreignParent = await createSkill(ALICE_BEARER, "u-foreign-parent", { name: "u-foreign-parent-name" });
    const child = await createSkill(BOB_BEARER, "u-foreign-child");
    await setParent(child.id, foreignParent.id);
    const childRow = (await services.skills.getById(child.id))!;

    // the child's owner + anonymous → hidden (never the row)
    expect((await services.skills.parentOf(childRow, bobPrincipal)).status).toBe("hidden");
    expect((await services.skills.parentOf(childRow, anonPrincipal)).status).toBe("hidden");
    // the parent's owner → ok, and it's actually the parent row
    const okForOwner = await services.skills.parentOf(childRow, alicePrincipal);
    expect(okForOwner.status).toBe("ok");
    expect(okForOwner.status === "ok" && okForOwner.skill.id).toBe(foreignParent.id);

    // deleted parent → hidden even for the owner
    await softDelete(foreignParent.id);
    expect((await services.skills.parentOf(childRow, alicePrincipal)).status).toBe("hidden");
  });

  it("childrenOf: returns only the viewer's OWN children, and excludes soft-deleted children", async () => {
    const parent = await createSkill(ALICE_BEARER, "u-children-parent");
    const aliceChild = await createSkill(ALICE_BEARER, "u-children-alice");
    const carolChild = await createSkill(CAROL_BEARER, "u-children-carol");
    const deletedAliceChild = await createSkill(ALICE_BEARER, "u-children-deleted");
    await setParent(aliceChild.id, parent.id);
    await setParent(carolChild.id, parent.id);
    await setParent(deletedAliceChild.id, parent.id);
    await softDelete(deletedAliceChild.id);

    const anonIds = (await services.skills.childrenOf(parent.id, anonPrincipal)).map((r) => r.id);
    expect(anonIds).toEqual([]); // anonymous reads nothing

    const aliceIds = new Set((await services.skills.childrenOf(parent.id, alicePrincipal)).map((r) => r.id));
    expect(aliceIds).toEqual(new Set([aliceChild.id])); // own child only; carol's + deleted excluded

    const carolIds = new Set((await services.skills.childrenOf(parent.id, carolPrincipal)).map((r) => r.id));
    expect(carolIds).toEqual(new Set([carolChild.id])); // never alice's
  });
});
