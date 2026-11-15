// migrations-logs/0001_logs.sql + 0002_total_bytes.sql + 0003_update_trigger.sql (the cf-memory-logs D1, binding LOGS): the schema
// the log tools rely on, applied the way `wrangler d1 migrations apply LOGS`
// would, on a fresh Miniflare D1. Part of `npm run test:migrations`.
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logSettings, pruneLogs } from "../src/logs";
import { applyLogMigrations, sqlStatements } from "./helpers";

let mf: Miniflare;
let db: D1Database;
const insert = (id: string, text: string, kind = "prompt", user = "u1") =>
  db.prepare("INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(user, id, "s1", "codex", "acme/cf-memory", 1, kind, text, text.length, 1).run();
const matches = async (term: string) =>
  (await db.prepare("SELECT e.id FROM log_fts f JOIN log_entries e ON e.rowid = f.rowid WHERE log_fts MATCH ? ORDER BY e.id").bind(`"${term}"`).all<{ id: string }>()).results.map(r => r.id);

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["LOGS"] }));
  db = (await mf.getD1Database("LOGS")) as unknown as D1Database;
  await applyLogMigrations(db);
});
afterAll(async () => { await mf?.dispose(); });

describe("0001_logs: cf-memory-logs schema", () => {
  it("0002 only adds the two total-byte counters", () => {
    expect(sqlStatements(readFileSync("migrations-logs/0002_total_bytes.sql", "utf8"))).toEqual([
      "ALTER TABLE log_daily ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE log_daily ADD COLUMN total_dropped INTEGER NOT NULL DEFAULT 0",
    ]);
  });

  it("0003 only adds the update trigger, its body whole", () => {
    const statements = sqlStatements(readFileSync("migrations-logs/0003_update_trigger.sql", "utf8"));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^CREATE TRIGGER log_entries_au AFTER UPDATE ON log_entries BEGIN[\s\S]*'delete', old\.rowid, old\.text[\s\S]*new\.rowid, new\.text[\s\S]*END$/);
  });

  it("splits the file into its 9 statements, keeping each trigger body whole", () => {
    const statements = sqlStatements(readFileSync("migrations-logs/0001_logs.sql", "utf8"));
    expect(statements).toHaveLength(9);
    expect(statements.filter(s => /^CREATE TRIGGER/i.test(s)).every(s => /BEGIN[\s\S]*END$/i.test(s))).toBe(true);
  });

  it("creates the table, the five indexes (the fifth from 0004), the trigram FTS table, the three triggers and log_daily", async () => {
    const rows = await db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'log_fts_%' AND substr(name, 1, 3) != '_cf' ORDER BY name").all<{ type: string; name: string; tbl_name: string }>();
    expect(rows.results.map(r => `${r.type}:${r.name}`)).toEqual([
      "table:log_daily", "table:log_entries", "trigger:log_entries_ad", "trigger:log_entries_ai", "trigger:log_entries_au", "table:log_fts",
      "index:log_kind_ts", "index:log_user_kind_ts", "index:log_user_repo_ts", "index:log_user_session", "index:log_user_ts",
    ]);
    const cols = await db.prepare("SELECT name FROM pragma_table_info('log_entries')").all<{ name: string }>();
    expect(cols.results.map(c => c.name)).toEqual(["rowid", "user_id", "id", "session_id", "client", "repo", "ts", "kind", "text", "bytes", "created_at"]);
    const daily = await db.prepare("SELECT name, pk FROM pragma_table_info('log_daily')").all<{ name: string; pk: number }>();
    expect(daily.results).toEqual([{ name: "user_id", pk: 1 }, { name: "day", pk: 2 }, { name: "action_bytes", pk: 0 }, { name: "dropped", pk: 0 },
      { name: "total_bytes", pk: 0 }, { name: "total_dropped", pk: 0 }]); // the last two from 0002
    const fts = await db.prepare("SELECT sql FROM sqlite_master WHERE name='log_fts'").first<{ sql: string }>();
    expect(fts?.sql).toContain("content='log_entries'");
    expect(fts?.sql).toContain("tokenize='trigram'");
  });

  it("keeps log_fts in sync on insert and delete", async () => {
    await insert("a".repeat(64), "deploy failed with D1_ERROR");
    await insert("b".repeat(64), "認証エラーの原因を調べた");
    expect(await matches("d1_error")).toEqual(["a".repeat(64)]);
    expect(await matches("認証エラー")).toEqual(["b".repeat(64)]);
    await db.prepare("DELETE FROM log_entries WHERE id=?").bind("a".repeat(64)).run();
    expect(await matches("d1_error")).toEqual([]);
    const integrity = await db.prepare("INSERT INTO log_fts(log_fts, rank) VALUES ('integrity-check', 1)").run();
    expect(integrity.success).toBe(true);
  });

  it("keeps log_fts in sync when an operator redacts a stored text (UPDATE), through a later prune too", async () => {
    const id = "f".repeat(64);
    await db.prepare("INSERT INTO log_entries (user_id,id,session_id,client,repo,ts,kind,text,bytes,created_at) VALUES ('u4',?,'s','codex','r',?,'action',?,0,1)")
      .bind(id, Date.now() - 200 * 86400000, "my deploy key is QWERTYUIOP12345 oops").run();
    expect(await matches("qwertyuiop")).toEqual([id]);
    await db.prepare("UPDATE log_entries SET text=replace(text, 'QWERTYUIOP12345', '[REDACTED]') WHERE user_id='u4' AND id=?").bind(id).run();
    expect(await matches("qwertyuiop")).toEqual([]);
    expect(await matches("[redacted] oops")).toEqual([id]);
    expect((await db.prepare("INSERT INTO log_fts(log_fts, rank) VALUES ('integrity-check', 1)").run()).success).toBe(true);
    // Updating another column re-indexes the same text, still consistent.
    await db.prepare("UPDATE log_entries SET bytes=length(CAST(text AS BLOB)) WHERE id=?").bind(id).run();
    expect(await matches("[redacted] oops")).toEqual([id]);
    // The retention prune deletes the row; no trigram of either text is left behind.
    expect((await pruneLogs(db, logSettings({}))).deleted_entries).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("SELECT count(*) AS n FROM log_fts WHERE log_fts MATCH '\"QWERTYUIOP\" OR \"[REDACTED] oops\"'").first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("INSERT INTO log_fts(log_fts, rank) VALUES ('integrity-check', 1)").run()).success).toBe(true);
  });

  it("rejects an unknown kind and a second row with the same (user_id, id)", async () => {
    await expect(insert("c".repeat(64), "x", "summary")).rejects.toThrow(/CHECK constraint failed/);
    await insert("d".repeat(64), "first");
    await expect(insert("d".repeat(64), "again")).rejects.toThrow(/UNIQUE constraint failed/);
    await insert("d".repeat(64), "another user may use the same client id", "prompt", "u2");
    expect((await db.prepare("SELECT count(*) AS n FROM log_entries WHERE id=?").bind("d".repeat(64)).first<{ n: number }>())?.n).toBe(2);
  });

  it("defaults repo to '' and log_daily counters to 0", async () => {
    await db.prepare("INSERT INTO log_entries (user_id,id,session_id,client,ts,kind,text,bytes,created_at) VALUES ('u3',?, 's','codex',1,'reply','t',1,1)").bind("e".repeat(64)).run();
    expect((await db.prepare("SELECT repo FROM log_entries WHERE id=?").bind("e".repeat(64)).first<{ repo: string }>())?.repo).toBe("");
    await db.prepare("INSERT INTO log_daily (user_id, day) VALUES ('u3','2026-10-31')").run();
    expect(await db.prepare("SELECT action_bytes, dropped, total_bytes, total_dropped FROM log_daily WHERE user_id='u3'").first()).toEqual({ action_bytes: 0, dropped: 0, total_bytes: 0, total_dropped: 0 });
  });
});
