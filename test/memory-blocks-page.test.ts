// issue #81: the 基本記憶 (GET /@handle/memory) screen — first web view of the
// owner's core-memory blocks (persona/human/conventions/context), owner-gated
// (blocks are private; listBlocks returns [] for anonymous), with a nav
// link. Drives the REAL Hono app on Miniflare D1 (mirrors
// test/memory-library.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { accessEnvVars, bearerKeyFixture, mintTestToken, rsEnvVars, setupAccessAuth } from "./helpers";

const OWNER = "u_memblk_owner";
let OWNER_BEARER = "";
const OWNER_HANDLE = "memblk-owner";
const OWNER_EMAIL = "memblk-owner@example.com";
const EMPTY = "u_memblk_empty";
const EMPTY_HANDLE = "memblk-empty";
const EMPTY_EMAIL = "memblk-empty@example.com";

let mf: Miniflare;
let db: D1Database;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string) => Promise<string>;
let emptyBearer: string;

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

// The owner's Access-JWT cookie door (Task 3), replacing the old password
// login + web-session-cookie flow. Access resolves ONLY to OWNER_HANDLE.
async function ownerCookie(): Promise<string> {
  return `CF_Authorization=${await jwtFor(OWNER_EMAIL)}`;
}

async function setBlock(label: string, value: string): Promise<void> {
  const res = await req(`/api/v1/memory/blocks/${label}`, {
    method: "PATCH",
    headers: { get authorization() { return `Bearer ${OWNER_BEARER}`; }, "content-type": "application/json" },
    body: JSON.stringify({ op: "set", value }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(OWNER, OWNER_HANDLE, "owner", OWNER_EMAIL, "", 0, 0)
    .run();
  OWNER_BEARER = await mintTestToken(OWNER, "notes:read,notes:write");
  await db
    .prepare("INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(EMPTY, EMPTY_HANDLE, "empty", EMPTY_EMAIL, "", 0, 0)
    .run();
  jwtFor = await setupAccessAuth();
  emptyBearer = await bearerKeyFixture(db, EMPTY);
  env = { DB: db, ...rsEnvVars(), OWNER_HANDLE, ...accessEnvVars(OWNER_EMAIL) } as unknown as Parameters<typeof app.request>[2];

  await setBlock("persona", "PERSONA-SECRET-VALUE 親切なアシスタント");
  await setBlock("conventions", "CONVENTIONS-SECRET 日本語で答える");
  await setBlock("human", "HUMAN-SECRET-WSA ユーザーはエンジニア");
});

afterAll(async () => {
  await mf?.dispose();
});

describe("基本記憶 (GET /@handle/memory) — owner view", () => {
  it("shows the owner's blocks with Japanese kind labels, values, and char usage", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}/memory`, { headers: { cookie: await ownerCookie() } })).text();
    expect(html).toContain("AIの人格設定");
    expect(html).toContain("運用ルール");
    expect(html).toContain("あなたについてのメモ");
    expect(html).toContain("PERSONA-SECRET-VALUE 親切なアシスタント");
    // Char-usage line (value.length / limit 文字).
    expect(html).toMatch(/\d+ \/ .+文字/);
  });
});

describe("基本記憶 — privacy gate", () => {
  it("redirects an anonymous viewer to /access/login and denies a non-owner Bearer viewer with a flat 403 — neither ever exposes a block value", async () => {
    // Anonymous browser-ish request: the fail-closed gate (decision 9) redirects.
    const res = await req(`/@${OWNER_HANDLE}/memory`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/login`);
    const html = await res.text();
    expect(html).not.toContain("PERSONA-SECRET-VALUE");

    // A different authenticated (non-owner Bearer) caller also cannot view the
    // owner's blocks — Bearer never sets sessionHandle, so sh !== handle holds
    // regardless of whose key it is. W2: this in-route owner-only guard now
    // denies flatly (403) instead of redirecting to the deleted /login — the
    // caller is already authenticated, so a login redirect would just dead-end.
    const other = await req(`/@${OWNER_HANDLE}/memory`, { headers: { get authorization() { return `Bearer ${emptyBearer}`; } } });
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain("PERSONA-SECRET-VALUE");
  });
});

describe("ProfilePage core-memory glance (web redesign) — owner-gated", () => {
  it("shows the owner's core-block values on their OWN home (/@owner)", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}`, { headers: { cookie: await ownerCookie() } })).text();
    expect(html).toContain("PERSONA-SECRET-VALUE 親切なアシスタント");
  });

  it("a DIFFERENT authenticated (non-owner Bearer) caller visiting /@owner never receives the owner's block values (leak-guard)", async () => {
    const html = await (await req(`/@${OWNER_HANDLE}`, { headers: { get authorization() { return `Bearer ${emptyBearer}`; } } })).text();
    expect(html).not.toContain("PERSONA-SECRET-VALUE");
    expect(html).not.toContain("CONVENTIONS-SECRET");
    expect(html).not.toContain("HUMAN-SECRET-WSA");
  });
});

describe("基本記憶 — empty state + nav", () => {
  it("shows the empty-state message for an owner with no blocks", async () => {
    // EMPTY has zero blocks — the deterministic empty-state fixture. Access
    // resolves ONLY to the single env-configured OWNER_HANDLE/OWNER_EMAIL, and
    // /memory gates on sessionHandle(c)===handle (Bearer can never satisfy
    // that — it never sets sessionHandle). So EMPTY viewing their OWN /memory
    // page as themselves needs a request-scoped env naming EMPTY as THAT
    // request's owner (same underlying DB) rather than a Bearer key.
    const emptyAsOwnerEnv = { DB: db, OWNER_HANDLE: EMPTY_HANDLE, ...accessEnvVars(EMPTY_EMAIL) } as unknown as Parameters<typeof app.request>[2];
    const html = await (
      await app.request(`https://memory.test/@${EMPTY_HANDLE}/memory`, { headers: { cookie: `CF_Authorization=${await jwtFor(EMPTY_EMAIL)}` } }, emptyAsOwnerEnv)
    ).text();
    expect(html).toContain("まだ基本記憶がありません。");
  });

  it("the 基本記憶 nav link shows for the owner and NOT for a non-owner Bearer caller (anonymous never sees the page at all — decision 9)", async () => {
    const ownerHtml = await (await req(`/@${OWNER_HANDLE}`, { headers: { cookie: await ownerCookie() } })).text();
    expect(ownerHtml).toContain(`/@${OWNER_HANDLE}/memory`);
    expect(ownerHtml).toContain("基本記憶");

    const otherHtml = await (await req(`/@${OWNER_HANDLE}`, { headers: { get authorization() { return `Bearer ${emptyBearer}`; } } })).text();
    expect(otherHtml).not.toContain(`/@${OWNER_HANDLE}/memory`);
  });
});
