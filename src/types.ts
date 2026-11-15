// Shared domain + environment types. One substrate (D1) backs every door.

export type Actor = "human" | "agent" | "curator" | "import";
export type NoteKind = "note" | "journal" | "observation" | "block";

export interface Env {
  DB: D1Database;
  /** The separate `cf-memory-logs` database (kept conversations). Optional: when
   * the binding is absent the log tools answer "not configured" and nothing
   * else is affected. See src/logs.ts and migrations-logs/. */
  LOGS?: D1Database;
  OWNER_HANDLE: string;
  RECALL_TOKEN_BUDGET: string; // numeric string
  BUILD_GIT_SHA?: string;
  BUILD_DATE?: string;
  CF_MEMORY_RAW_EVENT_RETENTION_DAYS?: string;
  /** Daily cap on stored `action` bytes per user per UTC day (unset: no limit, the default since 2026-11-05). */
  LOG_DAILY_ACTION_BYTES?: string;
  /** Daily cap on stored bytes of every kind per user per UTC day (unset: no limit). */
  LOG_DAILY_TOTAL_BYTES?: string;
  /** Days `action` and `error` log rows are kept (default 90). */
  LOG_ACTION_RETENTION_DAYS?: string;
  BUNDLES?: R2Bucket;
  // Cloudflare Access (Zero Trust SSO) — the human/web door (all optional; empty
  // = web door fail-closed; the Bearer door is unaffected either way). Both must
  // be set for verifyAccessJwt to accept an assertion. Membership is NOT decided
  // here: cf-memory's own allow-list was retired 2026-08-18, so these say only
  // "genuinely ours", and an invitation row says who may use cf-memory.
  // See src/access.ts.
  ACCESS_TEAM_DOMAIN?: string; // e.g. "team.cloudflareaccess.com"
  ACCESS_AUD?: string; // Access Application Audience (AUD) tag
  OWNER_EMAIL?: string; // the address ON the owner row — not an allow-list (see ensureOwner)
  /** DEV ONLY (.dev.vars — never deployed): when set AND the request carries
   * no cf-ray header (no Cloudflare edge in the loop — wrangler dev's routes
   * config rewrites the request URL/Host to the prod domain, so hostname
   * can't be the discriminator here), resolvePrincipal treats this email as
   * an SSO-verified identity so `wrangler dev` can exercise the web door
   * without an edge Access app. Double-guarded: the var only exists in
   * .dev.vars, and the code refuses any request that already carries cf-ray
   * even if the var somehow reached production config. */
  DEV_ACCESS_EMAIL?: string;

  // ---- OAuth resource-server config (2026-08-14 cutover). The agent door is
  // no longer an cf-memory-issued `eg_live_` key: it is an opaque token from
  // auth.example.com, validated by asking that server over a service binding.
  // Any of these being unset closes the agent door rather than widening it.
  /** Issuer, advertised in the protected-resource metadata document. */
  AUTH_ISSUER?: string;
  /** Service binding to the auth Worker — the introspection transport. */
  AUTH?: { fetch: (request: Request) => Promise<Response> };
  /** Shared secret this server presents to POST /introspect. */
  INTROSPECTION_SECRET?: string;
  /** This server's canonical resource URI == the required `aud` claim. */
  RESOURCE_URI?: string;

  // ---- Single-owner mode: one fixed token, no authorization server.
  /** A secret (`wrangler secret put API_TOKEN`). A Bearer token equal to it is
   * the instance owner with every scope. Shorter than 32 characters closes
   * this door rather than accepting a guessable token. */
  API_TOKEN?: string;
}

/** 記憶の種類。共有の既定を決めるだけで、可視性そのものではない(src/spaces.ts)。 */
export type NoteType = "user" | "feedback" | "project" | "reference";

export interface Principal {
  userId: string;
  handle: string;
  scopes: Set<string>;
  anonymous: boolean;
  actor: Actor;
  viaKeyPrefix?: string;
  /** A token was supplied but matched no (active) key — distinct from genuine anonymous. */
  invalidKey?: boolean;
  /** Which door resolved this principal. admin gating (decision 8) branches on this. */
  authSource: "bearer" | "access" | "none";
  /** Cloudflare Access vouched for this person, but cf-memory has no row for them.
   * Distinct from anonymous on purpose: an anonymous browser request is sent to
   * /access/login, which a signed-in non-member has already passed — they would
   * loop. This state renders a refusal that names the address instead. */
  notInvited?: boolean;
  /** The address the refusal was judged against. Only set with notInvited: the
   * commonest cause is being signed in as a different Google account, and the
   * person cannot tell that apart from "not a member" without seeing it. */
  email?: string;
  /** decision 8: the ONLY place an Access-authenticated admin check may look.
   * authSource !== 'access' => always false (the bearer path checks the
   * 'admin' scope instead, via callerIsAdmin()). NEVER derived from scopes. */
  isAdminFlag: boolean;
}

export interface NoteRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  body_md: string;
  frontmatter_json: string;
  kind: NoteKind;
  stage: string;
  scope: string; // #117 per-project relevance axis (NOT NULL DEFAULT 'global')
  /** 記憶の種類。共有の既定を決めた材料であって、可視性そのものではない。 */
  type?: NoteType | null;
  /** 共有されているか。保存時に1度だけ解決され、以後は固定。 */
  shared?: number | null;
  pinned_block_label: string | null;
  char_limit: number | null;
  content_hash: string;
  word_count: number;
  view_count: number;
  score: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  last_viewed_at: number | null; // #119: last DELIVERED (notes_get/recall); drives auto-demote
  archived_at: number | null; // #119: cold tier (out of recall, kept in search); NOT deleted_at
  // decision 10: bi-temporal validity + supersession. NULL = still valid / current.
  valid_from: number | null; // ms epoch the fact became true (NULL = since created_at)
  valid_until: number | null; // ms epoch the fact stopped being true (NULL = still valid)
  superseded_by: string | null; // id of the note that replaced this one (NULL = current)
  supersedes: string | null; // id of the note THIS note replaced (backpointer)
}

/** Snapshot inspected before an automatic create-only correction. Not an access grant. */
export interface SupersessionGuard {
  id: string;
  content_hash: string;
  scope: string;
  shared: boolean;
  updated_at: number;
  provenance_count: number;
}

export interface NoteInput {
  /** Optional owner-only text repair, pinned to a current ordinary note snapshot.
   * Does not permit metadata/lifecycle changes or retry into a different base. */
  updateGuard?: SupersessionGuard;
  /** Automatic ADD must not update or resurrect any existing row. */
  createOnly?: boolean;
  /** 記憶の種類。共有するかの既定を決める(project/reference は共有、user/feedback は個人)。
   * 編集で省略すると既存を保つ。 */
  type?: NoteType | null;
  /** 共有するかの明示指定。種類による既定を上書きしたいときだけ使う。 */
  shared?: boolean;
  slug?: string;
  title?: string;
  body_md?: string; // optional: omit when providing append_md instead
  tags?: string[];
  kind?: NoteKind;
  frontmatter?: Record<string, unknown>;
  pinned_block_label?: string | null;
  char_limit?: number | null;
  stage?: string;
  /** #117 project scope: a git remote URL, or 'global'. Anything else (a
   * workdir path, a bare label) normalizes to 'global' — see normalizeScope.
   * Omitted on a NEW note →
   * 'global'; omitted on an EDIT → the existing row's scope is preserved. */
  scope?: string;
  /** decision 10: bi-temporal validity. ms epoch (or a parseable ISO/date string
   * via frontmatter). Omitted on an EDIT preserves the existing row's value;
   * explicit `null` clears it. */
  valid_from?: number | null;
  valid_until?: number | null;
  /** decision 10: slug OR id of the note THIS note replaces. When set, upsert stamps
   * the target's `superseded_by` (only that — no `valid_until`); recall then hides the
   * old fact only WHILE this note is live (derived), reviving it if this is deleted.
   * Agent-driven; the server never auto-detects contradictions (decision 7). */
  supersedes?: string;
  supersedesGuard?: SupersessionGuard;
  append_md?: string;
  /** Separator placed before append_md when an existing body is present. Defaults
   * to a blank line ("\n\n"); core-memory block appends pass "\n" (single newline)
   * to match applyBlockOp's join, and an explicit separator also enables the
   * block-semantics empty-base + char_limit clamp on the append path. */
  append_separator?: string;
  /** When true, a CAS (content_hash) conflict on an in-place UPDATE is surfaced as
   * a StaleUpsertError to the caller instead of being retried internally. The block
   * set/replace path uses this so it can re-run applyBlockOp against the winner's
   * fresh body rather than letting upsert converge on a now-stale precomputed body. */
  bubbleStaleConflict?: boolean;
  /** Read-modify-write CAS token (H-1). When provided, the in-place UPDATE binds
   * its optimistic-concurrency check to THIS hash — the content_hash of the base
   * the caller already read — instead of a hash re-read independently inside
   * upsert. This closes the lost-update window where a concurrent commit landing
   * between the caller's base read and upsert's own re-read passed the CAS and let
   * a stale-base body overwrite it. A string is the base row's content_hash; `null`
   * means the caller read NO row (expects an INSERT) so a row appearing in the
   * window surfaces as a stale conflict. Pair with bubbleStaleConflict so the
   * caller can recompute against the winner's fresh body. */
  expectedContentHash?: string | null;
}

export interface NoteSummary {
  id: string;
  /** Author of the note. Populated by listMine(); optional because other
   * summary queries (backlinks) don't SELECT it. */
  user_id?: string;
  slug: string;
  title: string;
  kind: NoteKind;
  tags: string[];
  /** Growth stage / project scope. Optional: only the by-handle list() SELECTs
   * them (for the web garden's stage dots + scope pill); other summary queries
   * (backlinks/changes) leave them undefined. */
  stage?: string;
  scope?: string;
  updated_at: number;
  created_at: number;
}

export interface SearchHit {
  type: "note" | "skill";
  id: string;
  slug: string;
  title: string;
  snippet: string;
  /** Full source size/cost, so a caller can choose a few records to read in full. */
  char_count: number;
  estimated_tokens: number;
  /** The compact snippet is only a leading preview, not the whole source. */
  preview_truncated: boolean;
  score: number;
  /** Which lanes found the hit. Only "fts" since semantic search was removed. */
  via: Array<"fts">;
}
