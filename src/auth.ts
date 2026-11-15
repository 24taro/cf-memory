// One scope model for every door (web via Cloudflare Access, REST, MCP, CLI).
//
// 2026-08-14: cf-memory issues no credentials of its own any more. The agent door
// takes an opaque access token from auth.example.com and asks that server what it
// is (src/rs-introspect.ts); the `api_keys` store that this file used to hash
// into was dropped by migration 0026. What is left here is the vocabulary the
// two doors share — extraction, and the allows()/callerIsAdmin decisions.

import type { Principal } from "./types";

export type Scope = "notes:read" | "notes:write" | "admin";

/** `admin` implies everything; otherwise the exact scope must be present. */
export function hasScope(scopes: Set<string>, required: Scope): boolean {
  return scopes.has("admin") || scopes.has(required);
}

/** Extract a bearer token from an Authorization header. Split from cookie-based
 * extraction (extractAccessToken, decision 7) so the two credential spaces can
 * never be confused: a Bearer key's scopes must never leak onto an
 * Access-authenticated request, and vice versa. */
export function extractBearerToken(authHeader: string | null): string | null {
  if (authHeader && /^Bearer\s+/i.test(authHeader)) return authHeader.replace(/^Bearer\s+/i, "").trim();
  return null;
}

/** Shortest fixed owner token that is accepted (see Env.API_TOKEN). */
export const MIN_API_TOKEN_CHARS = 32;

/** Whether `presented` is the configured fixed owner token. Both sides are
 * hashed first, so the comparison takes the same time whatever the presented
 * token's length or content. An unset or too-short configured token matches
 * nothing. */
export async function matchesApiToken(presented: string, configured: string | undefined): Promise<boolean> {
  const expected = configured?.trim() ?? "";
  if (expected.length < MIN_API_TOKEN_CHARS) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Extract a Cloudflare Access app token. The Cf-Access-Jwt-Assertion header
 * (edge-injected on paths the Access app covers, e.g. /access*) wins; otherwise
 * the domain-wide CF_Authorization cookie (Path=/) set after passing the SSO
 * login app. The value is a JWT — cookie-safe charset, so no URI decoding. */
export function extractAccessToken(accessJwtHeader: string | null, cookieHeader: string | null): string | null {
  const h = accessJwtHeader?.trim();
  if (h) return h;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "CF_Authorization") {
      const val = v.join("=").trim();
      if (val) return val;
    }
  }
  return null;
}

/** 何ができるか。scope を見るのは機械の扉から来たときだけ。
 *
 * 2026-08-19: 人が自分の手で操作しているとき、委譲は起きていない。scope は
 * 「アプリが利用者の代理でどこまで触れるか」を表す委譲の仕組みであって、本人が
 * 直接操作する場面には登場しない。cf-memory はこれまで人間にも
 * {notes:read, notes:write} を捏造して渡していたが、その集合は誰に対しても同じで、
 * 判定に何も足していなかった。tasks の人間の扉が空集合を渡しているのと同じ形に揃える。
 *
 * cf-memory は招待された人の中で権限を分けない(3人規模)。だから「招待されている =
 * 読み書きできる」が全部で、access の扉に届いた時点で答えは決まっている。
 * admin はここでは扱わない — callerIsAdmin が扉ごとに別の根拠を見ている。 */
export function allows(principal: Principal, required: Scope): boolean {
  if (principal.anonymous) return false;
  // admin は扉ごとに根拠が違う。二重に書かず callerIsAdmin に委譲する。
  if (required === "admin") return callerIsAdmin(principal);
  if (principal.authSource === "access") return true;
  return hasScope(principal.scopes, required);
}

/** whoami 等で「この人は何ができるか」を答えるための実効集合。
 *
 * 生の principal.scopes を見せてはいけない: 人間の扉では空集合なので
 * 「何もできません」と読める。それは嘘で、招待されていれば読み書きできる。
 * 表示は allows() と同じ根拠から導く。 */
export function effectiveScopes(principal: Principal): Scope[] {
  const out: Scope[] = (["notes:read", "notes:write"] as const).filter((s) => allows(principal, s));
  // admin は「scope として持っているとき」だけ挙げる。人間の扉の isAdminFlag は
  // 自分の領域の管理者であることを指し、scope ではない(decision 7)。ここに混ぜると
  // 全員の whoami に admin が出て、今日 search:admin で直したのと同じ
  // 「scope でないものが scope に見える」状態が戻る。
  if (principal.authSource === "bearer" && hasScope(principal.scopes, "admin")) out.push("admin");
  return out;
}

/** decision 8: the single place admin status is derived. Bearer credentials use
 * the 'admin' scope; Access credentials (the human door) carry isAdminFlag on
 * the principal — an invited SSO identity administers ITS OWN space, so reaching
 * that branch already proves the only adminness that exists there.
 *
 * 2026-08-19: the old note here said both doors "hardcode {notes:read,
 * notes:write} regardless of admin status". The human door now carries no scopes
 * at all (see allows), so scope really is consulted for the bearer path only —
 * which is what this function always did. */
export function callerIsAdmin(principal: Principal): boolean {
  if (principal.anonymous) return false;
  if (principal.authSource === "bearer") return hasScope(principal.scopes, "admin");
  if (principal.authSource === "access") return principal.isAdminFlag === true;
  return false;
}
