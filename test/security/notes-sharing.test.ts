// Security regression: the shared-slug write-through of NotesRepo.upsert.
//   src/notes.ts:NotesRepo.upsert:shared-slug-write-through-without-owner-bind
// A write that is personal by intent never lands in a teammate's row, a
// non-owner's collaborative edit changes content only, and `kind` is checked at
// both doors. Dummy principals only, local Miniflare D1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, makeFixture, type Fixture } from "./notes.fixture";

let f: Fixture;
beforeAll(async () => { f = await makeFixture(); });
afterAll(async () => { await f?.mf?.dispose(); });

type Row = {
  id: string; user_id: string; title: string; kind: string; shared: number; body_md: string; pinned_block_label: string | null;
  char_limit: number | null; valid_from: number | null; valid_until: number | null; scope: string; type: string | null; stage: string;
  supersedes: string | null; superseded_by: string | null; archived_at: number | null;
};
const COLS = "id,user_id,title,kind,shared,body_md,pinned_block_label,char_limit,valid_from,valid_until,scope,type,stage,supersedes,superseded_by,archived_at";
const rows = (slug: string) => f.rows<Row>(`SELECT ${COLS} FROM notes WHERE slug=? AND deleted_at IS NULL ORDER BY user_id`, slug);
const rowOf = async (slug: string, userId: string) => (await rows(slug)).find((r) => r.user_id === userId);
const listSlugs = async (token: string) =>
  (((await (await f.req("/api/v1/notes", token)).json()) as { notes?: Array<{ slug: string }> }).notes ?? []).map((n) => n.slug);
const REPO = "https://github.com/example/dummy";

describe("a personal-by-intent write never resolves to a teammate's shared row", () => {
  for (const [name, extra] of [["type:'user'", { type: "user" }], ["type:'feedback'", { type: "feedback" }], ["shared:false", { shared: false }]] as const) {
    it(`${name} creates the caller's own row and leaves the shared row untouched`, async () => {
      const slug = `trap-${name.replace(/[^a-z]/g, "")}`;
      expect(await (await f.put(f.bobToken, { slug, body_md: "bob-bait", type: "project" })).json()).toMatchObject({ stored: "shared", created: true });
      const res = await f.put(f.aliceToken, { slug, body_md: "ALICE-PERSONAL", ...extra });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { id: string };
      expect(out).toMatchObject({ created: true, stored: "personal" });

      const bob = await rowOf(slug, BOB.id);
      const alice = await rowOf(slug, ALICE.id);
      expect(bob).toMatchObject({ shared: 1, body_md: "bob-bait", type: "project" });
      expect(alice).toMatchObject({ id: out.id, shared: 0, body_md: "ALICE-PERSONAL" });
      // The writer reads her own text back; the teammate cannot read it.
      expect((await f.mcp(f.aliceToken, "notes_get", { slug })).json).toMatchObject({ id: out.id, body_md: "ALICE-PERSONAL" });
      expect((await f.req(`/api/v1/notes/${out.id}`, f.bobToken)).status).toBe(404);
    });
  }

  it("MCP notes_put with shared:false does the same", async () => {
    await f.put(f.bobToken, { slug: "trap-mcp", body_md: "bob-bait", type: "project" });
    const out = await f.mcp(f.aliceToken, "notes_put", { slug: "trap-mcp", body_md: "ALICE-PERSONAL", shared: false });
    expect(out.json).toMatchObject({ created: true, stored: "personal" });
    expect(await rowOf("trap-mcp", BOB.id)).toMatchObject({ shared: 1, body_md: "bob-bait" });
    expect(await rowOf("trap-mcp", ALICE.id)).toMatchObject({ shared: 0, body_md: "ALICE-PERSONAL" });
  });

  it("the owner can still unshare her own shared note in place", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "own-unshare", body_md: "x", type: "project" })).json()) as { id: string };
    expect(await (await f.put(f.aliceToken, { slug: "own-unshare", body_md: "x", shared: false })).json()).toMatchObject({ id: made.id, created: false, stored: "personal" });
    expect(await rows("own-unshare")).toEqual([expect.objectContaining({ id: made.id, user_id: ALICE.id, shared: 0 })]);
  });
});

describe("core-memory block writes only ever touch a row owned by the caller", () => {
  it("memory_append with a teammate's shared note at block-<label> creates the caller's own block", async () => {
    expect((await f.mcp(f.bobToken, "notes_put", { slug: "block-probe", body_md: "bob-seed", shared: true })).json).toMatchObject({ stored: "shared" });
    const append = await f.mcp(f.aliceToken, "memory_append", { label: "probe", value: "ALICE-PRIVATE-LINE" });
    expect(append.isError).toBe(false);

    expect(await rowOf("block-probe", BOB.id)).toMatchObject({ kind: "note", shared: 1, pinned_block_label: null, body_md: "bob-seed" });
    expect(await rowOf("block-probe", ALICE.id)).toMatchObject({ kind: "block", shared: 0, pinned_block_label: "probe", body_md: "ALICE-PRIVATE-LINE" });
    expect((await f.mcp(f.aliceToken, "memory_get", { label: "probe" })).text).toContain("ALICE-PRIVATE-LINE");
    expect((await f.mcp(f.bobToken, "memory_get", { label: "probe" })).text).not.toContain("ALICE-PRIVATE-LINE");
    expect((await f.mcp(f.bobToken, "session_context", {})).text).not.toContain("ALICE-PRIVATE-LINE");
    expect((await f.mcp(f.bobToken, "notes_get", { slug: "block-probe" })).text).not.toContain("ALICE-PRIVATE-LINE");
  });

  it("memory_set and memory_replace on the same collision write the caller's own block instead of failing", async () => {
    await f.mcp(f.bobToken, "notes_put", { slug: "block-probe2", body_md: "bob-seed", shared: true });
    const set = await f.mcp(f.aliceToken, "memory_set", { label: "probe2", value: "alice v1" });
    expect(set.isError).toBe(false);
    expect((await f.mcp(f.aliceToken, "memory_replace", { label: "probe2", find: "v1", replace: "v2" })).isError).toBe(false);
    expect(await rowOf("block-probe2", BOB.id)).toMatchObject({ kind: "note", shared: 1, body_md: "bob-seed" });
    expect(await rowOf("block-probe2", ALICE.id)).toMatchObject({ kind: "block", shared: 0, pinned_block_label: "probe2", body_md: "alice v2" });
  });

  it("REST PATCH /memory/blocks/:label is bound the same way", async () => {
    await f.put(f.bobToken, { slug: "block-probe3", body_md: "bob-seed", shared: true });
    const res = await f.req("/api/v1/memory/blocks/probe3", f.aliceToken, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "append", value: "ALICE-REST" }) });
    expect(res.status).toBe(200);
    expect(await rowOf("block-probe3", BOB.id)).toMatchObject({ kind: "note", shared: 1, body_md: "bob-seed" });
    expect(await rowOf("block-probe3", ALICE.id)).toMatchObject({ kind: "block", shared: 0, body_md: "ALICE-REST" });
  });
});

describe("a non-owner's write-through changes content only", () => {
  it("audience and lifecycle fields keep the row's values; body, title and tags are the collaborative part", async () => {
    await f.put(f.bobToken, { slug: "bob-own-target", body_md: "bob private" });
    const made = (await (await f.put(f.aliceToken, { slug: "meta-keep", title: "Original", body_md: "alice v1", type: "project", scope: REPO, valid_from: 1000, valid_until: 4102444800000, tags: ["alpha"] })).json()) as { id: string };
    const before = (await rowOf("meta-keep", ALICE.id))!;
    expect(before).toMatchObject({ shared: 1, type: "project", kind: "note", scope: "github.com/example/dummy", stage: "seedling", valid_from: 1000, valid_until: 4102444800000 });

    const attempts: Array<Record<string, unknown>> = [
      { valid_until: 1 },
      { valid_from: 4102444800000 },
      { scope: "https://github.com/example/other" },
      { kind: "journal" },
      { type: "reference" },
      { type: "user", shared: true },
      { supersedes: "bob-own-target" },
      { body_md: "---\nstage: evergreen\nvalid_until: 1970-01-02\nsupersedes: bob-own-target\n---\nbob fm body" },
    ];
    for (const extra of attempts) {
      // Explicit shared intent: an untyped full write no longer writes through.
      const res = await f.put(f.bobToken, { slug: "meta-keep", body_md: "bob edit", shared: true, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(200);
      expect(await res.json(), JSON.stringify(extra)).toMatchObject({ id: made.id, created: false, stored: "shared", written_through: { owner: ALICE.handle } });
      const after = (await rows("meta-keep"));
      expect(after, JSON.stringify(extra)).toHaveLength(1);
      expect(after[0], JSON.stringify(extra)).toMatchObject({
        id: made.id, user_id: ALICE.id, shared: 1, type: "project", kind: "note", scope: before.scope, stage: "seedling",
        valid_from: 1000, valid_until: 4102444800000, supersedes: null, pinned_block_label: null, char_limit: null,
      });
    }
    expect((await rowOf("bob-own-target", BOB.id))?.superseded_by).toBeNull();
    // MCP door, stage included.
    const viaMcp = await f.mcp(f.bobToken, "notes_put", { slug: "meta-keep", type: "project", title: "Bob title", body_md: "bob final", tags: ["beta"], stage: "evergreen", valid_until: "1970-01-02", scope: "https://github.com/example/other" });
    expect(viaMcp.json).toMatchObject({ id: made.id, created: false, stored: "shared", written_through: { owner: ALICE.handle } });
    expect(await rowOf("meta-keep", ALICE.id)).toMatchObject({ title: "Bob title", body_md: "bob final", stage: "seedling", scope: before.scope, valid_until: 4102444800000, shared: 1 });
    expect(await f.rows("SELECT t.name FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=?", made.id)).toEqual([{ name: "beta" }]);
    expect(await listSlugs(f.bobToken)).toContain("meta-keep");
  });

  it("a non-owner's append keeps kind and sharing (notes_append passes kind:'journal' for a slug it does not own)", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "meta-append", body_md: "seed", type: "project" })).json()) as { id: string };
    expect((await f.mcp(f.bobToken, "notes_append", { slug: "meta-append", text: "bob line" })).json).toMatchObject({ id: made.id, created: false });
    expect(await rows("meta-append")).toEqual([expect.objectContaining({ user_id: ALICE.id, kind: "note", shared: 1, body_md: "seed\n\nbob line" })]);
  });

  it("a non-owner's write does not unarchive the owner's archived shared note", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "meta-archived", body_md: "seed", type: "project" })).json()) as { id: string };
    expect((await f.req(`/api/v1/notes/${made.id}/archive`, f.aliceToken, { method: "POST" })).status).toBe(200);
    expect((await rowOf("meta-archived", ALICE.id))?.archived_at).not.toBeNull();
    await f.put(f.bobToken, { slug: "meta-archived", body_md: "bob edit", shared: true });
    expect(await rowOf("meta-archived", ALICE.id)).toMatchObject({ body_md: "bob edit", archived_at: expect.any(Number) });
  });

  it("the owner can still change every one of those fields", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "meta-owner", body_md: "v1", type: "project" })).json()) as { id: string };
    await f.put(f.aliceToken, { slug: "owner-old", body_md: "old fact" });
    const res = await f.mcp(f.aliceToken, "notes_put", { slug: "meta-owner", body_md: "v2", kind: "journal", type: "reference", stage: "evergreen", scope: REPO, valid_from: "1970-01-01T00:00:01Z", valid_until: "2100-01-01", supersedes: "owner-old" });
    expect(res.json).toMatchObject({ id: made.id, created: false, stored: "shared" });
    const old = (await rowOf("owner-old", ALICE.id))!;
    expect(await rowOf("meta-owner", ALICE.id)).toMatchObject({ kind: "journal", type: "reference", stage: "evergreen", scope: "github.com/example/dummy", valid_from: 1000, valid_until: Date.parse("2100-01-01"), supersedes: old.id });
    expect(old.superseded_by).toBe(made.id);
    expect(await (await f.put(f.aliceToken, { slug: "meta-owner", body_md: "v3", type: "feedback" })).json()).toMatchObject({ id: made.id, stored: "personal" });
    expect(await rows("meta-owner")).toEqual([expect.objectContaining({ user_id: ALICE.id, shared: 0, type: "feedback" })]);
  });
});

describe("`kind` is validated at both doors", () => {
  it("REST refuses 'block' and unknown kinds with 400 and writes nothing", async () => {
    await f.put(f.aliceToken, { slug: "kind-a", body_md: "alice kind-a", type: "project" });
    for (const kind of ["block", "nonsense", 7]) {
      for (const token of [f.bobToken, f.aliceToken]) {
        const res = await f.put(token, { slug: "kind-a", body_md: "b", kind });
        expect(res.status).toBe(400);
      }
      const fresh = await f.put(f.bobToken, { slug: "kind-fresh", body_md: "b", kind });
      expect(fresh.status).toBe(400);
    }
    expect(await rows("kind-a")).toEqual([expect.objectContaining({ user_id: ALICE.id, kind: "note", shared: 1, body_md: "alice kind-a" })]);
    expect(await rows("kind-fresh")).toEqual([]);
    expect(await listSlugs(f.aliceToken)).toContain("kind-a");
  });

  it("MCP notes_put refuses them too", async () => {
    await f.put(f.aliceToken, { slug: "kind-b", body_md: "alice kind-b", type: "project" });
    for (const kind of ["block", "nonsense"]) {
      for (const token of [f.bobToken, f.aliceToken]) {
        const res = await f.mcp(token, "notes_put", { slug: "kind-b", body_md: "b", kind });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("kind");
      }
    }
    expect(await rows("kind-b")).toEqual([expect.objectContaining({ user_id: ALICE.id, kind: "note", shared: 1, body_md: "alice kind-b" })]);
  });

  it("the published kinds still work, and the memory service remains the only way to a block", async () => {
    expect((await f.put(f.aliceToken, { slug: "kind-ok", body_md: "j", kind: "journal" })).status).toBe(201);
    expect((await f.mcp(f.aliceToken, "notes_put", { slug: "kind-ok2", body_md: "o", kind: "observation" })).json).toMatchObject({ created: true });
    expect((await rowOf("kind-ok", ALICE.id))?.kind).toBe("journal");
    expect((await rowOf("kind-ok2", ALICE.id))?.kind).toBe("observation");
    expect((await f.mcp(f.aliceToken, "memory_set", { label: "kind-block", value: "v" })).isError).toBe(false);
    expect(await rowOf("block-kind-block", ALICE.id)).toMatchObject({ kind: "block", shared: 0 });
    // A block the caller owns can still be appended to through notes_append (documented).
    expect((await f.mcp(f.aliceToken, "notes_append", { slug: "block-kind-block", text: "more" })).isError).toBe(false);
    expect(await rowOf("block-kind-block", ALICE.id)).toMatchObject({ kind: "block", shared: 0, pinned_block_label: "kind-block" });
  });

  it("the repository refuses a kind outside the stored set without burning its retry budget", async () => {
    const started = Date.now();
    await expect(f.services.notes.upsert(f.alice, { slug: "kind-repo", body_md: "x", kind: "nonsense" as never })).rejects.toThrow(/kind/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await rows("kind-repo")).toEqual([]);
  });
});

// Fix review 13/18 (decided): a full-document write that names no audience is
// personal. Collaborative edits take a shared type, shared:true or an append.
describe("an untyped full-document write is personal by default", () => {
  it("REST and MCP create the caller's own row beside a teammate's shared note", async () => {
    for (const door of ["rest", "mcp"] as const) {
      const slug = `untyped-${door}`;
      await f.put(f.bobToken, { slug, title: "Bob shared", body_md: "bob-shared-body", type: "project" });
      const out = door === "rest"
        ? ((await (await f.put(f.aliceToken, { slug, body_md: "ALICE-PERSONAL-UNTYPED" })).json()) as Record<string, unknown>)
        : (await f.mcp(f.aliceToken, "notes_put", { slug, body_md: "ALICE-PERSONAL-UNTYPED" })).json;
      expect(out, door).toMatchObject({ created: true, stored: "personal" });
      expect(out, door).not.toHaveProperty("written_through");
      expect(await rowOf(slug, BOB.id), door).toMatchObject({ shared: 1, title: "Bob shared", body_md: "bob-shared-body" });
      expect(await rowOf(slug, ALICE.id), door).toMatchObject({ id: out.id, shared: 0, body_md: "ALICE-PERSONAL-UNTYPED" });
      expect((await f.mcp(f.bobToken, "notes_get", { slug })).text, door).not.toContain("ALICE-PERSONAL-UNTYPED");
      // From here on she has her own row and keeps editing it, typed or not.
      expect((await f.mcp(f.aliceToken, "notes_put", { slug, body_md: "alice v2" })).json, door).toMatchObject({ id: out.id, created: false, stored: "personal" });
      expect(await rowOf(slug, BOB.id), door).toMatchObject({ body_md: "bob-shared-body" });
    }
  });

  it("an untyped write revives the caller's own deleted note instead of replacing the teammate's", async () => {
    const mine = (await (await f.put(f.aliceToken, { slug: "untyped-tomb", body_md: "alice old" })).json()) as { id: string };
    expect((await f.req(`/api/v1/notes/${mine.id}`, f.aliceToken, { method: "DELETE" })).status).toBe(200);
    await f.put(f.bobToken, { slug: "untyped-tomb", body_md: "bob-shared-body", type: "project" });
    expect(await (await f.put(f.aliceToken, { slug: "untyped-tomb", body_md: "alice again" })).json()).toMatchObject({ id: mine.id, stored: "personal" });
    expect(await rowOf("untyped-tomb", BOB.id)).toMatchObject({ shared: 1, body_md: "bob-shared-body" });
    expect(await rowOf("untyped-tomb", ALICE.id)).toMatchObject({ id: mine.id, shared: 0, body_md: "alice again" });
  });

  it("explicit shared intent and the append tool still write through, and the result names the owner", async () => {
    const made = (await (await f.put(f.bobToken, { slug: "collab", title: "Collab", body_md: "v1", type: "project" })).json()) as { id: string };
    expect(await (await f.put(f.aliceToken, { slug: "collab", body_md: "v2", shared: true })).json()).toMatchObject({ id: made.id, created: false, stored: "shared", written_through: { owner: BOB.handle } });
    expect((await f.mcp(f.aliceToken, "notes_put", { slug: "collab", body_md: "v3", type: "reference" })).json).toMatchObject({ id: made.id, created: false, stored: "shared", written_through: { owner: BOB.handle } });
    expect((await f.mcp(f.aliceToken, "notes_append", { slug: "collab", text: "alice line" })).json).toMatchObject({ id: made.id, created: false, stored: "shared", written_through: { owner: BOB.handle } });
    expect(await rows("collab")).toEqual([expect.objectContaining({ id: made.id, user_id: BOB.id, shared: 1, type: "project", body_md: "v3\n\nalice line" })]);
    // The owner's own write is not a write-through.
    const own = await (await f.put(f.bobToken, { slug: "collab", body_md: "v4" })).json();
    expect(own).toMatchObject({ id: made.id, stored: "shared" });
    expect(own).not.toHaveProperty("written_through");
  });
});

describe("notes_append never changes a title (fix review 15)", () => {
  it("keeps a teammate's title, the caller's own title, and titles a new note with its slug", async () => {
    await f.put(f.aliceToken, { slug: "title-keep", title: "Alice Fine Title", body_md: "seed", type: "project" });
    // Bob once had (and deleted) a note at this slug: its title must not travel either.
    const tomb = (await (await f.put(f.bobToken, { slug: "title-keep-tomb", title: "Bob Old Title", body_md: "bob old" })).json()) as { id: string };
    await f.req(`/api/v1/notes/${tomb.id}`, f.bobToken, { method: "DELETE" });
    await f.put(f.aliceToken, { slug: "title-keep-tomb", title: "Alice Second Title", body_md: "seed", type: "project" });

    expect((await f.mcp(f.bobToken, "notes_append", { slug: "title-keep", text: "bob line" })).isError).toBe(false);
    expect((await f.mcp(f.bobToken, "notes_append", { slug: "title-keep-tomb", text: "bob line" })).isError).toBe(false);
    expect(await rows("title-keep")).toEqual([expect.objectContaining({ user_id: ALICE.id, title: "Alice Fine Title", body_md: "seed\n\nbob line" })]);
    expect(await rows("title-keep-tomb")).toEqual([expect.objectContaining({ user_id: ALICE.id, title: "Alice Second Title", body_md: "seed\n\nbob line" })]);

    await f.put(f.bobToken, { slug: "title-own", title: "Bob Own Title", body_md: "seed" });
    await f.mcp(f.bobToken, "notes_append", { slug: "title-own", text: "more" });
    expect(await rowOf("title-own", BOB.id)).toMatchObject({ title: "Bob Own Title", body_md: "seed\n\nmore" });
    expect((await f.mcp(f.bobToken, "notes_append", { slug: "title-fresh", text: "first" })).json).toMatchObject({ created: true, stored: "personal" });
    expect(await rowOf("title-fresh", BOB.id)).toMatchObject({ title: "title-fresh", kind: "journal", shared: 0 });
  });
});

describe("a write-through UPDATE names content columns only (fix review 8, 17)", () => {
  it("does not write back lifecycle values it read before the owner changed them", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "race-life", body_md: "seed", type: "project" })).json()) as { id: string };
    const notes = f.services.notes;
    const original = notes.tagsFor.bind(notes);
    let fired = false;
    // tagsFor runs between upsert's read of the row and its UPDATE: the owner's
    // lifecycle decisions commit inside that window.
    notes.tagsFor = async (id: string) => {
      if (!fired && id === made.id) {
        fired = true;
        await f.db.prepare("UPDATE notes SET archived_at=77, valid_until=4102444800000, valid_from=5, scope='github.com/x/y', stage='evergreen', type='reference' WHERE id=?").bind(made.id).run();
      }
      return original(id);
    };
    try {
      const out = await notes.upsert(f.bob, { slug: "race-life", append_md: "bob line" });
      expect(out).toMatchObject({ created: false, shared: true, writtenThrough: ALICE.handle });
    } finally { notes.tagsFor = original; }
    expect(fired).toBe(true);
    expect(await f.row(`SELECT ${COLS} FROM notes WHERE id=?`, made.id)).toMatchObject({
      user_id: ALICE.id, body_md: "seed\n\nbob line", archived_at: 77, valid_until: 4102444800000, valid_from: 5,
      scope: "github.com/x/y", stage: "evergreen", type: "reference", shared: 1, kind: "note",
    });
  });

  it("a write that raced the owner's unshare or delete does not land in that row", async () => {
    for (const change of ["shared=0", "deleted_at=9"]) {
      const slug = `race-${change.split("=")[0].replace("_", "")}`;
      const made = (await (await f.put(f.aliceToken, { slug, body_md: "seed", type: "project" })).json()) as { id: string };
      const notes = f.services.notes;
      const original = notes.tagsFor.bind(notes);
      let fired = false;
      notes.tagsFor = async (id: string) => {
        if (!fired && id === made.id) { fired = true; await f.db.prepare(`UPDATE notes SET ${change} WHERE id=?`).bind(made.id).run(); }
        return original(id);
      };
      try {
        const out = await notes.upsert(f.bob, { slug, append_md: "bob line" });
        expect(out.note.user_id, change).toBe(BOB.id);
        expect(out.writtenThrough, change).toBeUndefined();
      } finally { notes.tagsFor = original; }
      expect(await f.row("SELECT body_md FROM notes WHERE id=?", made.id), change).toEqual({ body_md: "seed" });
    }
  });

  it("stores neither the caller's frontmatter argument nor the lifecycle keys of a body block in the owner's frontmatter_json", async () => {
    const made = (await f.mcp(f.aliceToken, "notes_put", { slug: "fm-keep", body_md: "alice v1", type: "project", tags: ["alpha"], frontmatter: { source: "alice-import" } })).json as { id: string };
    const res = await f.mcp(f.bobToken, "notes_put", {
      slug: "fm-keep", shared: true, tags: ["beta"], frontmatter: { injected: "yes", source: "bob" },
      body_md: "---\nvalid_until: 1970-01-02\nstage: evergreen\nsupersedes: fm-keep\n---\nbob body",
    });
    expect(res.json).toMatchObject({ id: made.id, written_through: { owner: ALICE.handle } });
    const row = (await f.row<{ frontmatter_json: string; body_md: string; stage: string; valid_until: number | null }>("SELECT frontmatter_json,body_md,stage,valid_until FROM notes WHERE id=?", made.id))!;
    expect(row).toMatchObject({ body_md: "bob body", stage: "seedling", valid_until: null });
    expect(JSON.parse(row.frontmatter_json)).toEqual({ source: "alice-import", tags: ["beta"] });
    expect((await f.mcp(f.aliceToken, "notes_get", { slug: "fm-keep" })).json.frontmatter).toEqual({ source: "alice-import", tags: ["beta"] });
    // The revision copy records the same stored value.
    expect(await f.row("SELECT frontmatter_json FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,id DESC LIMIT 1", made.id)).toEqual({ frontmatter_json: row.frontmatter_json });
  });
});

describe("an id-addressed write only reaches the row that was authorised (fix review 7)", () => {
  const patch = (id: string, token: string, body: unknown) => f.req(`/api/v1/notes/${id}`, token, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("PATCH of the caller's own deleted note is 404 and writes nothing, whatever else answers to the slug", async () => {
    const old = (await (await f.put(f.bobToken, { slug: "p-a", title: "Bob old", body_md: "BOB-OLD-PRIVATE-TOMBSTONE" })).json()) as { id: string };
    expect((await f.req(`/api/v1/notes/${old.id}`, f.bobToken, { method: "DELETE" })).status).toBe(200);
    // No shared row yet: the tombstone is not revived through its id either.
    expect((await patch(old.id, f.bobToken, { tags: ["x"] })).status).toBe(404);
    expect(await rows("p-a")).toEqual([]);

    await f.put(f.aliceToken, { slug: "p-a", title: "Alice shared", body_md: "alice body", type: "project" });
    for (const body of [{ tags: ["x"] }, { title: "T" }, { body_md: "B" }]) expect((await patch(old.id, f.bobToken, body)).status).toBe(404);
    expect(await rows("p-a")).toEqual([expect.objectContaining({ user_id: ALICE.id, title: "Alice shared", body_md: "alice body", shared: 1 })]);
    expect(await f.row("SELECT body_md, deleted_at IS NOT NULL AS gone FROM notes WHERE id=?", old.id)).toEqual({ body_md: "BOB-OLD-PRIVATE-TOMBSTONE", gone: 1 });
  });

  it("the repository refuses an id-bound write when the caller's live row at that slug is not that id", async () => {
    const alice = (await (await f.put(f.aliceToken, { slug: "p-bind", body_md: "alice body", type: "project" })).json()) as { id: string };
    const bob = (await (await f.put(f.bobToken, { slug: "p-bind", body_md: "bob body", shared: false })).json()) as { id: string };
    for (const expectedId of [alice.id, "01NOSUCHROW000000000000000"]) {
      await expect(f.services.notes.upsert(f.bob, { slug: "p-bind", body_md: "REDIRECTED", expectedId })).rejects.toThrow(/not found/);
    }
    // Deleted between the door's check and the write: no revival, no fallback to the shared row.
    await f.db.prepare("UPDATE notes SET deleted_at=5 WHERE id=?").bind(bob.id).run();
    await expect(f.services.notes.upsert(f.bob, { slug: "p-bind", body_md: "REDIRECTED", expectedId: bob.id })).rejects.toThrow(/not found/);
    expect(await f.rows("SELECT user_id, body_md FROM notes WHERE slug='p-bind' ORDER BY user_id")).toEqual([
      { user_id: ALICE.id, body_md: "alice body" }, { user_id: BOB.id, body_md: "bob body" },
    ]);
  });

  it("control: PATCH of a live own note still works and stays on that row", async () => {
    const made = (await (await f.put(f.bobToken, { slug: "p-live", title: "t", body_md: "b" })).json()) as { id: string };
    const res = await patch(made.id, f.bobToken, { title: "t2", tags: ["x"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: made.id, slug: "p-live" });
    expect(await rowOf("p-live", BOB.id)).toMatchObject({ id: made.id, title: "t2", body_md: "b" });
  });
});

describe("the web edit form writes the caller's own namespace only (fix review 16)", () => {
  const form = (path: string, token: string, fields: Record<string, string>) =>
    f.req(path, token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

  it("saving from either handle's URL never replaces a teammate's shared note, and the editor shows what the save reached", async () => {
    await f.put(f.aliceToken, { slug: "p-e", title: "Alice shared", body_md: "alice shared body", type: "project", tags: ["alpha"] });
    for (const [i, handle] of [BOB.handle, ALICE.handle].entries()) {
      const before = await (await f.req(`/@${handle}/n/p-e/edit`, f.bobToken)).text();
      if (i === 0) expect(before).not.toContain("alice shared body");
      const res = await form(`/@${handle}/n/p-e/edit`, f.bobToken, { title: "T", body_md: `WEBFORM-${i}`, tags: "" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/@${BOB.handle}/n/p-e`);
      expect(await rowOf("p-e", ALICE.id)).toMatchObject({ title: "Alice shared", body_md: "alice shared body", shared: 1 });
      expect(await rowOf("p-e", BOB.id)).toMatchObject({ title: "T", body_md: `WEBFORM-${i}`, shared: 0 });
      expect(await (await f.req(`/@${handle}/n/p-e/edit`, f.bobToken)).text()).toContain(`WEBFORM-${i}`);
    }
    expect(await f.rows("SELECT t.name FROM note_tags nt JOIN tags t ON t.id=nt.tag_id JOIN notes n ON n.id=nt.note_id WHERE n.slug='p-e' AND n.user_id=?", ALICE.id)).toEqual([{ name: "alpha" }]);
  });

  // The form edits the viewer's own row, so a teammate's page must not offer it:
  // a blank form there would save a private copy that shadows the shared note.
  it("the edit link is offered on the viewer's own note page only", async () => {
    await f.put(f.aliceToken, { slug: "p-btn", title: "Alice shared", body_md: "alice shared body", type: "project" });
    const link = `/@${ALICE.handle}/n/p-btn/edit`;
    expect(await (await f.req(`/@${ALICE.handle}/n/p-btn`, f.aliceToken)).text()).toContain(link);
    const asBob = await (await f.req(`/@${ALICE.handle}/n/p-btn`, f.bobToken)).text();
    expect(asBob).toContain("alice shared body");
    expect(asBob).not.toContain(link);
  });
});
