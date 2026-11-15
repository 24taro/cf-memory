// view_count E2E through the REAL Hono app on a Miniflare D1 with the full
// migration set (issue #34). Pre-fix, incrementView() was only ever called
// from the human web-garden page (GET /@handle/n/:slug) — the agent-facing
// doors that DESIGN.md documents as the primary usage model (MCP notes_get,
// REST GET /notes/:id) never counted a view at all, so the anti-graveyard
// staleness signal (staleGraveyard(): view_count=0 AND stale) silently never
// saw agent reads. Live audit reproduced this exact asymmetry: 3x REST GET
// left view_count at 0, while 2x Web UI GET moved it 0->2.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NotesRepo } from '../src/notes';
import app from "../src/index";
import { mintTestToken, rsEnvVars } from "./helpers";

const OWNER = "u_owner";
let TOKEN = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];

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

const headers = { get authorization() { return `Bearer ${TOKEN}`; }, "content-type": "application/json" };

it('real Recall route retains delayed telemetry in its request context after returning', async () => {
  const id = await restCreateNote('viewcount-context-delivery', 'contextdeliveryprobe memory');
  const retained: Promise<unknown>[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = NotesRepo.prototype.incrementRecallViews;
  const views = vi.spyOn(NotesRepo.prototype, 'incrementRecallViews').mockImplementation(async function(this: NotesRepo, ...args) {
    await gate;
    await original.apply(this, args);
  });
  let returned = false;
  const pending = Promise.resolve(app.request('https://memory.test/mcp', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'recall', arguments: { query: 'contextdeliveryprobe', budget: 4000 },
    } }),
  }, env, { props: {}, waitUntil: task => { retained.push(task); }, passThroughOnException() {} })).then(r => { returned = true; return r; });
  try {
    await vi.waitFor(() => expect(returned).toBe(true));
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0].text).text).toContain('viewcount-context-delivery');
    expect(retained).toHaveLength(1);
    expect(await viewCountOf(id)).toBe(0);
  } finally { release(); await pending; await Promise.all(retained); views.mockRestore(); }
  expect(await viewCountOf(id)).toBe(1);
});

async function restCreateNote(slug: string, body_md: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await req("/api/v1/notes", { method: "POST", headers, body: JSON.stringify({ slug, title: slug, body_md, ...over }) });
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await req("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
}

async function viewCountOf(id: string): Promise<number> {
  const row = await db.prepare("SELECT view_count FROM notes WHERE id=?").bind(id).first<{ view_count: number }>();
  return row?.view_count ?? -1;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "owner@example.com", "", 0, 0).run();
  TOKEN = await mintTestToken(OWNER, "notes:read,notes:write");
  env = { DB: db, OWNER_HANDLE: "owner", ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("REST GET /notes/:id increments view_count (issue #34)", () => {
  it("3 consecutive REST GETs move view_count 0 -> 3 (was stuck at 0 pre-fix)", async () => {
    const id = await restCreateNote("viewcount-rest-note", "rest note body");
    expect(await viewCountOf(id)).toBe(0);
    for (let i = 0; i < 3; i++) {
      const res = await req(`/api/v1/notes/${id}`, { headers });
      expect(res.status).toBe(200);
    }
    expect(await viewCountOf(id)).toBe(3);
  });
});

describe("MCP notes_get increments view_count (issue #34)", () => {
  it("a single notes_get call moves view_count 0 -> 1", async () => {
    const id = await restCreateNote("viewcount-mcp-note", "mcp note body");
    expect(await viewCountOf(id)).toBe(0);
    const result = await mcpCall("notes_get", { id });
    expect(result.found).toBe(true);
    expect(await viewCountOf(id)).toBe(1);
  });

  it("REST and MCP reads on the SAME note both count, cumulatively (no double-counting bug, no missed counting)", async () => {
    const id = await restCreateNote("viewcount-both-doors-note", "both doors body");
    await req(`/api/v1/notes/${id}`, { headers });
    await mcpCall("notes_get", { id });
    await req(`/api/v1/notes/${id}`, { headers });
    expect(await viewCountOf(id)).toBe(3);
  });
});

describe("MCP notes_get_many — progressive disclosure", () => {
  it("returns selected full documents once each and increments each selected note once", async () => {
    const first = await restCreateNote("many-first", "first complete markdown");
    const second = await restCreateNote("many-second", "second complete markdown");
    const result = await mcpCall("notes_get_many", { slugs: ["many-first", "many-second"], ids: [first] });
    expect(result.found).toBe(true);
    expect(result.not_found).toEqual([]);
    expect(result.notes).toHaveLength(2); // duplicate slug+id selection is de-duplicated
    expect(result.notes.map((n: { body_md: string }) => n.body_md)).toEqual(["first complete markdown", "second complete markdown"]);
    expect(await viewCountOf(first)).toBe(1);
    expect(await viewCountOf(second)).toBe(1);
  });

  it("rejects an unbounded corpus-style request without reading anything", async () => {
    const result = await mcpCall("notes_get_many", { slugs: ["1", "2", "3", "4", "5", "6"] });
    expect(result).toMatchObject({ found: false, reason: "at most 5 notes per call" });
    // The cap is checked before type filtering too: malformed bulk input must
    // not create an unbounded CPU path that happens to return "provide slugs".
    const malformed = await mcpCall("notes_get_many", { ids: [1, 2, 3, 4, 5, 6] });
    expect(malformed).toMatchObject({ found: false, reason: "at most 5 notes per call" });
  });
});

describe("recall candidate index — progressive disclosure", () => {
  it("surfaces full cost, partial-preview state, and budget omission without injecting the full body", async () => {
    const body = `progressive disclosure probe ${"x".repeat(2_000)}\nFULL_ONLY_PROGRESSIVE_DISCLOSURE_MARKER`;
    const id = await restCreateNote("progressive-disclosure-probe", body);

    const search = await mcpCall("notes_search", { q: "progressive disclosure probe", scope: "notes" });
    const searchHit = (search.hits as Array<{ slug: string; char_count: number; estimated_tokens: number; preview_truncated: boolean }>).find((h) => h.slug === "progressive-disclosure-probe");
    expect(searchHit).toMatchObject({ char_count: body.length, estimated_tokens: expect.any(Number), preview_truncated: true });

    const result = await mcpCall("recall", { query: "progressive disclosure probe", budget: 4_000 });
    const candidate = (result.candidates as Array<Record<string, unknown>>).find((c) => c.ref === "progressive-disclosure-probe");
    expect(candidate).toMatchObject({
      source_type: "note",
      state: "included",
      source_chars: body.length,
      preview_chars: 1_600,
      preview_truncated: true,
    });
    expect(result.text).toContain(body.slice(0, 1_600));
    expect(result.text).not.toContain("FULL_ONLY_PROGRESSIVE_DISCLOSURE_MARKER");
    expect(await viewCountOf(id)).toBe(1); // included preview remains a recall view

    const cut = await mcpCall("recall", { query: "progressive disclosure probe", budget: 1 });
    const cutCandidate = (cut.candidates as Array<Record<string, unknown>>).find((c) => c.ref === "progressive-disclosure-probe");
    expect(cutCandidate).toMatchObject({ state: "omitted_budget", preview_truncated: true });
    expect(await viewCountOf(id)).toBe(1); // omitted candidates are not counted as viewed
  });
});

describe("notes_search does NOT increment view_count, v1 scope (issue #34)", () => {
  it("appearing in search hits leaves view_count at 0", async () => {
    const id = await restCreateNote("viewcount-search-note", "a note about hedgehogs and gardens");
    await mcpCall("notes_search", { q: "hedgehogs" });
    expect(await viewCountOf(id)).toBe(0);
  });
});

describe("recall() increments view_count ONLY for notes actually delivered in the pack (review follow-up)", () => {
  // Superseded issue #34's original "recall never counts" v1 scope: that
  // choice let issue #35's daily unattended cron auto-flag actively-recalled
  // notes (recall is DESIGN.md's own headline agent-consumption path) as
  // "never viewed, consider archiving" forever. Fix: count a note ONLY when
  // it survives packContext()'s token-budget cut (pack.included), not merely
  // when it's a raw search candidate -- narrower than notes_search's "any
  // hit" so the original over-counting worry still doesn't apply.
  it("a note actually included in the recall pack increments view_count", async () => {
    const id = await restCreateNote("viewcount-recall-included-note", "a note about recall packs and budgets");
    const result = await mcpCall("recall", { query: "recall packs", budget: 4000 });
    expect(result.included).toBeGreaterThan(0);
    expect(await viewCountOf(id)).toBe(1);
  });

  it("a note that matches but is cut by an insufficient token budget does NOT increment view_count", async () => {
    const id = await restCreateNote("viewcount-recall-truncated-note", "a note about recall packs and budgets, budget cut edition");
    const result = await mcpCall("recall", { query: "budget cut edition", budget: 1 });
    expect(result.included).toBe(0);
    expect(await viewCountOf(id)).toBe(0);
  });

  // review r1 fix: RecallItem.ref is an overloaded "slug or block label"
  // string shared across every tier (working/episodic/procedural), so a
  // naive ref-string lookup risks crediting an unrelated note whose slug
  // happens to collide with a memory block's label -- but ONLY if that note
  // is a genuine recall CANDIDATE (present in noteIdByItem) while not itself
  // surviving the budget cut. stage='evergreen' makes it a real `ambient`
  // candidate (byStage) regardless of query match; `ambient` is the LAST
  // tier packContext() fills, so a budget sized to fit only the (always-
  // first) working-memory block, but not also the ambient note, reproduces
  // the collision precisely: the block IS included, the note is NOT, and a
  // string-keyed lookup would wrongly resolve the included block's ref to
  // the excluded note's id (round-1 finding: this exact test previously
  // passed vacuously because the note was never a candidate at all).
  it("a memory block label that collides with an unrelated note's slug does NOT wrongly increment that note's view_count", async () => {
    const collidingSlug = "viewcount-collision-note";
    const id = await restCreateNote(collidingSlug, "this note's slug happens to match a memory block label below");
    // The REST door does not set stage; make it a genuine ambient (evergreen)
    // candidate directly. (It used to be a candidate only through the removed
    // semantic lane, which matched every note.)
    await db.prepare("UPDATE notes SET stage='evergreen' WHERE id=?").bind(id).run();
    await mcpCall("memory_set", { label: collidingSlug, value: "x" });

    // Budget fits the working-memory block (always first, always a
    // candidate) with slack but is deliberately too small to also fit the
    // ambient tier (last), so the colliding note remains a real candidate
    // that gets truncated, not merely absent. (Re-tuned after the episodic
    // tier's removal freed budget: 80 now let the ambient note in.)
    const result = await mcpCall("recall", { query: "completely unrelated query xyzzy plugh", budget: 55 });
    expect(result.included).toBeGreaterThan(0); // the block itself was included
    expect(result.truncated).toBeGreaterThan(0); // the ambient note candidate was cut, not merely absent
    expect(await viewCountOf(id)).toBe(0); // but the colliding note must NOT be credited a view
  });
});

describe("view_count still distinguishes a really-read note from an untouched one (issue #34; curator removed)", () => {
  it("a note read via notes_get gets a view; an untouched note stays at 0", async () => {
    const readId = await restCreateNote("viewcount-graveyard-read", "read via mcp");
    const untouchedId = await restCreateNote("viewcount-graveyard-untouched", "never read");
    await mcpCall("notes_get", { id: readId });
    expect(await viewCountOf(readId)).toBe(1);
    expect(await viewCountOf(untouchedId)).toBe(0);
  });
});
