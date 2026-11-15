// Security-fix regression: a portable restore (cf-memory-agent/scripts/portability.mjs)
// must succeed for records the server normalises on write (src/notes.ts inertBody,
// singleLine, normalizeTags) and must refuse an over-limit body before any write.
// Dummy data only; local Miniflare D1; source rows of the old shapes are planted by SQL.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_NOTE_BODY_CHARS } from "../../src/notes";
import { ALICE, BOB, makeFixture, type Fixture } from "./notes.fixture";
// @ts-expect-error the shipped Node-only JavaScript entry point (outside the Worker build)
import { exportArchive, importArchive } from "../../cf-memory-agent/scripts/portability.mjs";

let f: Fixture;
beforeAll(async () => { f = await makeFixture(); });
afterAll(async () => { await f.mf.dispose(); });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bridge = (token: string, seen?: string[]) => async (name: string, args: Record<string, unknown> = {}) => {
  seen?.push(name);
  const result = await f.mcp(token, name, args);
  if (result.isError) throw Error("tool rejected: " + result.text.slice(0, 200));
  return result.json;
};
/** A source row as an older server stored it: text written verbatim, hash consistent with it. */
async function legacy(slug: string, title: string, body: string, tags: string[] = []) {
  const put = await f.put(f.aliceToken, { slug, title: "placeholder", body_md: "placeholder" });
  expect(put.status).toBeLessThan(300);
  await f.db.prepare("UPDATE notes SET title=?, body_md=?, frontmatter_json=?, content_hash=? WHERE user_id=? AND slug=?")
    .bind(title, body, JSON.stringify({ tags }), sha(`${title}\n${body}\n${tags.join(",")}`), ALICE.id, slug).run();
}
const exported = () => exportArchive(bridge(f.aliceToken), { url: "https://memory.test/mcp", token: "not-persisted" });
const restored = () => f.rows<{ slug: string; title: string; body_md: string; frontmatter_json: string }>("SELECT slug,title,body_md,frontmatter_json FROM notes WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at, slug", BOB.id);

describe("portable restore of records the server normalises", () => {
  it("refuses a body over the server limit up front, in dry-run and apply, naming the record, with nothing written", async () => {
    await legacy("small-first", "Small", "small body");
    await legacy("too-large", "Large", "a".repeat(MAX_NOTE_BODY_CHARS + 1));
    const archive = await exported();
    const large = archive.records.find((r: { body_md: string }) => r.body_md.length > MAX_NOTE_BODY_CHARS);
    for (const apply of [false, true]) {
      const calls: string[] = [];
      const attempt = importArchive(bridge(f.bobToken, calls), archive, { apply });
      await expect(attempt).rejects.toThrow(String(MAX_NOTE_BODY_CHARS));
      await expect(attempt).rejects.toThrow(large.id);
      expect(calls.filter((name) => !["notes_get", "skills_get", "memory_export"].includes(name))).toEqual([]);
    }
    expect(await restored()).toEqual([]);
    // At the limit it is restored like any other record (below).
    const fits = "a".repeat(MAX_NOTE_BODY_CHARS);
    await f.db.prepare("UPDATE notes SET body_md=?, content_hash=? WHERE user_id=? AND slug='too-large'").bind(fits, sha(`Large\n${fits}\n`), ALICE.id).run();
  });

  it("restores a body that opens with a keyed block (also behind blank lines), a title and a tag with control characters, and every later record; a retry changes nothing", async () => {
    const block = "---\nstatus: draft\nowner: me\n---\n\nReal content.";
    await legacy("opens-with-block", "Opens with block", block);
    await legacy("blank-then-block", "Blank then block", "\n\n \n---\nstatus: draft\n---\nafter blank lines");
    await legacy("tab-title", "Col A\tCol B C", "title body");
    await legacy("tab-tag", "Tagged", "tag body", ["one\ttwo", "plain"]);
    await legacy("plain-rule", "Plain", "---\n\nnot a keyed block, kept as it is");
    // The server's parser adds no key for a `__proto__` line, so this block is not liftable and stays as written.
    await legacy("proto-only", "Proto\tonly", "---\n__proto__: x\n---\nproto body");
    await legacy("zz-later", "Later", "a later record");
    const archive = await exported();
    expect(archive.records.map((r: { body_md: string }) => r.body_md)).toContain(block); // the archive holds the source text as it was

    expect(await importArchive(bridge(f.bobToken), archive)).toMatchObject({ ok: true, mode: "dry-run", create: 9, existing: 0 });
    expect(await restored()).toEqual([]);
    expect(await importArchive(bridge(f.bobToken), archive, { apply: true })).toMatchObject({ ok: true, mode: "apply", created: 9 });

    const rows = await restored();
    const by = (text: string) => rows.find((row) => row.body_md.includes(text))!;
    expect(rows).toHaveLength(9);
    // Exactly what the server stores for that text: the opening fence inert, one space per run of control characters.
    expect(by("Real content.").body_md).toBe("***\nstatus: draft\nowner: me\n---\n\nReal content.");
    expect(by("after blank lines").body_md).toBe("\n\n \n***\nstatus: draft\n---\nafter blank lines");
    expect(by("title body").title).toBe("Col A Col B C");
    expect(JSON.parse(by("tag body").frontmatter_json).tags).toEqual(["one two", "plain"]);
    expect(by("not a keyed block").body_md).toBe("---\n\nnot a keyed block, kept as it is");
    expect(by("proto body")).toMatchObject({ title: "Proto only", body_md: "---\n__proto__: x\n---\nproto body" });
    expect(by("a later record").title).toBe("Later");
    // No restored body is a metadata channel: nothing of the block was lifted into the row.
    expect(JSON.parse(by("Real content.").frontmatter_json).status).toBeUndefined();

    for (let i = 0; i < 2; i++) expect(await importArchive(bridge(f.bobToken), archive, { apply: true })).toMatchObject({ ok: true, created: 0 });
    expect(await importArchive(bridge(f.bobToken), archive)).toMatchObject({ mode: "dry-run", create: 0, existing: 9 });
    expect(await restored()).toHaveLength(9);
  });

  it("still refuses a restored row whose text is neither the archive's nor its normalised form", async () => {
    const archive = await exported();
    await f.db.prepare("UPDATE notes SET content_hash=? WHERE user_id=? AND title='Later'").bind(sha("tampered"), BOB.id).run();
    await expect(importArchive(bridge(f.bobToken), archive, { apply: true })).rejects.toThrow("existing import conflicts");
  });
});
