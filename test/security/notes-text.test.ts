// Security regression: note text handling in NotesRepo.upsert.
//   src/notes.ts:upsert:stored-body-frontmatter-relift-confused-deputy
//   src/index.tsx:noteGet/md-twin-frontmatter-newline-injection (root cause: stored titles/tags)
//   cli/cf-memory.ts:pull:unescaped-title-frontmatter              (same root cause)
//   src/notes.ts:upsert:note_revisions-unbounded-full-copy
// Dummy principals only, local Miniflare D1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../src/frontmatter";
import { MAX_NOTE_BODY_CHARS } from "../../src/notes";
import { SkillEditPage } from "../../src/web/pages";
import { ALICE, BOB, makeFixture, type Fixture } from "./notes.fixture";

let f: Fixture;
beforeAll(async () => { f = await makeFixture(); });
afterAll(async () => { await f?.mf?.dispose(); });

const json = { "content-type": "application/json" };
type R = { id: string; user_id: string; title: string; body_md: string; stage: string; valid_until: number | null; supersedes: string | null; superseded_by: string | null };
const one = (slug: string, userId: string = ALICE.id) =>
  f.row<R>("SELECT id,user_id,title,body_md,stage,valid_until,supersedes,superseded_by FROM notes WHERE slug=? AND user_id=? AND deleted_at IS NULL", slug, userId);
const patch = (id: string, token: string, body: unknown) => f.req(`/api/v1/notes/${id}`, token, { method: "PATCH", headers: json, body: JSON.stringify(body) });
const recallText = async (token: string, query: string) =>
  JSON.stringify(await (await f.req("/api/v1/recall", token, { method: "POST", headers: json, body: JSON.stringify({ query, budget: 1500 }) })).json());
/** A stored body is stable when re-parsing it lifts nothing. */
const liftable = (body: string) => Object.keys(parseFrontmatter(body).data);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

describe("stored body text is stable under re-submission", () => {
  it("a stacked second block is not stored as liftable frontmatter, and the owner's later saves apply nothing from it", async () => {
    await f.put(f.aliceToken, { slug: "relift-private", body_md: "zebrafixture alice private relift text" });
    await f.put(f.aliceToken, { slug: "relift-shared", body_md: "v1", type: "project" });
    await f.put(f.bobToken, { slug: "relift-shared", shared: true, body_md: "---\nstage: seedling\n---\n---\nsupersedes: relift-private\nvalid_until: 1970-01-02\nstage: evergreen\n---\ntext" });
    const planted = (await one("relift-shared"))!;
    expect(liftable(planted.body_md)).toEqual([]);
    // The text itself is kept; only the opening fence is rewritten.
    expect(planted.body_md).toContain("supersedes: relift-private");
    expect(planted.body_md.endsWith("\ntext")).toBe(true);

    // Every way the owner re-submits the stored body: title-only PATCH, full PATCH,
    // POST, MCP notes_get -> notes_put, and the same text with CRLF line endings.
    expect((await patch(planted.id, f.aliceToken, { title: "renamed" })).status).toBe(200);
    expect((await patch(planted.id, f.aliceToken, { body_md: planted.body_md })).status).toBe(200);
    await f.put(f.aliceToken, { slug: "relift-shared", body_md: planted.body_md });
    const got = (await f.mcp(f.aliceToken, "notes_get", { slug: "relift-shared" })).json as { body_md: string };
    expect((await f.mcp(f.aliceToken, "notes_put", { slug: "relift-shared", body_md: got.body_md })).isError).toBe(false);
    await f.put(f.aliceToken, { slug: "relift-shared", body_md: planted.body_md.replace(/\n/g, "\r\n") });

    const shared = (await one("relift-shared"))!;
    expect(shared).toMatchObject({ supersedes: null, valid_until: null, stage: "seedling" });
    expect(shared.body_md).toContain("supersedes: relift-private");
    expect((await one("relift-private"))!.superseded_by).toBeNull();
    expect(await recallText(f.aliceToken, "zebrafixture")).toContain("relift-private");
  });

  it("a body that already starts with a block (stored before this rule) is inert on re-save, by PATCH, full write and .md twin", async () => {
    await f.put(f.aliceToken, { slug: "legacy-private", body_md: "quaggafixture alice private legacy text" });
    const made = (await (await f.put(f.aliceToken, { slug: "legacy-shared", body_md: "v1", type: "project" })).json()) as { id: string };
    const legacy = "---\nsupersedes: legacy-private\nvalid_until: 1970-01-02\n---\ntext";
    const plant = () => f.db.prepare("UPDATE notes SET body_md=? WHERE id=?").bind(legacy, made.id).run();
    const untouched = async () => {
      expect(await one("legacy-shared")).toMatchObject({ supersedes: null, valid_until: null });
      expect((await one("legacy-private"))!.superseded_by).toBeNull();
      expect((await one("legacy-shared"))!.body_md).toContain("supersedes: legacy-private");
    };

    await plant();
    expect((await patch(made.id, f.aliceToken, { title: "renamed" })).status).toBe(200);
    await untouched();

    await plant();
    await f.put(f.aliceToken, { slug: "legacy-shared", body_md: legacy.replace(/\n/g, "\r\n") + "\r\nalice added a line" });
    await untouched();
    expect((await one("legacy-shared"))!.body_md).toContain("alice added a line");

    await plant();
    const twin = await (await f.req(`/@${ALICE.handle}/n/legacy-shared.md`, f.aliceToken)).text();
    expect((await f.put(f.aliceToken, { body_md: twin })).status).toBe(200);
    await untouched();
    expect(liftable((await one("legacy-shared"))!.body_md)).toEqual([]);
  });

  it("a note created by notes_append follows the same rule", async () => {
    await f.put(f.bobToken, { slug: "append-private", body_md: "bob private" });
    const created = await f.mcp(f.bobToken, "notes_append", { slug: "relift-append-new", text: "---\nstage: evergreen\nsupersedes: append-private\n---\nbody" });
    expect(created.json).toMatchObject({ created: true });
    const stored = (await one("relift-append-new", BOB.id))!;
    expect(liftable(stored.body_md)).toEqual([]);
    expect(stored.body_md).toContain("stage: evergreen");
    await f.mcp(f.bobToken, "notes_put", { slug: "relift-append-new", body_md: stored.body_md });
    expect(await one("relift-append-new", BOB.id)).toMatchObject({ stage: "seedling", supersedes: null });
    expect((await one("append-private", BOB.id))!.superseded_by).toBeNull();
  });

  it("control: frontmatter the caller sends in this request still applies, and the .md twin still round-trips", async () => {
    await f.put(f.aliceToken, { slug: "fm-old", body_md: "old fact" });
    const res = await f.put(f.aliceToken, { body_md: "---\ntitle: FM New\nslug: fm-new\nstage: evergreen\nsupersedes: fm-old\ntags:\n  - one\n---\n\nnew fact" });
    const made = (await res.json()) as { id: string };
    const old = (await one("fm-old"))!;
    expect(await one("fm-new")).toMatchObject({ title: "FM New", body_md: "new fact", stage: "evergreen", supersedes: old.id });
    expect(old.superseded_by).toBe(made.id);

    const twin = await (await f.req(`/@${ALICE.handle}/n/fm-new.md`, f.aliceToken)).text();
    const back = (await (await f.put(f.aliceToken, { body_md: twin })).json()) as { id: string; created: boolean };
    expect(back).toMatchObject({ id: made.id, created: false });
    // The twin ends with exactly one newline (pre-existing, idempotent from here on).
    expect(await one("fm-new")).toMatchObject({ title: "FM New", body_md: "new fact\n", stage: "evergreen", supersedes: old.id });
  });
});

// Fix review 1, 5, 21: the rule is about the whole stored body, whatever precedes
// the block, and holds on the guarded append door too.
describe("a stored body is inert whatever precedes the block", () => {
  const BLOCK = "---\nsupersedes: lead-private\nvalid_until: 1970-01-02\nstage: evergreen\n---\ntext";
  const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  /** What a browser submits for a textarea: the parser drops one line break right
   * after the start tag, and form submission sends CRLF line endings. */
  const submitted = (html: string, name: string) => {
    const m = new RegExp(`<textarea name="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(html);
    if (!m) throw new Error(`no textarea ${name}`);
    return unescape(m[1]).replace(/^\r?\n/, "").replace(/\r?\n/g, "\r\n");
  };
  const form = (path: string, token: string, fields: Record<string, string>) =>
    f.req(path, token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const lf = (t: string) => t.replace(/\r\n/g, "\n");

  it("a block behind a line break, a BOM, blank lines or indentation is stored inert, and the owner's web-form save applies nothing", async () => {
    await f.put(f.aliceToken, { slug: "lead-private", body_md: "okapifixture alice private lead text" });
    const leads = ["\n", "\r\n\r\n", "\uFEFF\n", " \n\t\n", "\n\uFEFF", "  ", "\u2028"];
    for (const [i, lead] of leads.entries()) {
      const slug = `lead-shared-${i}`;
      await f.put(f.aliceToken, { slug, title: "Lead", body_md: "v1", type: "project" });
      expect((await f.put(f.bobToken, { slug, shared: true, body_md: lead + BLOCK })).status, slug).toBe(200);
      const planted = (await one(slug))!;
      // Kept as text, exactly as sent apart from the fence.
      expect(planted.body_md, slug).toBe(lead + BLOCK.replace(/^---/, "***"));
      expect(liftable(planted.body_md.trimStart()), slug).toEqual([]);
      expect(liftable(planted.body_md.replace(/^[\uFEFF\s]+/, "")), slug).toEqual([]);

      // The owner opens the editor and saves without changing anything.
      const html = await (await f.req(`/@${ALICE.handle}/n/${slug}/edit`, f.aliceToken)).text();
      const body = submitted(html, "body_md");
      expect((await form(`/@${ALICE.handle}/n/${slug}/edit`, f.aliceToken, { title: "Lead", tags: "", body_md: body })).status, slug).toBe(302);
      // ...and a client that trims before re-saving.
      await f.put(f.aliceToken, { slug, body_md: planted.body_md.trim() });
      expect(await one(slug), slug).toMatchObject({ supersedes: null, valid_until: null, stage: "seedling" });
      expect((await one(slug))!.body_md, slug).toContain("supersedes: lead-private");
    }
    expect((await one("lead-private"))!.superseded_by).toBeNull();
    expect(await recallText(f.aliceToken, "okapifixture")).toContain("lead-private");
  });

  // A browser form turns a bare CR into a line break, so a block fenced with lone
  // CRs is a normal block by the time the owner's save sends it back.
  it("a block whose lines end in a bare CR is stored inert, and the CR-normalised re-save applies nothing", async () => {
    await f.put(f.aliceToken, { slug: "cr-private", body_md: "okapifixture alice private cr text" });
    const bodies = [
      "---\rsupersedes: cr-private\rvalid_until: 1970-01-02\rstage: evergreen\r---\rtext",
      "---\rsupersedes: cr-private\nstage: evergreen\n---\ntext",
      "---\nsupersedes: cr-private\nstage: evergreen\r---\rtext",
      "\r---\rsupersedes: cr-private\rstage: evergreen\r---\rtext",
    ];
    for (const [i, body] of bodies.entries()) {
      const slug = `cr-shared-${i}`;
      await f.put(f.aliceToken, { slug, title: "CR", body_md: "v1", type: "project" });
      expect((await f.put(f.bobToken, { slug, shared: true, body_md: body })).status, slug).toBe(200);
      const planted = (await one(slug))!;
      expect(planted.body_md, slug).toBe(body.replace("---", "***"));
      // What the owner's browser sends back: every CR, CRLF or LF as CRLF.
      const res = await f.put(f.aliceToken, { slug, body_md: planted.body_md.replace(/\r\n?|\n/g, "\r\n") });
      expect(res.status, slug).toBe(200);
      expect(await one(slug), slug).toMatchObject({ stage: "seedling", valid_until: null, supersedes: null });
      expect((await one("cr-private"))!.superseded_by, slug).toBeNull();
    }
    // guarded-append door: appended text closes a CR-fenced block.
    await f.put(f.aliceToken, { slug: "cr-append", body_md: "seed" });
    const appended = await f.mcp(f.aliceToken, "notes_append", { slug: "cr-append-new", text: "---\rsupersedes: cr-private\rstage: evergreen\r---\rmore" });
    expect(appended.isError).toBe(false);
    expect((await one("cr-append-new"))!.body_md.startsWith("***")).toBe(true);
  });

  it("a body stored before this rule with a line break before the block is inert on the owner's web-form save and on a trimmed re-save", async () => {
    await f.put(f.aliceToken, { slug: "lead-legacy-private", body_md: "alice private legacy lead text" });
    const made = (await (await f.put(f.aliceToken, { slug: "lead-legacy", title: "Legacy", body_md: "v1", type: "project" })).json()) as { id: string };
    const block = BLOCK.replace("lead-private", "lead-legacy-private");
    for (const lead of ["\n", "\uFEFF\r\n", " \n"]) {
      const plant = () => f.db.prepare("UPDATE notes SET body_md=? WHERE id=?").bind(lead + block, made.id).run();
      const untouched = async () => {
        expect(await one("lead-legacy"), JSON.stringify(lead)).toMatchObject({ supersedes: null, valid_until: null, stage: "seedling" });
        expect((await one("lead-legacy-private"))!.superseded_by, JSON.stringify(lead)).toBeNull();
        expect((await one("lead-legacy"))!.body_md, JSON.stringify(lead)).toContain("supersedes: lead-legacy-private");
        expect(liftable((await one("lead-legacy"))!.body_md.replace(/^[\uFEFF\s]+/, "")), JSON.stringify(lead)).toEqual([]);
      };
      await plant();
      const html = await (await f.req(`/@${ALICE.handle}/n/lead-legacy/edit`, f.aliceToken)).text();
      expect((await form(`/@${ALICE.handle}/n/lead-legacy/edit`, f.aliceToken, { title: "Legacy", tags: "", body_md: submitted(html, "body_md") })).status).toBe(302);
      await untouched();
      // The pre-fix page (no extra line break after the tag) or any trimming client.
      for (const sent of [block, block.replace(/\n/g, "\r\n"), block + "\nalice added a line"]) {
        await plant();
        expect((await f.put(f.aliceToken, { slug: "lead-legacy", body_md: sent })).status).toBe(200);
        await untouched();
      }
      await plant();
      expect((await patch(made.id, f.aliceToken, { title: "renamed" })).status).toBe(200);
      await untouched();
    }
  });

  it("the note edit form round-trips a body exactly, leading line breaks included", async () => {
    for (const [i, stored] of ["\nstarts with a line break", "\n\ntwo of them\n", "plain <b>&amp; text</b>\nline two", "\n---\nnot: closed"].entries()) {
      const slug = `roundtrip-${i}`;
      const made = (await (await f.put(f.aliceToken, { slug, title: "RT", body_md: stored })).json()) as { id: string };
      const html = await (await f.req(`/@${ALICE.handle}/n/${slug}/edit`, f.aliceToken)).text();
      expect((await form(`/@${ALICE.handle}/n/${slug}/edit`, f.aliceToken, { title: "RT", tags: "", body_md: submitted(html, "body_md") })).status).toBe(302);
      expect(lf((await one(slug))!.body_md), slug).toBe(stored);
      expect((await one(slug))!.id).toBe(made.id);
    }
  });

  it("the skill edit form emits the same extra line break", async () => {
    const instructions = "\nstep one\nstep two";
    await f.services.skills.upsert(f.alice, { slug: "roundtrip-skill", name: "Roundtrip", description: "dummy", instructions });
    const stored = (await f.row<{ instructions_md: string }>("SELECT instructions_md FROM skills WHERE slug='roundtrip-skill'"))!.instructions_md;
    // The skill edit route needs a browser session, so render the page itself.
    const html = String(await SkillEditPage({ handle: ALICE.handle, slug: "roundtrip-skill", name: "Roundtrip", description: "dummy", instructions: stored, version: "1.0.0" }));
    expect(lf(submitted(html, "instructions"))).toBe(stored);
    expect(lf(submitted(String(await SkillEditPage({ handle: ALICE.handle, slug: "s", name: "n", description: "d", instructions, version: "1.0.0" })), "instructions"))).toBe(instructions);
  });

  it("guarded append: appended text that closes an unclosed block does not leave a liftable body", async () => {
    const eid = (n: number) => n.toString(16).padStart(64, "0");
    await f.services.capture.put(f.alice, { id: eid(11), session_id: eid(9011), tool_use_id: eid(11), event_type: "PostToolUse", tool_name: "Read", payload_redacted: { output: "dummy fixture output" }, payload_hash: eid(211), occurred_at: Date.now() - 1000, visibility: "personal", repo_context: [], file_refs: ["src/dummy.ts"], client: "claude-code" });
    await f.put(f.aliceToken, { slug: "c-private", body_md: "alice private c" });
    const cases: Array<[string, string, string]> = [
      ["guard-a", "---\nsupersedes: c-private\nstage: evergreen", "---\nmore text"],
      ["guard-b", "---\nsupersedes: c-private\nstage: evergreen", "A summary line.\n\n---\nmore text"],
      ["guard-c", "\n---\nsupersedes: c-private\nstage: evergreen", "A summary line.\n\n---\nmore text"],
    ];
    for (const [i, [slug, open, text]] of cases.entries()) {
      await f.put(f.aliceToken, { slug, body_md: open });
      expect((await one(slug))!.body_md).toBe(open);
      const got = (await f.mcp(f.aliceToken, "notes_get", { slug })).json as { id: string; supersession_guard: unknown };
      const res = await f.mcp(f.aliceToken, "notes_append_guarded", { slug, text, append_id: eid(300 + i), append_guard: got.supersession_guard, provenance: { source_event_ids: [eid(11)], generated_by: "cf-memory-agent/subscription", confidence: 0.5, rationale: "inert append check" } });
      expect(res.json, slug).toMatchObject({ appended: true, replayed: false });
      const stored = (await f.row<{ body_md: string; content_hash: string }>("SELECT body_md,content_hash FROM notes WHERE id=?", got.id))!;
      expect(stored.body_md, slug).toBe((open + "\n\n" + text).replace("---", "***"));
      expect(liftable(stored.body_md.replace(/^[\uFEFF\s]+/, "")), slug).toEqual([]);
      // Receipt, revision and FTS all describe the body that was stored.
      expect(res.json.content_hash, slug).toBe(stored.content_hash);
      expect(await f.row("SELECT body_md,content_hash FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,id DESC LIMIT 1", got.id), slug).toEqual(stored);
      expect((await f.mcp(f.aliceToken, "notes_append_status", { id: got.id, append_id: eid(300 + i) })).json, slug).toMatchObject({ completed: true, current_content_matches: true });
      // Re-submitting it anywhere applies nothing.
      await f.put(f.aliceToken, { slug: `${slug}-copy`, body_md: stored.body_md.trim() });
      expect(await one(`${slug}-copy`), slug).toMatchObject({ supersedes: null, stage: "seedling" });
    }
    expect((await one("c-private"))!.superseded_by).toBeNull();
  });

  it("plain notes_append onto an unclosed block follows the same rule", async () => {
    await f.put(f.aliceToken, { slug: "append-unclosed", body_md: "\n---\nstage: evergreen" });
    await f.mcp(f.aliceToken, "notes_append", { slug: "append-unclosed", text: "A summary line.\n\n---\nmore text" });
    const stored = (await one("append-unclosed"))!;
    expect(stored.body_md).toBe("\n***\nstage: evergreen\n\nA summary line.\n\n---\nmore text");
    expect(stored.stage).toBe("seedling");
  });
});

describe("stored titles and tags carry no line breaks or control characters", () => {
  const EVIL = "Runbook\nslug: b-private\n---";

  it("every write door stores a single-line title", async () => {
    const viaRest = (await (await f.put(f.aliceToken, { slug: "title-rest", title: EVIL, body_md: "x", shared: true })).json()) as { id: string; title: string };
    const viaMcp = (await f.mcp(f.aliceToken, "notes_put", { slug: "title-mcp", title: "A\r\nsupersedes: x\u2028y\u0000z\tq\u0085w", body_md: "x" })).json as { title: string };
    await f.put(f.aliceToken, { slug: "title-patch", title: "ok", body_md: "x" });
    const patched = (await one("title-patch"))!;
    await patch(patched.id, f.aliceToken, { title: EVIL });
    // A JSON-quoted frontmatter scalar decodes escapes, so it is a second way in.
    await f.put(f.aliceToken, { body_md: '---\ntitle: "Quoted\\nsupersedes: x"\nslug: title-fm\n---\nbody' });
    await f.mcp(f.aliceToken, "notes_append", { slug: "title\nappend", text: "x" });

    for (const title of [viaRest.title, viaMcp.title]) expect(title).not.toMatch(CONTROL);
    const stored = await f.rows<{ slug: string; title: string }>("SELECT slug,title FROM notes WHERE slug LIKE 'title-%'");
    expect(stored.length).toBeGreaterThanOrEqual(5);
    for (const row of stored) expect(row.title, row.slug).not.toMatch(CONTROL);
    expect((await one("title-rest"))!.title).toBe("Runbook slug: b-private ---");
    expect((await one("title-mcp"))!.title).toBe("A supersedes: x y z q w");
    // FTS and the revision frontmatter see the same normalised value.
    expect(viaRest.title).toBe("Runbook slug: b-private ---");
  });

  it("tag names are normalised the same way, from input and from frontmatter", async () => {
    const made = (await (await f.put(f.aliceToken, { slug: "tag-lines", body_md: "x", tags: ["ok", "evil\nsupersedes: x", "a\u0000b"] })).json()) as { id: string };
    const names = async (id: string) => (await f.rows<{ name: string }>("SELECT t.name FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id=? ORDER BY t.name", id)).map((r) => r.name);
    expect(await names(made.id)).toEqual(["a b", "evil supersedes: x", "ok"]);
    const fm = (await (await f.put(f.aliceToken, { slug: "tag-fm", body_md: '---\ntags:\n  - "q\\nr"\n---\nbody' })).json()) as { id: string };
    expect(await names(fm.id)).toEqual(["q r"]);
    for (const row of await f.rows<{ name: string }>("SELECT name FROM tags")) expect(row.name).not.toMatch(CONTROL);
  });

  it("the .md twin of a hostile-titled shared note cannot redirect or re-key a teammate's re-submission", async () => {
    const mine = (await (await f.put(f.bobToken, { slug: "b-private", title: "B private", body_md: "secret-b zebrafinch" })).json()) as { id: string };
    await f.put(f.aliceToken, { slug: "runbook", title: EVIL, body_md: "attacker body", shared: true, tags: ["t\nslug: b-private"] });
    await f.put(f.aliceToken, { slug: "runbook2", title: "Runbook\nsupersedes: b-private", body_md: "attacker body 2", shared: true });

    for (const slug of ["runbook", "runbook2"]) {
      const md = await (await f.req(`/@${ALICE.handle}/n/${slug}.md`, f.bobToken)).text();
      const parsed = parseFrontmatter(md);
      expect(parsed.data.slug).toBe(slug);
      expect(parsed.data.supersedes).toBeUndefined();
      expect(parsed.body.trim()).toBe(slug === "runbook" ? "attacker body" : "attacker body 2");
      const back = (await (await f.put(f.bobToken, { body_md: md })).json()) as { slug: string };
      expect(back.slug).toBe(slug);
    }
    expect(await one("b-private", BOB.id)).toMatchObject({ id: mine.id, title: "B private", body_md: "secret-b zebrafinch", superseded_by: null });
    expect(await recallText(f.bobToken, "zebrafinch")).toContain("b-private");
  });
});

describe("revision history does not grow without a content change, and a regular note body is bounded", () => {
  const stats = (noteId: string) => f.row<{ n: number }>("SELECT count(*) AS n FROM note_revisions WHERE note_id=?", noteId);

  it("an unchanged write adds no revision; a changed one adds exactly one", async () => {
    const created = await f.mcp(f.aliceToken, "notes_put", { slug: "rev-noop", title: "Rev", body_md: "body", tags: ["t"] });
    const id = created.json.id as string;
    expect(await stats(id)).toEqual({ n: 1 });
    for (let i = 0; i < 3; i++) await f.mcp(f.aliceToken, "notes_put", { slug: "rev-noop", title: "Rev", body_md: "body", tags: ["t"] });
    expect((await patch(id, f.aliceToken, {})).status).toBe(200);
    expect((await patch(id, f.aliceToken, { title: "Rev" })).status).toBe(200);
    expect(await stats(id)).toEqual({ n: 1 });

    await f.mcp(f.aliceToken, "notes_append", { slug: "rev-noop", text: "x" });
    expect(await stats(id)).toEqual({ n: 2 });
    await patch(id, f.aliceToken, { title: "Rev 2" });
    expect(await stats(id)).toEqual({ n: 3 });
    await patch(id, f.aliceToken, { tags: ["t", "u"] });
    expect(await stats(id)).toEqual({ n: 4 });
    // The latest revision always equals the live row.
    const live = (await f.row<{ body_md: string; content_hash: string }>("SELECT body_md,content_hash FROM notes WHERE id=?", id))!;
    expect(await f.row("SELECT body_md,content_hash FROM note_revisions WHERE note_id=? ORDER BY created_at DESC,id DESC LIMIT 1", id)).toEqual(live);
  });

  it("a non-owner's unchanged write to a shared note adds no revision to the owner's note either", async () => {
    const created = (await (await f.put(f.aliceToken, { slug: "rev-shared", body_md: "seed", type: "project" })).json()) as { id: string };
    for (let i = 0; i < 3; i++) expect(await (await f.put(f.bobToken, { slug: "rev-shared", body_md: "seed", shared: true })).json()).toMatchObject({ id: created.id, written_through: { owner: ALICE.handle } });
    expect(await stats(created.id)).toEqual({ n: 1 });
  });

  it("reviving a deleted note with the same content still records the revival", async () => {
    const created = (await (await f.put(f.aliceToken, { slug: "rev-revive", body_md: "same" })).json()) as { id: string };
    expect((await f.req(`/api/v1/notes/${created.id}`, f.aliceToken, { method: "DELETE" })).status).toBe(200);
    await f.put(f.aliceToken, { slug: "rev-revive", body_md: "same" });
    expect(await stats(created.id)).toEqual({ n: 2 });
  });

  it("a body over the limit is refused at REST, MCP put and append; one at the limit is stored", async () => {
    const atLimit = "a".repeat(MAX_NOTE_BODY_CHARS);
    const ok = await f.put(f.aliceToken, { slug: "big-ok", body_md: atLimit });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { id: string }).id;

    const over = await f.put(f.aliceToken, { slug: "big-over", body_md: atLimit + "b" });
    expect(over.status).toBe(413);
    expect(await f.row("SELECT id FROM notes WHERE slug='big-over'")).toBeNull();
    const viaMcp = await f.mcp(f.aliceToken, "notes_put", { slug: "big-over", body_md: atLimit + "b" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain(String(MAX_NOTE_BODY_CHARS));
    expect(await f.row("SELECT id FROM notes WHERE slug='big-over'")).toBeNull();

    // Growth by append is refused at the same bound, and nothing is retained.
    const append = await f.mcp(f.aliceToken, "notes_append", { slug: "big-ok", text: "x" });
    expect(append.isError).toBe(true);
    expect((await patch(id, f.aliceToken, { body_md: atLimit + "b" })).status).toBe(413);
    expect((await f.row<{ n: number }>("SELECT length(body_md) AS n FROM notes WHERE id=?", id))!.n).toBe(MAX_NOTE_BODY_CHARS);
    expect(await stats(id)).toEqual({ n: 1 });
    // Shrinking stays possible.
    expect((await patch(id, f.aliceToken, { body_md: "small" })).status).toBe(200);
  }, 60000);

  it("a note that is already over the limit can be retitled or shrunk, not grown", async () => {
    const created = (await (await f.put(f.aliceToken, { slug: "big-legacy", body_md: "seed" })).json()) as { id: string };
    const legacy = "c".repeat(MAX_NOTE_BODY_CHARS + 10);
    await f.db.prepare("UPDATE notes SET body_md=? WHERE id=?").bind(legacy, created.id).run();
    expect((await patch(created.id, f.aliceToken, { title: "retitled" })).status).toBe(200);
    expect((await f.mcp(f.aliceToken, "notes_append", { slug: "big-legacy", text: "x" })).isError).toBe(true);
    expect((await patch(created.id, f.aliceToken, { body_md: legacy.slice(0, -5) })).status).toBe(200);
  }, 60000);

  it("the guarded append door enforces the same bound", async () => {
    const eid = (n: number) => n.toString(16).padStart(64, "0");
    await f.services.capture.put(f.alice, { id: eid(1), session_id: eid(9001), tool_use_id: eid(1), event_type: "PostToolUse", tool_name: "Read", payload_redacted: { output: "dummy fixture output" }, payload_hash: eid(200), occurred_at: Date.now() - 1000, visibility: "personal", repo_context: [], file_refs: ["src/dummy.ts"], client: "claude-code" });
    await f.put(f.aliceToken, { slug: "big-guarded", body_md: "a".repeat(MAX_NOTE_BODY_CHARS - 2) });
    const got = (await f.mcp(f.aliceToken, "notes_get", { slug: "big-guarded" })).json as { id: string; supersession_guard: unknown };
    const res = await f.mcp(f.aliceToken, "notes_append_guarded", { slug: "big-guarded", text: "supplement", append_id: eid(77), append_guard: got.supersession_guard, provenance: { source_event_ids: [eid(1)], generated_by: "cf-memory-agent/subscription", confidence: 0.5, rationale: "bounded append check" } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(String(MAX_NOTE_BODY_CHARS));
    expect((await f.row<{ n: number }>("SELECT length(body_md) AS n FROM notes WHERE id=?", got.id))!.n).toBe(MAX_NOTE_BODY_CHARS - 2);
    expect(await stats(got.id)).toEqual({ n: 1 });
  }, 60000);
});
