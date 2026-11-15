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

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  [k: string]: unknown;
}

// Module-level JWKS cache (per instance lifetime). Keyed by team domain so a
// re-used isolate serving multiple configs stays correct; value is a Map by kid.
const jwksCache = new Map<string, Map<string, CryptoKey>>();

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

/** Fetch + parse the team JWKS into a kid→CryptoKey map, caching per team domain.
 * `forceRefresh` bypasses the cache (kid-rotation path). Test seam: `seedJwks`
 * lets unit tests inject keys without network access. */
async function getKeys(teamDomain: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh) {
    const cached = jwksCache.get(teamDomain);
    if (cached) return cached;
  }
  const map = new Map<string, CryptoKey>();
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) {
      // Do not cache a failed fetch — keep any previous cache so a transient
      // JWKS outage doesn't wipe known-good keys, and allow a later retry.
      return jwksCache.get(teamDomain) ?? map;
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      try {
        const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        map.set(jwk.kid, key);
      } catch {
        // skip malformed key
      }
    }
    jwksCache.set(teamDomain, map);
    return map;
  } catch {
    // Network error (DNS, timeout, reset) or parsing error — fail closed by
    // returning the previous cache (or empty map), never throwing. Allows
    // verifyAccessJwt to maintain its fail-closed invariant: return null,
    // never reject.
    return jwksCache.get(teamDomain) ?? map;
  }
}

/** TEST SEAM: seed the JWKS cache for a team domain so verifyAccessJwt can run
 * fully offline (no network). Not used in production paths. */
export function seedJwks(teamDomain: string, keys: Map<string, CryptoKey>): void {
  jwksCache.set(teamDomain, keys);
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
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlToJson<AccessHeader>(headerB64);
  const payload = b64urlToJson<AccessPayload>(payloadB64);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;
  if (!header.kid) return null;

  let keys = await getKeys(teamDomain);
  let key = keys.get(header.kid);
  if (!key) {
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
      keys = await getKeys(teamDomain, true);
      key = keys.get(header.kid);
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

  // aud must include the configured Application Audience tag.
  const audList = Array.isArray(payload.aud) ? payload.aud : payload.aud != null ? [payload.aud] : [];
  if (!audList.includes(aud)) return null;

  // iss must be the team domain.
  if (payload.iss !== `https://${teamDomain}`) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec - SKEW) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + SKEW) return null;
  if (typeof payload.iat === "number" && payload.iat > nowSec + SKEW) return null;

  if (!payload.email || !payload.sub) return null;
  return { email: payload.email, sub: payload.sub };
}

