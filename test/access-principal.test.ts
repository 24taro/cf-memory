// Access-JWT principal resolution (design 2026-07-25 §5.3): a verified
// Cf-Access-Jwt-Assertion header OR CF_Authorization cookie resolves to the
// OWNER principal (single-user instance); Bearer wins over Access; disallowed
// email / invalid JWT / cf-ray-present dev bypass all fail closed to anonymous.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type AccessJwtOverrides, accessEnvVars, bearerKeyFixture, setupAccessAuth } from "./helpers";

let mf: Miniflare;
let env: Parameters<typeof app.request>[2];
let jwtFor: (email: string, overrides?: AccessJwtOverrides) => Promise<string>;
let db: D1Database;

async function applyMigrations(d: D1Database): Promise<void> {
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
      if (s) await d.prepare(s).run();
    }
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://memory.test${path}`, init, env);
}

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: ["DB"] }));
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);
  jwtFor = await setupAccessAuth();
  env = { DB: db, OWNER_HANDLE: "owner", ...accessEnvVars("owner@example.com") } as unknown as Parameters<typeof app.request>[2];
});

afterAll(async () => {
  await mf?.dispose();
});

describe("Access-JWT principal (header and cookie doors)", () => {
  it("Cf-Access-Jwt-Assertion header for the owner email → owner principal (whoami)", async () => {
    const res = await req("/api/v1/whoami", { headers: { "cf-access-jwt-assertion": await jwtFor("owner@example.com") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handle: string; anonymous: boolean; actor: string; scopes: string[] };
    expect(body.anonymous).toBe(false);
    expect(body.handle).toBe("owner");
    expect(body.actor).toBe("human");
    // 生の principal.scopes は空(人間に委譲は起きていない)。whoami が返すのは
    // 実効値なので、招待された人には読み書きが見える。
    expect(body.scopes.sort()).toEqual(["notes:read", "notes:write"]);
  });

  it("CF_Authorization cookie works on any path (domain-wide door)", async () => {
    const res = await req("/api/v1/whoami", { headers: { cookie: `CF_Authorization=${await jwtFor("owner@example.com")}` } });
    expect(((await res.json()) as { anonymous: boolean }).anonymous).toBe(false);
  });

  it("an address this instance has never seen is refused, and told why", async () => {
    // 2026-08-19: cf-memory は招待制になった。Access が通した = このホストに届いてよい、
    // 招待 = cf-memory を使ってよい。別の問いなので、通っただけでは入れない。
    const res = await req("/api/v1/notes", { headers: { "cf-access-jwt-assertion": await jwtFor("newcomer@example.com") } });
    // 401 ではなく 403: 誰かは分かっている。分からないのではなく、許されていない。
    expect(res.status).toBe(403);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("NOT_INVITED");
    // 判定に使った住所を返すこと。「別アカウントでログイン中」と「本当に未招待」を
    // 本人が区別できる唯一の手がかり。
    expect(body).toContain("newcomer@example.com");
  });

  it("refuses without sending a signed-in person back to the SSO they passed", async () => {
    // ここが匿名に落ちると /access/login へ 302 し、既に通った SSO へ戻されて
    // ループする。招待されていないことは「認証されていない」ではない。
    const res = await req("/", {
      headers: { accept: "text/html", "cf-access-jwt-assertion": await jwtFor("newcomer@example.com") },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("newcomer@example.com");
  });

  it("an assertion for another Access application is refused", async () => {
    // The signature is real; it just is not for us. This is what replaced the
    // allow-list as the thing standing between an outsider and a session.
    const res = await req("/api/v1/notes", {
      headers: { "cf-access-jwt-assertion": await jwtFor("intruder@example.com", { aud: "another-application" }) },
    });
    expect(res.status).toBe(401);
  });

  it("a garbage token fails closed to anonymous", async () => {
    const res = await req("/api/v1/notes", { headers: { cookie: "CF_Authorization=not.a.jwt" } });
    expect(res.status).toBe(401);
  });

  it("Bearer wins over a simultaneous Access JWT (agent identity is preserved)", async () => {
    const owner = await db.prepare("SELECT id FROM users WHERE handle='owner'").first<{ id: string }>();
    const key = await bearerKeyFixture(db, owner!.id);
    const res = await req("/api/v1/whoami", {
      headers: { get authorization() { return `Bearer ${key}`; }, "cf-access-jwt-assertion": await jwtFor("owner@example.com") },
    });
    const body = (await res.json()) as { actor: string };
    expect(body.actor).toBe("agent"); // bearer branch, not the access branch
  });

  it("an SSO owner is admin (decision 8 access branch): GET /api/v1/audit is allowed", async () => {
    const res = await req("/api/v1/audit", { headers: { "cf-access-jwt-assertion": await jwtFor("owner@example.com") } });
    expect(res.status).toBe(200);
  });
});

// wrangler.jsonc's `routes` (custom_domain, needed for the real deploy) makes
// `wrangler dev`/Miniflare rewrite BOTH url.hostname and the Host header to
// the production domain even on a plain localhost:8787 curl (verified
// empirically against a real `wrangler dev` — Task 8 fix round), so the
// bypass discriminator can't be request-URL-based here; it keys on cf-ray
// absence instead (the Cloudflare edge stamps cf-ray on everything it proxies
// to the origin — `wrangler dev` has no edge in the loop, so a request
// without one cannot be production-shaped traffic).
describe("dev bypass (DEV_ACCESS_EMAIL) — no-edge (cf-ray-absent), .dev.vars-only", () => {
  it("resolves when DEV_ACCESS_EMAIL is the allowed owner email and the request carries no cf-ray (e.g. wrangler dev, no edge in the loop)", async () => {
    const devEnv = { ...(env as Record<string, unknown>), DEV_ACCESS_EMAIL: "owner@example.com" } as typeof env;
    const res = await app.request("https://memory.test/api/v1/whoami", {}, devEnv);
    const body = (await res.json()) as { anonymous: boolean; actor: string };
    expect(body.anonymous).toBe(false);
    expect(body.actor).toBe("human");
  });

  it("does NOT resolve when the request carries cf-ray (edge-routed / production-shaped), even when the var is set (deploy-leak guard)", async () => {
    const devEnv = { ...(env as Record<string, unknown>), DEV_ACCESS_EMAIL: "owner@example.com" } as typeof env;
    const res = await app.request("https://memory.test/api/v1/notes", { headers: { "cf-ray": "8c9f2e1a4b3d5e6f-SJC" } }, devEnv);
    expect(res.status).toBe(401);
  });

  it("does not let DEV_ACCESS_EMAIL name someone who was never invited", async () => {
    // dev バイパスは「誰として入るか」を決めるだけで、招待の代わりにはならない。
    // ここが 200 になると、ローカルでだけ招待制が無効という状態が生まれる。
    const devEnv = { ...(env as Record<string, unknown>), DEV_ACCESS_EMAIL: "someone-else@example.com" } as typeof env;
    const res = await app.request("https://memory.test/api/v1/notes", {}, devEnv);
    expect(res.status).toBe(403);
  });

  it("resolves an INVITED address named by DEV_ACCESS_EMAIL", async () => {
    const devEnv = { ...(env as Record<string, unknown>), DEV_ACCESS_EMAIL: "owner@example.com" } as typeof env;
    const res = await app.request("https://memory.test/api/v1/notes", {}, devEnv);
    expect(res.status).toBe(200);
  });

  it("does NOT resolve when DEV_ACCESS_EMAIL is unset", async () => {
    const res = await app.request("https://memory.test/api/v1/notes", {}, env);
    expect(res.status).toBe(401);
  });
});
