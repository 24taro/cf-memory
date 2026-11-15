// #117 context-scoped memory: a note/skill carries a project `scope`; recall and
// search pre-filter to `scope ∈ {current-context, 'global'}`. Fixtures share the
// same keywords, so the SCOPE filter is the only thing that narrows the result
// set (isolating the behavior under test).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeServices, type Services } from "../src/services";
import { principalFixture } from "./helpers";
import type { Principal, SearchHit } from "../src/types";

const OWNER = "u_scope_owner";
const BOB = "u_scope_bob";
const owner: Principal = principalFixture({ userId: OWNER, handle: "scope-owner" });
const bob: Principal = principalFixture({ userId: BOB, handle: "scope-bob" });
let mf: Miniflare;
let db: D1Database;
let services: Services;

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}

const slugs = (hits: SearchHit[]) => hits.map((h) => h.slug).sort();

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "scope-owner", "scope-owner", "o@e.com", "", 0, 0).run();
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(BOB, "scope-bob", "scope-bob", "b@e.com", "", 0, 0).run();
  services = makeServices(db);
  // repoA note written via the scp-like remote form; MUST normalize+stamp as
  // github.com/acme/repoA so an https-form read context matches it.
  await services.notes.upsert(owner, { slug: "a-note", title: "A", body_md: "kubernetes deploy in repoA", scope: "git@github.com:acme/repoA.git" });
  await services.notes.upsert(owner, { slug: "b-note", title: "B", body_md: "kubernetes deploy in repoB", scope: "https://github.com/acme/repoB" });
  await services.notes.upsert(owner, { slug: "g-note", title: "G", body_md: "kubernetes deploy global wisdom" }); // scope omitted → global
  await services.skills.upsert(owner, { slug: "a-skill", name: "askill", description: "kubernetes helm repoA", scope: "github.com/acme/repoA" });
  await services.skills.upsert(owner, { slug: "g-skill", name: "gskill", description: "kubernetes helm global" });
});
afterAll(async () => { await mf?.dispose(); });

describe("#117 context-scoped memory", () => {
  it("stamps a NORMALIZED scope on write (scp git@ and https collapse to one canonical value)", async () => {
    const a = await db.prepare("SELECT scope FROM notes WHERE slug='a-note'").first<{ scope: string }>();
    expect(a?.scope).toBe("github.com/acme/repoA");
    const g = await db.prepare("SELECT scope FROM notes WHERE slug='g-note'").first<{ scope: string }>();
    expect(g?.scope).toBe("global");
  });

  it("context=repoA (read context normalized from an https URL) → repoA + global notes, NOT repoB", async () => {
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20, context: "https://github.com/acme/repoA.git" });
    expect(slugs(hits)).toEqual(["a-note", "g-note"]);
  });

  it("context=repoB → repoB + global, NOT repoA", async () => {
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20, context: "github.com/acme/repoB" });
    expect(slugs(hits)).toEqual(["b-note", "g-note"]);
  });

  it("null-scoping guard: a 'global' note surfaces in EVERY context (IN(context,'global'), never a bare exact match)", async () => {
    const inA = await services.search.hybrid(owner, "kubernetes", { limit: 20, context: "github.com/acme/repoA" });
    const inB = await services.search.hybrid(owner, "kubernetes", { limit: 20, context: "github.com/acme/repoB" });
    expect(slugs(inA)).toContain("g-note");
    expect(slugs(inB)).toContain("g-note");
  });

  it("no context → every scope visible (back-compat / staged rollout)", async () => {
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20 });
    expect(slugs(hits)).toEqual(["a-note", "b-note", "g-note"]);
  });

  it("skills are scoped too (context=repoA → repoA skill + global skill)", async () => {
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20, scope: "skills", context: "github.com/acme/repoA" });
    expect(slugs(hits)).toEqual(["a-skill", "g-skill"]);
  });

  it("recall respects context: a repoA recall includes the repoA note and excludes the repoB one", async () => {
    const pack = await services.recall.recall(owner, "kubernetes", 4000, 8, "github.com/acme/repoA");
    expect(pack.text).toContain("repoA");
    expect(pack.text).not.toContain("repoB");
  });

  it("a scope-LESS edit PRESERVES the row's scope (curator apply / append / fork must not reset it to 'global')", async () => {
    await services.notes.upsert(owner, { slug: "edit-note", title: "E", body_md: "kubernetes v1", scope: "git@github.com:acme/repoA.git" });
    // a curator-style edit: SAME slug, new body, NO scope passed.
    await services.notes.upsert(owner, { slug: "edit-note", title: "E", body_md: "kubernetes v2 edited" });
    const row = await db.prepare("SELECT scope FROM notes WHERE slug='edit-note'").first<{ scope: string }>();
    expect(row?.scope).toBe("github.com/acme/repoA"); // NOT reset to 'global'
    // skills likewise.
    await services.skills.upsert(owner, { slug: "edit-skill", name: "es", description: "kubernetes s1", scope: "https://github.com/acme/repoA" });
    await services.skills.upsert(owner, { slug: "edit-skill", name: "es", description: "kubernetes s2 edited" });
    const srow = await db.prepare("SELECT scope FROM skills WHERE slug='edit-skill'").first<{ scope: string }>();
    expect(srow?.scope).toBe("github.com/acme/repoA");
  });

  it("a PARTIAL skills_put (e.g. a scope-only re-scope) PRESERVES name/description/instructions — it must never blank the skill", async () => {
    // Regression: skills_put declares no required fields, so `{slug, scope}` is a
    // schema-valid call. It used to default every omitted field to "" and silently
    // wipe the skill; there is no skill_revisions table, so that loss was permanent
    // (prod lost the body of `cf-memory-operations` exactly this way).
    await services.skills.upsert(owner, {
      slug: "partial-skill",
      name: "Release Runbook",
      description: "how to cut a release",
      instructions: "1. tag\n2. build\n3. deploy",
      scope: "github.com/acme/repoA",
    });
    // The documented repair call: change ONLY the scope.
    await services.skills.upsert(owner, { slug: "partial-skill", scope: "global" });
    const row = await db.prepare("SELECT name, description, instructions_md, scope FROM skills WHERE slug='partial-skill'").first<{
      name: string; description: string; instructions_md: string; scope: string;
    }>();
    expect(row?.scope).toBe("global"); // the re-scope took effect
    expect(row?.name).toBe("Release Runbook"); // ...and the content survived
    expect(row?.description).toBe("how to cut a release");
    expect(row?.instructions_md).toContain("2. build");
  });

  it("an explicitly-passed skills_put field still overwrites (preserve-on-omit must not become preserve-always)", async () => {
    await services.skills.upsert(owner, { slug: "edit-me", name: "Old", description: "old desc", instructions: "old body" });
    await services.skills.upsert(owner, { slug: "edit-me", description: "new desc" });
    const row = await db.prepare("SELECT name, description, instructions_md FROM skills WHERE slug='edit-me'").first<{
      name: string; description: string; instructions_md: string;
    }>();
    expect(row?.description).toBe("new desc"); // explicit value wins
    expect(row?.name).toBe("Old"); // omitted ones still preserved
    expect(row?.instructions_md).toBe("old body");
  });

  it("byStage('evergreen') — the ambient tier's live selector — filters by stage (evergreen in, seedling out)", async () => {
    await services.notes.upsert(owner, { slug: "amb-ever", title: "AE", body_md: "ambientstage evergreen fact", stage: "evergreen" });
    await services.notes.upsert(owner, { slug: "amb-seed", title: "AS", body_md: "ambientstage seedling fact" }); // default seedling
    const cohort = await services.notes.byStage(owner, "evergreen", 50, new Set(), null);
    const slugs = cohort.map((c) => c.slug);
    expect(slugs).toContain("amb-ever");
    expect(slugs).not.toContain("amb-seed");
  });

  it("the NO-query recall tiers are scope-filtered too (listMine 'recent' + byStage evergreen 'ambient')", async () => {
    await services.notes.upsert(owner, { slug: "ever-a", title: "EA", body_md: "evergreen repoA wisdom", scope: "github.com/acme/repoA", stage: "evergreen" });
    await services.notes.upsert(owner, { slug: "ever-b", title: "EB", body_md: "evergreen repoB wisdom", scope: "github.com/acme/repoB", stage: "evergreen" });
    await services.notes.upsert(owner, { slug: "ever-g", title: "EG", body_md: "evergreen global wisdom", stage: "evergreen" });

    // ambient tier (byStage evergreen) via empty-query recall: context=repoA → repoA + global, NOT repoB.
    const pack = await services.recall.recall(owner, "", 4000, 8, "github.com/acme/repoA");
    expect(pack.text).toContain("evergreen repoA");
    expect(pack.text).toContain("evergreen global");
    expect(pack.text).not.toContain("repoB");
  });

  it("owner-only (decision 9): another author's skill NEVER surfaces in the caller's search, in ANY context — the old public-skill discovery branch is gone", async () => {
    // Bob writes a skill scoped to HIS repo. (seeded last so it doesn't
    // pollute the exact-match assertions of the owner-only tests above.)
    await services.skills.upsert(bob, { slug: "bob-pub", name: "bobpub", description: "kubernetes shared helm runbook", scope: "github.com/bob/infra" });
    // Neither bob's own context nor an unrelated one leaks it to the owner.
    for (const context of ["github.com/bob/infra", "github.com/acme/repo-unrelated", undefined]) {
      const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20, scope: "skills", context });
      expect(hits.map((h) => h.slug)).not.toContain("bob-pub");
    }
    // Bob still finds his own skill (the isolation cuts one way per user).
    const bobHits = await services.search.hybrid(bob, "kubernetes", { limit: 20, scope: "skills", context: "github.com/bob/infra" });
    expect(bobHits.map((h) => h.slug)).toContain("bob-pub");
  });

  it("an ANONYMOUS principal matches NOTHING in search or recall (fail-closed below the HTTP gate too)", async () => {
    const anon = principalFixture({ userId: "anonymous", handle: "anonymous", anonymous: true });
    // empty-query recall (listMine tier) as ANON delivers no notes.
    const pack = await services.recall.recall(anon, "", 4000, 8, "github.com/acme/repoA");
    expect(pack.included).toEqual([]);
    // and keyword search (accessClause path) returns no hits.
    const hits = await services.search.hybrid(anon, "kubernetes", { limit: 20, context: "github.com/acme/repoA" });
    expect(hits).toEqual([]);
  });
});
