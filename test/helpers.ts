// Test-only fixture helpers (not production code — YAGNI does not apply to
// test-fixture ergonomics). Principal grew two required fields (authSource,
// isAdminFlag) with this feature; this one function is the single place that
// change is absorbed so future Principal changes don't need to be patched
// into every test file individually.
import type { Principal } from "../src/types";

export function principalFixture(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "U_TEST",
    handle: "test",
    // Both scopes, like mintTestToken/bearerTokenFor: a Bearer principal without
    // notes:read is refused by every read tool and GET route (2026-11-14).
    scopes: new Set(["notes:read", "notes:write"]),
    anonymous: false,
    actor: "agent",
    authSource: overrides.anonymous ? "none" : "bearer",
    isAdminFlag: false,
    ...overrides,
  };
}

// ---- Cloudflare Access test-auth fixture (Task 2) --------------------------
// One RSA keypair per test file: setupAccessAuth() seeds the JWKS cache under
// ACCESS_TEST_TEAM/ACCESS_TEST_KID and returns a signer so integration tests
// can mint a valid Access JWT for any email — no network, mirrors the
// signJwt/seedJwks pattern of test/access.test.ts.
import { seedJwks } from "../src/access";

export const ACCESS_TEST_TEAM = "team.test.cloudflareaccess.com";
export const ACCESS_TEST_AUD = "test-aud-tag";
export const ACCESS_TEST_KID = "helper-kid";

export const TEST_ISSUER = "https://auth.test";
export const TEST_RESOURCE = "https://memory.test/mcp";
export const TEST_TOKEN_KID = "rs-helper-kid";

/** Access vars PLUS the agent-door vars — a test that authenticates one way
 * usually authenticates the other way somewhere in the same file, and omitting
 * the second set fails closed rather than loudly. */
export function accessEnvVars(ownerEmail: string) {
  return {
    ACCESS_TEAM_DOMAIN: ACCESS_TEST_TEAM,
    ACCESS_AUD: ACCESS_TEST_AUD,
    OWNER_EMAIL: ownerEmail,
    ...rsEnvVars(),
  };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export interface AccessJwtOverrides {
  /** Mint for another Access application: a real signature that is not for us. */
  aud?: string;
  /** Mint from another Cloudflare team. */
  iss?: string;
  /** Negative to mint an already-expired assertion. */
  expiresInSeconds?: number;
}

export async function setupAccessAuth(): Promise<
  (email: string, overrides?: AccessJwtOverrides) => Promise<string>
> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pub = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  seedJwks(ACCESS_TEST_TEAM, new Map([[ACCESS_TEST_KID, pub]]));
  return async (email: string, overrides: AccessJwtOverrides = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const h = b64urlJson({ alg: "RS256", typ: "JWT", kid: ACCESS_TEST_KID });
    const p = b64urlJson({ aud: overrides.aud ?? ACCESS_TEST_AUD, iss: overrides.iss ?? `https://${ACCESS_TEST_TEAM}`, exp: now + (overrides.expiresInSeconds ?? 600), iat: now - 5, nbf: now - 5, email, sub: `sub-${email}` });
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`)));
    return `${h}.${p}.${b64url(sig)}`;
  };
}

// ---- Bearer token fixture (2026-08-14: opaque tokens + introspection) ------
// Tokens are opaque now, so a fixture cannot sign one — it registers one. The
// AUTH service binding is stubbed to answer introspection from that registry,
// which is exactly the shape the real authorization server returns.

interface TokenRecord {
  subject: string;
  scope: string;
  aud: string[];
  email?: string;
  /** Force a response the real server would not send, so the resource server's
   * own refusals can be told apart from "auth already said no". */
  respondWith?: { status?: number; body?: unknown };
}
const issuedTokens = new Map<string, TokenRecord>();
let tokenCounter = 0;

/** The stand-in for the auth Worker's service binding. */
export const authStub = {
  async fetch(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${TEST_INTROSPECTION_SECRET}`) {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    }
    const form = new URLSearchParams(await request.text());
    const rec = issuedTokens.get(form.get("token") ?? "");
    if (!rec) return new Response(JSON.stringify({ active: false }), { status: 200 });
    if (rec.respondWith) {
      return new Response(JSON.stringify(rec.respondWith.body ?? {}), {
        status: rec.respondWith.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ active: true, sub: rec.subject, scope: rec.scope, aud: rec.aud, ...(rec.email ? { email: rec.email } : {}) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
};

export const TEST_INTROSPECTION_SECRET = "test-introspection-secret";

function registerToken(
  subject: string,
  scopesCsv: string,
  aud: string | string[] = TEST_RESOURCE,
  respondWith?: { status?: number; body?: unknown },
  email?: string,
): string {
  tokenCounter++;
  const token = `at_test_${tokenCounter}`;
  issuedTokens.set(token, {
    subject,
    // The wire format is space-delimited (RFC 6749); the retired key rows were CSV.
    scope: scopesCsv.split(",").map((x) => x.trim()).filter(Boolean).join(" "),
    aud: Array.isArray(aud) ? aud : [aud],
    respondWith,
    email,
  });
  return token;
}

export async function bearerKeyFixture(db: D1Database, userId: string, scopes = "notes:read,notes:write"): Promise<string> {
  // Mint the token the real authorization server would: it names the person,
  // and the resource server resolves that name to a row. Falling back to a
  // machine subject keeps callers that seeded no user working.
  // 2026-08-17: subject は `user:<account id>`。行に auth_user_id が無ければ、
  // 実運用と同じく初回提示で紐付けさせる(email クレーム経由)。
  const row = await db
    .prepare("SELECT email, auth_user_id FROM users WHERE id=?")
    .bind(userId)
    .first<{ email: string | null; auth_user_id: string | null }>()
    .catch(() => null);
  if (!row?.email) return registerToken(`machine:${userId}`, scopes);
  const accountId = row.auth_user_id ?? `acct-${userId}`;
  return registerToken(`user:${accountId}`, scopes, TEST_RESOURCE, undefined, row.email);
}

/** Drop-in replacement for the retired `INSERT INTO api_keys` fixture. */
export async function mintTestToken(userIdOrEmail: string, scopes = "notes:read,notes:write"): Promise<string> {
  const subject = userIdOrEmail.includes("@") ? `human:${userIdOrEmail}` : `machine:${userIdOrEmail}`;
  return registerToken(subject, scopes);
}

/** Mint a token that is valid except for the property under test. */
export async function bearerTokenFor(opts: {
  sub?: string;
  scopes?: string;
  aud?: string | string[];
  respondWith?: { status?: number; body?: unknown };
  /** The `email` claim auth carries alongside `user:<ULID>`. Needed to link an
   * account to an existing row, and to name a handle for a new one. */
  email?: string;
}): Promise<string> {
  return registerToken(
    opts.sub ?? "machine:test",
    opts.scopes ?? "notes:read,notes:write",
    opts.aud ?? TEST_RESOURCE,
    opts.respondWith,
    opts.email,
  );
}

/** The three vars plus the binding the agent door needs. Spread into a test's
 * env literal; without them resolvePrincipal fails closed and every Bearer
 * request looks anonymous. */
export function rsEnvVars() {
  return {
    AUTH_ISSUER: TEST_ISSUER,
    RESOURCE_URI: TEST_RESOURCE,
    INTROSPECTION_SECRET: TEST_INTROSPECTION_SECRET,
    AUTH: authStub,
  };
}

// ---- Concurrent-change hook (2026-10-31) ------------------------------------
// The removed vector index used to be the seam where tests injected a write
// "between candidate selection and hydration". With keyword-only search the
// seam is the D1 statement itself: `gatedDb` wraps a database so that, right
// after a statement whose SQL matches `match` finishes `method`, the pending
// `gate.next` hook (if any) runs once before the caller sees the result.
export interface DbGate { next?: () => Promise<void> }
export function gatedDb(real: D1Database, gate: DbGate, match: (sql: string) => boolean, method: 'all' | 'first' | 'run' = 'all'): D1Database {
  const passthrough = <T extends object>(target: T, override: (t: T, p: PropertyKey) => unknown) => new Proxy(target, {
    get: (t, p) => {
      const v = override(t, p);
      if (v !== undefined) return v;
      const own = (t as Record<PropertyKey, unknown>)[p];
      return typeof own === 'function' ? (own as (...a: unknown[]) => unknown).bind(t) : own;
    },
  });
  const after = (bound: D1PreparedStatement) => passthrough(bound, (b, p) => p !== method ? undefined : async (...args: unknown[]) => {
    const out = await (b[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    const hook = gate.next; gate.next = undefined;
    if (hook) await hook();
    return out;
  });
  return passthrough(real, (t, p) => p !== 'prepare' ? undefined : (sql: string) => {
    const stmt = t.prepare(sql);
    if (!match(sql)) return stmt;
    return passthrough(stmt, (st, q) => q !== 'bind' ? undefined : (...args: unknown[]) => after(st.bind(...args)));
  });
}

// ---- cf-memory-logs migrations (2026-10-31) -------------------------------------
import { readFileSync as readMigration, readdirSync as listMigrations } from "node:fs";
import { join as joinPath } from "node:path";
/** Split a migration file into statements. Unlike the `split(';')` the other
 * suites use for `migrations/`, this keeps a `CREATE TRIGGER … BEGIN … END;`
 * body (which contains its own semicolons) as one statement. */
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [], inTrigger = false;
  for (const raw of sql.split("\n")) {
    const line = raw.split("--")[0].trimEnd();
    if (!line.trim()) continue;
    current.push(line);
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) inTrigger = true;
    const ends = inTrigger ? /^\s*END\s*;\s*$/i.test(line) : /;\s*$/.test(line);
    if (ends) { out.push(current.join("\n").replace(/;\s*$/, "")); current = []; inTrigger = false; }
  }
  if (current.join("").trim()) out.push(current.join("\n"));
  return out;
}
/** Apply every `migrations-logs/*.sql` file in order (the LOGS database). */
export async function applyLogMigrations(db: D1Database): Promise<void> {
  for (const name of listMigrations("migrations-logs").filter(n => /^\d+_.*\.sql$/.test(n)).sort())
    for (const statement of sqlStatements(readMigration(joinPath("migrations-logs", name), "utf8"))) await db.prepare(statement).run();
}
/** Apply every `migrations/*.sql` file in order (the main DB), as the other suites do. */
export async function applyMainMigrations(db: D1Database): Promise<void> {
  for (const name of listMigrations("migrations").filter(n => /^\d+_.*\.sql$/.test(n)).sort())
    for (const statement of readMigration(joinPath("migrations", name), "utf8").split("\n").map(l => l.split("--")[0]).join("\n").split(";").map(s => s.trim()).filter(Boolean))
      await db.prepare(statement).run();
}
