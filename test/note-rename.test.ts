// fidelity C5: note rename + slug_redirects. The slug_redirects table (migration
// 0001) existed unused; there was no rename op. rename() moves the row IN PLACE
// (note id stable, so resolved wikilinks/backlinks — keyed by target_note_id —
// survive) and records old_slug -> new_note_id so the old URL 301s to the note's
// CURRENT slug (a rename chain resolves in one hop). Drives the real app + a
// Miniflare D1 (mirroring skill-usage.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { handleMcp } from "../src/mcp";
import { makeServices, type Services } from "../src/services";
import { bearerKeyFixture, principalFixture, rsEnvVars } from "./helpers";
import type { Principal } from "../src/types";

const OWNER = "u_rn_owner";
const OWNER_HANDLE = "rn-owner";
let OWNER_BEARER = "";
const OTHER = "u_rn_other";
let OTHER_BEARER = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let services: Services;
const p = (): Principal => principalFixture({ userId: OWNER, handle: OWNER_HANDLE });

async function applyMigrations(database: D1Database): Promise<void> {
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
      if (s) await database.prepare(s).run();
    }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

async function insertUser(id: string, handle: string): Promise<string> {
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, handle, handle, `${handle}@example.com`, "", 0, 0)
    .run();
  return await bearerKeyFixture(db, id, "notes:read,notes:write");
}

async function mkNote(slug: string, body = "body"): Promise<string> {
  const { note } = await services.notes.upsert(p(), { slug, title: slug, body_md: body });
  return note.id;
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = { principal: p(), services: services as never, budget: 2000 };
  const r = new Request("http://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcp(r, ctx as never);
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  OWNER_BEARER = await insertUser(OWNER, OWNER_HANDLE);
  OTHER_BEARER = await insertUser(OTHER, "rn-other");
  env = { DB: db, OWNER_HANDLE, ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
  services = makeServices(db);
});

afterAll(async () => {
  await mf?.dispose();
});

describe("NotesRepo.rename", () => {
  it("moves the row in place (same id, new slug) and records a slug_redirect", async () => {
    const id = await mkNote("rn-a");
    const r = await services.notes.rename(p(), "rn-a", "rn-a2");
    expect(r.ok).toBe(true);
    expect(await services.notes.getRowBySlug(OWNER, "rn-a")).toBeNull();
    const moved = await services.notes.getRowBySlug(OWNER, "rn-a2");
    expect(moved?.id).toBe(id); // same row, stable id
    const redir = await db.prepare("SELECT new_note_id FROM slug_redirects WHERE user_id=? AND old_slug=?").bind(OWNER, "rn-a").first<{ new_note_id: string }>();
    expect(redir?.new_note_id).toBe(id);
  });

  it("refuses to clobber a live note at the new slug", async () => {
    await mkNote("rn-keep");
    const id = await mkNote("rn-move");
    const r = await services.notes.rename(p(), "rn-move", "rn-keep");
    expect(r).toMatchObject({ ok: false, reason: "slug taken" });
    // both originals intact; no redirect written for rn-move
    expect((await services.notes.getRowBySlug(OWNER, "rn-move"))?.id).toBe(id);
    expect(await db.prepare("SELECT 1 FROM slug_redirects WHERE user_id=? AND old_slug=?").bind(OWNER, "rn-move").first()).toBeNull();
  });

  it("treats a SOFT-DELETED note at the new slug as taken (no UNIQUE-constraint 500)", async () => {
    const deadId = await mkNote("sd-dead");
    expect(await services.notes.softDelete(p(), deadId)).toBe(true); // slug stays occupied by the tombstone
    const liveId = await mkNote("sd-live");
    const r = await services.notes.rename(p(), "sd-live", "sd-dead");
    expect(r).toMatchObject({ ok: false, reason: "slug taken" }); // graceful, not a thrown 500
    expect((await services.notes.getRowBySlug(OWNER, "sd-live"))?.id).toBe(liveId); // unchanged
  });

  it("rejects same-slug and missing-note renames", async () => {
    await mkNote("rn-same");
    expect(await services.notes.rename(p(), "rn-same", "rn-same")).toMatchObject({ ok: false, reason: "same slug" });
    expect(await services.notes.rename(p(), "rn-ghost", "rn-x")).toMatchObject({ ok: false, reason: "no such note" });
  });

  it("keeps inbound resolved wikilinks pointing at the renamed note (id stable)", async () => {
    const targetId = await mkNote("rn-target");
    const srcId = await mkNote("rn-src", "see [[rn-target]] for details");
    // the wikilink resolved to the target's id at write time
    const before = await db.prepare("SELECT target_note_id FROM links WHERE src_note_id=? AND target_slug=?").bind(srcId, "rn-target").first<{ target_note_id: string }>();
    expect(before?.target_note_id).toBe(targetId);
    await services.notes.rename(p(), "rn-target", "rn-target-moved");
    const after = await db.prepare("SELECT target_note_id FROM links WHERE src_note_id=? AND target_slug=?").bind(srcId, "rn-target").first<{ target_note_id: string }>();
    expect(after?.target_note_id).toBe(targetId); // unchanged — link still resolves to the (renamed) note
  });
});

describe("web GET follows the rename redirect (301)", () => {
  it("301s the old slug (and its .md twin) to the note's current slug", async () => {
    await mkNote("rn-web");
    await services.notes.rename(p(), "rn-web", "rn-web2");

    const html = await req(`/@${OWNER_HANDLE}/n/rn-web`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(html.status).toBe(301);
    expect(html.headers.get("location")).toBe(`/@${OWNER_HANDLE}/n/rn-web2`);

    const md = await req(`/@${OWNER_HANDLE}/n/rn-web.md`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(md.status).toBe(301);
    expect(md.headers.get("location")).toBe(`/@${OWNER_HANDLE}/n/rn-web2.md`);
  });

  it("resolves a rename CHAIN A->B->C to C in a single hop", async () => {
    await mkNote("rn-c1");
    await services.notes.rename(p(), "rn-c1", "rn-c2");
    await services.notes.rename(p(), "rn-c2", "rn-c3");
    for (const old of ["rn-c1", "rn-c2"]) {
      const res = await req(`/@${OWNER_HANDLE}/n/${old}`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`/@${OWNER_HANDLE}/n/rn-c3`);
    }
  });

  it("does NOT leak a note's rename via 301 to non-owners (owner-only, decision 9; owner still redirected)", async () => {
    await mkNote("priv-orig", "secret body");
    await services.notes.rename(p(), "priv-orig", "priv-new");

    // a DIFFERENT authenticated user: the old slug must stay an indistinguishable
    // 404, never a 301 that would disclose the note's existence + new slug.
    const other = await req(`/@${OWNER_HANDLE}/n/priv-orig`, { headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } } });
    expect(other.status).toBe(404);
    expect(other.headers.get("location")).toBeNull();
    const otherMd = await req(`/@${OWNER_HANDLE}/n/priv-orig.md`, { headers: { get authorization() { return `Bearer ${OTHER_BEARER}`; } } });
    expect(otherMd.status).toBe(404);

    // anonymous never even reaches the resolver — the fail-closed gate 401s first.
    const anon = await req(`/@${OWNER_HANDLE}/n/priv-orig`);
    expect(anon.status).toBe(401);

    // the owner CAN still use the redirect (they can read the note).
    const owner = await req(`/@${OWNER_HANDLE}/n/priv-orig`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(owner.status).toBe(301);
    expect(owner.headers.get("location")).toBe(`/@${OWNER_HANDLE}/n/priv-new`);
  });

  it("a live note that reoccupies a former redirect slug wins (no 301 loop)", async () => {
    const firstId = await mkNote("rn-loop");
    await services.notes.rename(p(), "rn-loop", "rn-loop2"); // redirect rn-loop -> firstId
    const secondId = await mkNote("rn-fresh");
    await services.notes.rename(p(), "rn-fresh", "rn-loop"); // rn-loop is now a LIVE note (secondId)
    const res = await req(`/@${OWNER_HANDLE}/n/rn-loop`, { headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; } } });
    expect(res.status).toBe(200); // served live, not redirected
    expect(secondId).not.toBe(firstId);
    // the stale redirect keyed on rn-loop was cleared
    expect(await db.prepare("SELECT 1 FROM slug_redirects WHERE user_id=? AND old_slug=?").bind(OWNER, "rn-loop").first()).toBeNull();
  });
});

describe("MCP + REST rename doors", () => {
  it("MCP notes_rename renames and reports slug-taken", async () => {
    await mkNote("rn-mcp");
    expect(await mcpCall("notes_rename", { slug: "rn-mcp", new_slug: "rn-mcp2" })).toMatchObject({ ok: true, slug: "rn-mcp2" });
    await mkNote("rn-mcp-occupied");
    await mkNote("rn-mcp-src");
    expect(await mcpCall("notes_rename", { slug: "rn-mcp-src", new_slug: "rn-mcp-occupied" })).toMatchObject({ ok: false, reason: "slug taken" });
  });

  it("REST POST /notes/:slug/rename renames and validates input", async () => {
    await mkNote("rn-rest");
    const ok = await req(`/api/v1/notes/rn-rest/rename`, {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
      body: JSON.stringify({ new_slug: "rn-rest2" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, slug: "rn-rest2" });

    const bad = await req(`/api/v1/notes/rn-rest2/rename`, {
      method: "POST",
      headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });
});
