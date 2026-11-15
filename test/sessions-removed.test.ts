// Removal-affirming tests for the sessions subsystem (decision 8) — the same
// pattern the curator removal set (a residual door must never quietly return).
// Also pins the two contracts the removal explicitly KEEPS: legacy session.*
// audit events still render, and the recall pack no longer has an episodic tier.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { mintTestToken, rsEnvVars } from "./helpers";

const OWNER = "u_sessgone_owner";
let BEARER = "";
let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];

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
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "sessgone", "sg", "sg@example.com", "", 0, 0).run();
  BEARER = await mintTestToken(OWNER, "notes:read,notes:write,admin");
  env = { DB: db, ...rsEnvVars(), OWNER_EMAIL: "sg@example.com", OWNER_HANDLE: "sessgone" } as unknown as Parameters<typeof app.request>[2];
});
afterAll(async () => { await mf?.dispose(); });

describe("sessions subsystem is gone (decision 8)", () => {
  it("MCP session_* tools return Unknown tool and are absent from tools/list", async () => {
    const call = await app.request("https://memory.test/mcp", { method: "POST", headers: { get authorization() { return `Bearer ${BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_start", arguments: {} } }) }, env);
    const body = (await call.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("Unknown tool");
    const list = await app.request("https://memory.test/mcp", { method: "POST", headers: { get authorization() { return `Bearer ${BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }, env);
    const tools = ((await list.json()) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
    // Capture originals are short-lived drill-down sources, not the retired
    // session memory subsystem. Pin the original tools separately.
    const captureTools = new Set(['capture_put', 'capture_session_end', 'capture_sessions', 'capture_search', 'capture_get_many', 'capture_session_timeline', 'capture_checkpoint', 'timeline', 'provenance_attach', 'provenance_search', 'client_heartbeat', 'client_health', 'server_status']);
    const portabilityTools = new Set(['memory_export', 'memory_export_provenance', 'memory_import_provenance', 'skills_file_create']);
    expect(tools.filter(t => portabilityTools.has(t.name))).toHaveLength(4);
    expect(tools.filter(t => t.name === 'memory_lookup')).toHaveLength(1);
    expect(tools.filter(t => t.name === 'notes_retraction_status')).toHaveLength(1);
    expect(tools.filter(t => t.name === 'notes_update_text')).toHaveLength(1);
    const guardedAppendTools = new Set(['notes_append_guarded','notes_append_status']);
    expect(tools.filter(t => guardedAppendTools.has(t.name))).toHaveLength(2);
    // Design B (2026-10-31): the conversation log tools. `session_context` is the
    // SessionStart hook's read, not the retired session-memory subsystem.
    const logTools = new Set(['log_append', 'log_search', 'log_read', 'log_sessions', 'session_context']);
    expect(tools.filter(t => logTools.has(t.name))).toHaveLength(5);
    expect(tools.filter(t => !captureTools.has(t.name) && !portabilityTools.has(t.name) && !guardedAppendTools.has(t.name) && !logTools.has(t.name) && t.name !== 'memory_lookup' && t.name !== 'notes_retraction_status' && t.name !== 'notes_update_text')).toHaveLength(27);
    expect(tools.filter((t) => t.name.startsWith("session_") && t.name !== "session_context")).toHaveLength(0);
  });

  it("REST /api/v1/sessions and web /@handle/sessions return 404", async () => {
    const rest = await app.request("https://memory.test/api/v1/sessions", { headers: { get authorization() { return `Bearer ${BEARER}`; } } }, env);
    expect(rest.status).toBe(404);
    const web = await app.request("https://memory.test/@sessgone/sessions", { headers: { get authorization() { return `Bearer ${BEARER}`; } } }, env);
    expect(web.status).toBe(404);
  });

  it("the recall pack has no episodic tier", async () => {
    // 2026-08-21 修正: この DB にはノートが1件も無く、recall が空のパックを返すので
    // 「含まれない」は何を消しても成り立っていた。中身のあるパックで確かめる。
    const mcp = (name: string, args: Record<string, unknown>) =>
      app.request(
        "https://memory.test/mcp",
        {
          method: "POST",
          headers: { get authorization() { return `Bearer ${BEARER}`; }, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
        },
        env,
      );
    await mcp("notes_put", { slug: "recall-probe", body_md: "zzrecallprobe 中身のあるノート" });

    const res = await mcp("recall", { query: "zzrecallprobe" });
    const text = ((await res.json()) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? "";
    // 対照: パックに中身があること。空なら以下の「含まれない」は何も証明しない。
    expect(text).toContain("recall-probe");
    expect(text).not.toContain("Relevant past sessions");
  });

  it("legacy session.* audit events still render on /activity (kept contract)", async () => {
    await db.prepare("INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind("ev_legacy_sess", OWNER, "agent", null, "session.created", "session", "s_legacy", null, "legacy session row", "{}", 1).run();
    const res = await app.request("https://memory.test/activity", { headers: { get authorization() { return `Bearer ${BEARER}`; } } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("会話ログ"); // VERB_LABEL mapping for session.created survives
  });
});
