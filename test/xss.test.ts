// Stored XSS (review follow-up): renderMarkdown()'s output was injected verbatim
// into dangerouslySetInnerHTML sinks (ProfilePage bio, SkillPage instructions,
// NotePage body — src/web/pages.tsx) with no sanitization and no CSP. Any
// notes:write-scoped principal could write a note containing raw <script>/on*=
// HTML that would execute in the owner's own authenticated browser session
// (same-origin cookie), fully defeating the notes:write-vs-admin scope
// separation. This drives the REAL Hono app
// (middleware -> door -> renderMarkdown -> web page) on a Miniflare D1 with the
// full migration set — mirroring the original live repro against a note page.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { renderMarkdown } from "../src/markdown";
import { makeServices, type Services } from "../src/services";
import { mintTestToken, principalFixture, rsEnvVars } from "./helpers";

const OWNER = "u_owner";
let TOKEN = "";
const principal = principalFixture({ userId: OWNER, handle: "owner" });

let mf: Miniflare;
let env: Parameters<typeof app.request>[2];

async function applyMigrations(db: D1Database): Promise<void> {
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
      if (s) await db.prepare(s).run();
    }
  }
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db.prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(OWNER, "owner", "owner", "owner@example.com", "", 0, 0).run();
  TOKEN = await mintTestToken(OWNER, "admin");
  env = { DB: db, OWNER_HANDLE: "owner", ...rsEnvVars(), OWNER_EMAIL: "owner@example.com" } as unknown as Parameters<typeof app.request>[2];

  const services: Services = makeServices(db);
  await services.notes.upsert(principal, {
    slug: "xss-probe",
    title: "xss-probe",
    body_md: 'Some intro text.\n\n<script>window.__cf_memory_xss_probe__=1</script>\n\n<img src=x onerror="alert(1)">\n\n<a href="javascript:alert(1)" onclick="alert(1)">click</a>\n\nMore text after.',
  });
});

afterAll(async () => {
  await mf?.dispose();
});

describe("renderMarkdown() sanitizes HTML output (unit-level)", () => {
  const resolve = () => ({ href: "#", exists: false });

  it("strips <script> tags entirely", () => {
    const html = renderMarkdown("before\n\n<script>alert(document.cookie)</script>\n\nafter", resolve);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(document.cookie)");
  });

  it("strips on* event-handler attributes from otherwise-allowed tags", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">', resolve);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("strips javascript: URLs from links", () => {
    const html = renderMarkdown('<a href="javascript:alert(1)" onclick="alert(1)">click</a>', resolve);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
  });

  it("still renders ordinary markdown and wikilinks (no functional regression)", () => {
    const html = renderMarkdown("# Title\n\n**bold** and [[a-note]]", resolve);
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("wikilink");
  });
});

describe("stored XSS end-to-end (review follow-up): the real note page never serves live script/handlers", () => {
  it("GET /@owner/n/xss-probe strips the script tag and event handler from the note's rendered HTML", async () => {
    const res = await app.request("https://memory.test/@owner/n/xss-probe", { headers: { get authorization() { return `Bearer ${TOKEN}`; } } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Some intro text");
    expect(html).not.toContain("<script>window.__cf_memory_xss_probe__=1</script>");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("onclick=");
  });

  it("anonymous (unauthenticated) visitors never receive the note at all (owner-only gate, decision 9) — so no stored payload can reach them", async () => {
    const res = await app.request("https://memory.test/@owner/n/xss-probe", { headers: { accept: "text/html" } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/access/login?next=${encodeURIComponent("/@owner/n/xss-probe")}`);
    const html = await res.text();
    expect(html).not.toContain("<script>window.__cf_memory_xss_probe__=1</script>");
    expect(html).not.toContain("onerror=");
  });
});

describe("Content-Security-Policy header (defense-in-depth)", () => {
  it("every response carries a restrictive CSP with no unsafe-inline in script-src", async () => {
    const res = await app.request("https://memory.test/@owner/n/xss-probe", { headers: { get authorization() { return `Bearer ${TOKEN}`; } } }, env);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src");
    expect(csp).not.toContain("unsafe-inline' 'nonce"); // sanity: not both
    const scriptSrc = /script-src\s+([^;]+)/.exec(csp)?.[1] ?? "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).toContain("'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it("issues a fresh nonce per request and matches it in the network page's inline script", async () => {
    const res = await app.request("https://memory.test/@owner/network", { headers: { get authorization() { return `Bearer ${TOKEN}`; } } }, env);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
  });
});
