// Recall is keyword-only since 2026-10-31 (no query embedding). These pin the
// remaining pipeline: views are retained without blocking delivery, the exact
// and OR keyword lanes start together, note hydration does not wait for skill
// discovery, Japanese prompts still reach English identifier notes, and a
// pack keeps working memory, notes and skills under ACL/scope.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeServices, type Services } from "../src/services";
import { principalFixture } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_embedonce_owner";
const owner: Principal = principalFixture({ userId: OWNER, handle: "embedonce" });
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

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "embedonce", "eo", "eo@example.com", "", 0, 0).run();
  services = makeServices(db);
  // A note and a skill so every recall tier has real work.
  await services.notes.upsert(owner, { slug: "eo-note", title: "Widget debugging", body_md: "how to debug the widget pipeline" });
  await services.skills.upsert(owner, { slug: "eo-skill", name: "widget-runbook", description: "debug widgets", instructions: "step 1" });
});

afterAll(async () => {
  await mf.dispose();
});

describe("keyword recall pipeline", () => {
  it('returns the pack while retained view telemetry is still pending', async () => {
    const retained: Promise<void>[] = [];
    const deferred = makeServices(db, null, undefined, task => { retained.push(task); });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = deferred.notes.incrementRecallViews.bind(deferred.notes);
    const views = vi.spyOn(deferred.notes, 'incrementRecallViews').mockImplementation(async (...args) => {
      await gate;
      await original(...args);
    });
    let returned = false;
    const pending = deferred.recall.recall(owner, 'widget debugging', 4000).then(pack => { returned = true; return pack; });
    try {
      await vi.waitFor(() => expect(returned).toBe(true));
      const pack = await pending;
      expect(pack.text).toContain('eo-note');
      expect(retained).toHaveLength(1);
      expect(views).toHaveBeenCalledTimes(1);
      expect(views.mock.calls[0][1]).not.toHaveLength(0);
    } finally { release(); await pending; await Promise.all(retained); views.mockRestore(); }
  });

  it('observes failed background views without leaking error details or losing Recall', async () => {
    const retained: Promise<void>[] = [];
    const deferred = makeServices(db, null, undefined, task => { retained.push(task); });
    const views = vi.spyOn(deferred.notes, 'incrementRecallViews').mockRejectedValue(new Error('private-telemetry-error-fixture'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pack = await deferred.recall.recall(owner, 'widget debugging', 4000);
      await Promise.all(retained);
      expect(pack.text).toContain('eo-note');
      expect(retained).toHaveLength(1);
      expect(log.mock.calls).toEqual([['[recall] view tracking failed']]);
    } finally { views.mockRestore(); log.mockRestore(); }
  });

  it('starts independent exact and keyword lanes while retaining the same result ranking', async () => {
    const expected = await services.search.hybrid(owner, 'widget debugging');
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = Reflect.get(services.search, 'fts');
    let calls = 0;
    Reflect.set(services.search, 'fts', async (...args: unknown[]) => {
      calls++;
      await gate;
      return Reflect.apply(original, services.search, args);
    });
    const pending = services.search.hybrid(owner, 'widget debugging');
    try { await vi.waitFor(() => expect(calls).toBe(2), { timeout: 200 }); }
    finally { release(); const actual = await pending; Reflect.set(services.search, 'fts', original); expect(actual).toEqual(expected); }
  });

  it('hydrates current note bodies while skill discovery is pending', async () => {
    let releaseSkills: () => void = () => {};
    const skillGate = new Promise<void>(resolve => { releaseSkills = resolve; });
    const original = services.search.hybrid.bind(services.search);
    const search = vi.spyOn(services.search, 'hybrid').mockImplementation(async (principal, q, opts) => {
      if (opts?.scope === 'skills') await skillGate;
      return original(principal, q, opts);
    });
    const hydrate = vi.spyOn(services.notes, 'getRowsByIds');
    const pending = services.recall.recall(owner, 'widget debugging', 4000);
    try {
      await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
      expect(search.mock.calls.some(call => call[2]?.scope === 'skills')).toBe(true);
    } finally { releaseSkills(); await pending; search.mockRestore(); hydrate.mockRestore(); }
  });

  it('finds technical identifiers named in an actual Japanese prompt', async () => {
    const context = 'https://github.com/team/japanese-recall';
    await services.notes.upsert(owner, { slug: 'ja-ack-current', title: 'Vectorize ACK pending fallback', body_md: 'Vectorize ACK pending: immediately use D1; five minutes classify stale, not the fallback delay. Processed checkpoints restore ANN.', type: 'project', scope: context });
    await services.notes.upsert(owner, { slug: 'ja-ack-noise', title: 'Unrelated MCP Web integration', body_md: 'memory MCP Web integration deployment status', type: 'reference' });
    await services.notes.upsert(owner, { slug: 'ja-ack-other-repo', title: 'Vectorize ACK pending fallback', body_md: 'other-repo-vectorize-private-evidence', type: 'project', scope: 'https://github.com/team/elsewhere' });
    {
      const q = 'cf-memoryでVectorizeのACKが未処理なら、pendingが5分未満でもD1に退避しますか？5分の閾値の意味とANNへ戻る条件を、注入された過去memoryだけから短く説明してください。memoryのnote IDかタイトルも示してください。ファイル・コマンド・MCP・Web等のツールを一切使用せず、不明なら不明と答えてください。';
      const pack = await services.recall.recall(owner, q, 2000, undefined, context);
      expect(pack.included.some(i => i.ref === 'ja-ack-current')).toBe(true);
      expect(pack.text).not.toContain('other-repo-vectorize-private-evidence');
      expect(pack.retrieval).toMatchObject({ mode: 'keyword', semantic_status: 'not_requested' });
    }
  });
  it("returns working memory, keyword notes and skills without leaking other users' or repos' notes", async () => {
    await services.memory.setBlock(owner, "deadline-contract", "set", "Keep the operating contract available in every recall.");
    await db.prepare("INSERT INTO users(id,handle,display_name,created_at,updated_at) VALUES ('u_deadline_bob','deadline-bob','Bob',0,0)").run();
    await services.notes.upsert(principalFixture({ userId: "u_deadline_bob", handle: "deadline-bob" }), { slug: "deadline-private", title: "Widget debugging", body_md: "private-bob-widget-evidence", type: "user" });
    await services.notes.upsert(owner, { slug: "deadline-otherrepo", title: "Widget debugging", body_md: "otherrepo-widget-evidence", scope: "https://github.com/team/other-repo" });
    {
      const pack = await services.recall.recall(owner, "widget debugging", 4000, undefined, "https://github.com/team/current-repo");
      expect(pack!.included.some(i => i.ref === "deadline-contract")).toBe(true);
      expect(pack!.included.some(i => i.ref === "eo-note")).toBe(true);
      expect(pack!.included.some(i => i.ref === "eo-skill")).toBe(true);
      expect(pack!.text).not.toContain("private-bob-widget-evidence");
      expect(pack!.text).not.toContain("otherrepo-widget-evidence");
      expect(pack!.retrieval).toEqual({ mode: "keyword", semantic_status: "not_requested", lexical_focus: "full_query", japanese_lexical_focus: false });
    }
  });

  it("a no-query recall is a recency listing", async () => {
    const pack = await services.recall.recall(owner, "", 4000);
    expect(pack.retrieval).toMatchObject({ mode: "recent", semantic_status: "not_requested" });
  });


});

describe("short Japanese words without a semantic lane (review 4)", () => {
  beforeAll(async () => {
    await services.notes.upsert(owner, { slug: "jp-auth", title: "認証まわりのメモ", body_md: "OAuth の設定と認証の手順。設定は年に一度見直す。" });
    await services.notes.upsert(owner, { slug: "jp-db", title: "移行の記録", body_md: "DB を D1 に移行した手順とロールバック。" });
    await services.notes.upsert(owner, { slug: "jp-other", title: "無関係", body_md: "天気と昼ごはんの話。" });
  });
  const slugs = async (q: string) => (await services.search.hybrid(owner, q, { mode: "keyword", scope: "notes", limit: 10 })).map((h: any) => h.slug ?? h.id);
  it("finds notes by 1–2 character words, at least two of them, most words first", async () => {
    expect(await slugs("認証 設定")).toContain("jp-auth");
    expect(await slugs("DB 移行")).toContain("jp-db");
    expect(await slugs("db 移行")).toContain("jp-db");
    expect(await slugs("記憶 検索")).not.toContain("jp-auth");
    for (const q of ["do it", "ok go", "is it ok", "a b"]) expect(await slugs(q)).toEqual([]); // ASCII short words only as acronyms
    expect(await slugs("認証 設定")).not.toContain("jp-other");
    expect(await slugs("天気 移行")).not.toContain("jp-auth");
  });
  it("recall reaches them too", async () => {
    const pack = await services.recall.recall(owner, "認証 設定", 4000);
    expect(pack.text).toContain("jp-auth");
  });
});
