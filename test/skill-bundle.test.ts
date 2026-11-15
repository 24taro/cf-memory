// Skill bundle files (phase 2b) E2E through the REAL Hono app on a Miniflare D1 +
// LOCAL R2. A skill's SKILL.md stays in D1; optional bundle files (scripts/
// references/ assets/) keep their bytes in R2 with a skill_files manifest row.
// Exercises the security surface (path traversal, size caps, content-type/XSS,
// owner-only ownership — decision 9), the round-trip, install-with-files,
// resurrect/fork lifecycle, and graceful degrade when R2 is unbound.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { validateBundlePath } from "../src/bundle";
import app from "../src/index";
import { bearerKeyFixture, rsEnvVars } from "./helpers";

const OWNER = "u_owner";
const OTHER = "u_other";
let TOKEN = "";
let OTHER_TOKEN = "";

let mf: Miniflare;
let db: D1Database;
let bundles: R2Bucket;
let env: Parameters<typeof app.request>[2];

async function applyMigrations(database: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8").split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
    for (const s of raw.split(";")) { const t = s.trim(); if (t) await database.prepare(t).run(); }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}
const jsonHeaders = (bearer = TOKEN) => ({ get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" });

async function pushSkill(slug: string, over: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await req("/api/v1/skills", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ slug, name: slug, description: "a test skill", instructions: "do the thing", ...over }) });
  return res.json();
}

function putFile(id: string, path: string, body: BodyInit, contentType: string, bearer = TOKEN): Promise<Response> {
  return req(`/api/v1/skills/${id}/files/${path}`, { method: "PUT", headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": contentType }, body });
}

// biome-ignore lint/suspicious/noExplicitAny: test JSON
async function mcpCall(bearer: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await req("/mcp", { method: "POST", headers: { get authorization() { return `Bearer ${bearer}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"], r2Buckets: ["BUNDLES"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  bundles = (await mf.getR2Bucket("BUNDLES")) as unknown as R2Bucket;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "owner@example.com", "", 0, 0).run();
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OTHER, "other", "other", "other@example.com", "", 0, 0).run();
  TOKEN = await bearerKeyFixture(db, OWNER, "notes:read,notes:write");
  OTHER_TOKEN = await bearerKeyFixture(db, OTHER, "notes:read,notes:write");
  env = { DB: db, OWNER_HANDLE: "owner", ...rsEnvVars(), BUNDLES: bundles, OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];
});
afterAll(async () => { await mf?.dispose(); });

describe("skill bundle files — harness + round-trip", () => {
  it("the migration created skill_files and local R2 supports put/get/delete", async () => {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_files'").first<{ name: string }>();
    expect(row?.name).toBe("skill_files");
    await bundles.put("smoke/k", new TextEncoder().encode("hi"), { httpMetadata: { contentType: "text/plain" } });
    const got = await bundles.get("smoke/k");
    expect(new Uint8Array((await got!.arrayBuffer())!)).toEqual(new TextEncoder().encode("hi"));
    await bundles.delete("smoke/k");
    expect(await bundles.get("smoke/k")).toBeNull();
  });

  it("PUT stores a manifest row + R2 object; raw GET returns the exact bytes; manifest surfaces; DELETE removes both", async () => {
    const { id, slug } = await pushSkill("rt-skill");
    const body = "console.log('hi')\n";
    const put = await putFile(id, "scripts/run.ts", body, "text/plain");
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, path: "scripts/run.ts", size: body.length });

    const manifestRow = await db.prepare("SELECT r2_key, size FROM skill_files WHERE skill_id=? AND path=?").bind(id, "scripts/run.ts").first<{ r2_key: string; size: number }>();
    expect(manifestRow?.r2_key).toBe(`skills/${id}/scripts/run.ts`);
    expect(await bundles.get(manifestRow!.r2_key)).not.toBeNull();

    const raw = await req(`/@owner/skills/${slug}/files/scripts/run.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(body);

    // manifest surfaces on REST GET, skills_get, and install
    const restGet = (await (await req(`/api/v1/@owner/skills/${slug}`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).json()) as { files: Array<{ path: string }> };
    expect(restGet.files.map((f) => f.path)).toContain("scripts/run.ts");
    const sg = await mcpCall(TOKEN, "skills_get", { slug });
    expect(sg.files.map((f: { path: string }) => f.path)).toContain("scripts/run.ts");

    const del = await req(`/api/v1/skills/${id}/files/scripts/run.ts`, { method: "DELETE", headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(del.status).toBe(200);
    expect(await bundles.get(`skills/${id}/scripts/run.ts`)).toBeNull();
    expect(await db.prepare("SELECT 1 FROM skill_files WHERE skill_id=? AND path=?").bind(id, "scripts/run.ts").first()).toBeNull();
  });

  it("overwrite is idempotent (same key, one row)", async () => {
    const { id } = await pushSkill("rt-overwrite");
    await putFile(id, "references/a.md", "v1", "text/markdown");
    await putFile(id, "references/a.md", "v2-longer", "text/markdown");
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM skill_files WHERE skill_id=? AND path=?").bind(id, "references/a.md").first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const raw = await req(`/@owner/skills/rt-overwrite/files/references/a.md`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(await raw.text()).toBe("v2-longer");
  });
});

describe("validateBundlePath (pure — authoritative path-traversal defense)", () => {
  it("accepts safe relative paths under an allowlisted top dir", () => {
    expect(validateBundlePath("scripts/run.ts")).toBe("scripts/run.ts");
    expect(validateBundlePath("references/docs/guide.md")).toBe("references/docs/guide.md");
    expect(validateBundlePath("assets/img/logo.png")).toBe("assets/img/logo.png");
  });
  it("rejects traversal / absolute / dotfile / empty-segment / non-allowlisted / SKILL.md / control chars", () => {
    for (const p of ["", "scripts/../../etc/passwd", "../x", "/etc/passwd", "scripts/./x", "assets//x", ".git/config", "scripts/.env", "secret/x", "SKILL.md", "scripts", "C:/x/y", "scripts/a\\b", "scripts/x/"]) {
      expect(validateBundlePath(p)).toBeNull();
    }
    expect(validateBundlePath('assets/a"b.txt')).toBeNull(); // double-quote rejected → Content-Disposition filename stays well-formed
  });
  it("rejects paths exceeding the length / segment / depth caps", () => {
    expect(validateBundlePath(`scripts/${"a".repeat(101)}`)).toBeNull(); // per-segment > 100
    expect(validateBundlePath(`scripts/${"a/".repeat(10)}x`)).toBeNull(); // depth > 10
    expect(validateBundlePath(`scripts/${"a".repeat(300)}`)).toBeNull(); // total > 255
  });
});

describe("skill bundle files — path traversal rejected at the PUT route", () => {
  it("rejects encoded traversal + non-allowlisted + SKILL.md (400/404) and writes no row", async () => {
    const { id } = await pushSkill("trav-skill");
    // encoded slashes survive URL normalization, so they reach validateBundlePath decoded and are caught
    for (const p of ["..%2f..%2fx", "secret%2fx", "SKILL.md", "scripts%2f.env"]) {
      const res = await putFile(id, p, "x", "text/plain");
      expect([400, 404]).toContain(res.status);
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM skill_files WHERE skill_id=?").bind(id).first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

describe("skill bundle files — size + count caps", () => {
  it("rejects a file over the 5 MiB per-file cap (413), even with a spoofed small Content-Length", async () => {
    const { id } = await pushSkill("cap-file");
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await putFile(id, "assets/big.bin", big, "application/octet-stream");
    expect(res.status).toBe(413);
    // spoofed Content-Length: still caught post-read
    const spoof = await req(`/api/v1/skills/${id}/files/assets/spoof.bin`, { method: "PUT", headers: { get authorization() { return `Bearer ${TOKEN}`; }, "content-type": "application/octet-stream", "content-length": "10" }, body: big });
    expect(spoof.status).toBe(413);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM skill_files WHERE skill_id=?").bind(id).first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("rejects the 101st distinct path (count cap) and an upload past the 25 MiB total (413)", async () => {
    const { id } = await pushSkill("cap-count");
    const ts = 0;
    // seed 100 tiny rows directly (fast) to hit the count cap on the next PUT
    for (let i = 0; i < 100; i++) {
      await db.prepare("INSERT INTO skill_files (id,skill_id,path,r2_key,content_type,size,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`sf_${i}`, id, `scripts/f${i}.txt`, `skills/${id}/scripts/f${i}.txt`, "text/plain", 1, "x", ts, ts).run();
    }
    expect((await putFile(id, "scripts/one-too-many.txt", "x", "text/plain")).status).toBe(413);

    const { id: id2 } = await pushSkill("cap-total");
    await db.prepare("INSERT INTO skill_files (id,skill_id,path,r2_key,content_type,size,sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind("sf_huge", id2, "assets/huge.bin", `skills/${id2}/assets/huge.bin`, "application/octet-stream", 25 * 1024 * 1024 - 5, "x", ts, ts).run();
    expect((await putFile(id2, "assets/tips.bin", new Uint8Array(10), "application/octet-stream")).status).toBe(413);
  });
});

describe("skill bundle files — write ownership + owner-only read", () => {
  it("write is owner-only (other→404, anon→401/403, deleted skill→404); read is owner-only too (decision 9)", async () => {
    const { id, slug } = await pushSkill("own-skill");
    await putFile(id, "scripts/x.ts", "secret", "text/plain");

    // write ownership
    expect((await putFile(id, "scripts/y.ts", "x", "text/plain", OTHER_TOKEN)).status).toBe(404);
    const anon = await req(`/api/v1/skills/${id}/files/scripts/z.ts`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "x" });
    expect([401, 403]).toContain(anon.status);

    // read: anon is stopped by the fail-closed gate (401); an authenticated
    // non-owner gets an indistinguishable 404; only the owner reads the bytes
    expect((await req(`/@owner/skills/${slug}/files/scripts/x.ts`)).status).toBe(401); // anon
    expect((await req(`/@owner/skills/${slug}/files/scripts/x.ts`, { headers: { get authorization() { return `Bearer ${OTHER_TOKEN}`; } } })).status).toBe(404);
    expect((await req(`/@owner/skills/${slug}/files/scripts/x.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(200);
    // skills_file_read is likewise gated for the non-owner
    expect(await mcpCall(OTHER_TOKEN, "skills_file_read", { slug, path: "scripts/x.ts" })).toMatchObject({ found: false });

    // a soft-deleted skill's files 404 even for the owner
    await req(`/api/v1/skills/own-skill`, { method: "DELETE", headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect((await req(`/@owner/skills/${slug}/files/scripts/x.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(404);
    expect((await putFile(id, "scripts/after-del.ts", "x", "text/plain")).status).toBe(404); // write to deleted → 404
  });
});

describe("skill bundle files — content-type / stored-XSS defense on serve", () => {
  it("never serves active types inline; sets nosniff + CSP + attachment; images serve inline", async () => {
    const { id, slug } = await pushSkill("xss-skill");
    await putFile(id, "assets/evil.html", "<script>alert(1)</script>", "text/html");
    await putFile(id, "assets/evil.svg", "<svg onload='alert(1)'></svg>", "image/svg+xml");
    await putFile(id, "assets/pic.png", new Uint8Array([137, 80, 78, 71]), "image/png");

    const html = await req(`/@owner/skills/${slug}/files/assets/evil.html`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("content-security-policy")).toBeTruthy(); // global CSP present; the real XSS defense is octet-stream + nosniff + attachment
    expect(html.headers.get("content-disposition")).toContain("attachment");

    const svg = await req(`/@owner/skills/${slug}/files/assets/evil.svg`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(svg.headers.get("content-type")).toBe("application/octet-stream"); // SVG is scriptable → never image/svg
    expect(svg.headers.get("content-disposition")).toContain("attachment");

    const png = await req(`/@owner/skills/${slug}/files/assets/pic.png`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toBeNull(); // raster image serves inline
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a non-ASCII (CJK) filename without a 500 — RFC 6266 Content-Disposition", async () => {
    const { id, slug } = await pushSkill("cjk-skill");
    await putFile(id, "references/設計.md", "日本語ドキュメント", "text/markdown");
    const res = await req(`/@owner/skills/${slug}/files/references/設計.md`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(res.status).toBe(200); // a raw non-Latin1 filename in the header would otherwise throw → 500
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("filename*=UTF-8''"); // RFC 6266 UTF-8 form present for modern clients
    expect(await res.text()).toBe("日本語ドキュメント");
  });
});

describe("skill bundle files — install, back-compat, resurrect, fork", () => {
  it("structured skills_put exports valid YAML through get/install and reimport preserves content", async () => {
    const name = 'cf-memory agent: 導入 "procedure"';
    const description = '出典: docs/guide.md # keep the suffix\nsecond line';
    const instructions = "Step 1. Preserve existing settings.\nStep 2. Review Shadow.";
    const created = await mcpCall(TOKEN, "skills_put", { slug: "yaml-export", name, description, instructions });
    expect(created.created).toBe(true);
    const got = await mcpCall(TOKEN, "skills_get", { slug: "yaml-export" });
    const installed = await mcpCall(TOKEN, "skills_install", { slug: "yaml-export" });
    const md = installed.bundle.files.find((f: { path: string }) => f.path === "SKILL.md")?.content;
    expect(md).toBe(got.skill_md);
    const header = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1];
    expect(header).toBeDefined();
    const parsed = parseDocument(header!);
    expect(parsed.errors).toEqual([]);
    expect(parsed.toJSON()).toEqual({ name, description });

    await mcpCall(TOKEN, "skills_put", { slug: "yaml-reimport", skill_md: md });
    const reimported = await mcpCall(TOKEN, "skills_get", { slug: "yaml-reimport" });
    expect(reimported.name).toBe(name);
    expect(reimported.description).toBe(description);
    expect(reimported.instructions_md.trim()).toBe(instructions);

    // A content-neutral structured edit also repairs generated headers without
    // changing canonical content or overwriting omitted instructions.
    await mcpCall(TOKEN, "skills_put", { slug: "yaml-export", name });
    const updated = await mcpCall(TOKEN, "skills_get", { slug: "yaml-export" });
    expect(updated.content_hash).toBe(got.content_hash);
    expect(updated.instructions_md).toBe(got.instructions_md);
    expect(updated.skill_md).toBe(got.skill_md);
  });

  it("install/skills_install inline small text + URL for large/binary; bundle() back-compat for a file-less skill", async () => {
    const { id, slug } = await pushSkill("inst-skill");
    await putFile(id, "references/small.md", "tiny", "text/markdown"); // inline
    await putFile(id, "assets/blob.bin", new Uint8Array(100), "application/octet-stream"); // URL (binary)

    const inst = await mcpCall(TOKEN, "skills_install", { slug });
    const byPath = new Map<string, { content?: string; url?: string }>(inst.bundle.files.map((f: { path: string }) => [f.path, f]));
    expect(byPath.get("SKILL.md")?.content).toBeTruthy();
    expect(byPath.get("references/small.md")?.content).toBe("tiny");
    expect(byPath.get("assets/blob.bin")?.url).toBe(`/@owner/skills/${slug}/files/assets/blob.bin`);
    expect(byPath.get("assets/blob.bin")?.content).toBeUndefined(); // never inlines binary
    expect(byPath.get("assets/blob.bin")?.url).not.toContain("http"); // same-origin, never a presigned R2 URL

    // back-compat: a skill with NO files installs as exactly {files:[SKILL.md]}
    await pushSkill("plain-skill");
    const plain = await mcpCall(TOKEN, "skills_install", { slug: "plain-skill" });
    expect(plain.bundle.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md"]);
  });

  it("resurrect keeps files; fork copies none", async () => {
    const { id, slug } = await pushSkill("res-skill");
    await putFile(id, "scripts/keep.ts", "keep", "text/plain");
    await req(`/api/v1/skills/${slug}`, { method: "DELETE", headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect((await req(`/@owner/skills/${slug}/files/scripts/keep.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(404); // hidden while deleted
    await pushSkill(slug); // upsert resurrects (deleted_at=NULL) reusing the same id
    const raw = await req(`/@owner/skills/${slug}/files/scripts/keep.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("keep"); // same id → same key → file restored

    // fork mints a new id → zero files copied
    await mcpCall(TOKEN, "skills_fork", { slug, new_slug: "res-skill-forked" });
    const fork = await db.prepare("SELECT id FROM skills WHERE slug='res-skill-forked' AND user_id=?").bind(OWNER).first<{ id: string }>();
    expect(fork?.id).toBeTruthy();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM skill_files WHERE skill_id=?").bind(fork!.id).first<{ n: number }>()).toMatchObject({ n: 0 });
  });
});

describe("skill bundle files — skills_file_read content branches + URL encoding", () => {
  it("returns utf8 for text, base64 for binary, and a url (no bytes read) for >256 KiB", async () => {
    const { id, slug } = await pushSkill("sfr-skill");
    await putFile(id, "scripts/hi.txt", "hello world", "text/plain");
    await putFile(id, "assets/blob.bin", new Uint8Array([1, 2, 3, 250]), "application/octet-stream");
    await putFile(id, "assets/big.txt", new Uint8Array(300 * 1024).fill(65), "text/plain");

    expect(await mcpCall(TOKEN, "skills_file_read", { slug, path: "scripts/hi.txt" })).toMatchObject({ found: true, encoding: "utf8", content: "hello world" });
    const bin = await mcpCall(TOKEN, "skills_file_read", { slug, path: "assets/blob.bin" });
    expect(bin).toMatchObject({ found: true, encoding: "base64" });
    expect(Buffer.from(bin.content, "base64")).toEqual(Buffer.from([1, 2, 3, 250]));
    const large = await mcpCall(TOKEN, "skills_file_read", { slug, path: "assets/big.txt" });
    expect(large).toMatchObject({ found: true, too_large: true, url: `/@owner/skills/${slug}/files/assets/big.txt` });
    expect(large.content).toBeUndefined();
    expect(await mcpCall(TOKEN, "skills_file_read", { slug, path: "scripts/nope.txt" })).toMatchObject({ found: false });
  });

  it("percent-encodes reserved chars in bundle URLs so they round-trip", async () => {
    const { id, slug } = await pushSkill("enc-skill");
    await putFile(id, "assets/a%25b.bin", new Uint8Array(300 * 1024), "application/octet-stream"); // stored path decodes to assets/a%b.bin (large → url)
    const inst = await mcpCall(TOKEN, "skills_install", { slug });
    const entry = inst.bundle.files.find((f: { path: string }) => f.path === "assets/a%b.bin");
    expect(entry?.url).toBe(`/@owner/skills/${slug}/files/assets/a%25b.bin`); // % re-encoded in the advertised URL
    expect((await req(entry.url, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(200); // the encoded URL round-trips
  });
});

describe("skill bundle files — graceful degrade when R2 is unbound", () => {
  // Same env minus R2 — but it still needs the agent-door vars, or every
  // request 401s before it can reach the degrade path under test.
  const envNoR2 = () => ({ DB: db, ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" }) as unknown as Parameters<typeof app.request>[2];
  const reqNoR2 = (path: string, init: RequestInit = {}) => app.request(`https://memory.test${path}`, init, envNoR2());
  // biome-ignore lint/suspicious/noExplicitAny: test JSON
  async function mcpNoR2(name: string, args: Record<string, unknown>): Promise<any> {
    const res = await reqNoR2("/mcp", { method: "POST", headers: { get authorization() { return `Bearer ${TOKEN}`; }, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(body.result?.content?.[0]?.text ?? "{}");
  }

  it("PUT/DELETE → 501, raw GET → 404, skills_file_read degrades; skills_get/install still work (no 500)", async () => {
    const { id, slug } = await pushSkill("degrade-skill"); // created via the R2-enabled env
    expect((await reqNoR2(`/api/v1/skills/${id}/files/scripts/x.ts`, { method: "PUT", headers: { get authorization() { return `Bearer ${TOKEN}`; }, "content-type": "text/plain" }, body: "x" })).status).toBe(501);
    expect((await reqNoR2(`/api/v1/skills/${id}/files/scripts/x.ts`, { method: "DELETE", headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(501);
    expect((await reqNoR2(`/@owner/skills/${slug}/files/scripts/x.ts`, { headers: { get authorization() { return `Bearer ${TOKEN}`; } } })).status).toBe(404);
    expect(await mcpNoR2("skills_file_read", { slug, path: "scripts/x.ts" })).toMatchObject({ error: "bundle files not enabled" });
    expect((await mcpNoR2("skills_get", { slug })).found).toBe(true); // no 500
    expect((await mcpNoR2("skills_install", { slug })).bundle.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md"]);
  });
});
