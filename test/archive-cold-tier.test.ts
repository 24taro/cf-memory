// Cold-tier (archived_at) semantics — the ONE primitive kept from the removed
// curator (decision 7). Ports the surviving assertions from the deleted
// test/consolidation.test.ts and adds coverage for the NEW direct doors:
// the notes_archive MCP tool and POST /api/v1/notes/:id/archive, including
// the ownership gate (a non-owner must never archive someone else's note).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { makeServices, type Services } from "../src/services";
import { bearerKeyFixture, principalFixture, rsEnvVars } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_cold_owner";
const INTRUDER = "u_cold_intruder";
let OWNER_BEARER = "";
let INTRUDER_BEARER = "";
const owner: Principal = principalFixture({ userId: OWNER, handle: "cold-owner" });
let mf: Miniflare;
let db: D1Database;
let services: Services;
let env: Parameters<typeof app.request>[2];

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}

const row = async (slug: string) => db.prepare("SELECT id, archived_at, last_viewed_at FROM notes WHERE slug=? AND user_id=?").bind(slug, OWNER).first<{ id: string; archived_at: number | null; last_viewed_at: number | null }>();

async function mcpCall(name: string, args: Record<string, unknown>, bearer = OWNER_BEARER): Promise<Record<string, unknown>> {
  const res = await app.request(
    "https://memory.test/mcp",
    { method: "POST", headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) },
    env,
  );
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  for (const [id, handle] of [
    [OWNER, "cold-owner"],
    [INTRUDER, "cold-intruder"],
  ] as const) {
    await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(id, handle, handle, `${handle}@example.com`, "", 0, 0).run();
  }
  OWNER_BEARER = await bearerKeyFixture(db, OWNER, "notes:read,notes:write");
  INTRUDER_BEARER = await bearerKeyFixture(db, INTRUDER, "notes:read,notes:write");
  services = makeServices(db);
  env = { DB: db, ...rsEnvVars(), OWNER_EMAIL: "cold-owner@example.com", OWNER_HANDLE: "cold-owner" } as unknown as Parameters<typeof app.request>[2];
});
afterAll(async () => { await mf?.dispose(); });

describe("archived_at cold tier (kept from the removed curator)", () => {
  it("incrementView stamps last_viewed_at", async () => {
    const { note } = await services.notes.upsert(owner, { slug: "viewed-note", title: "V", body_md: "kubernetes viewedbody" });
    expect((await row("viewed-note"))?.last_viewed_at).toBeNull();
    await services.notes.incrementView(note.id);
    expect((await row("viewed-note"))?.last_viewed_at).not.toBeNull();
  });

  it("notes_archive drops the note from recall but it STAYS in search; notes_unarchive restores it", async () => {
    await services.notes.upsert(owner, { slug: "arch-note", title: "AR", body_md: "kubernetes archivedbody unique" });
    const archived = await mcpCall("notes_archive", { slug: "arch-note" });
    expect(archived.archived).toBe(true);
    const pack = await services.recall.recall(owner, "kubernetes", 4000, 8);
    expect(pack.text).not.toContain("archivedbody");
    const hits = await services.search.hybrid(owner, "kubernetes", { limit: 20 });
    expect(hits.map((h) => h.slug)).toContain("arch-note");
    const unarchived = await mcpCall("notes_unarchive", { slug: "arch-note" });
    expect(unarchived.unarchived).toBe(true);
    const pack2 = await services.recall.recall(owner, "kubernetes", 4000, 8);
    expect(pack2.text).toContain("archivedbody");
  });

  it("editing an archived note (notes_put/upsert) resurrects it — archived_at cleared", async () => {
    const { note } = await services.notes.upsert(owner, { slug: "resurrect", title: "RE", body_md: "kubernetes resurrectbody" });
    await services.notes.setArchived(owner, note.id);
    expect((await row("resurrect"))?.archived_at).not.toBeNull();
    await services.notes.upsert(owner, { slug: "resurrect", title: "RE", body_md: "kubernetes resurrectbody edited" });
    expect((await row("resurrect"))?.archived_at).toBeNull();
  });

  it("refuses to archive a core-memory block (kind='block' is outside the cold tier)", async () => {
    await services.memory.setBlock(owner, "persona", "set", "test persona block");
    const res = await mcpCall("notes_archive", { slug: "block-persona" });
    expect(res.archived).not.toBe(true);
    const blocks = await services.memory.listBlocks(owner);
    expect(blocks.map((b) => b.label)).toContain("persona");
  });

  it("REST POST /notes/:id/archive works for the owner and 404s for a non-owner (ownership gate)", async () => {
    await services.notes.upsert(owner, { slug: "rest-arch", title: "RA", body_md: "kubernetes restarchbody" });
    const target = await row("rest-arch");
    // non-owner first: must 404 and leave archived_at untouched
    const foreign = await app.request(`https://memory.test/api/v1/notes/${target!.id}/archive`, { method: "POST", headers: { get authorization() { return `Bearer ${INTRUDER_BEARER}`; } } }, env);
    expect(foreign.status).toBe(404);
    expect((await row("rest-arch"))?.archived_at).toBeNull();
    // MCP door, non-owner: archived:false
    const mcpForeign = await mcpCall("notes_archive", { id: target!.id }, INTRUDER_BEARER);
    expect(mcpForeign.archived).not.toBe(true);
    expect((await row("rest-arch"))?.archived_at).toBeNull();
    // owner succeeds
    const own = await app.request(`https://memory.test/api/v1/notes/${target!.id}/archive`, { method: "POST", headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } }, env);
    expect(own.status).toBe(200);
    expect((await row("rest-arch"))?.archived_at).not.toBeNull();
  });
});
