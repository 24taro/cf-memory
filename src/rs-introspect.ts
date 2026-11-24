// ============================================================================
// Replaces the earlier rs-verify.ts (JWT + JWKS). Tokens are opaque now, so a
// resource server cannot check one by itself — it asks the authorization
// server. That call goes over a Cloudflare service binding, so it stays inside
// the account and costs no public round trip.
//
// Consequences of this shape, both deliberate:
//   - `auth` is on the request path. If it is down, this server rejects.
//   - Revocation takes effect on the NEXT request, not at token expiry.
// ============================================================================

import { boundedJson } from "./bounded-body";

const MAX_INTROSPECTION_RESPONSE_BYTES = 64 * 1024;
const INTROSPECTION_TIMEOUT_MS = 5_000;

export interface VerifiedToken {
  /** `user:<ULID>` (a person) or `machine:<name>`. Stable — resolve accounts by
   * THIS, never by the email below. An address is a name someone can change; a
   * server that keys off it turns a rename into a different person. */
  subject: string;
  scopes: Set<string>;
  /** The person's address at consent time, for display and attribution.
   * Absent for machine credentials. */
  email?: string;
}

export interface IntrospectConfig {
  /** Service binding to the auth Worker. */
  auth: { fetch: (request: Request) => Promise<Response> };
  /** Shared secret this resource server authenticates to /introspect with. */
  secret: string;
  /** This server's canonical resource URI. The token's audience must cover it. */
  audience: string;
}

/** Validate a Bearer token. Returns null on ANY failure — including the
 * authorization server being unreachable, which must read as "not authorised"
 * rather than as an exception that 500s the request. */
export async function introspectToken(
  token: string | null | undefined,
  config: IntrospectConfig,
): Promise<VerifiedToken | null> {
  if (!token || !config.secret) return null;

  let res: Response;
  try {
    res = await config.auth.fetch(
      new Request("https://auth.internal/introspect", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${config.secret}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return null;
  }

  let body: unknown;
  try {
    body = await boundedJson(res, MAX_INTROSPECTION_RESPONSE_BYTES);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { active, sub, scope, aud, email } = body as Record<string, unknown>;
  if (active !== true || typeof sub !== "string" || !sub.trim()) return null;
  if (scope !== undefined && typeof scope !== "string") return null;
  if (email !== undefined && typeof email !== "string") return null;

  // Audience binding is still ours to enforce: the authorization server reports
  // what the token is for, but only this server knows what it is. Without this
  // check a token minted for cf-memory would be accepted by search.
  const auds = typeof aud === "string" ? [aud] : aud;
  if (!Array.isArray(auds) || !auds.every(value => typeof value === "string") || !auds.includes(config.audience)) return null;

  return {
    subject: sub,
    scopes: new Set((scope ?? "").split(" ").filter(Boolean)),
    ...(email ? { email } : {}),
  };
}

/** The 401 an unauthenticated machine request must get. `resource_metadata`
 * points at the discovery document, which is how an MCP client finds the
 * authorization server without being told (RFC 9728 §5.1). */
export function unauthorizedChallenge(resourceMetadataUrl: string, scope: string): Headers {
  return new Headers({
    "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scope}"`,
  });
}

/** The 403 for a valid token missing a scope. Distinct from 401 on purpose: a
 * client that cannot tell them apart loops on re-authentication instead of
 * asking for more scope. */
export function insufficientScopeChallenge(resourceMetadataUrl: string, requiredScopes: string[]): Headers {
  return new Headers({
    "www-authenticate":
      `Bearer error="insufficient_scope", scope="${requiredScopes.join(" ")}", ` +
      `resource_metadata="${resourceMetadataUrl}"`,
  });
}

/** Protected-resource metadata (RFC 9728). Serve UNAUTHENTICATED at
 * `/.well-known/oauth-protected-resource[/<path>]` — a client that cannot read
 * it cannot discover where to authenticate. */
export function protectedResourceMetadata(input: { resource: string; issuer: string; scopes: string[] }) {
  return {
    resource: input.resource,
    authorization_servers: [input.issuer],
    scopes_supported: input.scopes,
    bearer_methods_supported: ["header"],
  };
}
