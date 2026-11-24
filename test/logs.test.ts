// Design B (2026-10-31): the kept conversation in the separate cf-memory-logs D1
// (binding LOGS). LogService and the MCP tools log_append, log_search,
// log_read, log_sessions and session_context, the server_status `logs` block
// and the daily scheduled() prune — on real Miniflare D1 databases (DB with
// every migration for core memory, LOGS with migrations-logs).
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { scrubEntryText } from "../cf-memory-agent/scripts/redact.mjs";
import { CUT_MARK, cutText, HANDOFF_SCAN_ROWS, jstTime, LogInputError, logQuery, LogService, logSettings, MAX_FTS_TERMS, parseEntry, pruneLogs, READ_TEXT_CHARS, utcDay } from "../src/logs";
import { handleMcp, MAX_LOG_CALLS_PER_REQUEST, toolErrorText } from "../src/mcp";
import { renderTiers } from "../src/recall";
import { makeServices, type Services, workingTier } from "../src/services";
import type { Env, Principal } from "../src/types";
import { applyLogMigrations, applyMainMigrations, principalFixture } from "./helpers";

const scopes = new Set(["notes:read", "notes:write"]);
const user = (id: string, s = scopes): Principal => principalFixture({ userId: id, handle: id, scopes: s });
const alice = user("log-alice"), bob = user("log-bob");
const hex = (n: number) => n.toString(16).padStart(64, "0");
const NOW = Date.now();
const DAY = 86400000;
let mf: Miniflare, db: D1Database, logsDb: D1Database, services: Services;
let seq = 1;
/** A valid entry; a fresh id unless one is given. */
function entry(over: Record<string, unknown> = {}) {
  return { id: hex(seq++), session_id: "sess-default", client: "claude-code", repo: "acme/cf-memory", ts: NOW - 60000, kind: "prompt", text: "hello", ...over };
}
async function rpc(name: string, args: Record<string, unknown>, principal: Principal = alice, svc: Services = services): Promise<any> {
  const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    { principal, services: svc, budget: 4000 });
  const body: any = await res.json();
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw new Error(body.result.content[0].text);
  return JSON.parse(body.result.content[0].text);
}
/** The full log_append result; only the named counters may be non-zero. */
const res = (stored: number, duplicates: number, dropped_over_cap: number, extra: Record<string, number> = {}) =>
  ({ stored, duplicates, dropped_over_cap, dropped_over_total_cap: 0, ts_clamped: 0, ...extra });
const count = async (userId: string) => (await logsDb.prepare("SELECT count(*) AS n FROM log_entries WHERE user_id=?").bind(userId).first<{ n: number }>())!.n;
const daily = (userId: string, day = utcDay(NOW)) => logsDb.prepare("SELECT action_bytes, dropped FROM log_daily WHERE user_id=? AND day=?").bind(userId, day).first<{ action_bytes: number; dropped: number }>();
const totals = (userId: string, day = utcDay(NOW)) => logsDb.prepare("SELECT total_bytes, total_dropped FROM log_daily WHERE user_id=? AND day=?").bind(userId, day).first<{ total_bytes: number; total_dropped: number }>();

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB", "LOGS"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  logsDb = (await mf.getD1Database("LOGS")) as unknown as D1Database;
  await applyMainMigrations(db);
  await applyLogMigrations(logsDb);
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle).run();
  services = makeServices(db, null, { LOGS: logsDb } as unknown as Env);
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe("log_append validation", () => {
  it("rejects malformed batches and entries, naming the field, and stores nothing", async () => {
    const u = user("log-validate");
    const before = await count(u.userId);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /entries must be an array of 1-50/],
      [{ entries: [] }, /entries must be an array of 1-50/],
      [{ entries: Array.from({ length: 51 }, () => entry()) }, /entries must be an array of 1-50/],
      [{ entries: [entry()], extra: 1 }, /unknown field 'extra'/],
      [{ entries: ["text"] }, /entries\[0\] must be an object/],
      [{ entries: [entry(), entry({ id: "A".repeat(64) })] }, /entries\[1\]\.id must be 64 lowercase hex/],
      [{ entries: [entry({ id: "a".repeat(63) })] }, /entries\[0\]\.id must be 64 lowercase hex/],
      [{ entries: [entry({ session_id: "" })] }, /entries\[0\]\.session_id must not be empty/],
      [{ entries: [entry({ session_id: "s".repeat(129) })] }, /entries\[0\]\.session_id must be at most 128/],
      [{ entries: [entry({ client: "cursor" })] }, /entries\[0\]\.client must be one of: claude-code, codex/],
      [{ entries: [entry({ repo: "r".repeat(201) })] }, /entries\[0\]\.repo must be at most 200/],
      [{ entries: [entry({ repo: 7 })] }, /entries\[0\]\.repo must be a string/],
      [{ entries: [entry({ ts: "2026-10-31" })] }, /entries\[0\]\.ts must be a finite epoch-millisecond number/],
      [{ entries: [entry({ ts: Number.NaN })] }, /entries\[0\]\.ts must be a finite/],
      [{ entries: [entry({ ts: -1 })] }, /entries\[0\]\.ts must be a finite/],
      [{ entries: [entry({ kind: "summary" })] }, /entries\[0\]\.kind must be one of: prompt, reply, action, error/],
      [{ entries: [entry({ text: null })] }, /entries\[0\]\.text must be a string/],
      [{ entries: [entry({ cwd: "/tmp" })] }, /entries\[0\]: unknown field 'cwd'/],
    ];
    for (const [args, message] of cases) {
      await expect(services.logs.append(u, args)).rejects.toThrow(message);
      await expect(services.logs.append(u, args)).rejects.toBeInstanceOf(LogInputError);
    }
    // A bad entry anywhere rejects the whole batch.
    await expect(services.logs.append(u, { entries: [entry(), entry(), entry({ kind: "x" })] })).rejects.toThrow(/entries\[2\]/);
    expect(await count(u.userId)).toBe(before);
    // An omitted repo and an empty text are valid.
    const { repo: _omitted, ...noRepo } = entry({ ts: Date.now() + 3500000 });
    expect(await services.logs.append(u, { entries: [noRepo, entry({ text: "" })] })).toEqual(res(2, 0, 0));
    expect((await logsDb.prepare("SELECT repo FROM log_entries WHERE id=?").bind(noRepo.id).first<{ repo: string }>())?.repo).toBe("");
  });

  it("is idempotent per (user, id): resends and in-batch repeats count as duplicates", async () => {
    const u = user("log-idem");
    const batch = [entry({ text: "first" }), entry({ text: "second" })];
    expect(await services.logs.append(u, { entries: batch })).toEqual(res(2, 0, 0));
    expect(await services.logs.append(u, { entries: [...batch, entry({ text: "third" })] })).toEqual(res(1, 2, 0));
    const repeated = entry({ text: "twice in one batch" });
    expect(await services.logs.append(u, { entries: [repeated, { ...repeated, text: "changed" }] })).toEqual(res(1, 1, 0));
    expect((await logsDb.prepare("SELECT text FROM log_entries WHERE user_id=? AND id=?").bind(u.userId, repeated.id).first<{ text: string }>())?.text).toBe("twice in one batch");
    expect(await count(u.userId)).toBe(4);
    // The same client id under another user is a different row.
    expect(await services.logs.append(user("log-idem-other"), { entries: [batch[0]] })).toEqual(res(1, 0, 0));
  });

  it("cuts text over the per-kind limit, ending with the marker, without splitting a surrogate pair", async () => {
    const u = user("log-cut");
    const rows = [
      entry({ kind: "prompt", text: "p".repeat(70000) }),
      entry({ kind: "reply", text: "a".repeat(65528) + "😀".repeat(10) }),
      entry({ kind: "action", text: "Bash: " + "x".repeat(600) }),
      entry({ kind: "error", text: "Bash: make → 失敗\n" + "e".repeat(3000) }),
      entry({ kind: "action", text: "Read src/logs.ts" }),
    ];
    await services.logs.append(u, { entries: rows });
    const stored = await logsDb.prepare("SELECT id, kind, text, bytes FROM log_entries WHERE user_id=?").bind(u.userId).all<{ id: string; kind: string; text: string; bytes: number }>();
    const byId = new Map(stored.results.map(r => [r.id, r]));
    const [prompt, reply, action, error, short] = rows.map(r => byId.get(r.id)!);
    expect(prompt.text).toHaveLength(65536); expect(prompt.text.endsWith(CUT_MARK)).toBe(true);
    expect(reply.text.length).toBeLessThanOrEqual(65536); expect(reply.text.endsWith(CUT_MARK)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(reply.text)).toBe(false);
    expect(action.text).toHaveLength(400); expect(action.text.endsWith(CUT_MARK)).toBe(true);
    expect(error.text).toHaveLength(2048); expect(error.text.startsWith("Bash: make → 失敗")).toBe(true);
    expect(short.text).toBe("Read src/logs.ts");
    // bytes is the UTF-8 size of the stored (cut) text.
    expect(error.bytes).toBe(new TextEncoder().encode(error.text).byteLength);
  });

  it("scrubs the full text with the Agent's log scrubber, including prose secrets, before cutting", async () => {
    const u = user("log-scrub-full");
    const prose = entry({ kind: "prompt", text: "DBのパスワードはFake1234です。password is hunter22" });
    // A secret far beyond the old 1,024-character scrub window still goes through the same scrub-then-cut path.
    const long = entry({ kind: "reply", text: "r".repeat(70000) + " token sk-ant-" + "B".repeat(30) });
    // Scrubbing can shorten an over-limit input below the limit: the cut marker is still added.
    const shrunk = entry({ kind: "action", text: "Bash: curl -H 'x-api-key: sk-ant-" + "a".repeat(420) + "'" });
    await services.logs.append(u, { entries: [prose, long, shrunk] });
    const stored = async (id: string) => (await logsDb.prepare("SELECT text FROM log_entries WHERE id=?").bind(id).first<{ text: string }>())!.text;
    const p = await stored(prose.id);
    expect(p).not.toContain("Fake1234"); expect(p).not.toContain("hunter22"); expect(p).toContain("[REDACTED]");
    expect(await stored(long.id)).toBe(cutText(scrubEntryText(long.text), 65536, true).text);
    const a = await stored(shrunk.id);
    expect(a.length).toBeLessThan(400); expect(a.endsWith(CUT_MARK)).toBe(true); expect(a).not.toContain("aaaaaaaa");
    // Input exactly at the limit (the Agent already cut it) gets no second marker.
    const exact = entry({ kind: "action", text: "x".repeat(393) + CUT_MARK });
    await services.logs.append(u, { entries: [exact] });
    expect(await stored(exact.id)).toBe(exact.text);
  });

  it("stores a ts more than 1 hour ahead as the receipt time and counts it", async () => {
    const u = user("log-clamp"), svc = new LogService(logsDb, logSettings(), () => NOW);
    const fast = entry({ ts: NOW + 3 * 3600000, text: "fast clock" }), edge = entry({ ts: NOW + 3600000, text: "within an hour" });
    expect(await svc.append(u, { entries: [fast, edge] })).toEqual(res(2, 0, 0, { ts_clamped: 1 }));
    const ts = async (id: string) => (await logsDb.prepare("SELECT ts FROM log_entries WHERE id=?").bind(id).first<{ ts: number }>())!.ts;
    expect(await ts(fast.id)).toBe(NOW);
    expect(await ts(edge.id)).toBe(NOW + 3600000);
    // A resend is a duplicate, not another clamp.
    expect(await svc.append(u, { entries: [fast] })).toEqual(res(0, 1, 0));
  });

  it("scrubs secrets again on the server", async () => {
    const u = user("log-scrub");
    const e = entry({ kind: "action", text: "Bash: export API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123 && curl -H 'Authorization: Bearer abc.def'" });
    await services.logs.append(u, { entries: [e] });
    const text = (await logsDb.prepare("SELECT text FROM log_entries WHERE id=?").bind(e.id).first<{ text: string }>())!.text;
    expect(text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toContain("abc.def");
    expect(text).toContain("[REDACTED");
  });
});

describe("daily action byte cap", () => {
  const capped = (clock = () => NOW) => new LogService(logsDb, { dailyActionBytes: 1000, actionRetentionDays: 90 }, clock);
  const action = (bytes: number, over: Record<string, unknown> = {}) => entry({ kind: "action", text: "a".repeat(bytes), ...over });

  it("drops actions over the cap and counts them; prompt, reply and error are always kept", async () => {
    const u = user("log-cap"), svc = capped();
    expect(await svc.append(u, { entries: [action(400), action(400)] })).toEqual(res(2, 0, 0));
    const third = action(400);
    expect(await svc.append(u, { entries: [third, action(200), entry({ kind: "prompt", text: "p".repeat(5000) }), entry({ kind: "reply", text: "r".repeat(5000) }), entry({ kind: "error", text: "e".repeat(2000) })] }))
      .toEqual(res(4, 0, 1)); // 400 over, 200 fits exactly
    expect(await daily(u.userId)).toEqual({ action_bytes: 1000, dropped: 1 });
    // Resending a dropped action is dropped (and counted) again; resending a stored one is a duplicate and costs nothing.
    expect(await svc.append(u, { entries: [third] })).toEqual(res(0, 0, 1));
    expect(await daily(u.userId)).toEqual({ action_bytes: 1000, dropped: 2 });
    expect((await svc.status(u)).today_action_bytes).toBe(1000);
    // Another user has their own budget; the next UTC day starts at zero.
    expect(await svc.append(user("log-cap-other"), { entries: [action(400), action(400)] })).toEqual(res(2, 0, 0));
    expect(await capped(() => NOW + DAY).append(u, { entries: [action(400), action(400)] })).toEqual(res(2, 0, 0));
    expect(await daily(u.userId, utcDay(NOW + DAY))).toEqual({ action_bytes: 800, dropped: 0 });
  });

  it("a daily total byte cap across all kinds drops any kind over it, beside the action cap", async () => {
    const u = user("log-total"), svc = new LogService(logsDb, { dailyActionBytes: 1000, dailyTotalBytes: 2500, actionRetentionDays: 90 }, () => NOW);
    const prompt = (bytes: number) => entry({ kind: "prompt", text: "p".repeat(bytes) });
    expect(await svc.append(u, { entries: [prompt(1000), action(400), prompt(1000)] })).toEqual(res(3, 0, 0)); // 2400 bytes
    const reply = entry({ kind: "reply", text: "r".repeat(200) });
    // The action fits its own cap (800 ≤ 1000) but not the total (2,800 > 2,500); the reply does not fit either.
    expect(await svc.append(u, { entries: [action(400), reply, entry({ kind: "error", text: "e".repeat(50) })] })).toEqual(res(1, 0, 0, { dropped_over_total_cap: 2 }));
    expect(await totals(u.userId)).toEqual({ total_bytes: 2450, total_dropped: 2 });
    expect(await daily(u.userId)).toEqual({ action_bytes: 400, dropped: 0 });
    // Over the action cap counts as dropped_over_cap only.
    expect(await svc.append(u, { entries: [action(400), action(400)] })).toEqual(res(0, 0, 0, { dropped_over_total_cap: 2 }));
    const actions = new LogService(logsDb, { dailyActionBytes: 400, dailyTotalBytes: 10000, actionRetentionDays: 90 }, () => NOW);
    const v = user("log-total-action");
    expect(await actions.append(v, { entries: [action(400), action(400), prompt(100)] })).toEqual(res(2, 0, 1));
    const status = await svc.status(u);
    expect(status).toMatchObject({ today_total_bytes: 2450, daily_total_limit: 2500 });
    // The environment var sets it; no limit by default (2026-11-05).
    expect(logSettings({ LOG_DAILY_TOTAL_BYTES: "1234" }).dailyTotalBytes).toBe(1234);
    expect(logSettings().dailyTotalBytes).toBeNull();
  });

  it("counts UTF-8 bytes, and a cap of 0 drops every action", async () => {
    const u = user("log-cap-bytes"), svc = capped();
    // 334 × 3-byte chars = 1002 bytes > 1000, even though it is only 334 chars.
    expect(await svc.append(u, { entries: [entry({ kind: "action", text: "認".repeat(334) })] })).toMatchObject({ stored: 0, dropped_over_cap: 1 });
    const none = new LogService(logsDb, { dailyActionBytes: 0, actionRetentionDays: 90 });
    expect(await none.append(user("log-cap-zero"), { entries: [action(1), entry()] })).toEqual(res(1, 0, 1));
  });

  it("without the environment vars there is no daily limit: nothing is dropped and status says null", async () => {
    const u = user("log-nocap"), svc = new LogService(logsDb, logSettings(), () => NOW);
    expect(logSettings()).toEqual({ dailyActionBytes: null, dailyTotalBytes: null, actionRetentionDays: 90 });
    const big = Array.from({ length: 5 }, () => entry({ kind: "action", text: "a".repeat(400) }));
    expect(await svc.append(u, { entries: [...big, entry({ kind: "reply", text: "r".repeat(60000) })] })).toEqual(res(6, 0, 0));
    expect(await totals(u.userId)).toEqual({ total_bytes: 62000, total_dropped: 0 });
    expect(await svc.status(u)).toMatchObject({ daily_action_limit: null, daily_total_limit: null, today_action_bytes: 2000, today_total_bytes: 62000 });
  });

  // Sixteen writers race on purpose and each gives up after 12 attempts, so on a
  // slow machine one of them can lose every round. The run is repeated then.
  it("many concurrent appends of one user all succeed through jittered retries", { retry: 3 }, async () => {
    const u = user("log-race-many-" + Math.random().toString(36).slice(2)), svc = new LogService(logsDb, logSettings(), () => NOW);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => svc.append(u, { entries: [entry({ text: "race " + i }), entry({ kind: "action", text: "Bash: echo " + i })] })));
    expect(results.every(r => r.stored === 2)).toBe(true);
    const sum = await logsDb.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM log_entries WHERE user_id=?").bind(u.userId).first<{ bytes: number }>();
    expect((await totals(u.userId))!.total_bytes).toBe(sum!.bytes);
  });

  it("concurrent appends never exceed the cap and keep the counter exact", async () => {
    const u = user("log-cap-race"), svc = capped();
    const batches = Array.from({ length: 6 }, () => ({ entries: [action(100), action(100), action(100), entry()] }));
    const results = await Promise.all(batches.map(b => svc.append(u, b)));
    const stored = await logsDb.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes, count(*) AS n FROM log_entries WHERE user_id=? AND kind='action'").bind(u.userId).first<{ bytes: number; n: number }>();
    expect(stored!.bytes).toBeLessThanOrEqual(1000);
    expect(stored!.bytes).toBe(1000); // 18 × 100 bytes offered, exactly 10 fit
    expect(await daily(u.userId)).toEqual({ action_bytes: stored!.bytes, dropped: 8 });
    expect(results.reduce((n, r) => n + r.dropped_over_cap, 0)).toBe(8);
    expect(results.reduce((n, r) => n + r.stored, 0)).toBe(10 + 6);
  });
});

describe("log_search", () => {
  const u = user("log-search");
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const add = async (name: string, over: Record<string, unknown>) => { const e = entry(over); ids[name] = e.id; await services.logs.append(u, { entries: [e] }); };
    await add("older-dense", { ts: NOW - 50000, text: "vectorize vectorize vectorize removal plan" });
    await add("sparse", { ts: NOW - 40000, kind: "reply", text: "we talked about vectorize once, then about many other unrelated topics for a long while" });
    await add("newer-dense", { ts: NOW - 30000, text: "vectorize vectorize vectorize removal plan" });
    await add("codex", { ts: NOW - 20000, client: "codex", repo: "acme/tasks", session_id: "sess-codex", kind: "action", text: "Bash: wrangler deploy migration" });
    await add("error", { ts: NOW - 10000, kind: "error", session_id: "sess-err", text: "Bash: npm test → 失敗\nmigration failed: D1_ERROR" });
    await add("old", { ts: Date.parse("2026-01-15T00:00:00Z"), text: "migration plan from january" });
    await add("db", { ts: NOW - 9000, text: "DB を移行した" });
    await add("db-only", { ts: NOW - 8000, text: "DB だけの話" });
    await add("japanese", { ts: NOW - 7000, kind: "reply", text: "認証エラーの原因はトークン切れでした" });
    await add("time", { ts: Date.UTC(2026, 9, 28, 14, 46, 30), text: "timestamp probe" });
    await services.logs.append(bob, { entries: [entry({ text: "vectorize secret of bob", ts: NOW - 1000 })] });
  });

  it("ranks by bm25, then newest, and returns the hit shape", async () => {
    const { hits } = await rpc("log_search", { query: "vectorize" }, u);
    expect(hits.map((h: any) => h.id)).toEqual([ids["newer-dense"], ids["older-dense"], ids["sparse"]]);
    expect(Object.keys(hits[0]).sort()).toEqual(["client", "id", "kind", "repo", "session_id", "snippet", "time", "ts"]);
    expect(hits[0]).toMatchObject({ client: "claude-code", repo: "acme/cf-memory", kind: "prompt", session_id: "sess-default", snippet: "vectorize vectorize vectorize removal plan" });
    const probe = (await rpc("log_search", { query: "timestamp" }, u)).hits[0];
    expect(probe.time).toBe("2026-10-28 23:46 JST");
    expect(jstTime(Date.UTC(2026, 11, 31, 15, 0))).toBe("2027-01-01 00:00 JST");
  });

  it("is owner-only", async () => {
    expect((await rpc("log_search", { query: "vectorize" }, bob)).hits).toHaveLength(1);
    expect((await rpc("log_search", { query: "vectorize" }, u)).hits.every((h: any) => h.id !== undefined && !h.snippet.includes("bob"))).toBe(true);
    expect((await rpc("log_search", { query: "secret" }, u)).hits).toEqual([]);
  });

  it("applies since/until, repo substring, kind, client, session_id and limit", async () => {
    const q = (args: Record<string, unknown>) => rpc("log_search", { query: "migration", ...args }, u).then(r => r.hits.map((h: any) => h.id).sort());
    expect(await q({})).toEqual([ids.codex, ids.error, ids.old].sort());
    expect(await q({ since: new Date(NOW - 30000).toISOString() })).toEqual([ids.codex, ids.error].sort());
    expect(await q({ since: String(NOW - 30000), until: NOW - 15000 })).toEqual([ids.codex]);
    expect(await q({ until: "2026-02-01" })).toEqual([ids.old]);
    expect(await q({ repo: "tasks" })).toEqual([ids.codex]);
    expect(await q({ repo: "cme/cf-mem" })).toEqual([ids.error, ids.old].sort());
    expect(await q({ kind: "error" })).toEqual([ids.error]);
    expect(await q({ client: "codex" })).toEqual([ids.codex]);
    expect(await q({ session_id: "sess-err" })).toEqual([ids.error]);
    expect(await q({ limit: 1 })).toHaveLength(1);
    expect((await rpc("log_search", { query: "a" }, u)).hits.length).toBeLessThanOrEqual(10); // default 10
    expect((await rpc("log_search", { query: "a", limit: 500 }, u)).hits.length).toBeLessThanOrEqual(20);
  });

  it("matches Japanese terms of 3+ characters through the trigram index, with a snippet around the term", async () => {
    const { hits } = await rpc("log_search", { query: "認証エラー" }, u);
    expect(hits.map((h: any) => h.id)).toEqual([ids.japanese]);
    const long = entry({ text: "x".repeat(2000) + " needle-in-the-middle " + "y".repeat(2000) });
    await services.logs.append(u, { entries: [long] });
    const snippet = (await rpc("log_search", { query: "needle" }, u)).hits[0].snippet as string;
    expect(snippet.length).toBeLessThanOrEqual(242);
    expect(snippet).toContain("needle-in-the-middle");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("falls back to LIKE for 1–2 character queries and for queries of only 1–2 character words", async () => {
    expect((await rpc("log_search", { query: "DB" }, u)).hits.map((h: any) => h.id)).toEqual([ids["db-only"], ids.db]); // newest first
    expect((await rpc("log_search", { query: "db" }, u)).hits).toHaveLength(2); // ASCII case-insensitive
    expect((await rpc("log_search", { query: "DB 移行" }, u)).hits.map((h: any) => h.id)).toEqual([ids.db]); // every word must appear
    expect((await rpc("log_search", { query: "移" }, u)).hits.map((h: any) => h.id)).toEqual([ids.db]);
    // The fallback keeps the filters and the owner boundary.
    expect((await rpc("log_search", { query: "DB", until: NOW - 8500 }, u)).hits.map((h: any) => h.id)).toEqual([ids.db]);
    expect((await rpc("log_search", { query: "DB" }, bob)).hits).toEqual([]);
    // A query with any 3+ character word stays on FTS; its 1–2 character words only rank (none of these contain "DB").
    const mixed = await rpc("log_search", { query: "DB migration" }, u);
    expect(mixed.hits.map((h: any) => h.id).sort()).toEqual([ids.codex, ids.error, ids.old].sort());
    expect(mixed.query_terms_dropped).toBeUndefined();
    // LIKE wildcards are literal.
    expect((await rpc("log_search", { query: "%" }, u)).hits).toEqual([]);
  });

  it("matches full-width and other non-ASCII words exactly in the LIKE fallback (no lowercasing)", async () => {
    const v = user("log-search-width");
    const full = entry({ text: "ＤＢを移行した" }), ascii = entry({ text: "DB を移行した", ts: NOW - 50000 }), lower = entry({ text: "db だけ", ts: NOW - 40000 }), umlaut = entry({ text: "Äb の件" });
    await services.logs.append(v, { entries: [full, ascii, lower, umlaut] });
    const ids = async (query: string) => (await rpc("log_search", { query }, v)).hits.map((h: any) => h.id).sort();
    expect(await ids("ＤＢ")).toEqual([full.id]);
    expect(await ids("ｄｂ")).toEqual([]); // full-width case is not folded
    expect(await ids("Db")).toEqual([ascii.id, lower.id].sort()); // ASCII case folds in SQLite LIKE
    expect(await ids("Äb")).toEqual([umlaut.id]);
    expect(await ids("äb")).toEqual([]);
  });

  it(`sends at most ${MAX_FTS_TERMS} distinct 3+ character words to MATCH and lists the rest`, async () => {
    const v = user("log-search-terms");
    const words = Array.from({ length: 15 }, (_, i) => "term" + String.fromCharCode(97 + i) + "zz");
    const late = entry({ text: "only " + words[14] }), early = entry({ text: "only " + words[0] });
    await services.logs.append(v, { entries: [late, early] });
    const r = await rpc("log_search", { query: words.join(" ") + " ab" }, v);
    expect(r.hits.map((h: any) => h.id)).toEqual([early.id]);
    expect(r.query_terms_dropped).toEqual(words.slice(12)); // "ab" ranks instead of being dropped
    expect((await rpc("log_search", { query: words.slice(0, 12).join(" ") }, v)).query_terms_dropped).toBeUndefined();
    // Repeated words count once.
    expect((await rpc("log_search", { query: Array(20).fill(words[0]).join(" ") }, v)).query_terms_dropped).toBeUndefined();
  });

  it("rejects invalid arguments", async () => {
    for (const [args, message] of [
      [{}, /query must be a non-empty string/],
      [{ query: "  " }, /query must be a non-empty string/],
      [{ query: "x", since: "not a date" }, /since must be an ISO date\/time, a JST time like "2026-10-28 23:46 JST", or epoch milliseconds/],
      [{ query: "x", since: "2026-02-30" }, /since must be an ISO date\/time/],
      [{ query: "x", until: "2026-10-28 24:00 JST" }, /until must be an ISO date\/time/],
      [{ query: "x", since: NOW, until: NOW }, /since must be before until/],
      [{ query: "x", kind: "summary" }, /kind must be one of/],
      [{ query: "x", client: "cursor" }, /client must be one of/],
      [{ query: "x", limit: "5" }, /limit must be a number/],
      [{ query: "x", mode: "semantic" }, /unknown field 'mode'/],
    ] as Array<[Record<string, unknown>, RegExp]>) await expect(services.logs.search(u, args)).rejects.toThrow(message);
  });
});

describe("log_read", () => {
  const u = user("log-read");
  const session: string[] = [];
  beforeAll(async () => {
    const rows = Array.from({ length: 10 }, (_, i) => entry({ session_id: "read-main", ts: NOW - 100000 + i * 1000, kind: i % 2 ? "reply" : "prompt", text: `turn ${i}` }));
    rows[7].text = "L".repeat(20000);
    session.push(...rows.map(r => r.id));
    // Same ts as turn 4 but inserted later: ordered after it by rowid.
    const tie = entry({ session_id: "read-main", ts: NOW - 100000 + 4000, text: "turn 4b" });
    rows.splice(5, 0, tie); session.splice(5, 0, tie.id);
    await services.logs.append(u, { entries: rows });
    // Another session interleaved in time must not appear.
    await services.logs.append(u, { entries: Array.from({ length: 5 }, (_, i) => entry({ session_id: "read-other", ts: NOW - 100000 + i * 1000 + 500, text: `other ${i}` })) });
  });

  it("returns the entry and its neighbours in the same session, oldest first", async () => {
    const r = await rpc("log_read", { id: session[5], before: 2, after: 3 }, u);
    expect(r).toMatchObject({ found: true, id: session[5], session_id: "read-main" });
    expect(r.entries.map((e: any) => e.id)).toEqual(session.slice(3, 9));
    expect(r.entries.map((e: any) => e.text.slice(0, 10))).toEqual(["turn 3", "turn 4", "turn 4b", "turn 5", "turn 6", "L".repeat(10)]);
    expect(r.entries.filter((e: any) => e.anchor).map((e: any) => e.id)).toEqual([session[5]]);
    expect(Object.keys(r.entries[0]).sort()).toEqual(["anchor", "chars", "client", "id", "kind", "repo", "text", "time", "truncated", "ts"]);
  });

  it("defaults to 3 each way, clamps to 10, and cuts each text at 8,000 chars", async () => {
    expect((await rpc("log_read", { id: session[5] }, u)).entries.map((e: any) => e.id)).toEqual(session.slice(2, 9));
    expect((await rpc("log_read", { id: session[0], before: 50, after: 50 }, u)).entries).toHaveLength(11);
    expect((await rpc("log_read", { id: session[0], before: 0, after: 0 }, u)).entries.map((e: any) => e.id)).toEqual([session[0]]);
    const long = (await rpc("log_read", { id: session[8], before: 0, after: 0 }, u)).entries[0];
    expect(long).toMatchObject({ chars: 20000, truncated: true, next_offset: 8000 - CUT_MARK.length });
    expect(long.text).toHaveLength(8000); expect(long.text.endsWith(CUT_MARK)).toBe(true);
    // A cut neighbour carries its own next_offset (to read it as the anchor).
    expect((await rpc("log_read", { id: session[7], before: 0, after: 1 }, u)).entries[1]).toMatchObject({ id: session[8], truncated: true, next_offset: 7993 });
  });

  it("is owner-only and validates the id", async () => {
    expect(await rpc("log_read", { id: session[5] }, bob)).toEqual({ found: false, id: session[5], entries: [] });
    expect(await rpc("log_read", { id: hex(999999) }, u)).toEqual({ found: false, id: hex(999999), entries: [] });
    await expect(rpc("log_read", { id: "nope" }, u)).rejects.toThrow(/id must be 64 lowercase hex/);
    await expect(rpc("log_read", { id: session[5], before: "2" }, u)).rejects.toThrow(/before must be a number/);
  });
});

describe("log_sessions", () => {
  const u = user("log-sessions");
  beforeAll(async () => {
    await services.logs.append(u, { entries: [
      entry({ session_id: "s-old", ts: NOW - 900000, text: "first question in old session" }),
      entry({ session_id: "s-old", ts: NOW - 800000, kind: "action", text: "Read README.md" }),
      entry({ session_id: "s-old", ts: NOW - 700000, kind: "reply", text: "old answer" }),
      entry({ session_id: "s-new", ts: NOW - 500000, client: "codex", repo: "acme/tasks", kind: "action", text: "Bash: ls" }),
      entry({ session_id: "s-new", ts: NOW - 400000, client: "codex", repo: "acme/tasks", text: "  second   session\nprompt  " }),
      entry({ session_id: "s-new", ts: NOW - 300000, client: "codex", repo: "acme/tasks", kind: "reply", text: "R".repeat(1000) }),
      entry({ session_id: "s-new", ts: NOW - 200000, client: "codex", repo: "acme/tasks", kind: "reply", text: "final reply" }),
      entry({ session_id: "s-noreply", ts: NOW - 100000, text: "no reply yet" }),
    ] });
  });

  it("lists recent sessions newest first with times, first prompt and last reply", async () => {
    const { sessions } = await rpc("log_sessions", {}, u);
    expect(sessions.map((s: any) => s.session_id)).toEqual(["s-noreply", "s-new", "s-old"]);
    expect(sessions[1]).toEqual({ session_id: "s-new", client: "codex", repo: "acme/tasks", first_time: jstTime(NOW - 500000), last_time: jstTime(NOW - 200000),
      first_prompt: "second session prompt", last_reply: "final reply" });
    expect(sessions[0]).toMatchObject({ first_prompt: "no reply yet", last_reply: null });
    expect(sessions[2]).toMatchObject({ client: "claude-code", repo: "acme/cf-memory", first_prompt: "first question in old session", last_reply: "old answer" });
  });

  it("filters by repo substring and client, bounds snippets to 300 chars, and is owner-only", async () => {
    expect((await rpc("log_sessions", { client: "codex" }, u)).sessions.map((s: any) => s.session_id)).toEqual(["s-new"]);
    expect((await rpc("log_sessions", { repo: "cf-memory" }, u)).sessions.map((s: any) => s.session_id)).toEqual(["s-noreply", "s-old"]);
    expect((await rpc("log_sessions", { limit: 1 }, u)).sessions).toHaveLength(1);
    const svc = new LogService(logsDb);
    await svc.append(u, { entries: [entry({ session_id: "s-long", ts: NOW - 50000, kind: "reply", text: "Z".repeat(1000) })] });
    const long = (await svc.sessions(u, { limit: 1 })).sessions[0];
    expect(long.last_reply).toHaveLength(300); expect(long.last_reply!.endsWith("…")).toBe(true);
    expect((await rpc("log_sessions", {}, user("log-sessions-nobody"))).sessions).toEqual([]);
    await expect(rpc("log_sessions", { client: "cursor" }, u)).rejects.toThrow(/client must be one of/);
    await expect(rpc("log_sessions", { since: 1 }, u)).rejects.toThrow(/unknown field 'since'/);
  });
});

describe("session_context", () => {
  const u = user("log-ctx");
  beforeAll(async () => {
    await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(u.userId, u.handle, u.handle).run();
    await services.memory.setBlock(u, "persona", "set", "Prefers keyword search over vectors.");
    await services.memory.setBlock(u, "conventions", "set", "Short commits.");
    await services.logs.append(u, { entries: [
      entry({ session_id: "ctx-a", repo: "acme/cf-memory", ts: NOW - 300000, kind: "reply", text: "Session A finished the logs migration." }),
      entry({ session_id: "ctx-a", repo: "acme/cf-memory", ts: NOW - 290000, kind: "action", text: "Bash: git commit" }),
      entry({ session_id: "ctx-b", repo: "acme/cf-memory", ts: NOW - 200000, kind: "reply", text: "H".repeat(5000) }),
      entry({ session_id: "ctx-c", repo: "acme/tasks", ts: NOW - 100000, kind: "reply", text: "other repo reply" }),
    ] });
    await services.logs.append(bob, { entries: [entry({ session_id: "ctx-bob", repo: "acme/cf-memory", ts: NOW - 1000, kind: "reply", text: "bob's reply" })] });
  });

  it("returns core memory rendered like recall's working tier", async () => {
    const r = await rpc("session_context", { repo: "acme/cf-memory", session_id: "ctx-z" }, u);
    const blocks = await services.memory.listBlocks(u);
    expect(r.core_memory).toBe(renderTiers([workingTier(blocks)]));
    expect(r.core_memory).toBe("## Working memory (core blocks)\n### block:conventions ([[conventions]])\nShort commits.\n### block:persona ([[persona]])\nPrefers keyword search over vectors.");
    expect(Object.keys(r).sort()).toEqual(["core_memory", "handoff"]);
    // The same lines recall's pack text renders for the working tier.
    expect((await services.recall.recall(u, "", 4000)).text).toContain(r.core_memory);
  });

  it("returns an empty core_memory string when there are no blocks", async () => {
    expect(await rpc("session_context", { repo: "acme/none" }, user("log-ctx-empty"))).toEqual({ core_memory: "", handoff: null });
  });

  it("hands off the latest reply in the same repo from a different session, cut to 4,000 chars", async () => {
    const latest = (await rpc("session_context", { repo: "acme/cf-memory", session_id: "ctx-z" }, u)).handoff;
    expect(latest).toMatchObject({ session_id: "ctx-b", time: jstTime(NOW - 200000) });
    expect(latest.text).toHaveLength(4000); expect(latest.text.endsWith(CUT_MARK)).toBe(true);
    expect(Object.keys(latest).sort()).toEqual(["session_id", "text", "time"]);
    // The current session is excluded, and actions are never a handoff.
    expect((await rpc("session_context", { repo: "acme/cf-memory", session_id: "ctx-b" }, u)).handoff).toEqual({ session_id: "ctx-a", time: jstTime(NOW - 300000), text: "Session A finished the logs migration." });
    expect((await rpc("session_context", { repo: "acme/tasks", session_id: "ctx-c" }, u)).handoff).toBeNull();
    expect((await rpc("session_context", { repo: "acme/none" }, u)).handoff).toBeNull();
    expect((await rpc("session_context", {}, u)).handoff).toBeNull(); // no repo: nothing to hand off from
    // Owner-only: Bob sees his own reply, never Alice's.
    expect((await rpc("session_context", { repo: "acme/cf-memory" }, bob)).handoff).toMatchObject({ session_id: "ctx-bob", text: "bob's reply" });
    await expect(rpc("session_context", { repo: 3 }, u)).rejects.toThrow(/repo must be a string/);
    await expect(rpc("session_context", { cwd: "/tmp" }, u)).rejects.toThrow(/unknown field 'cwd'/);
  });

  it("still returns core memory when the log database is not configured", async () => {
    const bare = makeServices(db);
    const r = await rpc("session_context", { repo: "acme/cf-memory", session_id: "x" }, u, bare);
    expect(r).toEqual({ core_memory: expect.any(String), handoff: null });
    expect(r.core_memory).toContain("Prefers keyword search");
    await expect(rpc("log_search", { query: "x" }, u, bare)).rejects.toThrow(/logs database is not configured/);
    await expect(rpc("log_append", { entries: [entry()] }, u, bare)).rejects.toThrow(/logs database is not configured/);
  });
});

describe("MCP registration and scopes", () => {
  it("lists the five tools with agent-facing search guidance", async () => {
    const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), { principal: alice, services, budget: 4000 });
    const tools = ((await res.json()) as any).result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    const byName = new Map(tools.map(t => [t.name, t]));
    for (const name of ["log_append", "log_search", "log_read", "log_sessions", "session_context"]) expect(byName.has(name), name).toBe(true);
    expect(byName.get("log_search")!.description).toMatch(/SHORT words separated by spaces/);
    expect(byName.get("log_search")!.description).toMatch(/SEVERAL queries/);
    expect(byName.get("log_search")!.inputSchema.required).toEqual(["query"]);
    expect(byName.get("log_append")!.inputSchema.properties.entries.maxItems).toBe(50);
    expect(byName.get("notes_search")!.description).toMatch(/no semantic\/vector search/);
  });

  it(`allows at most ${MAX_LOG_CALLS_PER_REQUEST} log tool calls per HTTP request (a JSON-RPC batch)`, async () => {
    const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const batch = [
      ...Array.from({ length: 11 }, (_, i) => call(i + 1, i % 2 ? "log_search" : "log_sessions", i % 2 ? { query: "anything" } : {})),
      call(12, "whoami", {}), call(13, "session_context", {}),
    ];
    const res = await handleMcp(new Request("https://memory.test/mcp", { method: "POST", body: JSON.stringify(batch) }), { principal: alice, services, budget: 4000 });
    const out = (await res.json()) as any[];
    const byId = new Map(out.map(r => [r.id, r.result]));
    for (let id = 1; id <= 10; id++) expect(byId.get(id).isError, String(id)).toBeUndefined();
    for (const id of [11, 13]) {
      expect(byId.get(id).isError).toBe(true);
      expect(byId.get(id).content[0].text).toMatch(/at most 10 log_\* \/ session_context calls per HTTP request/);
    }
    expect(byId.get(12).isError).toBeUndefined(); // other tools are not counted
    // The next request starts a new allowance.
    expect((await rpc("log_sessions", {}, alice)).sessions).toBeDefined();
  });

  it("log_append needs notes:write; the read tools need notes:read; invalid tokens are refused", async () => {
    const reader = user("log-alice", new Set(["notes:read"])), writer = user("log-alice", new Set(["notes:write"]));
    await expect(rpc("log_append", { entries: [entry()] }, reader)).rejects.toThrow(/Forbidden: missing scope 'notes:write'/);
    expect(await rpc("log_append", { entries: [entry({ text: "via writer" })] }, writer)).toEqual(res(1, 0, 0));
    for (const [name, args] of [["log_search", { query: "writer" }], ["log_read", { id: hex(1) }], ["log_sessions", {}], ["session_context", {}]] as const) {
      await expect(rpc(name, args, writer)).rejects.toThrow(/Forbidden: missing scope 'notes:read'/);
      await expect(rpc(name, args, principalFixture({ anonymous: true, invalidKey: true, userId: "anonymous", scopes: new Set() }))).rejects.toThrow(/Unauthorized/);
    }
    expect((await rpc("log_search", { query: "writer" }, reader)).hits.length).toBeGreaterThan(0);
    // The service itself refuses an anonymous caller even if a door forgot to.
    await expect(services.logs.search(principalFixture({ anonymous: true, userId: "anonymous" }), { query: "x" })).rejects.toThrow(/authentication required/);
  });
});

describe("server_status.logs", () => {
  it("reports the caller's entry counts and reserves the whole database size for the instance owner", async () => {
    const u = user("log-status");
    await services.logs.append(u, { entries: [entry({ kind: "action", text: "a".repeat(120) }), entry()] });
    const ownerServices = makeServices(db, null, { LOGS: logsDb, OWNER_HANDLE: u.handle } as unknown as Env);
    const status = await rpc("server_status", {}, u, ownerServices);
    expect(status.logs).toEqual({ configured: true, daily_action_limit: null, daily_total_limit: null, action_retention_days: 90,
      size_bytes: expect.any(Number), entries: 2, today_action_bytes: 120, today_total_bytes: 125 });
    expect(status.logs.size_bytes).toBeGreaterThan(0);
    expect((await rpc("server_status", {}, u)).logs).toEqual({ ...status.logs, size_bytes: null });
    for (const removed of ["embedding_provider", "embedding_model", "embedding_jobs", "queue", "async_embedding", "vectorize_processing"]) expect(status).not.toHaveProperty(removed);
    // Installed 0.2.x doctors pass vectorize_processing only for 'disabled' or 'configured' (until phase 5).
    expect(status.vectorize).toBe("disabled");
    expect((await rpc("server_status", {}, u, makeServices(db))).logs).toEqual({ configured: false, daily_action_limit: null, daily_total_limit: null, action_retention_days: 90,
      size_bytes: null, entries: null, today_action_bytes: null, today_total_bytes: null });
  });

  it("reads the caps and retention from the environment; an unset or invalid cap means no limit", () => {
    expect(logSettings({ LOG_DAILY_ACTION_BYTES: "2048", LOG_ACTION_RETENTION_DAYS: "30" })).toEqual({ dailyActionBytes: 2048, dailyTotalBytes: null, actionRetentionDays: 30 });
    expect(logSettings({ LOG_DAILY_ACTION_BYTES: "0" }).dailyActionBytes).toBe(0);
    for (const bad of ["", "-1", "1.5", "lots"]) expect(logSettings({ LOG_DAILY_ACTION_BYTES: bad, LOG_DAILY_TOTAL_BYTES: bad, LOG_ACTION_RETENTION_DAYS: bad })).toEqual({ dailyActionBytes: null, dailyTotalBytes: null, actionRetentionDays: 90 });
    expect(logSettings({ LOG_ACTION_RETENTION_DAYS: "0" }).actionRetentionDays).toBe(90);
  });
});

describe("retention prune and scheduled()", () => {
  const raw = (userId: string, id: string, kind: string, ts: number, text = `${kind} probe-retention`) =>
    logsDb.prepare("INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(userId, id, "prune-s", "codex", "r", ts, kind, text, text.length, ts).run();
  const kinds = async (userId: string) => (await logsDb.prepare("SELECT kind FROM log_entries WHERE user_id=? ORDER BY kind").bind(userId).all<{ kind: string }>()).results.map(r => r.kind);

  it("deletes only action/error rows past retention, in batches, keeps log_fts in sync and drops old log_daily rows", async () => {
    const u = "log-prune", old = NOW - 91 * DAY;
    let n = 700000;
    for (let i = 0; i < 5; i++) { await raw(u, hex(n++), "action", old - i); await raw(u, hex(n++), "error", old - i); }
    await raw(u, hex(n++), "prompt", old); await raw(u, hex(n++), "reply", old);
    await raw(u, hex(n++), "action", NOW - 89 * DAY); await raw(u, hex(n++), "error", NOW - DAY);
    await logsDb.prepare("INSERT INTO log_daily (user_id, day, action_bytes) VALUES (?, ?, 5), (?, ?, 6)").bind(u, utcDay(NOW - 121 * DAY), u, utcDay(NOW - 119 * DAY)).run();
    const settings = { dailyActionBytes: 1000, actionRetentionDays: 90 };
    // A spent budget stops before any work and resumes next time.
    expect(await pruneLogs(logsDb, settings, { now: NOW, budgetMs: 0 })).toMatchObject({ deleted_entries: 0, complete: false });
    expect(await kinds(u)).toHaveLength(14);
    const result = await pruneLogs(logsDb, settings, { now: NOW, batchSize: 3 });
    expect(result).toMatchObject({ deleted_entries: 10, deleted_daily: 1, complete: true });
    expect(await kinds(u)).toEqual(["action", "error", "prompt", "reply"]);
    const fts = await logsDb.prepare("SELECT count(*) AS n FROM log_fts f JOIN log_entries e ON e.rowid=f.rowid WHERE log_fts MATCH '\"probe-retention\"' AND e.user_id=?").bind(u).first<{ n: number }>();
    expect(fts!.n).toBe(4);
    expect((await logsDb.prepare("SELECT count(*) AS n FROM log_fts WHERE log_fts MATCH '\"probe-retention\"'").first<{ n: number }>())!.n).toBe(4);
    expect((await logsDb.prepare("SELECT day FROM log_daily WHERE user_id=?").bind(u).all<{ day: string }>()).results.map(r => r.day)).toEqual([utcDay(NOW - 119 * DAY)]);
  });

  it("the Worker's scheduled() handler runs the prune with the configured retention", async () => {
    const u = "log-cron";
    await raw(u, hex(800001), "action", NOW - 31 * DAY);
    await raw(u, hex(800002), "error", NOW - 29 * DAY);
    await raw(u, hex(800003), "prompt", NOW - 400 * DAY);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const info = console.info; console.info = () => {};
    try {
      await (worker as unknown as { scheduled: (c: ScheduledController, e: Env, x: ExecutionContext) => Promise<void> })
        .scheduled({ cron: "0 18 * * *", scheduledTime: NOW, noRetry() {} } as ScheduledController, { LOGS: logsDb, LOG_ACTION_RETENTION_DAYS: "30" } as unknown as Env, ctx);
      await Promise.all(pending);
    } finally { console.info = info; }
    expect(pending).toHaveLength(1);
    expect(await kinds(u)).toEqual(["error", "prompt"]);
    // No LOGS binding: nothing to do, nothing scheduled.
    const none: Promise<unknown>[] = [];
    await (worker as any).scheduled({}, {} as Env, { waitUntil: (p: Promise<unknown>) => none.push(p) });
    expect(none).toHaveLength(0);
  });
});

// ---- Review round 2 (2026-11-03)

describe("log_search: file names, versions, error codes and short words (review 2)", () => {
  const u = user("log-r2-words");
  const add = async (text: string, over: Record<string, unknown> = {}) => { const e = entry({ text, ...over }); await services.logs.append(u, { entries: [e] }); return e.id; };
  let dbFile: string, dbNoise: string, mcpFile: string, version: string, deleted: string;
  beforeAll(async () => {
    dbFile = await add("edited src/db.ts to add an index", { kind: "action", ts: NOW - 50000 });
    dbNoise = await add("db schema reviewed; all tests pass", { kind: "reply", ts: NOW - 40000 });
    mcpFile = await add("edited src/mcp.ts handler", { kind: "action", ts: NOW - 30000 });
    await add("mcp mcp mcp: restarted the mcp server, mcp ok", { kind: "reply", ts: NOW - 20000 });
    version = await add("installed cf-memory-agent 0.2.158 on codex", { ts: NOW - 45000 });
    await add("line 158 of the log said ok", { ts: NOW - 15000 });
    await add("vectorize vectorize vectorize index plan", { ts: NOW - 10000 });
    deleted = await add("vectorize index を削除した", { ts: NOW - 60000 });
  });
  const ids = async (query: string) => (await rpc("log_search", { query }, u)).hits.map((h: any) => h.id);

  it("plans a punctuated word as one literal phrase beside its 3+ character tokens, and short words as boosts", () => {
    expect(logQuery("db.ts")).toEqual({ match: ["db.ts"], boost: ["db.ts"], like: null, dropped: [] });
    expect(logQuery("mcp.ts")).toEqual({ match: ["mcp.ts", "mcp"], boost: ["mcp.ts"], like: null, dropped: [] });
    expect(logQuery("0.2.158")).toEqual({ match: ["0.2.158", "158"], boost: ["0.2.158"], like: null, dropped: [] });
    expect(logQuery("vectorize 削除")).toEqual({ match: ["vectorize"], boost: ["削除"], like: null, dropped: [] });
    expect(logQuery("「D1_ERROR」, .env")).toEqual({ match: ["d1_error", "error", ".env", "env"], boost: ["D1_ERROR", ".env"], like: null, dropped: [] });
    expect(logQuery("DB 移行")).toEqual({ match: [], boost: [], like: ["DB", "移行"], dropped: [] });
    expect(logQuery('"')).toEqual({ match: [], boost: [], like: ['"'], dropped: [] }); // only wrapping punctuation: as written
    expect(logQuery("VectorizeのACK")).toMatchObject({ match: ["vectorizeのack", "vectorize", "ack"], boost: [] }); // no punctuation: tokens only
  });

  it("finds a file name, not every row with its parts", async () => {
    expect(await ids("db.ts")).toEqual([dbFile]); // was LIKE %db% AND %ts% → the noise row first
    expect(await ids("db.ts")).not.toContain(dbNoise);
    expect((await ids("mcp.ts"))[0]).toBe(mcpFile); // was MATCH "mcp" only → the mcp-dense row first
    expect((await ids("MCP.TS"))[0]).toBe(mcpFile);
  });

  it("ranks the exact version first, and a 2-character word next to a longer one", async () => {
    expect((await ids("0.2.158"))[0]).toBe(version); // was MATCH "158" only
    const r = await rpc("log_search", { query: "vectorize 削除" }, u);
    expect(r.hits[0].id).toBe(deleted); // was "削除" dropped → the vectorize-dense row first
    expect(r.hits).toHaveLength(2); // still OR: rows without 削除 are kept, after it
    expect(r.query_terms_dropped).toBeUndefined();
    expect(r.hits[0].snippet).toContain("削除");
  });

  it("keeps MATCH syntax and LIKE wildcards literal, and the 12-term cap with phrases", async () => {
    for (const query of ['"a" OR b* NEAR(x y) text:z ^start', 'col:"x" AND', '%_\\', '"""', '「」']) {
      await expect(rpc("log_search", { query }, u)).resolves.toMatchObject({ hits: expect.any(Array) });
    }
    expect(await ids("d%.ts")).toEqual([]);
    const words = Array.from({ length: 14 }, (_, i) => `f${String.fromCharCode(97 + i)}.ts`);
    const plan = logQuery(words.join(" "));
    expect(plan.match).toEqual(words.slice(0, MAX_FTS_TERMS)); // `fa`/`ts` are too short for the index
    expect(plan.dropped).toEqual(["fm.ts", "fn.ts"]);
    expect(plan.boost).toEqual(words.slice(0, 8));
  });
});

describe("log_search / log_sessions examined rows (review 2)", () => {
  const u = user("log-r2-bulk"), reads: number[] = [];
  /** D1 whose .all()/.first() record meta.rows_read. */
  const metered = (d: D1Database): D1Database => new Proxy(d, { get(target, prop) {
    if (prop !== "prepare") { const v = (target as any)[prop]; return typeof v === "function" ? v.bind(target) : v; }
    return (sql: string) => {
      const wrap = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, { get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (k === "all") return async () => { const r = await t.all(); reads.push((r.meta as any).rows_read); return r; };
        if (k === "first") return async () => { const r = await t.all(); reads.push((r.meta as any).rows_read); return r.results[0] ?? null; };
        const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v;
      } });
      return wrap(target.prepare(sql));
    };
  } });
  const svc = () => new LogService(metered(logsDb), { ...logSettings(), likeScanRows: 300, conversationScanRows: 300, sessionScanRows: 500 });
  const BASE = NOW - 10 * DAY, ROWS = 2000;
  beforeAll(async () => {
    // 2,000 actions in 40 sessions of repo bulk/one, one per second, plus an old prompt with 移行 at n=1000.
    await logsDb.prepare(`INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at)
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${ROWS})
      SELECT ?1, printf('%064x', 990000000 + n), 'bulk-' || (n % 40), 'claude-code', 'bulk/one', ?2 + n * 1000,
        CASE n WHEN 1000 THEN 'prompt' ELSE 'action' END, CASE n WHEN 1000 THEN 'DB を移行する計画' ELSE 'Bash: step ' || n END, 10, ?2 FROM c`).bind(u.userId, BASE).run();
  }, 30000);
  const sum = () => reads.reduce((a, b) => a + b, 0);

  it("the LIKE fallback examines at most the newest likeScanRows entries, says so, and continues with until", async () => {
    const s = svc();
    reads.length = 0;
    const none = await s.search(u, { query: "zz" });
    expect(none.hits).toEqual([]);
    // Per kind: its window, its rows and the index-only edge, each bounded by the window, not the 2,000 rows; was 2 × 2,000.
    expect(sum()).toBeLessThanOrEqual(3 * 300 + 30);
    const edge = BASE + (ROWS - 299) * 1000 + 1; // the 300th newest action (n = 1701)
    expect(none.scan_limited).toEqual({ entries: 300, until: edge, time: jstTime(edge), kinds: ["action"] });
    // The old 移行 prompt is behind 1,000 newer actions, but prompts have their own window.
    const r = await s.search(u, { query: "移行" });
    expect(r.hits.map(h => h.id)).toEqual([(990000000 + 1000).toString(16).padStart(64, "0")]);
    // Following `until` pages through the actions to the oldest.
    let page = none, pages = 1;
    while (page.scan_limited && pages < 20) { page = await s.search(u, { query: "zz", until: page.scan_limited.until }); pages++; }
    expect(pages).toBe(7);
    // Enough hits inside the window: exact, newest first, no scan_limited; the action
    // window stops at the 5th hit (the prompt/reply windows are empty of "st").
    reads.length = 0;
    const many = await s.search(u, { query: "st", limit: 5 });
    expect(many.hits.map(h => h.ts)).toEqual([0, 1, 2, 3, 4].map(i => BASE + (ROWS - i) * 1000));
    expect(many.scan_limited).toBeUndefined();
    expect(sum()).toBeLessThan(60);
    // since/until and session_id narrow the window through an index.
    expect((await s.search(u, { query: "移行", since: BASE + 900 * 1000, until: BASE + 1100 * 1000 })).hits).toHaveLength(1);
    expect((await s.search(u, { query: "移行", session_id: "bulk-0" })).hits).toHaveLength(1);
  });

  it("log_sessions with a selective filter examines at most sessionScanRows entries and says so", async () => {
    const s = svc();
    reads.length = 0;
    expect(await s.sessions(u, { repo: "nomatch" })).toEqual({ sessions: [], scan_limited: { entries: 500 } });
    expect(sum()).toBeLessThanOrEqual(3 * 500 + 10); // was every own row
    reads.length = 0;
    expect(await s.sessions(u, { client: "codex" })).toEqual({ sessions: [], scan_limited: { entries: 500 } });
    const found = await s.sessions(u, { repo: "bulk", limit: 20 });
    expect(found.sessions).toHaveLength(20);
    expect(found.scan_limited).toBeUndefined();
  });
});

describe("log_search time formats (review 2)", () => {
  const u = user("log-r2-time");
  const at = (iso: string) => Date.parse(iso);
  const rows = {
    beforeJstDay: entry({ ts: at("2026-10-27T14:59:59Z"), text: "timeprobe a" }), // 10-27 23:59:59 JST
    jstMidnight: entry({ ts: at("2026-10-27T15:00:00Z"), text: "timeprobe b" }), // 10-28 00:00 JST
    jstEvening: entry({ ts: at("2026-10-28T14:46:30Z"), text: "timeprobe c" }), // 10-28 23:46:30 JST
    nextJstDay: entry({ ts: at("2026-10-28T15:00:00Z"), text: "timeprobe d" }), // 10-29 00:00 JST
  };
  beforeAll(async () => { await services.logs.append(u, { entries: Object.values(rows) }); });
  const q = async (args: Record<string, unknown>) => (await rpc("log_search", { query: "timeprobe", ...args }, u)).hits.map((h: any) => h.id).sort();

  it("reads a date alone as a JST day: since from 00:00 JST, until to the end of that JST day", async () => {
    expect(await q({ since: "2026-10-28", until: "2026-10-28" })).toEqual([rows.jstMidnight.id, rows.jstEvening.id].sort());
    expect(await q({ until: "2026-10-27" })).toEqual([rows.beforeJstDay.id]);
    expect(await q({ since: "2026-10-29" })).toEqual([rows.nextJstDay.id]);
  });

  it("accepts a hit's own time back, JST wall times without a zone, and zoned ISO as before", async () => {
    const hit = (await rpc("log_search", { query: "timeprobe c" }, u)).hits[0];
    expect(hit.time).toBe("2026-10-28 23:46 JST");
    expect(await q({ until: hit.time })).toEqual([rows.beforeJstDay.id, rows.jstMidnight.id].sort()); // older than that minute
    expect(await q({ since: hit.time })).toEqual([rows.jstEvening.id, rows.nextJstDay.id].sort());
    expect(await q({ since: "2026-10-28 23:46", until: "2026-10-28T23:47:00" })).toEqual([rows.jstEvening.id]);
    expect(await q({ since: "2026-10-28T23:46:30.000 JST", until: "2026-10-28 23:46:31 jst" })).toEqual([rows.jstEvening.id]);
    expect(await q({ since: "2026-10-28T14:46:00Z", until: "2026-10-29T00:00:00+09:00" })).toEqual([rows.jstEvening.id]);
    expect(await q({ since: String(at("2026-10-28T15:00:00Z")) })).toEqual([rows.nextJstDay.id]);
  });
});

describe("log_read text_offset (review 2)", () => {
  const u = user("log-r2-read");
  const long = "a".repeat(7992) + "😀" + "b".repeat(12000) + "end"; // the pair straddles the first cut
  let id: string, before: string;
  beforeAll(async () => {
    const e0 = entry({ session_id: "r2-read", ts: NOW - 3000, text: "question" }), e1 = entry({ session_id: "r2-read", ts: NOW - 2000, kind: "reply", text: long });
    id = e1.id; before = e0.id;
    await services.logs.append(u, { entries: [e0, e1] });
  });

  it("pages a long text with next_offset until the whole text is read, never splitting a surrogate pair", async () => {
    const pages: string[] = [];
    let offset = 0, last: any;
    for (let i = 0; i < 5; i++) {
      const r = await rpc("log_read", { id, before: 0, after: 0, ...(offset ? { text_offset: offset } : {}) }, u);
      last = r.entries[0];
      expect(last.text.length).toBeLessThanOrEqual(READ_TEXT_CHARS);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(last.text.replace(CUT_MARK, ""))).toBe(false);
      expect(last.text_offset).toBe(offset); // echoed on the anchor, 0 included
      pages.push(last.truncated ? last.text.slice(0, -CUT_MARK.length) : last.text);
      if (!last.truncated) break;
      offset = last.next_offset;
    }
    expect(pages[0]).toHaveLength(7992); // the emoji moved to the next page
    expect(pages.join("")).toBe(long);
    expect(last).toMatchObject({ truncated: false, chars: long.length });
    expect(last).not.toHaveProperty("next_offset");
  });

  it("applies the offset to the anchor only, past the end gives empty text, and validates it", async () => {
    const r = await rpc("log_read", { id, before: 1, after: 0, text_offset: 16000 }, u);
    expect(r.entries.map((e: any) => e.id)).toEqual([before, id]);
    expect(r.entries[0]).toMatchObject({ text: "question", truncated: false });
    expect(r.entries[1]).toMatchObject({ text: long.slice(16000), text_offset: 16000, truncated: false });
    expect((await rpc("log_read", { id, before: 0, after: 0, text_offset: 10 ** 9 }, u)).entries[0]).toMatchObject({ text: "", truncated: false, text_offset: long.length });
    await expect(rpc("log_read", { id, text_offset: "5" }, u)).rejects.toThrow(/text_offset must be a number/);
    // An offset inside a surrogate pair starts at the pair and echoes where the text really starts (review 3).
    const inside = (await rpc("log_read", { id, before: 0, after: 0, text_offset: 7993 }, u)).entries[0];
    expect(inside.text_offset).toBe(7992);
    expect(inside.text.startsWith("😀")).toBe(true);
  });
});

describe("log_append oversize text and the cut marker (review 2)", () => {
  const u = user("log-r2-cut");
  const stored = async (id: string) => (await logsDb.prepare("SELECT text FROM log_entries WHERE user_id=? AND id=?").bind(u.userId, id).first<{ text: string }>())!.text;

  it("keeps the head of a text over 1 MiB instead of the oversize marker", async () => {
    const big = entry({ kind: "prompt", text: "head of a pasted log " + "x".repeat(1100000) + " token sk-ant-" + "Z".repeat(40) });
    await services.logs.append(u, { entries: [big] });
    const text = await stored(big.id);
    expect(text.startsWith("head of a pasted log xxx")).toBe(true);
    expect(text).toHaveLength(65536); expect(text.endsWith(CUT_MARK)).toBe(true);
    expect(text).not.toContain("OVERSIZE");
  });

  it("never keeps a secret split at the scrub window's end, even when scrubbing shrinks the window", async () => {
    // 16 + 16 × 48 = 784: the 17th token is cut to `sk-ant-AAAAAAAAA` at 800 (2 × 400), too short to be
    // recognised. Scrubbing the window shrinks it to 304 chars, so that tail would land inside the limit.
    const token = "sk-ant-" + "A".repeat(40) + " ";
    const shrinking = entry({ kind: "action", text: "x".repeat(15) + " " + token.repeat(30) });
    const split = entry({ kind: "action", text: "Bash: " + "y".repeat(380) + " key sk-ant-" + "Q".repeat(900) });
    await services.logs.append(u, { entries: [shrinking, split] });
    const a = await stored(shrinking.id);
    expect(a).not.toMatch(/sk-ant-A/); expect(a).toContain("[REDACTED"); expect(a.endsWith(CUT_MARK)).toBe(true);
    const b = await stored(split.id);
    expect(b).not.toContain("QQQQ"); expect(b).toHaveLength(400); expect(b.endsWith(CUT_MARK)).toBe(true);
  });

  it("ends with the cut marker when the Agent's clip ended inside a redaction marker", async () => {
    // The Agent clips at the limit and appends the marker; the server re-scrub rewrites the clipped
    // `[REDAC…（以下省略）` tail and used to drop the marker with it.
    const clipped = "Bash: curl https://example.test/?token=[REDAC";
    expect(scrubEntryText(clipped + CUT_MARK).endsWith(CUT_MARK)).toBe(false);
    const atLimit = entry({ kind: "action", text: "x".repeat(400 - clipped.length - CUT_MARK.length) + clipped + CUT_MARK });
    const short = entry({ kind: "action", text: clipped + CUT_MARK });
    const once = entry({ kind: "action", text: "Read src/logs.ts" + CUT_MARK });
    await services.logs.append(u, { entries: [atLimit, short, once] });
    expect(await stored(short.id)).toBe("Bash: curl https://example.test/?token=[REDACTED]" + CUT_MARK);
    const full = await stored(atLimit.id);
    expect(full).toHaveLength(400); expect(full.endsWith(CUT_MARK)).toBe(true); // [REDACTED] no longer fits whole: cut into
    expect(await stored(once.id)).toBe(once.text); // already ends with it: no second marker
  });
});

describe("tool errors (review 2)", () => {
  it("hides D1/SQL failures behind a short code, logged without user data", async () => {
    const mf2 = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["LOGS"] }));
    try {
      const only0001 = (await mf2.getD1Database("LOGS")) as unknown as D1Database;
      for (const statement of (await import("./helpers")).sqlStatements((await import("node:fs")).readFileSync("migrations-logs/0001_logs.sql", "utf8"))) await only0001.prepare(statement).run();
      const broken = makeServices(db, null, { LOGS: only0001 } as unknown as Env);
      const lines: string[] = [], error = console.error;
      console.error = (line: string) => { lines.push(line); };
      let message = "";
      try {
        await rpc("log_append", { entries: [entry({ text: "private words hunter-zeta" })] }, alice, broken).catch((e: Error) => { message = e.message; });
      } finally { console.error = error; }
      expect(message).toMatch(/^Internal error in log_append \(code [0-9a-f]{8}\)\. Retry later/);
      expect(message).not.toMatch(/total_bytes|SQLITE|D1_/);
      // Not a validation prefix: the Agent retries it instead of dropping the batch.
      expect(message).not.toMatch(/^(?:entries\[\d+\]|log_append:|entries must be)/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(message.match(/code ([0-9a-f]{8})/)![1]);
      expect(lines[0]).toContain("total_bytes");
      expect(lines[0]).not.toContain("hunter-zeta");
      expect(lines[0]).not.toContain(alice.userId);
    } finally { await mf2.dispose(); }
  });

  it("keeps validation, configuration and conflict messages exactly", async () => {
    await expect(rpc("log_append", { entries: [entry({ id: "x" })] }, alice)).rejects.toThrow(/^entries\[0\]\.id must be 64 lowercase hex characters \(a sha256 digest\)$/);
    await expect(rpc("log_append", { entries: [] }, alice)).rejects.toThrow(/^entries must be an array of 1-50 entries$/);
    await expect(rpc("log_append", { entries: [entry()], x: 1 }, alice)).rejects.toThrow(/^log_append: unknown field 'x'/);
    await expect(rpc("log_search", { query: "x", since: "nope" }, alice)).rejects.toThrow(/^since must be/);
    await expect(rpc("log_search", { query: "x" }, alice, makeServices(db))).rejects.toThrow(/^logs database is not configured/);
    const quiet = () => {};
    expect(toolErrorText("log_append", new Error("log_append conflicted with concurrent writes; retry the same entries"), quiet)).toBe("log_append conflicted with concurrent writes; retry the same entries");
    // A log tool shows only its own messages; other tools keep theirs unless D1/SQLite or engine errors.
    expect(toolErrorText("log_search", new Error("something internal"), quiet)).toMatch(/^Internal error in log_search \(code /);
    expect(toolErrorText("notes_get", new Error("note not found: x"), quiet)).toBe("note not found: x");
    expect(toolErrorText("notes_get", new Error("D1_ERROR: no such table: notes: SQLITE_ERROR"), quiet)).toMatch(/^Internal error in notes_get/);
    expect(toolErrorText("notes_get", new TypeError("Cannot read properties of undefined (reading 'x')"), quiet)).toMatch(/^Internal error in notes_get/);
    const logged: string[] = [];
    toolErrorText("notes_put", new SyntaxError(`Unexpected token 'p', "private body" is not valid JSON`), l => logged.push(l));
    expect(logged[0]).not.toContain("private body");
    toolErrorText("notes_put", new TypeError("Temporary private contents"), l => logged.push(l));
    expect(logged[1]).not.toContain("Temporary private contents");
    expect(logged[1]).toContain('"error":"TypeError"');
  });

  it("server_status hides an engine error from a non-log tool too", async () => {
    const failing = { ...services, capture: { status: async () => { throw new TypeError("Cannot read properties of undefined (reading 'results')"); } } } as unknown as Services;
    const error = console.error; console.error = () => {};
    try {
      await expect(rpc("server_status", {}, alice, failing)).rejects.toThrow(/^Internal error in server_status \(code [0-9a-f]{8}\)/);
    } finally { console.error = error; }
  });
});

describe("review 3: plans, time formats, scan edges, control characters, oversize", () => {
  const reads: number[] = [];
  /** D1 whose .all()/.first() record meta.rows_read. */
  const metered = (d: D1Database): D1Database => new Proxy(d, { get(target, prop) {
    if (prop !== "prepare") { const v = (target as any)[prop]; return typeof v === "function" ? v.bind(target) : v; }
    return (sql: string) => {
      const wrap = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, { get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (k === "all") return async () => { const r = await t.all(); reads.push((r.meta as any).rows_read); return r; };
        if (k === "first") return async () => { const r = await t.all(); reads.push((r.meta as any).rows_read); return r.results[0] ?? null; };
        const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v;
      } });
      return wrap(target.prepare(sql));
    };
  } });
  const sum = () => reads.reduce((a, b) => a + b, 0);
  const bulk = user("log-r3-bulk"), BASE = NOW - 5 * DAY, ROWS = 3000;
  beforeAll(async () => {
    // 3,000 actions of ONE session in repo r3/one, one per second; row 1500 mentions zebrafish.
    await logsDb.prepare(`INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at)
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${ROWS})
      SELECT ?1, printf('%064x', 880000000 + n), 'r3-long', 'claude-code', 'r3/one', ?2 + n * 1000, 'action',
        CASE n WHEN 1500 THEN 'Bash: grep zebrafish notes.md' ELSE 'Bash: npm vitest deploy step ' || n END, 10, ?2 FROM c`).bind(bulk.userId, BASE).run();
  }, 30000);

  it("keyword search with since/until, kind or session_id keeps the FTS match as the outer loop", async () => {
    const s = new LogService(metered(logsDb), logSettings());
    for (const extra of [{}, { since: BASE, until: BASE + (ROWS + 1) * 1000 }, { kind: "action", since: BASE }, { session_id: "r3-long", since: BASE }]) {
      reads.length = 0;
      const r = await s.search(bulk, { query: "zebrafish", ...extra });
      expect(r.hits.map(h => h.id)).toEqual([(880000000 + 1500).toString(16).padStart(64, "0")]);
      expect(sum()).toBeLessThan(50); // a ts-range walk probing log_fts per row read every one of the 3,000 rows
    }
    const plan = await logsDb.prepare(`EXPLAIN QUERY PLAN SELECT e.rowid FROM log_fts f CROSS JOIN log_entries e ON e.rowid = f.rowid
      WHERE log_fts MATCH ? AND e.user_id = ? AND e.ts >= ? AND e.ts < ? ORDER BY f.rank LIMIT 10`).bind('"zebrafish"', bulk.userId, 0, NOW).all<{ detail: string }>();
    expect(plan.results[0].detail).toMatch(/^SCAN f VIRTUAL TABLE/);
  });

  it("log_read and the handoff read rows near the anchor, not the whole session or repo", async () => {
    const s = new LogService(metered(logsDb), logSettings());
    for (const n of [1, ROWS]) {
      reads.length = 0;
      const r = await s.read(bulk, { id: (880000000 + n).toString(16).padStart(64, "0") });
      expect(r.entries).toHaveLength(4);
      expect(sum()).toBeLessThan(30); // the far side read all 3,000
    }
    reads.length = 0;
    expect(await s.handoff(bulk, "r3/one", null)).toBeNull(); // no reply at all in the repo
    expect(sum()).toBeLessThanOrEqual(2 * HANDOFF_SCAN_ROWS);
    await s.append(bulk, { entries: [entry({ session_id: "r3-other", repo: "r3/one", kind: "reply", ts: BASE + (ROWS + 5) * 1000, text: "handoff reply" })] });
    reads.length = 0;
    expect((await s.handoff(bulk, "r3/one", "r3-long"))?.text).toBe("handoff reply");
    expect(sum()).toBeLessThan(10);
  });

  it("reads slash, dot and one-digit JST dates; rejects zone-less strings Date.parse would read as UTC", async () => {
    const u = user("log-r3-time");
    const at = (iso: string) => Date.parse(iso);
    const rows = [entry({ ts: at("2026-10-27T15:00:00Z"), text: "slashprobe a" }), entry({ ts: at("2026-10-28T14:46:30Z"), text: "slashprobe b" })];
    await services.logs.append(u, { entries: rows });
    const q = async (args: Record<string, unknown>) => (await rpc("log_search", { query: "slashprobe", ...args }, u)).hits.map((h: any) => h.id).sort();
    const both = rows.map(r => r.id).sort();
    expect(await q({ since: "2026/10/28", until: "2026/10/28" })).toEqual(both); // 00:00 JST to the end of that JST day
    expect(await q({ since: "2026.10.28 23:46" })).toEqual([rows[1].id]);
    expect(await q({ since: "2026/10/28 9:05", until: "2026/10/28 23:47" })).toEqual([rows[1].id]);
    expect(await q({ since: "Tue, 28 Oct 2026 14:46:00 GMT" })).toEqual([rows[1].id]);
    for (const bad of ["10/28", "Oct 28 2026", "2026/10/28 25:00", "10-28-2026", "2026-10-28T23:46-ish"])
      await expect(rpc("log_search", { query: "slashprobe", since: bad }, u)).rejects.toThrow(/since must be an ISO date\/time/);
  });

  it("scan_limited continues past entries sharing the window's oldest ts, and is not set when nothing is older", async () => {
    const u = user("log-r3-edge"), T = NOW - 100000;
    const s = new LogService(logsDb, { ...logSettings(), likeScanRows: 3, conversationScanRows: 3, sessionScanRows: 5 });
    const rows = [entry({ ts: T + 2000, text: "a1" }), entry({ ts: T + 1000, text: "a2" }),
      entry({ ts: T, kind: "action", text: "Bash: DB migrate → 失敗" }), entry({ ts: T, kind: "error", text: "Bash: x → 失敗 timeout DB" }),
      entry({ ts: T - 5000, text: "older DB" })];
    await s.append(u, { entries: rows });
    let r = await s.search(u, { query: "DB" }), pages = 1;
    const seen = new Set(r.hits.map(h => h.id));
    while (r.scan_limited && pages < 10) { r = await s.search(u, { query: "DB", until: r.scan_limited.until }); r.hits.forEach(h => seen.add(h.id)); pages++; }
    expect([...seen].sort()).toEqual([rows[2].id, rows[3].id, rows[4].id].sort());
    const exact = user("log-r3-exact"), s5 = new LogService(logsDb, { ...logSettings(), likeScanRows: 5, conversationScanRows: 5, sessionScanRows: 5 });
    await s5.append(exact, { entries: [1, 2, 3, 4, 5].map(i => entry({ ts: NOW - i * 1000, session_id: "x" + i, text: "row " + i })) });
    expect((await s5.search(exact, { query: "zz" })).scan_limited).toBeUndefined();
    expect((await s5.sessions(exact, { repo: "nomatch" })).scan_limited).toBeUndefined();
    await s5.append(exact, { entries: [entry({ ts: NOW - 9000, text: "row 6" })] });
    expect((await s5.search(exact, { query: "zz" })).scan_limited?.entries).toBe(5);
    expect((await s5.sessions(exact, { repo: "nomatch" })).scan_limited).toEqual({ entries: 5 });
  });

  it("drops NUL and other C0 controls from stored text and from queries", async () => {
    const u = user("log-r3-nul"), e = entry({ kind: "error", text: "Bash: cat bin → 失敗\nhead \u0000\u0001\u001b[31m tail ZQ\tend" });
    await rpc("log_append", { entries: [e] }, u);
    const stored = (await rpc("log_read", { id: e.id }, u)).entries[0].text;
    expect(stored).toBe("Bash: cat bin → 失敗\nhead [31m tail ZQ\tend");
    expect((await rpc("log_search", { query: "ZQ" }, u)).hits.map((h: any) => h.id)).toEqual([e.id]); // LIKE lane saw past the NUL
    expect((await rpc("log_search", { query: "tail\u0000ZQ" }, u)).hits.map((h: any) => h.id)).toEqual([e.id]);
    await expect(rpc("log_search", { query: "\u0000\u0000" }, u)).rejects.toThrow(/query must be a non-empty string/);
  });

  it("text over 1 MiB keeps a scrubbed head even when scrubbing shrinks the first window", () => {
    const img = "data:image/png;base64," + "A".repeat(100000);
    const text = 'see this page: <img src="' + img + '"> and the log follows\n' + "log line ok\n".repeat(100000); // ~1.3 MB
    const e = parseEntry({ id: "a".repeat(64), session_id: "s", client: "codex", repo: "", ts: 1, kind: "prompt", text }, 0, Date.now());
    expect(e.text.startsWith("see this page:")).toBe(true);
    expect(e.text).not.toContain("AAAAAAAA");
    expect(e.text).toContain("log line ok");
    expect(e.text.endsWith(CUT_MARK)).toBe(true);
  });
});

describe("review 4: long words and repos, compact dates, years", () => {
  const u = user("log-r4-long");
  const url = "https://example.com/very/long/path/to/some/resource/that/is/over/fifty/bytes";
  const repo = "github.com/acme/a-really-long-repository-name-for-tests";
  beforeAll(async () => {
    await services.logs.append(u, { entries: [entry({ repo, kind: "action", text: "Bash: curl " + url + " → 失敗", ts: NOW - 5000 }), entry({ repo, kind: "prompt", text: "東京都・神奈川県・千葉県・埼玉県・茨城県 の件", ts: NOW - 4000 })] });
  });
  it("a punctuated word or repo over 50 bytes never hits D1's LIKE pattern limit", async () => {
    expect((await rpc("log_search", { query: url }, u)).hits).toHaveLength(1);
    expect((await rpc("log_search", { query: "東京都・神奈川県・千葉県・埼玉県・茨城県" }, u)).hits).toHaveLength(1);
    expect((await rpc("log_search", { query: "curl", repo }, u)).hits).toHaveLength(1);
    expect((await rpc("log_sessions", { repo }, u)).sessions).toHaveLength(1);
  });
  it("reads 8 digits as a JST date and refuses zoned times without a year or short numbers", async () => {
    const day = (iso: string) => Date.parse(iso);
    const at = entry({ ts: day("2026-10-28T03:00:00Z"), text: "ymdprobe" });
    await services.logs.append(u, { entries: [at] });
    expect((await rpc("log_search", { query: "ymdprobe", since: "20261028", until: "20261028" }, u)).hits).toHaveLength(1);
    for (const bad of ["10/28 14:46 GMT", "Oct 28 14:46 UTC", "1028"])
      await expect(rpc("log_search", { query: "ymdprobe", since: bad }, u)).rejects.toThrow(/since must be/);
  });
});

describe("review 5: zone offsets are no year; epoch seconds are refused", () => {
  const u = user("log-r5-time");
  it("refuses yearless times with a numeric zone and epoch-second-sized numbers", async () => {
    await services.logs.append(u, { entries: [entry({ text: "r5probe" })] });
    for (const bad of ["10/28 10:00 +0900", "Oct 28 10:00 +0900", "28 Oct 10:00 -0500", "1761650000", 20261028, 1761650000])
      await expect(rpc("log_search", { query: "r5probe", since: bad }, u)).rejects.toThrow(/since must be/);
    expect((await rpc("log_search", { query: "r5probe", since: "2026-10-28T10:00:00+0900" }, u)).hits).toHaveLength(1);
    expect((await rpc("log_search", { query: "r5probe", since: 0 }, u)).hits).toHaveLength(1);
  });
});
