// decision 10: bi-temporal validity + supersession. Mirrors archive-cold-tier's
// harness (the same reversible "out of recall, kept in search" contract). Covers:
// a past valid_until and a future valid_from drop a note from recall but keep it in
// notes_search; `supersedes` hides the old note while its superseder is live; still-valid notes stay
// recalled; the notes_put MCP door and the .md-twin frontmatter round-trip carry
// the fields. Fixtures share the same keywords, so a note surviving recall proves
// it passed the validity WHERE filter, not relevance.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { mintTestToken, principalFixture, rsEnvVars } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_val_owner";
let OWNER_BEARER = "";
const owner: Principal = principalFixture({ userId: OWNER, handle: "val-owner" });
let mf: Miniflare;
let db: D1Database;
let services: Services;
let env: Parameters<typeof app.request>[2];

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}

const row = async (slug: string) =>
  db.prepare("SELECT id, valid_from, valid_until, superseded_by, supersedes FROM notes WHERE slug=? AND user_id=?").bind(slug, OWNER).first<{
    id: string;
    valid_from: number | null;
    valid_until: number | null;
    superseded_by: string | null;
    supersedes: string | null;
  }>();

async function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.request(
    "https://memory.test/mcp",
    { method: "POST", headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) },
    env,
  );
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "val-owner", "val-owner", "val-owner@example.com", "", 0, 0).run();
  // notes:read too (2026-11-14): this token also reads back (notes_get, the .md twin).
  OWNER_BEARER = await mintTestToken(OWNER, "notes:read,notes:write");
  services = makeServices(db);
  env = { DB: db, ...rsEnvVars(), OWNER_EMAIL: "val-owner@example.com", OWNER_HANDLE: "val-owner" } as unknown as Parameters<typeof app.request>[2];
});
afterAll(async () => { await mf?.dispose(); });

describe("bi-temporal validity (decision 10)", () => {
  it("a past valid_until drops a note from recall but it STAYS in notes_search", async () => {
    await services.notes.upsert(owner, { slug: "expired-fact", title: "Expired", body_md: "kubernetes expiredtoken", valid_until: 1000 });
    const pack = await services.recall.recall(owner, "kubernetes", 8000, 20);
    expect(pack.text).not.toContain("expiredtoken");
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20 });
    expect(hits.map((h) => h.slug)).toContain("expired-fact");
  });

  it("a future valid_from withholds a note from recall until it becomes valid", async () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    await services.notes.upsert(owner, { slug: "future-fact", title: "Future", body_md: "kubernetes futuretoken", valid_from: future });
    const pack = await services.recall.recall(owner, "kubernetes", 8000, 20);
    expect(pack.text).not.toContain("futuretoken");
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20 });
    expect(hits.map((h) => h.slug)).toContain("future-fact");
  });

  it("a note valid now (both windows open) IS recalled", async () => {
    await services.notes.upsert(owner, { slug: "current-fact", title: "Current", body_md: "kubernetes currenttoken" });
    const pack = await services.recall.recall(owner, "kubernetes", 8000, 20);
    expect(pack.text).toContain("currenttoken");
  });

  it("a superseded evergreen note drops out of the ambient (byStage) recall tier — derive correlation works unaliased", async () => {
    await services.notes.upsert(owner, { slug: "eg-old", title: "EG", body_md: "egoldtoken wisdom", stage: "evergreen" });
    await services.notes.upsert(owner, { slug: "eg-new", title: "EG", body_md: "egnewtoken wisdom", stage: "evergreen", supersedes: "eg-old" });
    const pack = await services.recall.recall(owner, "", 8000, 50); // empty query surfaces the ambient/evergreen tier
    expect(pack.text).toContain("egnewtoken");
    expect(pack.text).not.toContain("egoldtoken");
  });

  it("an evergreen note past valid_until drops out of the ambient recall tier", async () => {
    await services.notes.upsert(owner, { slug: "old-evergreen", title: "Old EG", body_md: "wisdomtoken here", stage: "evergreen", valid_until: 1000 });
    const ambient = await services.notes.byStage(owner, "evergreen", 10);
    expect(ambient.map((n) => n.slug)).not.toContain("old-evergreen");
  });
});

describe("supersession (decision 10)", () => {
  it("supersedes hides the old note (while superseder live); new is recalled, old drops out but stays searchable", async () => {
    const { note: oldNote } = await services.notes.upsert(owner, { slug: "lives-osaka", title: "Address", body_md: "lives in Osaka osakatoken" });
    await services.notes.upsert(owner, { slug: "lives-nishinomiya", title: "Address", body_md: "lives in Nishinomiya nishitoken", supersedes: "lives-osaka" });

    const old = await row("lives-osaka");
    const fresh = await row("lives-nishinomiya");
    expect(old?.superseded_by).toBe(fresh?.id);
    // supersede hides the old note via the DERIVED live-superseder filter (a live note
    // whose `supersedes` = the old note) — it does NOT fabricate a temporal window, so
    // valid_until stays null (that keeps supersession cleanly reversible if the
    // superseder is later deleted; see the softDelete test below). superseded_by here
    // is just the display/history pointer.
    expect(old?.valid_until).toBeNull();
    expect(fresh?.supersedes).toBe(oldNote.id);

    const pack = await services.recall.recall(owner, "lives address", 8000, 20);
    expect(pack.text).toContain("nishitoken");
    expect(pack.text).not.toContain("osakatoken");

    const hits = await services.search.hybrid(owner, "Osaka", { limit: 20 });
    expect(hits.map((h) => h.slug)).toContain("lives-osaka");
  });

  it("supersession is idempotent under re-supersede and never self-links", async () => {
    await services.notes.upsert(owner, { slug: "self-note", title: "Self", body_md: "selftoken body" });
    // self-reference is ignored (no superseded_by on itself)
    await services.notes.upsert(owner, { slug: "self-note", title: "Self", body_md: "selftoken body edited", supersedes: "self-note" });
    expect((await row("self-note"))?.superseded_by).toBeNull();
  });

  it("a body-only edit PRESERVES validity fields (omit ≠ reset) — including via notes_append", async () => {
    // R1 gap: an edit that omits valid_from/valid_until/supersedes must not wipe them.
    await services.notes.upsert(owner, { slug: "pres", title: "P", body_md: "prestoken v1", valid_from: 1000, valid_until: 5_000_000_000_000 });
    await services.notes.upsert(owner, { slug: "pres", title: "P", body_md: "prestoken v2 (validity omitted)" }); // body-only edit
    let r = await row("pres");
    expect(r?.valid_from).toBe(1000);
    expect(r?.valid_until).toBe(5_000_000_000_000);
    // notes_append routes through upsert with append_md only → must also preserve.
    await services.notes.upsert(owner, { slug: "pres", append_md: "appended line" });
    r = await row("pres");
    expect(r?.valid_from).toBe(1000);
    expect(r?.valid_until).toBe(5_000_000_000_000);
  });

  it("the no-query recall tier (listMine) also drops superseded / expired notes", async () => {
    // R1 gap: the empty-query recall branch went through listMine, previously untested.
    await services.notes.upsert(owner, { slug: "lm-cur", title: "LM", body_md: "lmcurtoken current" });
    await services.notes.upsert(owner, { slug: "lm-exp", title: "LM", body_md: "lmexptoken expired", valid_until: 1000 });
    await services.notes.upsert(owner, { slug: "lm-old", title: "LM", body_md: "lmoldtoken old" });
    await services.notes.upsert(owner, { slug: "lm-new", title: "LM", body_md: "lmnewtoken new", supersedes: "lm-old" });
    const pack = await services.recall.recall(owner, "", 8000, 50); // empty query → recency/listMine tier
    expect(pack.text).toContain("lmcurtoken");
    expect(pack.text).toContain("lmnewtoken");
    expect(pack.text).not.toContain("lmexptoken"); // expired
    expect(pack.text).not.toContain("lmoldtoken"); // superseded
  });

  it("deleting the superseding note REVIVES the older note into recall (derive: hide only while superseder is live)", async () => {
    // R1 High / R2: recall hides the old note only while its superseder is LIVE.
    // Deleting the superseder must return the old fact — with NO reconcile write
    // (so a concurrent delete can never strand it). superseded_by stays pointing at
    // the now-dead superseder (a harmless hint); the derived filter ignores it.
    await services.notes.upsert(owner, { slug: "addr-old", title: "Addr", body_md: "addroldtoken osaka" });
    const { note: sup } = await services.notes.upsert(owner, { slug: "addr-new", title: "Addr", body_md: "addrnewtoken nishinomiya", supersedes: "addr-old" });
    expect((await row("addr-old"))?.superseded_by).toBe(sup.id);
    let pack = await services.recall.recall(owner, "addr", 8000, 20);
    expect(pack.text).not.toContain("addroldtoken");
    // delete the superseder → the old fact comes back (derived from liveness)
    await services.notes.softDelete(owner, sup.id);
    pack = await services.recall.recall(owner, "addr", 8000, 20);
    expect(pack.text).toContain("addroldtoken");
    // a fresh superseder re-hides it (re-supersede works despite the stale pointer)
    await services.notes.upsert(owner, { slug: "addr-newer", title: "Addr", body_md: "addrnewertoken kyoto", supersedes: "addr-old" });
    pack = await services.recall.recall(owner, "addr", 8000, 20);
    expect(pack.text).not.toContain("addroldtoken");
    expect(pack.text).toContain("addrnewertoken");
  });

  it("a chain unwinds correctly on delete: head-delete revives the prior; a live superseder keeps it hidden", async () => {
    // A <- B <- C. Recall shows only C. Delete C (head) → B revives; A stays hidden
    // (its superseder B is live again). Documents the derive model's chain behavior.
    await services.notes.upsert(owner, { slug: "ch-a", title: "Ch", body_md: "chatoken one" });
    await services.notes.upsert(owner, { slug: "ch-b", title: "Ch", body_md: "chbtoken two", supersedes: "ch-a" });
    const { note: c } = await services.notes.upsert(owner, { slug: "ch-c", title: "Ch", body_md: "chctoken three", supersedes: "ch-b" });
    let pack = await services.recall.recall(owner, "Ch", 8000, 20);
    expect(pack.text).toContain("chctoken");
    expect(pack.text).not.toContain("chbtoken");
    expect(pack.text).not.toContain("chatoken");
    await services.notes.softDelete(owner, c.id); // delete head → B is current again
    pack = await services.recall.recall(owner, "Ch", 8000, 20);
    expect(pack.text).toContain("chbtoken"); // B revived
    expect(pack.text).not.toContain("chatoken"); // A still hidden (live superseder B)
  });

  it("a note that is ITSELF superseded cannot supersede another (cycle guard — no mutual A↔B hiding)", async () => {
    // R1 footgun: A supersedes B, then B edited to supersede A → both vanish forever.
    await services.notes.upsert(owner, { slug: "cyc-a", title: "C", body_md: "cyca token" });
    const { note: b } = await services.notes.upsert(owner, { slug: "cyc-b", title: "C", body_md: "cycb token", supersedes: "cyc-a" });
    expect((await row("cyc-a"))?.superseded_by).toBe(b.id); // A superseded by B
    // now edit B (which is CURRENT) to supersede A — but B is not superseded, so this
    // is allowed and would form a 2-cycle unless guarded. Instead edit A (superseded)
    // to try to supersede B: the guard must refuse, so B stays current.
    await services.notes.upsert(owner, { slug: "cyc-a", title: "C", body_md: "cyca token edited", supersedes: "cyc-b" });
    expect((await row("cyc-b"))?.superseded_by).toBeNull(); // guard held: B not superseded
    const pack = await services.recall.recall(owner, "token", 8000, 20);
    expect(pack.text).toContain("cycb"); // B still recalled (not hidden by a cycle)
  });

  it("two live notes supersede the SAME target; deleting the LATER superseder keeps it hidden (finding #5 — not last-writer-wins)", async () => {
    // A superseded first by B, then by C. superseded_by is last-writer-wins, so
    // A.superseded_by = C (a display pointer only). The OLD derive (a live note whose
    // id = A.superseded_by) revived A the moment C was deleted, even though B still
    // supersedes it. The fixed derive (a live note whose SUPERSEDES = A) keeps A hidden
    // until EVERY superseder is gone.
    await services.notes.upsert(owner, { slug: "dup-a", title: "D", body_md: "duprec dupatoken original" });
    const { note: b } = await services.notes.upsert(owner, { slug: "dup-b", title: "D", body_md: "duprec dupbtoken corrected once", supersedes: "dup-a" });
    const { note: c } = await services.notes.upsert(owner, { slug: "dup-c", title: "D", body_md: "duprec dupctoken corrected again", supersedes: "dup-a" });
    expect((await row("dup-a"))?.superseded_by).toBe(c.id); // last-writer-wins display pointer
    let pack = await services.recall.recall(owner, "duprec", 8000, 20);
    expect(pack.text).not.toContain("dupatoken"); // A hidden (two live supersessions)
    // delete the LATER superseder C → B STILL supersedes A → A must stay hidden
    await services.notes.softDelete(owner, c.id);
    pack = await services.recall.recall(owner, "duprec", 8000, 20);
    expect(pack.text).not.toContain("dupatoken"); // ← the bug: old derive wrongly revived A here
    expect(pack.text).toContain("dupbtoken"); // B is the current fact
    // delete B too → no live superseder remains → A revives
    await services.notes.softDelete(owner, b.id);
    pack = await services.recall.recall(owner, "duprec", 8000, 20);
    expect(pack.text).toContain("dupatoken");
  });

  it("cycle guard tests the LIVE superseder, not the stale superseded_by pointer (no A↔B cycle via a dead pointer)", async () => {
    // A superseded by B then C; delete C. A.superseded_by now points to the DEAD C,
    // but B still supersedes A. Editing A to supersede B must STILL be refused — a
    // guard that only checked A.superseded_by's liveness (dead C) would wrongly admit
    // it and form the mutual-hide A↔B cycle the guard exists to prevent.
    await services.notes.upsert(owner, { slug: "sg-a", title: "S", body_md: "sgrec sgatoken" });
    const { note: bb } = await services.notes.upsert(owner, { slug: "sg-b", title: "S", body_md: "sgrec sgbtoken", supersedes: "sg-a" });
    const { note: cc } = await services.notes.upsert(owner, { slug: "sg-c", title: "S", body_md: "sgrec sgctoken", supersedes: "sg-a" });
    void bb;
    await services.notes.softDelete(owner, cc.id); // A.superseded_by = dead C; B still live-supersedes A
    await services.notes.upsert(owner, { slug: "sg-a", title: "S", body_md: "sgrec sgatoken edited", supersedes: "sg-b" });
    expect((await row("sg-b"))?.superseded_by).toBeNull(); // guard held → no cycle
    const pack = await services.recall.recall(owner, "sgrec", 8000, 20);
    expect(pack.text).toContain("sgbtoken"); // B current
    expect(pack.text).not.toContain("sgatoken"); // A still hidden (live superseder B)
  });
});

describe("write doors carry validity (decision 10)", () => {
  it("the notes_put MCP tool accepts valid_until and drops the note from recall", async () => {
    const res = await mcpCall("notes_put", { slug: "mcp-expired", body_md: "kubernetes mcpexpiredtoken", valid_until: "2000-01-01T00:00:00.000Z" });
    expect(res.slug).toBe("mcp-expired");
    expect((await row("mcp-expired"))?.valid_until).toBe(Date.parse("2000-01-01T00:00:00.000Z"));
    const pack = await services.recall.recall(owner, "kubernetes", 8000, 20);
    expect(pack.text).not.toContain("mcpexpiredtoken");
  });

  it("notes_get surfaces the validity + supersession axes (so recall drops are explainable)", async () => {
    await services.notes.upsert(owner, { slug: "ng-old", body_md: "ngoldtoken" });
    await mcpCall("notes_put", { slug: "ng-new", body_md: "ngnewtoken", valid_until: "2999-01-01T00:00:00.000Z", supersedes: "ng-old" });
    const oldRow = await row("ng-old");
    const newRow = await row("ng-new");
    const gotOld = await mcpCall("notes_get", { slug: "ng-old" });
    const gotNew = await mcpCall("notes_get", { slug: "ng-new" });
    expect(gotOld.superseded_by).toBe(newRow?.id); // old note shows it was replaced
    expect(gotNew.supersedes).toBe(oldRow?.id); // new note shows what it replaced
    expect(gotNew.valid_until).toBe(Date.parse("2999-01-01T00:00:00.000Z"));
  });

  it("frontmatter valid_until parses and the .md twin round-trips it", async () => {
    await services.notes.upsert(owner, { slug: "fm-note", body_md: "---\nvalid_until: 2001-01-01T00:00:00.000Z\n---\n\nkubernetes fmtoken" });
    expect((await row("fm-note"))?.valid_until).toBe(Date.parse("2001-01-01T00:00:00.000Z"));
    const md = await (await app.request("https://memory.test/@val-owner/n/fm-note.md", { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } }, env)).text();
    expect(md).toContain("valid_until: 2001-01-01T00:00:00.000Z");
    // push the twin back unchanged → validity preserved (idempotent round-trip)
    await services.notes.upsert(owner, { slug: "fm-note", body_md: md });
    expect((await row("fm-note"))?.valid_until).toBe(Date.parse("2001-01-01T00:00:00.000Z"));
  });
});
