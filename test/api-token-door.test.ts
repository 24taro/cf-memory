// Single-owner mode: the fixed API_TOKEN door (src/services.ts, src/auth.ts).
//
// Drives the real Hono app against a Miniflare D1 with NO authorization server
// configured, which is how an outside deployment runs.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { matchesApiToken } from "../src/auth";
import { bearerTokenFor, rsEnvVars } from "./helpers";

const TOKEN = "t".repeat(48);
const OWNER_EMAIL = "solo-owner@example.com";

let mf: Miniflare;
let db: D1Database;
type AppEnv = Parameters<typeof app.request>[2];

async function applyMigrations(d: D1Database): Promise<void> {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const raw = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    for (const stmt of raw.split(";")) {
      const s = stmt.trim();
      if (s) await d.prepare(s).run();
    }
  }
}

function envWith(extra: Record<string, unknown>): AppEnv {
  return { DB: db, OWNER_HANDLE: "owner", OWNER_EMAIL, ...extra } as AppEnv;
}

async function call(path: string, token: string | null, env: AppEnv, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.request(`https://memory.test${path}`, { ...init, headers }, env);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("fixed API_TOKEN door", () => {
  it("accepts the configured token as the owner with every scope", async () => {
    const env = envWith({ API_TOKEN: TOKEN });
    const res = await call("/api/v1/whoami", TOKEN, env);
    expect(res.status).toBe(200);
    const me = (await res.json()) as { handle: string; scopes: string[] };
    expect(me.handle).toBe("owner");
    expect(me.scopes).toEqual(expect.arrayContaining(["notes:read", "notes:write", "admin"]));
  });

  it("lets the owner write and read back a note", async () => {
    const env = envWith({ API_TOKEN: TOKEN });
    const put = await call("/api/v1/notes", TOKEN, env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Solo note", body: "kept by the fixed token" }),
    });
    expect(put.status).toBeLessThan(300);
    const list = await call("/api/v1/notes", TOKEN, env);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("Solo note");
  });

  it("refuses a wrong token, a prefix, and a longer token", async () => {
    const env = envWith({ API_TOKEN: TOKEN });
    for (const bad of ["x".repeat(48), TOKEN.slice(0, 47), `${TOKEN}t`, "t"]) {
      expect((await call("/api/v1/notes", bad, env)).status).toBe(401);
    }
  });

  it("refuses requests with no token", async () => {
    expect((await call("/api/v1/notes", null, envWith({ API_TOKEN: TOKEN }))).status).toBe(401);
  });

  it("stays closed when API_TOKEN is unset, empty, or shorter than 32 characters", async () => {
    for (const configured of [undefined, "", "   ", "short-token", "s".repeat(31)]) {
      const env = envWith({ API_TOKEN: configured });
      const presented = typeof configured === "string" && configured.trim() ? configured.trim() : "anything";
      expect((await call("/api/v1/notes", presented, env)).status).toBe(401);
    }
  });

  it("ignores surrounding whitespace in the configured secret", async () => {
    expect((await call("/api/v1/whoami", TOKEN, envWith({ API_TOKEN: `  ${TOKEN}\n` }))).status).toBe(200);
  });

  it("leaves the introspection door working beside it", async () => {
    await db
      .prepare("UPDATE users SET auth_user_id=? WHERE handle='owner'")
      .bind("01KSOLOOWNER00000000000000")
      .run();
    const env = envWith({ API_TOKEN: TOKEN, ...rsEnvVars() });
    const oauth = await bearerTokenFor({ sub: "user:01KSOLOOWNER00000000000000", email: OWNER_EMAIL });
    expect((await call("/api/v1/whoami", oauth, env)).status).toBe(200);
    expect((await call("/api/v1/whoami", TOKEN, env)).status).toBe(200);
  });
});

describe("an instance with no authorization server", () => {
  it("answers 401 with a bare Bearer challenge and names no other host", async () => {
    const res = await call("/api/v1/notes", null, envWith({ API_TOKEN: TOKEN }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const text = await res.text();
    expect(text).toContain("API token");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("serves no protected-resource metadata", async () => {
    const res = await call("/.well-known/oauth-protected-resource/mcp", null, envWith({ API_TOKEN: TOKEN }));
    expect(res.status).toBe(404);
  });

  it("advertises its own origin when only the issuer is configured", async () => {
    const env = envWith({ AUTH_ISSUER: "https://issuer.example" });
    const meta = await call("/.well-known/oauth-protected-resource/mcp", null, env);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe("https://memory.test/mcp");
    const res = await call("/api/v1/notes", null, env);
    expect(res.headers.get("www-authenticate")).toContain("https://memory.test/.well-known/oauth-protected-resource/mcp");
  });

  it("tells an MCP client without a token what to present", async () => {
    const res = await call("/mcp", null, envWith({ API_TOKEN: TOKEN }), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const text = await res.text();
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe("an instance deployed without OWNER_EMAIL", () => {
  it("creates the owner without an address, and fills it in once the var is set", async () => {
    const mf2 = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
    try {
      const fresh = (await mf2.getD1Database("DB")) as unknown as D1Database;
      await applyMigrations(fresh);
      const bare = { DB: fresh, API_TOKEN: TOKEN } as AppEnv;
      expect((await call("/api/v1/whoami", TOKEN, bare)).status).toBe(200);
      expect((await call("/api/v1/notes", null, bare)).status).toBe(401);
      const before = await fresh.prepare("SELECT email FROM users WHERE handle='owner'").first<{ email: string | null }>();
      expect(before?.email).toBeNull();
      const withMail = { DB: fresh, API_TOKEN: TOKEN, OWNER_EMAIL: "later@example.com" } as AppEnv;
      expect((await call("/api/v1/whoami", TOKEN, withMail)).status).toBe(200);
      const after = await fresh.prepare("SELECT email FROM users WHERE handle='owner'").first<{ email: string | null }>();
      expect(after?.email).toBe("later@example.com");
    } finally {
      await mf2.dispose();
    }
  });
});

describe("matchesApiToken", () => {
  it("matches only the exact configured token", async () => {
    expect(await matchesApiToken(TOKEN, TOKEN)).toBe(true);
    expect(await matchesApiToken(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(await matchesApiToken("", TOKEN)).toBe(false);
    expect(await matchesApiToken("", "")).toBe(false);
    expect(await matchesApiToken("", undefined)).toBe(false);
  });
});
