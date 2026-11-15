// T5 skill-outcome memory (0024): skills_log_use records whether USING a skill
// worked, updating a denormalized success_rate (success=1, partial=.5, failure=0)
// + invocation_count on the skill, and a skill_invocations audit row. Agent-declared,
// owner-only, and it must NOT bump usage_count (installs) or updated_at (edits).
// Drives the service, the MCP tool, and the REST door on a Miniflare D1.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { mintTestToken, principalFixture, rsEnvVars } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_out_owner";
const OWNER_HANDLE = "out-owner";
let OWNER_BEARER = "";
const READER = "u_out_reader";
const READER_HANDLE = "out-reader";
let READER_BEARER = "";

const owner: Principal = principalFixture({ userId: OWNER, handle: OWNER_HANDLE });
const reader: Principal = principalFixture({ userId: READER, handle: READER_HANDLE });

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let services: Services;

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}

async function insertUser(id: string, handle: string): Promise<string> {
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(id, handle, handle, `${handle}@example.com`, "", 0, 0).run();
  return await mintTestToken(id, "notes:read,notes:write");
}

const skillRow = async (slug: string, userId: string) =>
  db.prepare("SELECT success_rate, invocation_count, usage_count, updated_at FROM skills WHERE slug=? AND user_id=?").bind(slug, userId).first<{ success_rate: number | null; invocation_count: number; usage_count: number; updated_at: number }>();

async function mcp(bearer: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app.request("https://memory.test/mcp", { method: "POST", headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, env);
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  OWNER_BEARER = await insertUser(OWNER, OWNER_HANDLE);
  READER_BEARER = await insertUser(READER, READER_HANDLE);
  services = makeServices(db);
  env = { DB: db, ...rsEnvVars(), OWNER_EMAIL: `${OWNER_HANDLE}@example.com`, OWNER_HANDLE } as unknown as Parameters<typeof app.request>[2];
  await services.skills.upsert(owner, { slug: "deploy-runbook", name: "Deploy Runbook", description: "how to cut a release", instructions: "1. tag\n2. build\n3. deploy" });
});
afterAll(async () => { await mf?.dispose(); });

describe("T5 skill-outcome memory (skills_log_use → success_rate)", () => {
  it("first success → success_rate 1.0, invocation_count 1; a failure pulls it to 0.5; partial recomputes", async () => {
    let r = await services.skills.logUse(owner, (await services.skills.getBySlug(OWNER, "deploy-runbook"))!.id, "success", "worked first try");
    expect(r).toEqual({ success_rate: 1.0, invocation_count: 1 });
    const id = (await services.skills.getBySlug(OWNER, "deploy-runbook"))!.id;
    r = await services.skills.logUse(owner, id, "failure", "wrong deploy order → 500");
    expect(r).toEqual({ success_rate: 0.5, invocation_count: 2 });
    r = await services.skills.logUse(owner, id, "partial");
    expect(r?.invocation_count).toBe(3);
    expect(r?.success_rate).toBeCloseTo((1 + 0 + 0.5) / 3, 5); // 0.5
    // audit rows exist with the note
    const invs = await db.prepare("SELECT outcome, note FROM skill_invocations WHERE skill_id=? ORDER BY created_at").bind(id).all<{ outcome: string; note: string | null }>();
    expect(invs.results?.map((x) => x.outcome)).toEqual(["success", "failure", "partial"]);
    expect(invs.results?.[1].note).toBe("wrong deploy order → 500");
  });

  it("logging a use does NOT bump usage_count (installs) or updated_at (edits)", async () => {
    await services.skills.upsert(owner, { slug: "quiet", name: "Quiet", description: "d", instructions: "i" });
    const before = await skillRow("quiet", OWNER);
    await services.skills.logUse(owner, (await services.skills.getBySlug(OWNER, "quiet"))!.id, "success");
    const after = await skillRow("quiet", OWNER);
    expect(after?.usage_count).toBe(before?.usage_count); // still 0 — a use is not an install
    expect(after?.updated_at).toBe(before?.updated_at); // not an edit
    expect(after?.invocation_count).toBe(1);
  });

  it("editing a skill (skills_put) PRESERVES its outcome telemetry — the wipe-on-edit data-loss class (cf. f376a5b)", async () => {
    await services.skills.upsert(owner, { slug: "edited", name: "Edited", description: "v1", instructions: "step" });
    const id = (await services.skills.getBySlug(OWNER, "edited"))!.id;
    await services.skills.logUse(owner, id, "success");
    await services.skills.logUse(owner, id, "failure");
    const beforeEdit = await skillRow("edited", OWNER);
    expect(beforeEdit).toMatchObject({ invocation_count: 2, success_rate: 0.5 });
    // an EDIT (changed body/description) must not reset the logged telemetry
    await services.skills.upsert(owner, { slug: "edited", name: "Edited", description: "v2 — new body", instructions: "step\nstep2" });
    const afterEdit = await skillRow("edited", OWNER);
    expect(afterEdit?.invocation_count).toBe(2);
    expect(afterEdit?.success_rate).toBeCloseTo(0.5, 5);
    // and the audit rows survive the edit too
    const invs = await db.prepare("SELECT COUNT(*) AS n FROM skill_invocations WHERE skill_id=?").bind(id).first<{ n: number }>();
    expect(invs?.n).toBe(2);
  });

  it("owner-only: a reader cannot log against another user's skill (service returns null)", async () => {
    const id = (await services.skills.getBySlug(OWNER, "deploy-runbook"))!.id;
    const r = await services.skills.logUse(reader, id, "success");
    expect(r).toBeNull();
  });

  it("skills_get + skills_list surface success_rate + invocation_count (MCP)", async () => {
    const got = await mcp(OWNER_BEARER, "skills_get", { slug: "deploy-runbook" });
    expect(got.invocation_count).toBe(3);
    expect(got.success_rate).toBeCloseTo(0.5, 5);
    const listed = (await mcp(OWNER_BEARER, "skills_list", {})).skills as Array<{ slug: string; success_rate: number | null; invocation_count: number }>;
    const dr = listed.find((s) => s.slug === "deploy-runbook");
    expect(dr?.invocation_count).toBe(3);
  });

  it("the MCP skills_log_use tool records end-to-end and rejects a bad outcome", async () => {
    const ok = await mcp(OWNER_BEARER, "skills_log_use", { slug: "quiet", outcome: "failure", note: "flaked" });
    expect(ok.found).toBe(true);
    expect(ok.invocation_count).toBe(2); // quiet had 1 success earlier
    expect(ok.success_rate).toBeCloseTo(0.5, 5);
    const bad = await mcp(OWNER_BEARER, "skills_log_use", { slug: "quiet", outcome: "meh" });
    expect(bad.ok).toBe(false);
  });

  it("the REST POST /skills/:slug/log-use door works and 404s an unknown skill", async () => {
    const res = await app.request("https://memory.test/api/v1/skills/deploy-runbook/log-use", { method: "POST", headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ outcome: "success" }) }, env);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; invocation_count: number };
    expect(j.ok).toBe(true);
    expect(j.invocation_count).toBe(4); // deploy-runbook: 3 + this one
    const miss = await app.request("https://memory.test/api/v1/skills/no-such/log-use", { method: "POST", headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ outcome: "success" }) }, env);
    expect(miss.status).toBe(404);
    // a bad outcome is rejected at the REST door (400) BEFORE the DB CHECK — never a 500
    const bad = await app.request("https://memory.test/api/v1/skills/deploy-runbook/log-use", { method: "POST", headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" }, body: JSON.stringify({ outcome: "meh" }) }, env);
    expect(bad.status).toBe(400);
  });
});
