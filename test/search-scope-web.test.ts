// #117 web スコープ filter: the /search page exposes a project-scope dropdown
// (`<select name="context">`, labelled スコープ) listing the owner's distinct
// non-'global' scopes. The route validates the picked value against the owner's
// OWN scopes and passes it to hybrid as `context`, which narrows to
// `scope IN (context,'global')`. Driven through the REAL Hono app on Miniflare
// D1 (mirrors memory-blocks-page.test.ts). Search is keyword-only (2026-10-31),
// so the app needs no AI binding to run it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { accessEnvVars, bearerKeyFixture, principalFixture, setupAccessAuth } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_sscope_owner";
const OWNER_HANDLE = "sscope-owner";
const OWNER_EMAIL = "sscope-owner@example.com";
const REPO_A = "github.com/acme/repoA";
const REPO_B = "github.com/acme/repoB";
const REPO_C = "github.com/acme/repoC"; // used ONLY by a skill → exercises the skills half of listScopes' UNION
// HTML-special chars in a scope: must render escaped in the <option>, never raw.
// 2026-08-20 以降 scope は remote 形式に限られるので、裸のラベルではなく
// remote の形で危険文字を持たせる(リポジトリ名に引用符が入ることは実際にありうる)。
const SPECIAL_SCOPE = 'github.com/acme/proj"<x';

const BOB = "u_sscope_bob";
const BOB_HANDLE = "sscope-bob";

const owner: Principal = principalFixture({ userId: OWNER, handle: OWNER_HANDLE });
const bob: Principal = principalFixture({ userId: BOB, handle: BOB_HANDLE });

let mf: Miniflare;
let db: D1Database;
let services: Services;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
let bobBearer: string;

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
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

async function search(query: string, headers: Record<string, string>): Promise<string> {
  return (await req(`/search?${query}`, { headers })).text();
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  services = makeServices(db);
  // Three notes, one per scope. All share the "kubernetes" keyword so FTS matches
  // every one — the scope filter is the ONLY thing that can narrow the set.
  await services.notes.upsert(owner, { slug: "a-note", title: "RepoA", body_md: "kubernetes deploy in repoA", scope: `https://${REPO_A}` });
  await services.notes.upsert(owner, { slug: "b-note", title: "RepoB", body_md: "kubernetes deploy in repoB", scope: `https://${REPO_B}` });
  await services.notes.upsert(owner, { slug: "g-note", title: "GlobalNote", body_md: "kubernetes deploy global wisdom" }); // scope omitted → global
  // A SKILL scoped to a project with no note there — exercises the skills half of
  // listScopes' UNION (a notes-only listScopes would silently drop repoC).
  await services.skills.upsert(owner, { slug: "c-skill", name: "cskill", description: "helm only in repoC", scope: `https://${REPO_C}` });
  // A scope carrying HTML-special chars — normalizeScope keeps remote-form values
  // verbatim, so it reaches the rendered <option> and MUST be escaped there.
  await services.notes.upsert(owner, { slug: "x-note", title: "X", body_md: "scope-escaping note", scope: SPECIAL_SCOPE });
  // Bob: a SECOND user whose only content is 'global' → his /search must NOT show
  // the スコープ select (there is no project to narrow to).
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(BOB, BOB_HANDLE, "bob", "sscope-bob@example.com", "", 0, 0)
    .run();
  await services.notes.upsert(bob, { slug: "bob-g", title: "BG", body_md: "kubernetes bob global wisdom" }); // global
  jwtFor = await setupAccessAuth();
  bobBearer = await bearerKeyFixture(db, BOB);
  env = { DB: db, OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => { await mf?.dispose(); });

it('REST and web answer every mode with keyword search, keeping scope and privacy', async () => {
  for (const mode of ['hybrid', 'semantic', 'keyword']) {
    const query = new URLSearchParams({q:'kubernetes',context:REPO_A,mode});
    const api = await app.request('https://memory.test/api/v1/search?'+query,{headers:{authorization:'Bearer '+bobBearer}},env);
    expect(api.status).toBe(200);
    const result = await api.json() as any;
    expect(result.retrieval).toMatchObject({mode:'keyword',requested_mode:mode,requested_lanes_complete:true,semantic_status:'not_requested'});
    expect(result.hits.map((h:any)=>h.slug)).toEqual(['bob-g']); // only Bob's global note, not owner's personal notes
    const page = await app.request('https://memory.test/search?'+query,{headers:{cookie:await ownerCookie()}},env);
    expect(page.status).toBe(200);
    const html=await page.text();
    expect(html).not.toContain('意味検索');
    expect(html).not.toContain('name="mode"');
    expect(html).toContain('/n/a-note'); expect(html).toContain('/n/g-note');
    expect(html).not.toContain('/n/b-note');
  }
});

describe("SearchService.listScopes (#117 web scope filter source)", () => {
  it("returns the owner's DISTINCT non-'global' scopes, sorted, excluding 'global'", async () => {
    const scopes = await services.search.listScopes(owner);
    // Sorted (github…<proj); 'global' excluded. REPO_C proves the skills half of
    // the UNION contributes; SPECIAL_SCOPE proves a notes-only scope is included.
    // ソートは文字列順。引用符は英字より前に来る。
    expect(scopes).toEqual([SPECIAL_SCOPE, REPO_A, REPO_B, REPO_C]);
  });

  it("an anonymous principal gets NOTHING (owner-only door)", async () => {
    const anon = principalFixture({ userId: "anonymous", handle: "anonymous", anonymous: true });
    expect(await services.search.listScopes(anon)).toEqual([]);
  });
});

describe("GET /search — スコープ (project) filter wiring", () => {
  it("context=repoA narrows to the repoA note + the global note, NOT repoB", async () => {
    const html = await search(`q=kubernetes&mode=keyword&context=${encodeURIComponent(REPO_A)}`, { cookie: await ownerCookie() });
    expect(html).toContain("/n/a-note");
    expect(html).toContain("/n/g-note"); // 'global' surfaces in every scope
    expect(html).not.toContain("/n/b-note");
    expect(html).toContain(`スコープ: ${REPO_A}`); // meta line reflects the active filter
  });

  it("no context → every scope visible (a-note, b-note, g-note)", async () => {
    const html = await search("q=kubernetes&mode=keyword", { cookie: await ownerCookie() });
    expect(html).toContain("/n/a-note");
    expect(html).toContain("/n/b-note");
    expect(html).toContain("/n/g-note");
    expect(html).not.toContain("スコープ:"); // no filter → not shown in the meta line
  });

  it("a crafted context the owner does NOT own is ignored (falls back to no filter, does not leak into hybrid)", async () => {
    const html = await search("q=kubernetes&mode=keyword&context=github.com%2Fevil%2Fcraft", { cookie: await ownerCookie() });
    // All three still returned (unknown context → no narrowing), and the crafted
    // value never appears in the rendered meta line.
    expect(html).toContain("/n/a-note");
    expect(html).toContain("/n/b-note");
    expect(html).toContain("/n/g-note");
    expect(html).not.toContain("github.com/evil/craft");
  });

  it("the スコープ <select> renders the owner's distinct scopes as options (+ すべてのスコープ)", async () => {
    const html = await search("", { cookie: await ownerCookie() }); // empty query: dropdown still populated
    expect(html).toContain('name="context"');
    expect(html).toContain("すべてのスコープ");
    expect(html).toContain(`<option value="${REPO_A}"`);
    expect(html).toContain(`<option value="${REPO_B}"`);
    expect(html).toContain(`<option value="${REPO_C}"`); // skills half of the UNION reaches the picker
    // The HTML-special scope is rendered ESCAPED in the option value, never raw
    // (Hono JSX auto-escapes attribute values — a raw `"<` would break out).
    expect(html).not.toContain(`value="${SPECIAL_SCOPE}"`);
    expect(html).toContain('proj&quot;&lt;x');
  });

  it("an owner whose only content is 'global' gets NO スコープ select (nothing to narrow to)", async () => {
    const html = await search("q=kubernetes&mode=keyword", { get authorization() { return `Bearer ${bobBearer}`; } });
    expect(html).toContain("/n/bob-g"); // Bob still sees his own global note
    expect(html).not.toContain('name="context"'); // but there is no project-scope dropdown
  });
});
