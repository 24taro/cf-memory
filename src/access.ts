// Cloudflare Access (Zero Trust SSO) JWT verification — THE human/web auth.
//
// This file answers one question and no longer answers a second one. It says
// whether an assertion is genuinely ours; it does NOT say who is allowed to be
// here. That was cf-memory's own allow-list, retired 2026-08-18 — membership is a
// Cloudflare Access policy, so keeping a copy here made adding a person a
// two-place operation whose halves could disagree.
//
// When ACCESS_TEAM_DOMAIN or ACCESS_AUD is unset, the web door is closed
// fail-closed (Bearer agent doors are unaffected either way). Fail-closed
// everywhere: any failure returns null.
//
// Security note: a request can hit the Worker directly (bypassing the Access
// proxy) and forge a Cf-Access-Jwt-Assertion header, so the header is NEVER
// trusted on its own — we fully verify the RS256 signature against the team's
// JWKS and pin both `aud` (the Application Audience tag) and `iss` (the team
// domain). That signature + aud pinning is what makes header-based identity safe.

import type { Env } from "./types";
import { boundedJson } from "./bounded-body";

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  [k: string]: unknown;
}

// Cache by team domain and expire the whole set so a warm isolate eventually
// stops accepting retired keys even if it has never seen a newer key ID.
const jwksCache = new Map<string, { keys: Map<string, CryptoKey>; expiresAt: number }>();
const JWKS_CACHE_TTL_MS = 10 * 60_000;

function currentKeys(teamDomain: string): Map<string, CryptoKey> | undefined {
  const cached = jwksCache.get(teamDomain);
  return cached && cached.expiresAt > Date.now() ? cached.keys : undefined;
}

// W4: cooldown gate for the FORCED refetch on a kid-miss, keyed by team domain.
// A forged token with a random kid is a kid-miss on EVERY request -- unlike a
// legitimate rotation, it never populates a cache entry for that kid, so
// without a cap it forces one uncached JWKS fetch per request forever (an
// unauthenticated fetch-amplification vector). At most one forced refetch per
// team domain per FORCED_REFETCH_COOLDOWN_MS; legitimate rotation still
// recovers immediately on the very first miss (the map starts empty) and
// within the cooldown window on any miss thereafter.
const lastForcedRefetch = new Map<string, number>();
const FORCED_REFETCH_COOLDOWN_MS = 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 32;
const MAX_JWT_LENGTH = 64 * 1024;

// Clock skew tolerance (seconds) for exp/nbf/iat checks.
const SKEW = 60;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
  } catch {
    return null;
  }
}

/** Fetch the active key set. A failed refresh leaves any still-fresh keys available. */
async function refreshKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const map = new Map<string, CryptoKey>();
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return currentKeys(teamDomain) ?? map;
    }
    const body = await boundedJson(res, MAX_JWKS_RESPONSE_BYTES) as { keys?: Jwk[] } | null;
    if (!Array.isArray(body?.keys) || body.keys.length > MAX_JWKS_KEYS) return currentKeys(teamDomain) ?? map;
    for (const jwk of body.keys) {
      if (!jwk || typeof jwk.kid !== "string" || !jwk.kid || jwk.kty !== "RSA") continue;
      try {
        const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        map.set(jwk.kid, key);
      } catch {
        // skip malformed key
      }
    }
    if (!map.size && body.keys.length) return currentKeys(teamDomain) ?? map;
    jwksCache.set(teamDomain, { keys: map, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
    return map;
  } catch {
    // Network error (DNS, timeout, reset) or parsing error — fail closed by
    // returning the previous cache (or empty map), never throwing. Allows
    // verifyAccessJwt to maintain its fail-closed invariant: return null,
    // never reject.
    return currentKeys(teamDomain) ?? map;
  }
}

/** TEST SEAM: seed the JWKS cache for a team domain so verifyAccessJwt can run
 * fully offline (no network). Not used in production paths. */
export function seedJwks(teamDomain: string, keys: Map<string, CryptoKey>): void {
  jwksCache.set(teamDomain, { keys, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
}

/** TEST SEAM: clear the cache between tests. Also clears the W4 forced-refetch
 * cooldown map so each test starts with a clean, un-throttled cooldown state. */
export function clearJwksCache(): void {
  jwksCache.clear();
  lastForcedRefetch.clear();
}

interface AccessHeader {
  kid?: string;
  alg?: string;
}
interface AccessPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
}

/** Verify a Cloudflare Access JWT and return the allowed identity, or null on
 * ANY failure (including the feature being disabled). Validates signature, aud,
 * iss, and the exp/nbf/iat time bounds. */
export async function verifyAccessJwt(token: string | undefined | null, env: Env): Promise<AccessIdentity | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return null; // feature off
  if (!token || token.length > MAX_JWT_LENGTH) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlToJson<AccessHeader>(headerB64);
  const payload = b64urlToJson<AccessPayload>(payloadB64);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;
  if (typeof header.kid !== "string" || !header.kid) return null;

  // Reject claims that cannot belong to this application before fetching keys.
  // The signature still gates every returned identity.
  const audList = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
  if (!Array.isArray(audList) || !audList.every(value => typeof value === "string") || !audList.includes(aud)) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec - SKEW) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSec + SKEW)) return null;
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > nowSec + SKEW)) return null;
  if (typeof payload.email !== "string" || !payload.email.trim() || typeof payload.sub !== "string" || !payload.sub.trim()) return null;

  const cached = currentKeys(teamDomain);
  let key = (cached ?? await refreshKeys(teamDomain)).get(header.kid);
  if (!key && cached) {
    // Cloudflare rotates the Access signing keys; a long-lived isolate's cache
    // can predate the current set, so a kid miss triggers a refetch to recover.
    // W4: gate the refetch behind a per-team-domain cooldown -- a FORGED token
    // with a random kid is ALSO a kid miss, on every single request (the miss
    // never populates a cache entry for that kid, so it never gets cheaper),
    // and without this cooldown that costs one uncached JWKS fetch per garbage
    // request forever. Capping forced refetches to once per
    // FORCED_REFETCH_COOLDOWN_MS per team domain bounds that to at most one
    // JWKS fetch per minute per isolate, while legitimate rotation still
    // recovers immediately on the first miss (cooldown map starts empty) and
    // within the cooldown window on any later miss.
    const last = lastForcedRefetch.get(teamDomain) ?? 0;
    if (Date.now() - last > FORCED_REFETCH_COOLDOWN_MS) {
      lastForcedRefetch.set(teamDomain, Date.now());
      key = (await refreshKeys(teamDomain)).get(header.kid);
    }
  }
  if (!key) return null;

  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(sigB64);
  } catch {
    return null;
  }
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig as unknown as BufferSource, signed as unknown as BufferSource);
  } catch {
    return null;
  }
  if (!ok) return null;

  return { email: payload.email, sub: payload.sub };
}

