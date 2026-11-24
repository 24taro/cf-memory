// Security regression: read-scope enforcement is default-on at every door.
//   src/mcp.ts:TOOLS:read-tools-without-scope
//   src/index.tsx:requireRead:opt-in-read-scope
// A Bearer principal whose introspected scope set lacks notes:read reads no
// stored memory through MCP, REST or the web GET routes. Dummy principals only;
// the AUTH binding is the in-process stub from ../helpers; local Miniflare D1.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/index";
import { MCP_TOOL_SCOPES, toolScopeRefusal } from "../../src/mcp";
import { TEST_RESOURCE, accessEnvVars, applyMainMigrations, bearerTokenFor, principalFixture, rsEnvVars, setupAccessAuth } from "../helpers";

const ALICE = { id: "u_alice", handle: "alice", email: "alice@example.com", account: "01KRSCALICE0000000000000000" };
const BOB = { id: "u_bob", handle: "bob", email: "bob@example.com", account: "01KRSCBOB00000000000000000" };
const BODY = "PROBE-BODY-7f3a";
const BLOCK = "PROBE-BLOCK-7f3a";
const SKILL = "PROBE-SKILL-7f3a";
const FILE = "PROBE-FILE-7f3a";
const MARKERS = [BODY, BLOCK, SKILL, FILE, "alice-secret", "alice-followup", "alice-skill"];
const FORBIDDEN = "Forbidden: missing scope 'notes:read'";
const READ_403 = "forbidden: notes:read scope required";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
let full: string, writeOnly: string, noScope: string, readOnly: string;
const id: Record<string, string> = {};

async function req(path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.request(`https://memory.test${path}`, { ...init, headers }, env);
}
const post = (path: string, token: string, body: unknown) =>
  req(path, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** tools/call through the real /mcp route. Returns the tool text, flagged when isError. */
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ http: number; isError: boolean; text: string }> {
  const res = await post("/mcp", token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return { http: res.status, isError: true, text: raw }; }
  if (body.error) return { http: res.status, isError: true, text: `rpc-error: ${body.error.message}` };
  if (!body.result) return { http: res.status, isError: true, text: raw };
  return { http: res.status, isError: body.result.isError === true, text: body.result.content?.[0]?.text ?? "" };
}

const views = async () => (await db.prepare("SELECT view_count AS n FROM notes WHERE id=?").bind(id.secret).first<{ n: number }>())!.n;
const skillRow = async () => JSON.stringify(await db.prepare("SELECT * FROM skills WHERE id=?").bind(id.skill).first());

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"], r2Buckets: ["BUNDLES"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMainMigrations(db);
  for (const p of [ALICE, BOB]) {
    await db
      .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at,auth_user_id) VALUES (?,?,?,?,'',0,0,?)")
      .bind(p.id, p.handle, p.handle, p.email, p.account)
      .run();
  }
  env = { DB: db, BUNDLES: await mf.getR2Bucket("BUNDLES"), OWNER_HANDLE: ALICE.handle, ...accessEnvVars(ALICE.email), ...rsEnvVars() } as unknown as Parameters<typeof app.request>[2];
  jwtFor = await setupAccessAuth();

  const alice = (scopes: string) => bearerTokenFor({ sub: `user:${ALICE.account}`, aud: TEST_RESOURCE, scopes, email: ALICE.email });
  full = await alice("notes:read notes:write");
  writeOnly = await alice("notes:write");
  noScope = await alice("");
  readOnly = await alice("notes:read");

  const secret = await post("/api/v1/notes", full, { slug: "alice-secret", title: "Alice pangolin plan", body_md: `${BODY} private. See [[alice-followup]].`, tags: ["probe"] });
  expect(secret.status).toBeLessThan(300);
  id.secret = ((await secret.json()) as { id: string }).id;
  const followup = await post("/api/v1/notes", full, { slug: "alice-followup", title: "Alice followup", body_md: "the target, back to [[alice-secret]]" });
  id.followup = ((await followup.json()) as { id: string }).id;
  const block = await mcp(full, "memory_set", { label: "probe", value: BLOCK });
  expect(block.isError, block.text).toBe(false);
  const skill = await post("/api/v1/skills", full, { slug: "alice-skill", skill_md: `---\nname: alice-skill\ndescription: alice's private skill\n---\n${SKILL}` });
  expect(skill.status).toBeLessThan(300);
  const got = await mcp(full, "skills_get", { slug: "alice-skill" });
  id.skill = JSON.parse(got.text).id;
  const file = await mcp(full, "skills_file_create", { id: id.skill, path: "references/probe.txt", content_base64: btoa(FILE), content_type: "text/plain" });
  expect(file.isError, file.text).toBe(false);
}, 60000);

afterAll(async () => { await mf?.dispose(); });

const LACKING = [["notes:write only", () => writeOnly], ["empty scope set", () => noScope]] as const;

// ---------------------------------------------------------------------------
// 1. MCP: every tool declares its scope; read tools need notes:read
// ---------------------------------------------------------------------------
const READ_TOOLS: Array<[string, Record<string, unknown>, string]> = [
  ["recall", { query: BODY }, BODY],
  ["notes_search", { q: BODY }, "alice-secret"],
  ["notes_get", { slug: "alice-secret" }, BODY],
  ["notes_get_many", { slugs: ["alice-secret"] }, BODY],
  ["notes_list", {}, "alice-secret"],
  ["notes_backlinks", { slug: "alice-followup" }, "alice-secret"],
  ["notes_links", { slug: "alice-secret" }, "alice-followup"],
  ["memory_get", {}, BLOCK],
  ["skills_list", {}, "alice-skill"],
  ["skills_get", { slug: "alice-skill" }, SKILL],
  ["skills_install", { slug: "alice-skill" }, SKILL],
  ["skills_file_read", { slug: "alice-skill", path: "references/probe.txt" }, FILE],
  ["build_prompt", { query: BODY }, BLOCK],
];

describe("MCP read scope (src/mcp.ts:TOOLS:read-tools-without-scope)", () => {
  it("every tool in the table declares its scope explicitly", () => {
    expect(MCP_TOOL_SCOPES.length).toBeGreaterThan(40);
    const undeclared = MCP_TOOL_SCOPES.filter((t) => !["notes:read", "notes:write", "admin", "none"].includes(t.scope as string)).map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it("'none' is reserved for tools that return no stored memory", () => {
    // Adding a name here is a decision that the tool hands back nothing stored.
    expect(MCP_TOOL_SCOPES.filter((t) => t.scope === "none").map((t) => t.name)).toEqual(["whoami"]);
    const declared = new Map(MCP_TOOL_SCOPES.map((t) => [t.name, t.scope]));
    for (const [name] of READ_TOOLS) expect(declared.get(name), name).toBe("notes:read");
  });

  it("the dispatcher refuses a tool that declares no scope, for any caller", () => {
    const everything = principalFixture({ scopes: new Set(["notes:read", "notes:write", "admin"]) });
    const human = principalFixture({ authSource: "access", scopes: new Set() });
    for (const tool of [{}, { scope: undefined }, { scope: "" }, { scope: "notes:delete" }]) {
      expect(toolScopeRefusal(tool, everything)).toMatch(/^Forbidden/);
      expect(toolScopeRefusal(tool, human)).toMatch(/^Forbidden/);
    }
    expect(toolScopeRefusal({ scope: "none" }, principalFixture({ scopes: new Set() }))).toBeNull();
    expect(toolScopeRefusal({ scope: "notes:read" }, principalFixture({ scopes: new Set(["notes:write"]) }))).toBe(FORBIDDEN);
    expect(toolScopeRefusal({ scope: "notes:read" }, principalFixture({ scopes: new Set(["notes:read"]) }))).toBeNull();
    expect(toolScopeRefusal({ scope: "notes:read" }, human)).toBeNull();
  });

  for (const [label, token] of LACKING) {
    for (const [name, args] of READ_TOOLS) {
      it(`${name} refuses a Bearer token with ${label}`, async () => {
        const out = await mcp(token(), name, args);
        expect(out.isError, out.text).toBe(true);
        expect(out.text).toBe(FORBIDDEN);
      });
    }

    it(`no tool in the table hands stored content to a Bearer token with ${label}`, async () => {
      // Empty arguments reach the scope check before any argument validation.
      for (const t of MCP_TOOL_SCOPES) {
        if (t.scope !== "notes:read") continue;
        const out = await mcp(token(), t.name, {});
        expect(out.text, t.name).toBe(FORBIDDEN);
      }
    });

    it(`tools/list marks the read tools unavailable for a Bearer token with ${label}`, async () => {
      const res = await post("/mcp", token(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = ((await res.json()) as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
      for (const [name] of READ_TOOLS) {
        expect(tools.find((t) => t.name === name)!.description, name).toMatch(/^\[unavailable to you — requires 'notes:read' scope/);
      }
      expect(tools.find((t) => t.name === "whoami")!.description).not.toMatch(/^\[unavailable/);
    });

    it(`notes_get writes no view counter and skills_install no use for a Bearer token with ${label}`, async () => {
      const [v, s] = [await views(), await skillRow()];
      expect((await mcp(token(), "notes_get", { slug: "alice-secret" })).isError).toBe(true);
      expect((await mcp(token(), "notes_get_many", { slugs: ["alice-secret"] })).isError).toBe(true);
      expect((await mcp(token(), "skills_install", { slug: "alice-skill" })).isError).toBe(true);
      expect(await views()).toBe(v);
      expect(await skillRow()).toBe(s);
    });

    it(`whoami still answers a Bearer token with ${label}`, async () => {
      const out = await mcp(token(), "whoami", {});
      expect(out.isError, out.text).toBe(false);
      expect(JSON.parse(out.text).handle).toBe("alice");
      expect(JSON.parse(out.text).scopes).not.toContain("notes:read");
    });
  }

  it("a notes:read-only token is served by every read tool, including the two that write counters", async () => {
    const [v, s] = [await views(), await skillRow()];
    for (const [name, args, marker] of READ_TOOLS) {
      const out = await mcp(readOnly, name, args);
      expect(out.isError, `${name}: ${out.text}`).toBe(false);
      expect(out.text, name).toContain(marker);
    }
    // notes_get and notes_get_many each count a view (recall's own counting is
    // not pinned here); skills_install records a use.
    expect(await views()).toBeGreaterThanOrEqual(v + 2);
    expect(await skillRow()).not.toBe(s);
  });

  it("a notes:read-only token still cannot write", async () => {
    const out = await mcp(readOnly, "notes_put", { slug: "nope", body_md: "x" });
    expect(out.text).toBe("Forbidden: missing scope 'notes:write'");
  });

  it("a write-only token keeps its write tools", async () => {
    const out = await mcp(writeOnly, "notes_put", { slug: "write-only-probe", title: "w", body_md: "written without read" });
    expect(out.isError, out.text).toBe(false);
  });

  it("the human (Access) door reads through MCP as before", async () => {
    const res = await req("/mcp", undefined, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `CF_Authorization=${await jwtFor(ALICE.email)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_get", arguments: { slug: "alice-secret" } } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[0].text).toContain(BODY);
  });
});

// ---------------------------------------------------------------------------
// 2. REST + web: notes:read is required once, for every authenticated GET/HEAD
// ---------------------------------------------------------------------------
const PROBES: Array<[string, () => string, string]> = [
  ["GET /api/v1/@h/n/:slug", () => "/api/v1/@alice/n/alice-secret", BODY],
  ["GET /api/v1/notes/:id/links", () => `/api/v1/notes/${id.secret}/links`, "alice-followup"],
  ["GET /api/v1/notes/:id/backlinks", () => `/api/v1/notes/${id.followup}/backlinks`, "alice-secret"],
  ["GET /api/v1/@h/skills/:slug", () => "/api/v1/@alice/skills/alice-skill", SKILL],
  ["GET /api/v1/@h/skills/:slug/install", () => "/api/v1/@alice/skills/alice-skill/install", SKILL],
  ["GET /api/v1/@h/graph", () => "/api/v1/@alice/graph", "alice-secret"],
  ["GET /search (web)", () => `/search?q=${BODY}`, "alice-secret"],
  ["GET /@h (web profile)", () => "/@alice", "alice-secret"],
  ["GET /@h/n/:slug (web page)", () => "/@alice/n/alice-secret", BODY],
  ["GET /@h/n/:slug.md (web twin)", () => "/@alice/n/alice-secret.md", BODY],
  ["GET /@h/index.md", () => "/@alice/index.md", "alice-secret"],
  ["GET /@h/changes", () => "/@alice/changes", "alice-secret"],
  ["GET /@h/changes.md", () => "/@alice/changes.md", "alice-secret"],
  ["GET /@h/feed.xml", () => "/@alice/feed.xml", "alice-secret"],
  ["GET /@h/network.md", () => "/@alice/network.md", "alice-secret"],
  ["GET /@h/ranking.md", () => "/@alice/ranking.md", "alice-secret"],
  ["GET /@h/tags/:tag", () => "/@alice/tags/probe", "alice-secret"],
  ["GET /@h/skills", () => "/@alice/skills", "alice-skill"],
  ["GET /@h/skills/:slug", () => "/@alice/skills/alice-skill", SKILL],
  ["GET /@h/skills/:slug/SKILL.md", () => "/@alice/skills/alice-skill/SKILL.md", SKILL],
  ["GET /@h/skills/:slug/files/:path", () => "/@alice/skills/alice-skill/files/references/probe.txt", FILE],
];

/** GET routes that return no stored memory, so a token without notes:read may call them. */
const EXEMPT_GETS = [
  "/api/v1/whoami",
  "/api/v1/openapi",
  "/mcp",
  "/access",
  "/access/login",
  "/.well-known/oauth-protected-resource/mcp",
];

/** A concrete URL for a registered route pattern, pointed at the seeded rows. */
function concrete(pattern: string): string {
  return pattern
    .replace(/:h\{[^}]*\}/g, "@alice")
    .replace(/:path\{[^}]*\}/g, "references/probe.txt")
    .replace(/:slug\b/g, pattern.includes("/skills/") ? "alice-skill" : "alice-secret")
    .replace(/:id\b/g, id.secret)
    .replace(/:kind\b/g, "note")
    .replace(/:[a-z_]+(\{[^}]*\})?/g, "x");
}
const routes = (method: string) =>
  [...new Set(app.routes.filter((r) => (r.method === method || r.method === "ALL") && r.path !== "*" && r.path !== "/*").map((r) => r.path))];

describe("REST and web read scope (src/index.tsx:requireRead:opt-in-read-scope)", () => {
  for (const [label, token] of LACKING) {
    for (const [route, path, marker] of PROBES) {
      it(`${route} refuses a Bearer token with ${label}`, async () => {
        const res = await req(path(), token());
        const text = await res.text();
        expect(res.status).toBe(403);
        expect(text).toContain(READ_403);
        expect(text).not.toContain(marker);
      });
    }

    it(`every registered GET route outside the allowlist refuses a Bearer token with ${label}`, async () => {
      const walked = routes("GET");
      expect(walked.length).toBeGreaterThan(50);
      for (const exempt of EXEMPT_GETS) expect(walked, exempt).toContain(exempt);
      for (const pattern of walked) {
        const res = await req(concrete(pattern), token());
        const text = await res.text();
        if (EXEMPT_GETS.includes(pattern)) {
          expect(text, pattern).not.toContain(READ_403);
        } else {
          expect(res.status, pattern).toBe(403);
          expect(text, pattern).toContain(READ_403);
        }
        for (const marker of MARKERS.filter((m) => m.startsWith("PROBE-"))) expect(text, pattern).not.toContain(marker);
      }
    });

    it(`HEAD is covered like GET for a Bearer token with ${label}`, async () => {
      for (const path of ["/api/v1/@alice/n/alice-secret", "/@alice/n/alice-secret.md", "/api/v1/@alice/skills/alice-skill/install"]) {
        expect((await req(path, token(), { method: "HEAD" })).status, path).toBe(403);
      }
    });

    it(`no registered non-GET route serves a Bearer token with ${label === "empty scope set" ? label : "notes:write only on a read route"}`, async () => {
      // The read routes that are POSTs keep their own check; /mcp is gated per tool.
      for (const path of ["/api/v1/recall", "/api/v1/prompt"]) {
        const res = await post(path, token(), { query: BODY });
        expect(res.status, path).toBe(403);
        expect(await res.text()).not.toContain(BODY);
      }
      if (label !== "empty scope set") return;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const pattern of routes(method).filter((p) => p !== "/mcp")) {
          const res = await req(concrete(pattern), token(), { method, headers: { "content-type": "application/json" }, body: "{}" });
          expect([401, 403], `${method} ${pattern} -> ${res.status}`).toContain(res.status);
        }
      }
    });

    it(`GET .../install records no skill use and a note page no view for a Bearer token with ${label}`, async () => {
      const [v, s] = [await views(), await skillRow()];
      expect((await req("/api/v1/@alice/skills/alice-skill/install", token())).status).toBe(403);
      expect((await req("/@alice/n/alice-secret", token())).status).toBe(403);
      expect((await req(`/api/v1/notes/${id.secret}`, token())).status).toBe(403);
      expect(await views()).toBe(v);
      expect(await skillRow()).toBe(s);
    });

    it(`the routes that return no stored memory still answer a Bearer token with ${label}`, async () => {
      const who = await req("/api/v1/whoami", token());
      expect(who.status).toBe(200);
      expect(((await who.json()) as { handle: string }).handle).toBe("alice");
      expect((await req("/api/v1/openapi", token())).status).toBe(200);
      expect((await req("/.well-known/oauth-protected-resource/mcp", token())).status).toBe(200);
      expect((await req("/access", token())).status).toBe(302);
    });
  }

  it("a notes:read-only token is served by every probed route, and install still records the use", async () => {
    const s = await skillRow();
    for (const [route, path, marker] of PROBES) {
      const res = await req(path(), readOnly);
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toContain(marker);
    }
    expect(await skillRow()).not.toBe(s);
  });

  it("a full-scope token meets the read-scope refusal on no registered GET route", async () => {
    for (const pattern of routes("GET")) {
      expect(await (await req(concrete(pattern), full)).text(), pattern).not.toContain(READ_403);
    }
  });

  it("the web memory page stays browser-session only: 403 for every Bearer token", async () => {
    for (const token of [writeOnly, noScope, readOnly, full]) {
      const res = await req("/@alice/memory", token);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(BLOCK);
    }
  });

  it("the human (Access) door reads as before, with no scopes on the principal", async () => {
    const cookie = { cookie: `CF_Authorization=${await jwtFor(ALICE.email)}` };
    for (const [route, path, marker] of PROBES) {
      const res = await req(path(), undefined, { headers: cookie });
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toContain(marker);
    }
    const memory = await req("/@alice/memory", undefined, { headers: cookie });
    expect(memory.status).toBe(200);
    expect(await memory.text()).toContain(BLOCK);
  });

  it("an anonymous caller still gets 401, not the scope refusal", async () => {
    const res = await req("/api/v1/@alice/n/alice-secret");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. Write-scoped operations hand no stored content to a token without notes:read
//    (review follow-up: memory_append / memory_replace / PATCH memory/blocks
//    returned the stored block). Runs last: the calls below change the seeded rows.
// ---------------------------------------------------------------------------
const HEX = "ab".repeat(32);
const TITLE = "PROBE-TITLE-7f3a";
const TEAM_TITLE = "PROBE-TEAMTITLE-7f3a";
const TEAM_BODY = "PROBE-TEAMBODY-7f3a";
const SKILL_NAME = "PROBE-SKILL-NAME-7f3a";
const STORED = [BODY, BLOCK, SKILL, FILE, TITLE, TEAM_TITLE, TEAM_BODY, SKILL_NAME];
const BOGUS_GUARD = { id: "x", content_hash: "x", scope: "global", shared: false, updated_at: 0, provenance_count: 0 };
const PROV = { source_event_ids: [HEX], generated_by: "probe", confidence: 0.5, rationale: "probe" };

/** Every write-scoped tool, with arguments that reach its handler and point at
 * the seeded rows. Ordered so the calls that read back come before the ones
 * that replace or delete what they would read. */
const WRITE_CALLS = (): Array<[string, Record<string, unknown>]> => [
  ["memory_replace", { label: "probe", find: "zzzz-nomatch", replace: "y" }],
  ["memory_append", { label: "probe", value: "" }],
  ["memory_append", { label: "probe", value: "more", char_limit: 1 }],
  ["memory_set", { label: "probe", value: "mine", create_only: true }],
  ["memory_set", { label: "probe", value: "x".repeat(40), char_limit: 5 }],
  ["notes_append", { slug: "alice-secret", text: "" }],
  ["notes_append", { slug: "alice-secret", text: "more", expected_content_hash: "stale" }],
  ["notes_append", { slug: "block-probe", text: "" }],
  ["notes_append", { slug: "team-probe", text: "more" }],
  ["notes_append_guarded", { slug: "alice-secret", text: "more", append_id: HEX, append_guard: { ...BOGUS_GUARD, id: id.secret }, provenance: PROV }],
  ["notes_update_text", { slug: "alice-secret", body_md: "x", update_guard: { ...BOGUS_GUARD, id: id.secret } }],
  ["notes_put", { slug: "alice-secret", body_md: "x", create_only: true }],
  ["notes_put", { slug: "titled-probe", body_md: "replaced without a title" }],
  ["notes_put", { slug: "team-probe", type: "project", body_md: "replaced without a title" }],
  ["notes_put", { slug: "alice-followup", body_md: "x", supersedes: "alice-secret" }],
  ["notes_rename", { slug: "alice-followup", new_slug: "alice-secret" }],
  ["notes_archive", { slug: "alice-secret" }],
  ["notes_unarchive", { slug: "alice-secret" }],
  ["notes_delete", { slug: "alice-secret", deletion_guard: { ...BOGUS_GUARD, id: id.secret } }],
  ["notes_delete", { id: id.secret, deletion_guard: { ...BOGUS_GUARD, id: id.secret }, retraction_id: HEX, provenance: PROV }],
  ["provenance_attach", { memory_id: id.secret, source_event_ids: [HEX] }],
  ["memory_import_provenance", { kind: "note", id: id.secret, expected_content_hash: "x", expected_scope: "global", origin: "probe", snapshots: [] }],
  ["capture_put", { id: HEX, session_id: "probe-session", payload_hash: HEX, payload_redacted: { note: "probe" } }],
  ["capture_checkpoint", { source_event_ids: [HEX], mode: "shadow" }],
  ["capture_session_end", { session_id: "probe-session" }],
  ["client_heartbeat", { client_id: "probe-client" }],
  ["log_append", { entries: [{ id: "probe-entry-1", session_id: "probe-session", kind: "prompt", text: "hello", ts: 1 }] }],
  ["skills_log_use", { slug: "alice-skill", outcome: "success" }],
  ["skills_file_create", { id: id.skill, path: "references/probe.txt", content_base64: btoa("other"), content_type: "text/plain" }],
  ["skills_fork", { slug: "alice-skill", new_slug: "alice-skill-fork" }],
  ["skills_put", { slug: "alice-skill", description: "changed" }],
  ["skills_delete", { slug: "alice-skill" }],
  ["notes_delete", { slug: "alice-secret" }],
];

/** Non-GET routes with a body that reaches the handler (the walk sends `{}` to the rest). */
const WRITE_ROUTES = (): Array<[string, string, unknown]> => [
  ["PATCH", "/api/v1/memory/blocks/probe", { op: "replace", value: "y", replace: "zzzz-nomatch" }],
  ["PATCH", "/api/v1/memory/blocks/probe", { op: "append", value: "" }],
  ["PATCH", "/api/v1/memory/blocks/probe", { op: "append", value: "more", char_limit: 1 }],
  ["POST", "/api/v1/notes", { slug: "titled-probe", body_md: "replaced without a title" }],
  ["POST", "/api/v1/notes", { slug: "team-probe", type: "project", body_md: "replaced without a title" }],
  ["PATCH", `/api/v1/notes/${id.secret}`, { tags: ["probe"] }],
  ["POST", "/api/v1/notes/alice-followup/rename", { new_slug: "alice-secret" }],
  ["POST", `/api/v1/notes/${id.secret}/archive`, {}],
  ["POST", `/api/v1/notes/${id.secret}/unarchive`, {}],
  ["POST", "/api/v1/skills", { slug: "alice-skill", description: "changed" }],
  ["POST", "/api/v1/skills/alice-skill/log-use", { outcome: "success" }],
  ["POST", "/api/v1/@alice/skills/alice-skill/fork", { new_slug: "alice-skill-fork-2" }],
  ["PUT", `/api/v1/skills/${id.skill}/files/references/probe.txt`, "other"],
  ["POST", "/api/v1/synonyms", { term: "pangolin", synonyms: ["probe"] }],
];

describe("write-scoped operations return no stored content without notes:read", () => {
  const seed = async () => {
    const bob = await bearerTokenFor({ sub: `user:${BOB.account}`, aud: TEST_RESOURCE, scopes: "notes:read notes:write", email: BOB.email });
    expect((await post("/api/v1/notes", bob, { slug: "team-probe", title: TEAM_TITLE, body_md: TEAM_BODY, type: "project" })).status).toBeLessThan(300);
    expect((await post("/api/v1/notes", full, { slug: "titled-probe", title: TITLE, body_md: "a stored title" })).status).toBeLessThan(300);
    expect((await post("/api/v1/skills", full, { slug: "alice-skill", name: SKILL_NAME })).status).toBeLessThan(300);
    expect((await mcp(full, "memory_set", { label: "probe", value: BLOCK })).isError).toBe(false);
  };

  it("the table calls every tool that is not a notes:read tool", () => {
    const called = new Set(WRITE_CALLS().map(([name]) => name));
    const missing = MCP_TOOL_SCOPES.filter((t) => t.scope !== "notes:read" && t.scope !== "none" && !called.has(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("a caller with notes:read keeps the block in the memory write results", async () => {
    await seed();
    const viaMcp = await mcp(full, "memory_replace", { label: "probe", find: "zzzz-nomatch", replace: "y" });
    expect(JSON.parse(viaMcp.text).block.value).toContain(BLOCK);
    const viaRest = await req("/api/v1/memory/blocks/probe", full, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "replace", value: "y", replace: "zzzz-nomatch" }) });
    expect(((await viaRest.json()) as { block: { value: string } }).block.value).toContain(BLOCK);
  });

  it("memory_set answers a write-only token with label, length and char_limit only", async () => {
    await seed();
    const out = await mcp(writeOnly, "memory_set", { label: "probe-2", value: "fresh" });
    expect(out.isError, out.text).toBe(false);
    const block = JSON.parse(out.text).block;
    expect(Object.keys(block).sort()).toEqual(["char_limit", "label", "length"]);
    expect(block.label).toBe("probe-2");
    const res = await req("/api/v1/memory/blocks/probe-3", writeOnly, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "set", value: "fresh" }) });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as { block: object }).block).sort()).toEqual(["char_limit", "label", "length"]);
  });

  // The answer of an append or replace depends on the stored block (its length,
  // block_full, whether `find` matched), so even a length-only result is an oracle:
  // replace(find: s, replace: s + "#") changes the length by the number of matches.
  it("memory_append / memory_replace and their REST ops are refused without notes:read, and leave the block unchanged", async () => {
    await seed();
    const before = JSON.parse((await mcp(full, "memory_get", { label: "probe" })).text).block.value;
    for (const [name, args] of [
      ["memory_replace", { label: "probe", find: "zzzz-nomatch", replace: "y" }],
      ["memory_replace", { label: "probe", find: BLOCK.slice(0, 3), replace: BLOCK.slice(0, 3) + "#" }],
      ["memory_append", { label: "probe", value: "" }],
      ["memory_append", { label: "probe", value: "more", char_limit: 1 }],
      ["notes_append", { slug: "block-probe", text: "more" }],
    ] as const) {
      const out = await mcp(writeOnly, name, args);
      expect(out.isError, `${name}: ${out.text}`).toBe(true);
      expect(out.text, name).toMatch(/^Forbidden: missing scope 'notes:read'/);
      expect(out.text, name).not.toMatch(/length|block_full/);
    }
    for (const body of [{ op: "replace", value: BLOCK.slice(0, 3) + "#", replace: BLOCK.slice(0, 3) }, { op: "append", value: "" }, { op: "append", value: "more", char_limit: 1 }]) {
      const res = await req("/api/v1/memory/blocks/probe", writeOnly, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await res.text()).not.toMatch(/length|block_full/);
    }
    expect(JSON.parse((await mcp(full, "memory_get", { label: "probe" })).text).block.value).toBe(before);
    // control: a token that may read still appends and replaces.
    expect((await mcp(full, "memory_append", { label: "probe", value: "x" })).isError).toBe(false);
    expect((await mcp(full, "notes_append", { slug: "block-probe", text: "more" })).isError).toBe(false);
  });

  it("limits skill version and use statistics to callers with read scope", async () => {
    await seed();
    const update = { slug: "alice-skill", description: "update description" };
    const outcome = { outcome: "success" };
    const viaMcp = JSON.parse((await mcp(writeOnly, "skills_put", update)).text);
    expect(viaMcp).toMatchObject({ slug: "alice-skill", created: false });
    expect(viaMcp).not.toHaveProperty("version");
    const viaRest = await (await post("/api/v1/skills", writeOnly, update)).json();
    expect(viaRest).toMatchObject({ slug: "alice-skill", created: false });
    expect(viaRest).not.toHaveProperty("version");
    expect(JSON.parse((await mcp(full, "skills_put", update)).text)).toHaveProperty("version");
    expect(JSON.parse((await mcp(writeOnly, "skills_log_use", { ...outcome, slug: "alice-skill" })).text)).toEqual({ found: true, slug: "alice-skill", ...outcome });
    expect(await (await post("/api/v1/skills/alice-skill/log-use", writeOnly, outcome)).json()).toEqual({ ok: true, slug: "alice-skill", ...outcome });
    const stats = await (await post("/api/v1/skills/alice-skill/log-use", full, outcome)).json();
    expect(stats).toMatchObject({ success_rate: 1, invocation_count: 3 });
  });

  it("no write tool hands a seeded marker to a write-only token", async () => {
    await seed();
    for (const [name, args] of WRITE_CALLS()) {
      const out = await mcp(writeOnly, name, args);
      // Block edits that depend on stored content require notes:read.
      const readsBlock = name === "memory_append" || name === "memory_replace" || (name === "notes_append" && args.slug === "block-probe");
      if (!readsBlock) expect(out.text, name).not.toMatch(/^Forbidden|^rpc-error/);
      for (const marker of STORED) expect(out.text, `${name} ${JSON.stringify(args)}`).not.toContain(marker);
    }
  });

  it("no non-GET route hands a seeded marker to a write-only token", async () => {
    await mcp(full, "notes_put", { slug: "alice-secret", title: "Alice pangolin plan", body_md: `${BODY} private.` });
    await post("/api/v1/skills", full, { slug: "alice-skill", skill_md: `---\nname: alice-skill\ndescription: alice's private skill\n---\n${SKILL}` });
    await seed();
    const send = async (method: string, path: string, body: unknown) => {
      const res = await req(path, writeOnly, { method, headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
      const text = await res.text();
      for (const marker of STORED) expect(text + JSON.stringify([...res.headers]), `${method} ${path} -> ${res.status}`).not.toContain(marker);
    };
    for (const [method, path, body] of WRITE_ROUTES()) await send(method, path, body);
    // Then every registered non-GET route, so a new one is walked without being listed.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const pattern of routes(method).filter((p) => p !== "/mcp")) await send(method, concrete(pattern), {});
    }
  });
});
