// Concurrency regression (issue #3): a lost-update window let two concurrent
// appends to the same core-memory block (or same note slug) silently clobber
// one another — the block path precomputed a joined body once and upsert's CAS
// retry then converged on that stale body. Stand up a REAL D1 (miniflare) and
// race concurrent appends, asserting EVERY append survives in the final body.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeServices, type Services } from "../src/services";
import { principalFixture } from "./helpers";

const OWNER = "u_owner";
const principal = principalFixture({ userId: OWNER, handle: "owner" });

let mf: Miniflare;
let db: D1Database;
let services: Services;

async function applyMigrations(db: D1Database): Promise<void> {
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
      if (s) await db.prepare(s).run();
    }
  }
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "", 0, 0).run();
  services = makeServices(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("concurrency — block append (issue #3 acceptance criterion)", () => {
  it("races concurrent memory_append calls against the same block without losing updates", async () => {
    await services.memory.setBlock(principal, "race-block", "set", "base", null, undefined);
    const tokens = ["a1", "a2", "a3", "a4", "a5", "a6"];

    // All appends start from the same base; without the fix the CAS losers
    // converge on a stale precomputed body and silently clobber the winner.
    await Promise.all(tokens.map((t) => services.memory.setBlock(principal, "race-block", "append", t, null, undefined)));

    const blocks = await services.memory.listBlocks(principal);
    const value = blocks.find((b) => b.label === "race-block")?.value ?? "";
    expect(value).toContain("base");
    for (const t of tokens) expect(value).toContain(t);
    // single-newline block separators, no duplication
    expect(value.split("\n").filter((l) => l.length).length).toBe(tokens.length + 1);
  });

  it("races concurrent memory_replace calls editing distinct tokens without losing updates (H-1)", async () => {
    // H-1: set/replace precomputes a body from the base IT read via getRaw, but
    // upsert bound its OWN independent re-read (getRowBySlug) as the CAS token — so
    // a concurrent commit landing in the getRaw->getRowBySlug window passed the CAS
    // and the stale-base body silently overwrote it (HTTP 200, no StaleUpsertError,
    // no retry). The fix binds the CAS to the SAME read setBlock transformed
    // (expectedContentHash), so a commit in that window fails the CAS -> retry.
    //
    // Each writer replaces a DISTINCT token, so a lost update drops one transform.
    // Staggering the writers' starts widens the silent window (a writer commits
    // while another sits between its getRaw and upsert's re-read), which is exactly
    // what the unguarded path lost — pre-fix this drops tokens across these rounds;
    // post-fix every distinct replace survives every round.
    const tokens = ["alpha", "beta", "gamma", "delta"];
    for (let round = 0; round < 30; round++) {
      await services.memory.setBlock(principal, "edit-block", "set", tokens.join(" "), null, undefined);
      await Promise.all(
        tokens.map(async (t, i) => {
          await new Promise((r) => setTimeout(r, i * 2)); // stagger to open the lost-update window
          return services.memory.setBlock(principal, "edit-block", "replace", t.toUpperCase(), null, t);
        }),
      );
      const blocks = await services.memory.listBlocks(principal);
      const value = blocks.find((b) => b.label === "edit-block")?.value ?? "";
      for (const t of tokens) {
        expect(value, `round ${round}, token ${t}`).toContain(t.toUpperCase());
        expect(value.split(/\s+/)).not.toContain(t);
      }
    }
    // 30 staggered rounds of 4-way CAS contention run slower under Miniflare's
    // async D1 (each op is a promise) plus the jittered upsert retry backoff, so
    // wall-clock sits right at vitest's 5s default and flakes on timeout — never
    // on a lost update (better-sqlite3 runs this deterministically green). Give
    // it headroom; the assertions above are unchanged. GitHub's shared runner
    // exceeded 30 seconds with all 30 rounds still making progress; preserve
    // every race/assertion and give only this stress test a bounded CI budget.
  }, process.env.CI ? 120_000 : 30_000);

  it("clamps a racing block append to char_limit while still keeping later appends", async () => {
    await services.memory.setBlock(principal, "limited", "set", "", 12, undefined);
    await Promise.all([
      services.memory.setBlock(principal, "limited", "append", "xxxx", 12, undefined),
      services.memory.setBlock(principal, "limited", "append", "yyyy", 12, undefined),
    ]);
    const blocks = await services.memory.listBlocks(principal);
    const value = blocks.find((b) => b.label === "limited")?.value ?? "";
    expect(value.length).toBeLessThanOrEqual(12);
  });

  it.each(["append", "replace"] as const)("respects a limit changed before the block %s is written", async op => {
    const label = `limit-${op}`;
    await services.memory.setBlock(principal, label, "set", "base", 30);
    const raw = services.notes.upsert.bind(services.notes);
    const upsert = vi.spyOn(services.notes, "upsert").mockImplementationOnce(async (caller, input) => {
      await raw(principal, {
        slug: input.slug, title: label, kind: "block", pinned_block_label: label, body_md: "base", char_limit: 4,
      });
      return raw(caller, input);
    });
    try {
      await expect(services.memory.setBlock(principal, label, op, "longer", undefined, "base")).rejects.toThrow(/4-char limit/);
      expect(await services.memory.getBlock(principal, label)).toMatchObject({ value: "base", char_limit: 4 });
    } finally {
      upsert.mockRestore();
    }
  });
});

describe("concurrency — note append (issue #3 acceptance criterion)", () => {
  it("races concurrent notes_append (append_md) against the same slug without losing updates", async () => {
    await services.notes.upsert(principal, { slug: "race-note", title: "race-note", body_md: "base" });
    const tokens = ["n1", "n2", "n3", "n4", "n5", "n6"];

    await Promise.all(tokens.map((t) => services.notes.upsert(principal, { slug: "race-note", title: "race-note", append_md: t })));

    const row = await services.notes.getRowBySlug(OWNER, "race-note");
    expect(row?.body_md).toContain("base");
    for (const t of tokens) expect(row?.body_md).toContain(t);
  });

  it("keeps FTS, tags, and links aligned with the last concurrent note edit", async () => {
    const slug = "concurrent-index";
    const { note } = await services.notes.upsert(principal, { slug, body_md: "initial" });
    await Promise.all(["first", "second", "third"].map(label => services.notes.upsert(principal, {
      slug,
      body_md: `current ${label} [[target-${label}]]`,
      tags: [label],
    })));
    const saved = await services.notes.getRowById(note.id);
    const label = saved?.body_md.split(" ")[1];
    const row = await db.prepare(`SELECT f.body,f.tags FROM notes_fts f JOIN notes n ON n.rowid=f.rowid
      WHERE n.id=?`).bind(note.id).first<{ body: string; tags: string }>();
    expect(row).toEqual({ body: saved?.body_md, tags: label });
    expect(await services.notes.tagsFor(note.id, principal.userId)).toEqual([label]);
    const links = await db.prepare("SELECT target_slug FROM links WHERE src_note_id=?").bind(note.id).all<{ target_slug: string }>();
    expect(links.results).toEqual([{ target_slug: `target-${label}` }]);
    const events = await db.prepare("SELECT COUNT(*) AS count FROM events WHERE target_id=? AND verb='note.updated'")
      .bind(note.id).first<{ count: number }>();
    expect(events?.count).toBe(3);
  });

  it("merges concurrent metadata edits on an unchanged note body", async () => {
    const slug = "concurrent-note-metadata";
    const body_md = "unchanged body";
    const { note } = await services.notes.upsert(principal, { slug, body_md });
    await Promise.all([
      services.notes.upsert(principal, { slug, body_md, scope: "https://github.com/example/repo" }),
      services.notes.upsert(principal, { slug, body_md, type: "project" }),
    ]);
    expect(await services.notes.getRowById(note.id)).toMatchObject({
      scope: "github.com/example/repo", type: "project", content_hash: note.content_hash,
    });
  });
});

describe("concurrency — skills upsert CAS (review follow-up)", () => {
  it("races concurrent upserts of the same NEW slug -> all converge, no unhandled 500", async () => {
    // Pre-fix: one INSERT wins, the rest hit UNIQUE(user_id,slug) and throw a bare
    // 500 (no CAS/retry/catch). Post-fix the losers re-read the winner's row and
    // converge to an UPDATE, so every call resolves and exactly one row exists.
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((d) =>
        services.skills.upsert(principal, { slug: "race-skill", name: "Race Skill", description: `desc ${d}`, instructions: `do ${d}` }),
      ),
    );
    expect(results).toHaveLength(6);
    // exactly one row exists for the slug
    const list = await services.skills.list(principal, { ownerId: OWNER });
    expect(list.filter((s) => s.slug === "race-skill")).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("races concurrent updates of an existing slug without losing version bumps", async () => {
    await services.skills.upsert(principal, { slug: "ver-skill", name: "Ver", description: "v", instructions: "i0" });
    await Promise.all(
      ["i1", "i2", "i3", "i4", "i5"].map((body) => services.skills.upsert(principal, { slug: "ver-skill", name: "Ver", instructions: body })),
    );
    const saved = await services.skills.getBySlug(OWNER, "ver-skill");
    expect(saved?.version).toBe("0.1.5");
    const row = await db.prepare(`SELECT f.instructions FROM skills_fts f JOIN skills s ON s.rowid=f.rowid
      WHERE s.id=?`).bind(saved!.id).first<{ instructions: string }>();
    expect(row?.instructions).toBe(saved?.instructions_md);
    const events = await db.prepare("SELECT COUNT(*) AS count FROM events WHERE target_id=? AND verb='skill.updated'")
      .bind(saved!.id).first<{ count: number }>();
    expect(events?.count).toBe(5);
  });

  it("merges concurrent skill metadata edits while keeping the same content hash", async () => {
    const original = await services.skills.upsert(principal, { slug: "meta-skill", name: "Skill", instructions: "same content" });
    const flags = ["one", "two", "three", "four"];
    await Promise.all(flags.map(flag => services.skills.upsert(principal, {
      slug: "meta-skill",
      frontmatter: { [flag]: true },
    })));
    const saved = await services.skills.getBySlug(OWNER, "meta-skill");
    expect(saved?.content_hash).toBe(original.skill.content_hash);
    expect(saved?.version).toBe("0.1.4");
    expect(JSON.parse(saved!.frontmatter_json)).toMatchObject(Object.fromEntries(flags.map(flag => [flag, true])));
  });
});
