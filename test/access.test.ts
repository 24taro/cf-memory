// Cloudflare Access JWT verification — pure/unit tests. We generate a real
// RSASSA-PKCS1-v1_5 SHA-256 keypair via Web Crypto, export the public JWK (with
// a kid), sign a JWT ourselves, and seed it into verifyAccessJwt's JWKS cache
// (the `seedJwks` test seam) so NO network is hit. Asserts the full fail-closed
// matrix: valid → identity; tampered sig / wrong aud / wrong iss / expired → null;
// feature unset → null. Membership is not decided here any more (2026-08-18):
// the Cloudflare Access policy decides it, and this module proves the JWT is real.
import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import { clearJwksCache, seedJwks, verifyAccessJwt } from "../src/access";
import { allows, effectiveScopes } from "../src/auth";
import type { Env } from "../src/types";

const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud-tag-123";
const KID = "test-kid-1";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

let privateKey: CryptoKey;
let publicKey: CryptoKey;

async function setup(): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  // Import the public key under the test kid into the JWKS cache.
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const imported = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  seedJwks(TEAM, new Map([[KID, imported]]));
}

async function signJwt(payload: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): Promise<string> {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const signing = new TextEncoder().encode(`${h}.${p}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, signing));
  return `${h}.${p}.${b64url(sig)}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
function fullEnv(extra: Partial<Env> = {}): Env {
  return { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra } as Env;
}
function validPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: AUD, iss: `https://${TEAM}`, exp: nowSec() + 600, iat: nowSec() - 5, nbf: nowSec() - 5, email: "owner@example.com", sub: "sub-abc", ...extra };
}

beforeEach(async () => {
  clearJwksCache();
  await setup();
});

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the identity", async () => {
    const token = await signJwt(validPayload());
    const id = await verifyAccessJwt(token, fullEnv());
    expect(id).toEqual({ email: "owner@example.com", sub: "sub-abc" });
  });

  it("rejects a tampered signature → null", async () => {
    const token = await signJwt(validPayload());
    const parts = token.split(".");
    // Flip a char in the middle of the signature segment (the final char only
    // carries discarded padding bits, so mutate well inside the byte stream).
    const sig = parts[2];
    const i = Math.floor(sig.length / 2);
    parts[2] = sig.slice(0, i) + (sig[i] === "A" ? "B" : "A") + sig.slice(i + 1);
    const id = await verifyAccessJwt(parts.join("."), fullEnv());
    expect(id).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches) → null", async () => {
    const token = await signJwt(validPayload());
    const parts = token.split(".");
    parts[1] = b64urlJson(validPayload({ email: "attacker@example.com" }));
    const id = await verifyAccessJwt(parts.join("."), fullEnv());
    expect(id).toBeNull();
  });

  it("rejects a wrong aud → null", async () => {
    const token = await signJwt(validPayload({ aud: "some-other-aud" }));
    expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
  });

  it("accepts when aud is an array containing the configured tag", async () => {
    const token = await signJwt(validPayload({ aud: ["other", AUD] }));
    const id = await verifyAccessJwt(token, fullEnv());
    expect(id?.email).toBe("owner@example.com");
  });

  it("rejects a wrong iss → null", async () => {
    const token = await signJwt(validPayload({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
  });

  it("rejects an expired exp → null", async () => {
    const token = await signJwt(validPayload({ exp: nowSec() - 3600 }));
    expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
  });

  it("rejects an unknown kid → null", async () => {
    // Stub fetch so the kid-miss refetch doesn't hit the live JWKS endpoint.
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    });
    try {
      const token = await signJwt(validPayload(), { kid: "no-such-kid" });
      expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a non-RS256 alg → null", async () => {
    const token = await signJwt(validPayload(), { alg: "HS256" });
    expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
  });

  it("returns null when the feature is disabled (env unset)", async () => {
    const token = await signJwt(validPayload());
    expect(await verifyAccessJwt(token, {} as Env)).toBeNull();
    expect(await verifyAccessJwt(token, { ACCESS_TEAM_DOMAIN: TEAM } as Env)).toBeNull();
    expect(await verifyAccessJwt(token, { ACCESS_AUD: AUD } as Env)).toBeNull();
  });

  it("returns null for a missing/malformed token", async () => {
    expect(await verifyAccessJwt(undefined, fullEnv())).toBeNull();
    expect(await verifyAccessJwt("not-a-jwt", fullEnv())).toBeNull();
    expect(await verifyAccessJwt("a.b", fullEnv())).toBeNull();
  });
});


describe("JWKS rotation: kid miss triggers ONE refetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refetches the JWKS once when the cached set lacks the token's kid, then verifies", async () => {
    // Cache is seeded EMPTY (simulates a long-lived isolate that fetched before rotation).
    seedJwks(TEAM, new Map());
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID }] }), { status: 200 });
    });
    const token = await signJwt(validPayload());
    const id = await verifyAccessJwt(token, fullEnv());
    expect(id?.email).toBe("owner@example.com");
    expect(fetchCount).toBe(1); // exactly one refetch, no loop
  });

  it("returns null (no retry loop) when the kid is absent even after a refetch", async () => {
    seedJwks(TEAM, new Map());
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    });
    const token = await signJwt(validPayload(), { kid: "rotated-away" });
    expect(await verifyAccessJwt(token, fullEnv())).toBeNull();
    expect(fetchCount).toBe(1); // one refetch attempt, then fail closed
  });

  // W4: an unauthenticated caller can send an endless stream of garbage kids —
  // each one is a kid-miss on every request (a miss never populates a cache
  // entry for that kid), so without a cooldown that's an uncached JWKS fetch
  // PER REQUEST forever. A second garbage-kid verify within the cooldown
  // window must reuse the cache and perform no additional fetch.
  it("a second garbage-kid verify within the cooldown performs NO additional fetch", async () => {
    seedJwks(TEAM, new Map());
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    });
    const token1 = await signJwt(validPayload(), { kid: "garbage-kid-1" });
    expect(await verifyAccessJwt(token1, fullEnv())).toBeNull();
    expect(fetchCount).toBe(1); // first miss: forced refetch runs

    const token2 = await signJwt(validPayload(), { kid: "garbage-kid-2" });
    expect(await verifyAccessJwt(token2, fullEnv())).toBeNull();
    expect(fetchCount).toBe(1); // second miss within the cooldown: no new fetch
  });
});

// ── allows() / effectiveScopes() ────────────────────────────────────────────
// 2026-08-19: 人間の扉が scope を持たなくなったので、「何ができるか」は allows()
// だけが答える。ゲート(index.tsx)が匿名を先に 401 にするため、この関数の匿名判定は
// アプリ経由のテストでは到達しない — 実際、壊しても分離テストは通った。
// 二枚目の鍵は、それ自体を直接試さないと鍵として存在しない。
describe("allows — 何ができるか", () => {
  const base = { userId: "u1", handle: "h", anonymous: false, actor: "human" as const, isAdminFlag: false };
  const human = { ...base, scopes: new Set<string>(), authSource: "access" as const, isAdminFlag: true };
  const agentRead = { ...base, scopes: new Set(["notes:read"]), authSource: "bearer" as const, actor: "agent" as const };
  const agentAdmin = { ...base, scopes: new Set(["admin"]), authSource: "bearer" as const, actor: "agent" as const };
  const anon = { ...base, scopes: new Set<string>(), anonymous: true, authSource: "none" as const };

  it("匿名は何もできない", () => {
    expect(allows(anon, "notes:read")).toBe(false);
    expect(allows(anon, "notes:write")).toBe(false);
    expect(allows(anon, "admin")).toBe(false);
  });

  it("未招待の人は access 経路でも何もできない", () => {
    // ここが本番。anon(authSource:"none") は scope が空なので、匿名判定が無くても
    // 偶然 false になる — 実際、匿名判定を壊す変異はそれで素通りした。
    // 危険なのは notInvited の形で、anonymous:true かつ authSource:"access"。
    // 匿名判定が無いと「access なら true」の行に落ちて、招待されていない人に
    // 書き込みまで許してしまう。
    const notInvited = { ...base, scopes: new Set<string>(), anonymous: true, authSource: "access" as const, notInvited: true };
    expect(allows(notInvited, "notes:read")).toBe(false);
    expect(allows(notInvited, "notes:write")).toBe(false);
    expect(effectiveScopes(notInvited)).toEqual([]);
  });

  it("招待された人は scope を持たないが読み書きできる", () => {
    // 空集合を hasScope に通すと false になる。人間の扉では scope を見ないことが要点。
    expect(human.scopes.size).toBe(0);
    expect(allows(human, "notes:read")).toBe(true);
    expect(allows(human, "notes:write")).toBe(true);
  });

  it("機械はトークンの scope どおり", () => {
    expect(allows(agentRead, "notes:read")).toBe(true);
    expect(allows(agentRead, "notes:write")).toBe(false);
    expect(allows(agentAdmin, "notes:write")).toBe(true); // admin は全部を含む
  });

  it("whoami は人間に admin を見せない", () => {
    // isAdminFlag は「自分の領域の管理者」であって scope ではない。ここに混ぜると
    // 全員の whoami に admin が出て、scope でないものが scope に見える。
    expect(effectiveScopes(human)).toEqual(["notes:read", "notes:write"]);
    expect(effectiveScopes(agentAdmin)).toContain("admin");
    expect(effectiveScopes(anon)).toEqual([]);
  });
});
