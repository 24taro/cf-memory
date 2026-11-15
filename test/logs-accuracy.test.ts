// Accuracy follow-up to the 2026-11-05 evaluation (design B): what a reader
// needs from log_search and recall when it answers from the kept conversation.
// - the snippet shows the part of the text where the query words meet, not
//   the first place a 1–2 character word happens to occur;
// - without `kind`, prompts and replies come before tool actions, with a
//   few slots kept for the best actions and errors;
// - a query of only 1–2 character words reaches older prompts and replies
//   than the newest actions;
// - a reply hit says which prompt it answered (`question`);
// - recall can leave out the core blocks and stop at a character limit
//   (a hook that already injected them and whose text is capped).
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogService, logSettings, snippetAround } from "../src/logs";
import { handleMcp } from "../src/mcp";
import { packContext, type RecallTier } from "../src/recall";
import { makeServices, type Services } from "../src/services";
import type { Env, Principal } from "../src/types";
import { applyLogMigrations, applyMainMigrations, principalFixture } from "./helpers";

const scopes = new Set(["notes:read", "notes:write"]);
const user = (id: string): Principal => principalFixture({ userId: id, handle: id, scopes });
const hex = (n: number) => n.toString(16).padStart(64, "0");
const NOW = Date.now();
let mf: Miniflare, db: D1Database, logsDb: D1Database, services: Services;
let seq = 0x7000000;
function entry(over: Record<string, unknown> = {}) {
  return { id: hex(seq++), session_id: "acc-default", client: "claude-code", repo: "acme/cf-memory", ts: NOW - 60000, kind: "prompt", text: "hello", ...over };
}
async function rpc(name: string, args: Record<string, unknown>, principal: Principal): Promise<any> {
  const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    { principal, services, budget: 4000 });
  const body: any = await res.json();
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw new Error(body.result.content[0].text);
  return JSON.parse(body.result.content[0].text);
}
async function addUser(p: Principal) {
  await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle).run();
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB", "LOGS"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  logsDb = (await mf.getD1Database("LOGS")) as unknown as D1Database;
  await applyMainMigrations(db);
  await applyLogMigrations(logsDb);
  services = makeServices(db, null, { LOGS: logsDb } as unknown as Env);
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe("snippetAround", () => {
  it("centres on the place where the most query words meet, not the first short word", () => {
    const text = "日付の話を少しした。" + "x".repeat(600) + " Vectorize の 1 日の上限は 1,300 回にした。" + "y".repeat(600);
    const s = snippetAround(text, ["vectorize", "上限", "日"]);
    expect(s).toContain("1,300");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  });

  it("prefers a longer word over a 1–2 character word that occurs earlier", () => {
    const text = "DB " + "x".repeat(600) + " migration " + "y".repeat(600);
    expect(snippetAround(text, ["migration", "DB"])).toContain("migration");
  });

  it("falls back to the earliest occurrence on a tie and to the head when nothing matches", () => {
    const text = "alpha " + "x".repeat(600) + " alpha " + "y".repeat(600);
    expect(snippetAround(text, ["alpha"]).startsWith("alpha")).toBe(true);
    expect(snippetAround("z".repeat(1000), ["nothing"]).startsWith("zzz")).toBe(true);
  });
});

describe("log_search ordering without kind", () => {
  const u = user("acc-order");
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    // 12 actions that match better (the word three times) and are newer than the conversation.
    for (let i = 0; i < 12; i++) {
      const e = entry({ kind: "action", ts: NOW - 1000 * i, session_id: "acc-a", text: `Bash: grep deploy deploy deploy ${i}` });
      ids["a" + i] = e.id;
      await services.logs.append(u, { entries: [e] });
    }
    const add = async (name: string, over: Record<string, unknown>) => { const e = entry(over); ids[name] = e.id; await services.logs.append(u, { entries: [e] }); };
    await add("q", { kind: "prompt", ts: NOW - 900000, session_id: "acc-c", text: "どうやって本番に出す？" });
    await add("reply", { kind: "reply", ts: NOW - 800000, session_id: "acc-c", text: "deploy は手元で確かめてから明示の許可を取って行う。" });
    await add("prompt", { kind: "prompt", ts: NOW - 700000, session_id: "acc-d", text: "deploy して" });
    await add("err", { kind: "error", ts: NOW - 600000, session_id: "acc-d", text: "Bash: wrangler deploy → 失敗" });
  });

  it("puts prompts and replies first and keeps a third of the hits for the best actions and errors", async () => {
    const { hits } = await rpc("log_search", { query: "deploy" }, u);
    expect(hits).toHaveLength(10);
    expect(hits.slice(0, 2).map((h: any) => h.kind).sort()).toEqual(["prompt", "reply"]);
    expect(hits.slice(2).every((h: any) => h.kind === "action" || h.kind === "error")).toBe(true);
    // limit 20: all conversation hits, then the rest are actions and errors.
    const wide = await rpc("log_search", { query: "deploy", limit: 20 }, u);
    expect(wide.hits).toHaveLength(15);
    expect(wide.hits.slice(0, 2).every((h: any) => h.kind === "prompt" || h.kind === "reply")).toBe(true);
  });

  it("fills with actions when there are few conversation hits, and keeps 3 of 10 for actions when there are many", async () => {
    const v = user("acc-order-many");
    const conv = Array.from({ length: 12 }, (_, i) => entry({ kind: i % 2 ? "reply" : "prompt", ts: NOW - 100000 - i, session_id: "acc-m", text: `release note ${i}` }));
    const acts = Array.from({ length: 5 }, (_, i) => entry({ kind: "action", ts: NOW - i, session_id: "acc-m", text: `Bash: release release release ${i}` }));
    await services.logs.append(v, { entries: [...conv, ...acts] });
    const { hits } = await rpc("log_search", { query: "release" }, v);
    expect(hits.map((h: any) => h.kind === "action" ? "a" : "c").join("")).toBe("cccccccaaa");
    const one = await rpc("log_search", { query: "release", limit: 1 }, v);
    expect(one.hits.map((h: any) => h.kind)).not.toContain("action");
  });

  it("with kind, ranks only that kind as before", async () => {
    const { hits } = await rpc("log_search", { query: "deploy", kind: "action" }, u);
    expect(hits).toHaveLength(10);
    expect(hits.every((h: any) => h.kind === "action")).toBe(true);
  });

  it("a reply hit carries the prompt it answered; other hits do not", async () => {
    const { hits } = await rpc("log_search", { query: "deploy", limit: 20 }, u);
    const reply = hits.find((h: any) => h.id === ids.reply);
    expect(reply.question).toBe("どうやって本番に出す？");
    expect(hits.filter((h: any) => h.kind !== "reply").every((h: any) => !("question" in h))).toBe(true);
    // The question comes from the same session and is never newer than the reply.
    const lone = user("acc-lone");
    await services.logs.append(lone, { entries: [
      entry({ kind: "reply", ts: NOW - 5000, session_id: "acc-x", text: "orphan answer about kafka" }),
      entry({ kind: "prompt", ts: NOW - 4000, session_id: "acc-x", text: "a later prompt" }),
      entry({ kind: "prompt", ts: NOW - 9000, session_id: "acc-y", text: "another session's prompt" }),
    ] });
    const orphan = (await rpc("log_search", { query: "kafka" }, lone)).hits[0];
    expect(orphan.kind).toBe("reply");
    expect("question" in orphan).toBe(false);
  });

  it("cuts a long question to 200 characters", async () => {
    const w = user("acc-long-q");
    await services.logs.append(w, { entries: [
      entry({ kind: "prompt", ts: NOW - 2000, session_id: "acc-l", text: "長い質問 ".repeat(100) }),
      entry({ kind: "reply", ts: NOW - 1000, session_id: "acc-l", text: "answer about zookeeper" }),
    ] });
    const hit = (await rpc("log_search", { query: "zookeeper" }, w)).hits[0];
    expect(hit.question.length).toBeLessThanOrEqual(200);
    expect(hit.question.endsWith("…")).toBe(true);
  });
});

describe("log_search: a query of only 1–2 character words", () => {
  const u = user("acc-like"), BASE = NOW - 5 * 86400000, ROWS = 1500;
  beforeAll(async () => {
    // 1,500 newer actions, and an old reply with 容量 behind them.
    await logsDb.prepare(`INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at)
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${ROWS})
      SELECT ?1, printf('%064x', 880000000 + n), 'like-' || (n % 30), 'claude-code', 'bulk/like', ?2 + n * 1000, 'action', 'Bash: step ' || n, 10, ?2 FROM c`).bind(u.userId, BASE).run();
    await services.logs.append(u, { entries: [
      entry({ kind: "prompt", ts: BASE - 2000, session_id: "like-old", text: "D1 の容量はどれくらい？" }),
      entry({ kind: "reply", ts: BASE - 1000, session_id: "like-old", text: "D1 の容量は最大 10GB です。" }),
      entry({ kind: "error", ts: BASE - 500, session_id: "like-old", text: "Bash: 容量 check → 失敗" }),
    ] });
  }, 30000);
  const svc = () => new LogService(logsDb, { ...logSettings(), likeScanRows: 300, conversationScanRows: 1000 });

  it("looks at the newest conversationScanRows prompts and replies apart from the newest likeScanRows actions", async () => {
    const r = await svc().search(u, { query: "D1 容量" });
    expect(r.hits.map(h => h.kind)).toEqual(["reply", "prompt"]);
    expect(r.hits[0].question).toBe("D1 の容量はどれくらい？");
    // The old error is past the action window: said so, with the window's edge as until.
    expect(r.scan_limited).toMatchObject({ entries: 300, kinds: ["action"] });
    expect(r.scan_limited!.until).toBe(BASE + (ROWS - 299) * 1000 + 1);
    // Errors alone: their own window reaches the old one at once.
    const errors = await svc().search(u, { query: "容量", kind: "error" });
    expect(errors.hits.map(h => h.kind)).toEqual(["error"]);
    expect(errors.scan_limited).toBeUndefined();
  });

  it("with kind, the window holds only that kind", async () => {
    const r = await svc().search(u, { query: "容量", kind: "reply" });
    expect(r.hits.map(h => h.kind)).toEqual(["reply"]);
    expect(r.scan_limited).toBeUndefined();
    const s = new LogService(logsDb, { ...logSettings(), likeScanRows: 300, conversationScanRows: 1000 });
    const err = await s.search(u, { query: "容量", kind: "error", since: BASE - 600 });
    expect(err.hits.map(h => h.kind)).toEqual(["error"]);
  });
});

describe("recall: core and max_chars", () => {
  const u = user("acc-recall");
  beforeAll(async () => {
    await addUser(u);
    await services.memory.setBlock(u, "persona", "set", "Prefers keyword search over vectors.");
    for (let i = 0; i < 6; i++) {
      await rpc("notes_put", { slug: `zebra-note-${i}`, title: `Zebra note ${i}`, body_md: `zebra facts ${i} ` + "本文".repeat(400) }, u);
    }
  });

  it("core:false leaves out the core blocks; the default keeps them", async () => {
    const withCore = await rpc("recall", { query: "zebra", budget: 20000 }, u);
    expect(withCore.text).toContain("block:persona");
    const without = await rpc("recall", { query: "zebra", budget: 20000, core: false }, u);
    expect(without.text).not.toContain("block:persona");
    expect(without.candidates.every((c: any) => c.source_type !== "memory_block")).toBe(true);
    expect(without.text).toContain("Zebra note");
  });

  it("max_chars stops before the text would pass it, keeping whole items", async () => {
    const r = await rpc("recall", { query: "zebra", budget: 20000, core: false, max_chars: 2500 }, u);
    expect(r.text.length).toBeLessThanOrEqual(2500);
    expect(r.candidates.filter((c: any) => c.state === "omitted_budget").length).toBeGreaterThan(0);
    for (const c of r.candidates.filter((c: any) => c.state === "included")) expect(r.text).toContain(`([[${c.ref}]])`);
  });

  it("packContext counts the rendered characters exactly", () => {
    const tiers: RecallTier[] = [
      { tier: "working", label: "W", items: [{ ref: "b", title: "block:b", text: "abc" }] },
      { tier: "archival", label: "Notes", items: [{ ref: "n1", title: "N1", text: "x".repeat(50) }, { ref: "n2", title: "N2", text: "y".repeat(50) }] },
    ];
    const full = packContext("q", tiers, 100000);
    const exact = packContext("q", tiers, 100000, full.text.length);
    expect(exact.text).toBe(full.text);
    const less = packContext("q", tiers, 100000, full.text.length - 1);
    expect(less.text.length).toBeLessThan(full.text.length);
    expect(less.included.map(i => i.ref)).toEqual(["b", "n1"]);
  });
});

describe("MCP schema", () => {
  it("documents the new log_search behaviour and recall's core/max_chars", async () => {
    const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      { principal: user("acc-list"), services, budget: 4000 });
    const tools: any[] = ((await res.json()) as any).result.tools;
    const search = tools.find(t => t.name === "log_search"), recall = tools.find(t => t.name === "recall");
    expect(search.description).toMatch(/prompts and replies come first/);
    expect(search.description).toMatch(/`question`/);
    expect(search.description).toMatch(/log_read/);
    expect(Object.keys(recall.inputSchema.properties)).toEqual(expect.arrayContaining(["core", "max_chars"]));
    // Claude Code shows tool descriptions NFKC-normalized: keep them unchanged by it.
    for (const t of [search, recall]) {
      const s = JSON.stringify({ d: t.description, i: t.inputSchema });
      expect([...s].filter(c => c.normalize("NFKC") !== c)).toEqual([]);
    }
  });
});
