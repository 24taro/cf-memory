// Security regression: "personal capture events cannot become provenance of a
// shared note" must also hold after the note is shared.
//   src/capture.ts:personal-provenance-readable-after-share-transition
// The rule is enforced where provenance is returned: a reader who is not the
// row's actor only receives project-visibility rows. Nothing is deleted, so the
// actor keeps the full trace and unsharing loses nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMcp } from "../../src/mcp";
import { makeServices } from "../../src/services";
import type { Env } from "../../src/types";
import { TEST_RESOURCE } from "../helpers";
import { makeFixture, type Fixture } from "./notes.fixture";

let f: Fixture;
let guided: ReturnType<typeof makeServices>;
beforeAll(async () => {
  f = await makeFixture();
  // Guided search needs a 32+ character key; the HTTP fixture's is shorter.
  guided = makeServices(f.db, null, { INTROSPECTION_SECRET: "security-dummy-guided-key-0123456789abcdef", RESOURCE_URI: TEST_RESOURCE } as unknown as Env);
});
afterAll(async () => { await f?.mf?.dispose(); });

const eid = (n: number) => n.toString(16).padStart(64, "0");
const event = (n: number, visibility: "personal" | "project", fileRef: string) => ({
  id: eid(n), session_id: eid(9000 + n), tool_use_id: eid(n), event_type: "PostToolUse", tool_name: "Read",
  payload_redacted: { output: "dummy fixture output" }, payload_hash: eid(200), occurred_at: Date.now() - 10000 + n,
  visibility, repo_context: ["https://github.com/example/dummy"], file_refs: [fileRef], client: "claude-code",
});
type Prov = Array<{ event_id: string; source: { visibility?: string; file_refs?: string[] } }>;

async function lookup(principal: Fixture["bob"], q: string): Promise<string> {
  const call = async (args: object) => {
    const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_lookup", arguments: args } }) }), { principal, services: guided, budget: 4000 });
    return ((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text;
  };
  const index = JSON.parse(await call({ q, mode: "keyword", format: "json" })) as { cursor: string | null };
  expect(index.cursor).toBeTruthy();
  return call({ cursor: index.cursor, auto_select: true, format: "json" });
}

/** Everything a principal can obtain about a note's provenance, as one string per door. */
async function views(who: "alice" | "bob", noteId: string, q: string) {
  const token = who === "alice" ? f.aliceToken : f.bobToken, principal = who === "alice" ? f.alice : f.bob;
  const service = (await f.services.capture.provenance("note", noteId, principal)) as unknown as Prov;
  const rest = await f.req(`/api/v1/notes/${noteId}`, token);
  const web = await f.req(`/provenance/note/${noteId}`, token);
  return {
    service,
    restStatus: rest.status,
    rest: rest.status === 200 ? ((await rest.json()) as { provenance: Prov }).provenance : null,
    mcpGet: (await f.mcp(token, "notes_get", { id: noteId })).json as { provenance?: Prov },
    mcpGetMany: (await f.mcp(token, "notes_get_many", { ids: [noteId] })).text,
    webStatus: web.status,
    web: await web.text(),
    lookup: await lookup(principal, q),
  };
}

const transitions: Array<[string, Record<string, unknown>, Record<string, unknown>, boolean]> = [
  ["shared:true", { shared: false }, { shared: true }, false],
  ["type:'project'", { type: "user" }, { type: "project" }, false],
  ["revive with shared:true", { shared: false }, { shared: true }, true],
];

describe("personal provenance stays with its actor after the note becomes shared", () => {
  transitions.forEach(([name, first, second, revive], i) => {
    it(`${name}: no door returns the personal source to another member; the project source and the actor's view are intact`, async () => {
      const n = 10 + i * 10, slug = `prov-transition-${i}`, word = `provword${i}`;
      const personalRef = `src/dummy-personal-${i}.ts`, projectRef = `src/dummy-project-${i}.ts`;
      await f.services.capture.put(f.alice, event(n, "personal", personalRef));
      await f.services.capture.put(f.alice, event(n + 1, "project", projectRef));
      const { note } = await f.services.notes.upsert(f.alice, { slug, title: word, body_md: `${word} body`, ...first });
      await f.services.capture.attach(f.alice, { memory_id: note.id, source_event_ids: [eid(n), eid(n + 1)] });
      expect((await f.req(`/api/v1/notes/${note.id}`, f.bobToken)).status).toBe(404); // personal: unreadable before

      if (revive) expect(await f.services.notes.softDelete(f.alice, note.id)).toBe(true);
      const again = await f.services.notes.upsert(f.alice, { slug, body_md: `${word} body`, ...second });
      expect(again.note.id).toBe(note.id);
      expect(again.shared).toBe(true);

      const bob = await views("bob", note.id, word);
      expect(bob.restStatus).toBe(200);
      expect(bob.webStatus).toBe(200);
      for (const prov of [bob.service, bob.rest!, bob.mcpGet.provenance!]) {
        expect(prov.map((p) => p.event_id)).toEqual([eid(n + 1)]);
        expect(prov[0].source).toMatchObject({ visibility: "project", file_refs: [projectRef] });
      }
      for (const text of [JSON.stringify(bob.service), JSON.stringify(bob.rest), JSON.stringify(bob.mcpGet), bob.mcpGetMany, bob.web, bob.lookup]) {
        expect(text).not.toContain(personalRef);
        expect(text).not.toContain(eid(n)); // personal event id
        expect(text).not.toContain(eid(9000 + n)); // personal session id
      }
      for (const text of [bob.mcpGetMany, bob.web, bob.lookup]) expect(text).toContain(projectRef);

      // The actor still sees both, on every door.
      const alice = await views("alice", note.id, word);
      for (const prov of [alice.service, alice.rest!, alice.mcpGet.provenance!]) expect(prov.map((p) => p.event_id).sort()).toEqual([eid(n), eid(n + 1)]);
      for (const text of [alice.mcpGetMany, alice.web, alice.lookup]) expect(text).toContain(personalRef);

      // A source lookup by the personal file reference does not reveal the note to another member.
      const bySource = (principal: Fixture["bob"], ref: string) => f.services.capture.memoriesBySource(principal, { file_refs: [ref] });
      expect((await bySource(f.bob, personalRef)).hits).toEqual([]);
      expect((await bySource(f.bob, projectRef)).hits.map((h) => h.id)).toEqual([note.id]);
      expect((await bySource(f.alice, personalRef)).hits.map((h) => h.id)).toEqual([note.id]);

      // The search file_ref filter (notes_search / memory_lookup filters) follows the same reader rule.
      const searchSlugs = async (token: string, ref: string) =>
        (((await (await f.req(`/api/v1/search?q=${word}&mode=keyword&file_ref=${encodeURIComponent(ref)}`, token)).json()) as { hits?: Array<{ slug: string }> }).hits ?? []).map((h) => h.slug);
      expect(await searchSlugs(f.bobToken, personalRef)).toEqual([]);
      expect(await searchSlugs(f.bobToken, projectRef)).toEqual([slug]);
      expect(await searchSlugs(f.aliceToken, personalRef)).toEqual([slug]);

      // Nothing was destroyed: unsharing again leaves the actor's full trace.
      await f.services.notes.upsert(f.alice, { slug, body_md: `${word} body`, shared: false });
      expect((await f.row<{ n: number }>("SELECT count(*) AS n FROM memory_provenance WHERE memory_id=?", note.id))!.n).toBe(2);
      expect(((await f.services.capture.provenance("note", note.id, f.alice)) as unknown as Prov).map((p) => p.event_id).sort()).toEqual([eid(n), eid(n + 1)]);
      expect((await f.req(`/api/v1/notes/${note.id}`, f.bobToken)).status).toBe(404);
    });
  });

  it("the write-time rule is unchanged: a personal event is refused on an already-shared note", async () => {
    await f.services.capture.put(f.alice, event(90, "personal", "src/dummy-personal-ctl.ts"));
    const { note } = await f.services.notes.upsert(f.alice, { slug: "prov-already-shared", title: "T", body_md: "x", type: "project" });
    await expect(f.services.capture.attach(f.alice, { memory_id: note.id, source_event_ids: [eid(90)] })).rejects.toThrow("personal source cannot promote to shared memory");
  });

  it("an anonymous or unauthenticated reader gets no personal rows from the service either", async () => {
    await f.services.capture.put(f.alice, event(95, "personal", "src/dummy-personal-anon.ts"));
    const { note } = await f.services.notes.upsert(f.alice, { slug: "prov-anon", title: "T", body_md: "x", shared: false });
    await f.services.capture.attach(f.alice, { memory_id: note.id, source_event_ids: [eid(95)] });
    await f.services.notes.upsert(f.alice, { slug: "prov-anon", body_md: "x", shared: true });
    expect(await f.services.capture.provenance("note", note.id)).toEqual([]);
  });
});
