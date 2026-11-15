// Skill soft-delete E2E through the REAL Hono app on a Miniflare D1 with the
// full migration set (issue #36). Notes had notes_delete (MCP) / DELETE
// /api/v1/notes/:id since the start; skills had NO delete path at all in any
// door (MCP/REST/CLI) -- upsert-overwrite was the only cleanup mechanism.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { bearerKeyFixture, rsEnvVars } from "./helpers";

const OWNER = "u_owner";
const OTHER = "u_other";
let TOKEN = "";
let OTHER_TOKEN = "";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];

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

const headers = { get authorization() { return `Bearer ${TOKEN}`; }, "content-type": "application/json" };
const otherHeaders = { get authorization() { return `Bearer ${OTHER_TOKEN}`; }, "content-type": "application/json" };

async function pushSkill(slug: string, over: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await req("/api/v1/skills", { method: "POST", headers, body: JSON.stringify({ slug, name: slug, description: "a test skill", instructions: "do the thing", ...over }) });
  return res.json();
}

async function mcpCall(bearer: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await req("/mcp", {
    method: "POST",
    headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "owner@example.com", "", 0, 0).run();
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OTHER, "other", "other", "other@example.com", "", 0, 0).run();
  TOKEN = await bearerKeyFixture(db, OWNER, "notes:read,notes:write");
  OTHER_TOKEN = await bearerKeyFixture(db, OTHER, "notes:read,notes:write");
  env = { DB: db, OWNER_HANDLE: "owner", ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("DELETE /api/v1/skills/:slug (issue #36)", () => {
  it("soft-deletes the caller's own skill and removes it from GET /api/v1/skills", async () => {
    await pushSkill("del-rest-skill");
    let list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).toContain("del-rest-skill");

    const del = await req("/api/v1/skills/del-rest-skill", { method: "DELETE", headers });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).not.toContain("del-rest-skill");
  });

  it("is a soft delete, not a physical one — the row still exists in D1 with deleted_at set", async () => {
    const created = await pushSkill("del-soft-check-skill");
    await req("/api/v1/skills/del-soft-check-skill", { method: "DELETE", headers });
    const row = await db.prepare("SELECT deleted_at FROM skills WHERE id=?").bind(created.id).first<{ deleted_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
  });

  it("returns 404 deleting a not-found or already-deleted skill", async () => {
    const res1 = await req("/api/v1/skills/no-such-skill-slug", { method: "DELETE", headers });
    expect(res1.status).toBe(404);
    await pushSkill("del-twice-skill");
    await req("/api/v1/skills/del-twice-skill", { method: "DELETE", headers });
    const res2 = await req("/api/v1/skills/del-twice-skill", { method: "DELETE", headers });
    expect(res2.status).toBe(404);
  });

  it("cannot delete another owner's skill", async () => {
    await pushSkill("del-owner-only-skill");
    const res = await req("/api/v1/skills/del-owner-only-skill", { method: "DELETE", headers: otherHeaders });
    expect(res.status).toBe(404);
    const list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).toContain("del-owner-only-skill");
  });

  it("re-pushing (upsert) the same slug after deletion resurrects it (mirrors notes.upsert's deleted_at=NULL behavior)", async () => {
    await pushSkill("del-resurrect-skill");
    await req("/api/v1/skills/del-resurrect-skill", { method: "DELETE", headers });
    let list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).not.toContain("del-resurrect-skill");

    await pushSkill("del-resurrect-skill", { description: "resurrected" });
    list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).toContain("del-resurrect-skill");
  });
});

describe("MCP skills_delete (issue #36)", () => {
  it("soft-deletes via MCP and it disappears from skills_list", async () => {
    await mcpCall(TOKEN, "skills_put", { slug: "del-mcp-skill", name: "del-mcp-skill", description: "d", instructions: "i" });
    const del = await mcpCall(TOKEN, "skills_delete", { slug: "del-mcp-skill" });
    expect(del.deleted).toBe(true);
    const list = await mcpCall(TOKEN, "skills_list", {});
    expect((list.skills ?? []).map((s: { slug: string }) => s.slug)).not.toContain("del-mcp-skill");
  });

  it("skills_get on a deleted skill reports not found", async () => {
    await mcpCall(TOKEN, "skills_put", { slug: "del-mcp-get-skill", name: "x", description: "d", instructions: "i" });
    await mcpCall(TOKEN, "skills_delete", { slug: "del-mcp-get-skill" });
    const got = await mcpCall(TOKEN, "skills_get", { slug: "del-mcp-get-skill" });
    expect(got.found).toBe(false);
  });
});

describe("deleted skill's web door 404s (issue #36)", () => {
  it("GET /@handle/skills/:slug/SKILL.md and /@handle/skills/:slug 404 after deletion", async () => {
    await pushSkill("del-web-skill");
    expect((await req("/@owner/skills/del-web-skill/SKILL.md", { headers })).status).toBe(200);
    await req("/api/v1/skills/del-web-skill", { method: "DELETE", headers });
    expect((await req("/@owner/skills/del-web-skill/SKILL.md", { headers })).status).toBe(404);
    expect((await req("/@owner/skills/del-web-skill", { headers })).status).toBe(404);
  });

  // review r1 fix: softDelete() only removed the skills_fts row, but the skill
  // table config in search.ts still had soft:false, so semantic/hybrid search
  // never filtered deleted_at and kept surfacing a "deleted" skill's content.
  it("no longer appears in scope=skills search (hybrid, the default mode)", async () => {
    await pushSkill("del-search-skill", { description: "a uniquely searchable pangolin description" });
    let hits = (await (await req("/api/v1/search?q=pangolin&scope=skills", { headers })).json()) as { hits: Array<{ slug: string }> };
    expect(hits.hits.map((h) => h.slug)).toContain("del-search-skill");

    await req("/api/v1/skills/del-search-skill", { method: "DELETE", headers });
    hits = (await (await req("/api/v1/search?q=pangolin&scope=skills", { headers })).json()) as { hits: Array<{ slug: string }> };
    expect(hits.hits.map((h) => h.slug)).not.toContain("del-search-skill");
  });

  it("disappears from the index.md profile listing", async () => {
    await pushSkill("del-profile-skill");
    expect(await (await req("/@owner/index.md", { headers })).text()).toContain("del-profile-skill");
    await req("/api/v1/skills/del-profile-skill", { method: "DELETE", headers });
    expect(await (await req("/@owner/index.md", { headers })).text()).not.toContain("del-profile-skill");
  });
});

describe("fork lineage when a parent skill is deleted (issue #36)", () => {
  it("a forked child is unaffected and keeps parent_skill_id pointing at the deleted parent (no cascade, pure lineage record)", async () => {
    const parent = await pushSkill("del-fork-parent-skill");
    const forkRes = await req("/api/v1/@owner/skills/del-fork-parent-skill/fork", { method: "POST", headers, body: JSON.stringify({ new_slug: "del-fork-child-skill" }) });
    expect(forkRes.status).toBe(201);

    await req("/api/v1/skills/del-fork-parent-skill", { method: "DELETE", headers });

    // Child is fully unaffected: still readable, still in the list.
    const childGet = await req("/@owner/skills/del-fork-child-skill", { headers });
    expect(childGet.status).toBe(200);
    const list = (await (await req("/api/v1/skills", { headers })).json()) as { skills: Array<{ slug: string }> };
    expect(list.skills.map((s) => s.slug)).toContain("del-fork-child-skill");

    // parent_skill_id is left unchanged, still pointing at the (now-deleted) parent.
    const childRow = await db.prepare("SELECT parent_skill_id FROM skills WHERE slug=? AND user_id=?").bind("del-fork-child-skill", OWNER).first<{ parent_skill_id: string | null }>();
    expect(childRow?.parent_skill_id).toBe(parent.id);
    const parentRow = await db.prepare("SELECT deleted_at FROM skills WHERE id=?").bind(parent.id).first<{ deleted_at: number | null }>();
    expect(parentRow?.deleted_at).not.toBeNull();
  });
});
