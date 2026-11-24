// Identity/seed, core-memory blocks, and recall assembly — the glue tying the
// repo + search + pure packing into the behaviours the doors expose.

import { verifyAccessJwt } from "./access";
import { allows, extractAccessToken, extractBearerToken, matchesApiToken } from "./auth";
import { introspectToken } from "./rs-introspect";
import { normalizeScopes } from "./context";
import { estimateTokens, now, ulid } from "./db";
import { logSlowRead, type RecallTimings } from './read-timing';
import { applyBlockOp, resolveCharLimit, type BlockOp } from "./memory";
import { NotesRepo, StaleUpsertError, type RecallNoteRow } from "./notes";
import { PortabilityService } from './portability';
import { CaptureService } from "./capture";
import { LogService, logSettings } from "./logs";
import { GuidedSearchService } from './guided-search';
import { orderBySalience, packContext, type RecallItem, type RecallPack, type RecallTier } from "./recall";
import { japaneseProseMatch, leadingQuestion, SearchService, SEMANTIC_STATUS } from "./search";
import { SkillsRepo } from "./skills";
import { slugify } from "./slug";
import type { Actor, Env, Principal } from "./types";

export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  email: string | null;
  bio_md: string;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

/** Called after verifying a credential. The one-time email fixup below is
 * guarded by a WHERE clause that only matches an un-fixed-up row.
 *
 * OWNER_EMAIL is still load-bearing, but for one reason only: it is the address
 * ON the owner row. It stopped being an allow-list on 2026-08-18 — it decides
 * nothing about who may enter, it only makes the browser door (which matches by
 * email) land the owner on the owner row instead of provisioning them a second,
 * empty one. A falsy value would seed an owner nobody can sign in as. */
export async function ensureOwner(db: D1Database, env: Env): Promise<UserRow> {
  const handle = env.OWNER_HANDLE || "owner";
  const existing = await db.prepare("SELECT * FROM users WHERE handle=?").bind(handle).first<UserRow>();
  if (existing) {
    if (!existing.email) {
      // No address yet. That is allowed only while the web sign-in door is
      // closed (no ACCESS_AUD): the owner is then reached with the API token
      // alone. With the door configured, a missing OWNER_EMAIL stops every
      // request rather than serve an owner row that has no address.
      const ownerEmail = env.OWNER_EMAIL?.trim();
      if (!ownerEmail) {
        if (env.ACCESS_AUD?.trim()) throw new Error("OWNER_EMAIL must be set (falsy value rejected) — it is the owner row's address");
        return existing;
      }
      await db.prepare("UPDATE users SET email=? WHERE id=? AND email IS NULL").bind(ownerEmail, existing.id).run();
      return (await db.prepare("SELECT * FROM users WHERE id=?").bind(existing.id).first<UserRow>()) as UserRow;
    }
    return existing;
  }
  const ts = now();
  const id = ulid(ts);
  // Optional only while the web sign-in door is closed (see above).
  const ownerEmail = env.OWNER_EMAIL?.trim() || null;
  if (!ownerEmail && env.ACCESS_AUD?.trim()) throw new Error("OWNER_EMAIL must be set (falsy value rejected) to seed the owner");
  // Deliberately names NO is_admin/password_hash columns: this exact INSERT is
  // legal on BOTH the pre-0025 prod schema (is_admin NOT NULL DEFAULT 0 fills
  // itself) and the post-0025 schema (columns dropped) — the property that
  // makes deploy-code-first / apply-0025-later safe. Do not "restore" the
  // columns here; post-0025 that is a hard SQL error.
  await db.batch([
    db.prepare(`INSERT INTO users (id,handle,display_name,email,bio_md,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(handle) DO NOTHING`).bind(id, handle, handle, ownerEmail, "", ts, ts),
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('owner_handle', ?)").bind(handle),
  ]);
  const owner = await getUserByHandle(db, handle);
  if (!owner) throw new Error("could not initialize the configured owner");
  return owner;
}

export function getUserByHandle(db: D1Database, handle: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE handle=?").bind(handle).first<UserRow>();
}

/** By-id counterpart of getUserByHandle: used to resolve an owner's handle when
 * all we hold is a foreign row's user_id (e.g. skill fork lineage, issue #65 —
 * a parent/child skill may belong to a DIFFERENT user than the page's handle). */
export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<UserRow>();
}

/** The cf-memory account for a signed-in address. Never creates one.
 *
 * Kept separate from resolveAccount (the token door) because the two doors are
 * handed different identifiers: Access provides only an address, a token
 * provides an account id. They converge on the same row, which an invitation
 * created; the token door attaches the account id to it on first use.
 *
 * The owner address is initialized before this lookup so the owner keeps
 * their original account.
 */
async function resolveInvitedPerson(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  const lower = email.trim().toLowerCase();
  if (!lower) return null;
  const existing = await db
    .prepare("SELECT * FROM users WHERE lower(email)=? AND revoked_at IS NULL")
    .bind(lower)
    .first<UserRow>();
  if (existing) return existing;

  // 2026-08-18: there used to be a branch here that let an address-less owner row
  // be claimed by whoever signed in. A newcomer requires a separate invitation.

  // Not invited. Cloudflare Access says this person may reach the host; the
  // invitation says they use cf-memory. Returning null produces the refusal screen
  // — NOT a fall-through to anonymous, which would redirect a signed-in person
  // back to the SSO they already passed and loop.
  return null;
}

/** The cf-memory account for an auth.example.com account. Never creates one.
 *
 * 2026-08-19: this used to provision on first sight (JIT). It no longer does —
 * cf-memory is invite-only now, like tasks. auth vouching for someone says they are
 * a person here; it does not say they use cf-memory. A row is created by an
 * invitation and nowhere else.
 *
 * What keeps a space private is unchanged: every row carries user_id and
 * isReadable() compares it to the viewer.
 *
 * The email keeps one job — attaching this account id to the row an invitation
 * created (an invitation knows only an address) the first time that person
 * presents a token. After that the id is the key. It is never the lookup key,
 * and it can never move a link that already exists.
 */
async function resolveAccount(
  db: D1Database,
  authUserId: string,
  email: string | null,
): Promise<UserRow | null> {
  const linked = await db
    .prepare("SELECT * FROM users WHERE auth_user_id=? AND revoked_at IS NULL")
    .bind(authUserId)
    .first<UserRow>();
  if (linked) return linked;

  if (!email) return null; // nothing to link by and nothing to name a handle after

  const lower = email.toLowerCase();
  // Only fill an empty column: overwriting would let a second auth account take
  // over an existing person's notes.
  await db
    .prepare("UPDATE users SET auth_user_id=? WHERE lower(email)=? AND auth_user_id IS NULL AND revoked_at IS NULL")
    .bind(authUserId, lower)
    .run();
  // Linked, or not invited. Creating a row here is exactly the JIT that was
  // removed; the caller turns a null into a refusal that names the address.
  return db.prepare("SELECT * FROM users WHERE auth_user_id=? AND revoked_at IS NULL").bind(authUserId).first<UserRow>();
}

/** Resolves a principal from (in priority order) an opaque Bearer access token
 * from auth.example.com (validated by introspection — the cf-memory-issued
 * `eg_live_` keys are gone, 2026-08-14), a verified Cloudflare Access JWT
 * (header or CF_Authorization cookie — the human door), or the no-edge
 * (cf-ray-absent) DEV_ACCESS_EMAIL dev bypass.
 *
 * Both credentialed doors resolve to the caller's OWN row, never to the owner's
 * (2026-08-18): the token door keys on the account id in `sub`, the browser door
 * on the Access `email`. Neither door CREATES a row — cf-memory is invite-only
 * (2026-08-19), so an unrecognised person becomes `notInvited` (browser) or a
 * flagged anonymous (token) rather than being provisioned on first sight.
 * A `machine:` subject has no row of its own and acts as the owner.
 *
 * Takes only `headers` (no `url`) — the dev-bypass discriminator is cf-ray
 * HEADER absence, not anything derived from the request URL (see the dev-bypass
 * block below), so a `url` parameter has nothing left to do here. */
export async function resolvePrincipal(db: D1Database, env: Env, headers: Headers): Promise<Principal> {
  const authHeader = headers.get("authorization");
  const cookieHeader = headers.get("cookie");
  const ownerHandle = env.OWNER_HANDLE || "owner";
  /** Access は通ったが cf-memory に行が無い人。匿名ではないので SSO へ戻さない。 */
  const notInvited = (email: string): Principal => ({
    userId: "anonymous",
    handle: ownerHandle,
    scopes: new Set(),
    anonymous: true,
    actor: "human",
    authSource: "access",
    isAdminFlag: false,
    notInvited: true,
    email,
  });
  const anon = (invalidKey = false, actor: Actor = "human"): Principal => ({
    userId: "anonymous",
    handle: ownerHandle,
    scopes: new Set(),
    anonymous: true,
    actor,
    authSource: "none",
    isAdminFlag: false,
    ...(invalidKey ? { invalidKey: true } : {}),
  });

  // ---- Agents: an opaque access token from auth.example.com (2026-08-14
  // cutover; the cf-memory-issued `eg_live_` keys are gone). Only the issuer can
  // say whether a token is live, so this door depends on auth being up — the
  // trade accepted in exchange for having no signing key and for revocation
  // that lands on the next request instead of at token expiry.
  const bearer = extractBearerToken(authHeader);
  if (bearer) {
    // ---- Single-owner mode: the fixed token set as the API_TOKEN secret. It
    // is the owner, with every scope, and needs no authorization server. A
    // token that does not match falls through to introspection, so an instance
    // may run both doors.
    if (await matchesApiToken(bearer, env.API_TOKEN)) {
      const owner = await ensureOwner(db, env);
      return {
        userId: owner.id,
        handle: owner.handle,
        scopes: new Set(["notes:read", "notes:write", "admin"]),
        anonymous: false,
        actor: "agent",
        viaKeyPrefix: "api-token",
        authSource: "bearer",
        isAdminFlag: false,
      };
    }

    const audience = env.RESOURCE_URI?.trim();
    const secret = env.INTROSPECTION_SECRET?.trim();
    // Unconfigured means "no agent door", not "any token goes" — same
    // fail-closed posture the Access path takes when ACCESS_AUD is unset.
    if (!audience || !secret || !env.AUTH) return anon(true, "agent");

    // Opaque tokens: only the authorization server can say whether this one is
    // live. The call goes over a service binding, so it stays inside the
    // account, and a revoked token stops working on the very next request.
    const verified = await introspectToken(bearer, { auth: env.AUTH, secret, audience });
    if (!verified) {
      // Presented but unverifiable (expired, wrong audience, bad signature):
      // flagged anonymous, so gates answer 401 rather than a misleading 403.
      return anon(true, "agent");
    }

    // The token names WHO it is in `sub`. A `user:<ULID>` subject is a person and
    // resolves to their own row — one an INVITATION created, never one made here:
    // provisioning on first sight was removed 2026-08-19 (see resolveAccount).
    // Anything else is a machine (`machine:build-agent`), which has no row of
    // its own and acts as the owner.
    //
    // The subject is an ACCOUNT ID, not an address. Resolving people by email is
    // what this replaced: a rename made someone a different person, and here that
    // meant falling through to anonymous and seeing an empty instance.
    let user: UserRow | null = null;
    if (verified.subject.startsWith("user:")) {
      const authUserId = verified.subject.slice("user:".length);
      await ensureOwner(db, env);
      user = await resolveAccount(db, authUserId, verified.email ?? null);
    } else if (verified.subject.startsWith("machine:")) {
      user = await ensureOwner(db, env);
    } else {
      // Anything else — including the retired `human:<email>` form — is refused.
      // Falling through to the owner path was briefly present here and would have
      // made ANY unrecognised subject the owner, the opposite of what the retired
      // form's own fail-closed did.
      return anon(true, "agent");
    }
    const owner = user;
    if (!owner) return anon(true, "agent");
    return {
      userId: owner.id,
      handle: owner.handle,
      scopes: verified.scopes,
      anonymous: false,
      actor: "agent",
      // Attribution for the activity log: `machine:build-agent` /
      // `user:<ULID>` replaces the old key prefix.
      viaKeyPrefix: verified.subject,
      authSource: "bearer",
      isAdminFlag: false, // bearer path never consults isAdminFlag (see callerIsAdmin)
    };
  }

  // ---- Access (humans): a verified JWT — header on /access* (edge-injected),
  // CF_Authorization cookie everywhere else.
  //
  // 2026-08-18: this used to return the OWNER row for anyone the allow-list let
  // through, which was correct while the allow-list held exactly one address. It
  // is not correct with several: adding a second person to the list would have
  // handed them the first person's entire store. A signed-in person resolves to
  // THEIR OWN row now — the row an invitation created, the same rule the token
  // door uses, reached from the other direction. No row means `notInvited`, not
  // a newly minted space (2026-08-19).
  //
  // The address is the only identifier Cloudflare Access provides, so it is the
  // key here. That is unavoidable and bounded: it names a row, and if that person
  // also arrives with a token, the account id links to the same row and takes
  // over as the key from then on.
  const accessPrincipal = async (email: string): Promise<Principal> => {
    await ensureOwner(db, env);
    const person = await resolveInvitedPerson(db, email);
    if (!person) return notInvited(email);
    return {
      userId: person.id,
      handle: person.handle,
      // 2026-08-19: 空集合。人が自分の手で操作するとき委譲は起きていないので、
      // scope という語彙がそもそも当てはまらない(tasks の人間の扉と同じ)。
      // 何ができるかは allows() が authSource から答える。
      scopes: new Set(),
      anonymous: false,
      actor: "human",
      authSource: "access",
      // decision 8: the SSO identity administers ITS OWN space, not the instance.
      isAdminFlag: true,
    };
  };
  const accessToken = extractAccessToken(headers.get("cf-access-jwt-assertion"), cookieHeader);
  if (accessToken) {
    const id = await verifyAccessJwt(accessToken, env);
    // 2026-08-18: cf-memory 自前の許可リスト(ACCESS_ALLOWED_EMAILS / OWNER_EMAIL)は廃止した。
    // メンバーシップを決めるのは Cloudflare の Access アプリのポリシー(members
    // リスト)1箇所で、ここに届く JWT は既に署名・team domain・AUD を検証済み =
    // そのポリシーを通った証明。二重に持つと「人を増やす」操作が2箇所になり、
    // 追加漏れは「入れるのに空っぽ」という分かりにくい形で出る。
    //
    // 偽物を止めているのは引き続き verifyAccessJwt(署名 / aud / iss / exp / alg)。
    if (id) return accessPrincipal(id.email);
  }

  // ---- Dev bypass (.dev.vars only): lets `wrangler dev` exercise the web door
  // with no edge Access app. Discriminator is edge-ABSENCE, not the request URL:
  // wrangler.jsonc declares a `routes` custom_domain (needed for the real
  // deploy), and under that config `wrangler dev`/Miniflare rewrites BOTH
  // url.hostname and the Host header to the production domain even when you
  // curl plain http://localhost:8787 — verified empirically (Task 8 fix round),
  // so neither can tell local dev apart from production here. What genuinely
  // differs: every production request reaches this Worker exclusively through
  // the Cloudflare edge on that custom domain (no workers.dev route is
  // enabled), and the edge unconditionally stamps `cf-ray` on everything it
  // proxies to the origin. Local `wrangler dev` has no edge in the loop, so
  // `cf-ray` is always absent there. The primary guard remains
  // env.DEV_ACCESS_EMAIL itself — it lives only in the gitignored, locally
  // loaded .dev.vars file and is never part of a deployment — cf-ray absence
  // is the second factor, refusing the bypass even if the var somehow leaked
  // into a real deployment's config.
  if (env.DEV_ACCESS_EMAIL && !headers.get("cf-ray")) return accessPrincipal(env.DEV_ACCESS_EMAIL);

  return anon(false, authHeader && /^Bearer\s+/i.test(authHeader) ? "agent" : "human");
}

export interface BlockView {
  label: string;
  title: string;
  value: string;
  char_limit: number | null;
}

export class MemoryService {
  constructor(
    private db: D1Database,
    private notes: NotesRepo,
  ) {}

  // Core-memory blocks are team-shared for READS (§2.4, decision 3/4), like
  // notes; WRITES stay author-only (setBlock always reads/writes under
  // principal.userId — see getRaw below, unchanged).
  private async listRaw(principal: Principal): Promise<BlockView[]> {
    const res = await this.db
      .prepare(
        `SELECT pinned_block_label AS label, title, body_md AS value, char_limit FROM notes
         WHERE pinned_block_label IS NOT NULL AND deleted_at IS NULL AND user_id = ?
         ORDER BY pinned_block_label`,
      )
      .bind(principal.userId)
      .all<{ label: string; title: string; value: string; char_limit: number | null }>();
    return (res.results ?? []).map((r) => ({ label: r.label, title: r.title, value: r.value, char_limit: r.char_limit }));
  }

  private async getRaw(ownerId: string, label: string): Promise<(BlockView & { content_hash: string | null }) | null> {
    // Write-base read (setBlock): content_hash is selected so setBlock can bind it
    // as the upsert CAS token (closing the read-modify-write window, H-1).
    const r = await this.db
      .prepare(
        `SELECT pinned_block_label AS label, title, body_md AS value, char_limit, content_hash FROM notes WHERE user_id=? AND pinned_block_label=? AND deleted_at IS NULL`,
      )
      .bind(ownerId, label)
      .first<{ label: string; title: string; value: string; char_limit: number | null; content_hash: string | null }>();
    return r ? { label: r.label, title: r.title, value: r.value, char_limit: r.char_limit, content_hash: r.content_hash } : null;
  }

  private async getScoped(principal: Principal, label: string): Promise<BlockView | null> {
    const own = await this.db
      .prepare(`SELECT pinned_block_label AS label, title, body_md AS value, char_limit FROM notes WHERE user_id=? AND pinned_block_label=? AND deleted_at IS NULL`)
      .bind(principal.userId, label)
      .first<{ label: string; title: string; value: string; char_limit: number | null }>();
    return own ? { label: own.label, title: own.title, value: own.value, char_limit: own.char_limit } : null;
  }

  async listBlocks(principal: Principal): Promise<BlockView[]> {
    if (principal.anonymous) return []; // blocks are never anonymously public
    return this.listRaw(principal);
  }

  async getBlock(principal: Principal, label: string): Promise<BlockView | null> {
    if (principal.anonymous) return null;
    return this.getScoped(principal, label);
  }

  async setBlock(principal: Principal, label: string, op: BlockOp, value: string, charLimit?: number | null, replaceTarget?: string, createOnly = false): Promise<BlockView> {
    const slug = `block-${slugify(label)}`;
    if (createOnly && op !== 'set') throw new StaleUpsertError();

    // A plain 'append' is expressible as upsert's append_md path, which recomputes
    // the joined body against the winner's FRESHLY-read row on every CAS retry — so
    // two concurrent appends can't lose an update. Pass block semantics through
    // (single-newline separator + char_limit) so the result matches applyBlockOp.
    if (op === "append") {
      const existing = await this.getRaw(principal.userId, label);
      const limit = resolveCharLimit(charLimit, existing);
      const { note } = await this.notes.upsert(principal, {
        slug,
        title: label,
        append_md: value,
        append_separator: "\n",
        kind: "block",
        pinned_block_label: label,
        char_limit: limit,
      });
      return { label, title: label, value: note.body_md, char_limit: note.char_limit };
    }

    // 'set'/'replace' (and substring replace) can't be expressed as append_md, so
    // own the read->recompute->retry loop here: re-read the block, re-run
    // applyBlockOp, and write with bubbleStaleConflict so a lost CAS surfaces as a
    // StaleUpsertError to retry against the winner's body instead of clobbering it.
    const MAX_ATTEMPTS = 12;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await this.getRaw(principal.userId, label);
      const limit = resolveCharLimit(charLimit, existing);
      const next = applyBlockOp(existing?.value ?? "", { op, value, charLimit: limit, replaceTarget });
      try {
        await this.notes.upsert(principal, {
          slug,
          createOnly,
          title: label,
          body_md: next,
          kind: "block",
          pinned_block_label: label,
          char_limit: limit,
          // Bind the CAS to the SAME read we transformed (H-1): the base row's
          // content_hash, or null when there was no live base (expect an INSERT),
          // so a concurrent commit landing in this window fails the CAS instead of
          // being silently overwritten by next (computed from the stale base).
          expectedContentHash: existing ? existing.content_hash : null,
          bubbleStaleConflict: true,
        });
        return { label, title: label, value: next, char_limit: limit };
      } catch (err) {
        if (!createOnly && err instanceof StaleUpsertError && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * (attempt + 1))));
          continue;
        }
        throw err;
      }
    }
    throw new Error("setBlock: unreachable");
  }
}

/** What a block write (memory_set / memory_append / memory_replace, PATCH
 * /memory/blocks/:label) hands back. The stored block is the result of an append
 * or a replace, so returning it is a read: a caller without notes:read gets the
 * label, the resulting length and the limit, never the text. Callers that may
 * read (and the human door, which carries no scopes) get the block as before. */
export function blockWriteResult(principal: Principal, block: BlockView): BlockView | { label: string; length: number; char_limit: number | null } {
  if (allows(principal, "notes:read")) return block;
  return { label: block.label, length: block.value.length, char_limit: block.char_limit };
}

/** Core-memory blocks as recall's working tier. Shared by recall and
 * session_context so both render the blocks identically. */
export function workingTier(blocks: BlockView[]): RecallTier {
  return { tier: "working", label: "Working memory (core blocks)", items: blocks.map((b) => ({
    ref: b.label,
    title: `block:${b.label}`,
    text: b.value,
    source_chars: b.value.length,
    source_tokens: estimateTokens(b.value),
    source_type: "memory_block" as const,
  })) };
}

export type DeferRecallViews = (task: Promise<void>) => void | Promise<void>;

export class RecallService {
  constructor(
    private notes: NotesRepo,
    private search: SearchService,
    private memory: MemoryService,
    private skills: SkillsRepo,
    private deferViews?: DeferRecallViews,
    private db?: D1Database,
    /** The handle a machine token acts as (OWNER_HANDLE; see resolvePrincipal). */
    private ownerHandle = "owner",
  ) {}

  /** Shown when the author's row cannot be read: the item is still marked. */
  static readonly UNKNOWN_AUTHOR = "unknown";

  /** Resolve the references carried by the note snapshots and skill hits.
   * Each revision reference is the handle, a user subject, or an owner token. */
  private async authors(noteOwnerIds: string[], skillIds: string[], editorRefs: string[]): Promise<{ handles: Map<string, string>; skillOwners: Map<string, string>; editors: Map<string, Array<{ id: string; handle: string | null }>> }> {
    const handles = new Map<string, string>(), skillOwners = new Map<string, string>(), editors = new Map<string, Array<{ id: string; handle: string | null }>>();
    if (!this.db || (!noteOwnerIds.length && !skillIds.length && !editorRefs.length)) return { handles, skillOwners, editors };
    const marks = (n: number) => Array(n).fill("?").join(",");
    const statements: D1PreparedStatement[] = [];
    if (noteOwnerIds.length) statements.push(this.db.prepare(`SELECT id AS user_id, handle, NULL AS skill_id, NULL AS editor_ref FROM users WHERE id IN (${marks(noteOwnerIds.length)})`).bind(...noteOwnerIds));
    if (skillIds.length) statements.push(this.db.prepare(`SELECT s.user_id, u.handle, s.id AS skill_id, NULL AS editor_ref FROM skills s LEFT JOIN users u ON u.id = s.user_id WHERE s.id IN (${marks(skillIds.length)})`).bind(...skillIds));
    if (editorRefs.length) statements.push(this.db.prepare(
      `SELECT u.id AS user_id, u.handle, NULL AS skill_id, ref.value AS editor_ref
         FROM json_each(?) ref JOIN users u
           ON u.handle = CASE WHEN ref.value LIKE 'machine:%' THEN ? ELSE ref.value END
           OR u.auth_user_id = CASE WHEN substr(ref.value,1,5)='user:' THEN substr(ref.value,6) END`).bind(JSON.stringify(editorRefs), this.ownerHandle));
    for (const result of await this.db.batch<{ user_id: string; handle: string | null; skill_id: string | null; editor_ref: string | null }>(statements)) {
      for (const row of result.results ?? []) {
        if (row.editor_ref) { editors.set(row.editor_ref, [...(editors.get(row.editor_ref) ?? []), { id: row.user_id, handle: row.handle }]); continue; }
        if (row.handle) handles.set(row.user_id, row.handle);
        if (row.skill_id) skillOwners.set(row.skill_id, row.user_id);
      }
    }
    return { handles, skillOwners, editors };
  }

  // `budget * 2` made a single long note consume essentially the whole pack at
  // the default 4k budget, while still silently cutting a 32k source. Keep the
  // automatic pack compact and deterministic; the candidate index now exposes
  // a partial preview and points the caller to notes_get_many for the exact
  // document when it matters.
  static readonly NOTE_PREVIEW_CHARS = 1600;
  static readonly CANDIDATE_NOTE_LIMIT = 12;

  // review follow-up: a note actually delivered in a recall pack (survives
  // packContext()'s token-budget cut, i.e. appears in pack.included) now
  // increments view_count too, same as notes_get/GET /notes/:id -- issue #34
  // originally excluded recall() entirely over over-counting concerns, but
  // #35's daily unattended cron then auto-flagged actively-recalled notes as
  // "never viewed, consider archiving" (recall is DESIGN.md's own headline
  // agent-consumption path). notes_search hits still do NOT count (unchanged
  // — those are raw candidates, not delivered content).
  /** `core: false` leaves the core blocks out (a client that showed them at
   * session start); `maxChars` bounds the pack text (see packContext). */
  async recall(principal: Principal, query: string, budget: number, topNotes = RecallService.CANDIDATE_NOTE_LIMIT, rawContext: string | string[] | null = null,
    opts: { core?: boolean; maxChars?: number } = {}): Promise<RecallPack> {
    const started = Date.now(), timings: RecallTimings = {};
    // 一度だけ正規化する(空 = 絞り込み無し、'global' ではない)。配列を受けるのは、
    // 親ディレクトリで作業しているときに子リポジトリをまとめて指すため。
    const context = normalizeScopes(rawContext);
    // Cap the query the same way search.hybrid does (2000 chars) so a huge query
    // stays bounded (shared by every lane).
    const q = query.trim().slice(0, 2000);
    // #117: `context` (the caller's current project) pre-filters the note-backed
    // tiers to `scope ∈ {context, 'global'}`. Core-memory blocks are always
    // injected regardless (a caller's profile/conventions are global working
    // memory), so they are NOT scoped. 
    // relevance is carried through so the archival tier can be re-ranked by fused
    // salience below; the no-query branch has no real relevance signal (uniform 0).
    // 2026-10-31: keyword lanes only (no query embedding). The question,
    // Japanese-prose and identifier focus lanes stay.
    const lexicalOptions = { focusFirstQuestion: true, focusJapaneseProse: true };
    const blocks = opts.core === false ? [] : await this.memory.listBlocks(principal);
    timings.working_ms = Date.now() - started;
    let phaseStarted = Date.now();
    const blockItems = workingTier(blocks).items;
    let noteSummaries: Array<{ id: string; slug: string; title: string; relevance: number }>;
    const skillItems: Array<{ ref: string; title: string; text: string; source_chars: number; source_tokens: number; preview_truncated: boolean; source_type: "skill"; shared_by?: string }> = [];
    if (q) {
      const hits = await this.search.hybrid(principal, q, { limit: topNotes, context, excludeArchived: true, ...lexicalOptions });
      noteSummaries = hits.map((h) => ({ id: h.id, slug: h.slug, title: h.title, relevance: h.score }));
    } else {
      const recent = await this.notes.listMine(principal, { limit: topNotes, context, excludeArchived: true });
      noteSummaries = recent.map((r) => ({ id: r.id, slug: r.slug, title: r.title, relevance: 0 }));
    }

    timings.notes_ms = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    // ambient "surface": a couple of evergreen notes, even if unmatched by the query.
    // Exclude the archival hits by slug up front (byStage filters deleted rows, so
    // a deleted note's summary is inert here) so every row this recall needs is known
    // before hydration and can be fetched in ONE batched round-trip below.
    const exclude = new Set(noteSummaries.map((n) => n.slug));
    // Skill discovery is independent of ambient selection and final note
    // hydration.
    const [skillHits, { ambient, rows }] = await Promise.all([
      q ? this.search.hybrid(principal, q, { limit: 4, scope: "skills", context, ...lexicalOptions }) : Promise.resolve([]),
      (async () => {
        const ambient = await this.notes.byStage(principal, "evergreen", 2, exclude, context);
        // Authorize the same snapshot that reads the bodies, in one batch.
        const rows = await this.notes.getRowsByIds(principal, [...noteSummaries.map((n) => n.id), ...ambient.map((a) => a.id)], context);
        return { ambient, rows };
      })(),
    ]);
    timings.skills_hydration_ms = Date.now() - phaseStarted;
    phaseStarted = Date.now();
    // 2026-11-14: another member's text reaches the reader's agent context
    // through recall, so every such item is marked: the pack names who wrote it
    // and fences the body (recall.ts itemLines), and the candidate is flagged.
    // Trust is decided from who wrote the delivered text, not from who owns the
    // row and never from the `shared` flag:
    //   - a row the reader does not own carries its owner's handle (`shared_by`);
    //   - a note whose current text was last written by a member other than its
    //     owner carries that member's handle (`edited_by`) — for the reader's own
    //     shared note this is a teammate's write-through (notes_put to the slug,
    //     notes_append), which keeps the row's owner and used to arrive unmarked.
    // The reader's own note that the reader (or the owner's machine token) last
    // wrote carries neither. A skill whose owner cannot be read is treated as
    // someone else's; skills have no write-through.
    const foreignOwners = new Set<string>(), editorRefs = new Set<string>();
    for (const row of rows.values()) {
      if (row.user_id !== principal.userId) foreignOwners.add(row.user_id);
      if (row.recall_revision_state === "matching" && row.recall_editor_ref) editorRefs.add(row.recall_editor_ref);
    }
    const { handles, skillOwners, editors } = await this.authors([...foreignOwners], skillHits.map((h) => h.id), [...editorRefs]);
    const sharedBy = (ownerId: string | undefined): { shared_by?: string } =>
      ownerId === principal.userId ? {} : { shared_by: (ownerId && handles.get(ownerId)) || RecallService.UNKNOWN_AUTHOR };
    const writtenBy = (row: RecallNoteRow): Pick<RecallItem, "shared_by" | "edited_by" | "author_unverified"> => {
      const owner = sharedBy(row.user_id);
      const matched = row.recall_revision_state === "matching" && row.recall_editor_ref ? editors.get(row.recall_editor_ref) ?? [] : [];
      // editor_ref resolves to one member; were it ever to match two, prefer the
      // one that is not the owner so the item is marked rather than not.
      const editor = matched.find((e) => e.id !== row.user_id) ?? matched[0];
      if (editor && editor.id !== row.user_id) return { ...owner, edited_by: editor.handle || RecallService.UNKNOWN_AUTHOR };
      if (!editor) return { ...owner, author_unverified: true };
      return owner;
    };
    for (const h of skillHits) {
      skillItems.push({ ref: h.slug, title: `skill:${h.title}`, text: h.snippet,
        source_chars: h.char_count, source_tokens: h.estimated_tokens,
        preview_truncated: h.preview_truncated, source_type: "skill", ...sharedBy(skillOwners.get(h.id)) });
    }

    // review follow-up (post-#34/#35): count a view ONLY for notes that
    // actually survive packContext()'s token-budget cut (pack.included), not
    // every search candidate -- deliberately narrower than notes_search's
    // "any hit" (avoiding the over-counting #34 explicitly worried about),
    // but wide enough to close the gap #35's cron introduced: a note
    // recall()'d every session but never notes_get/GET'd directly used to
    // sit at view_count=0 forever and get auto-flagged "never viewed" by the
    // new daily cron.
    //
    // Keyed by OBJECT REFERENCE (the exact same RecallItem instance pushed
    // into a tier's `items` array), not by `ref` string -- RecallItem.ref is
    // an overloaded "slug or block label" shared across every tier (working
    // blocks, procedural skills), so a string-keyed map
    // risks crediting a view to an unrelated note whose slug happens to
    // collide with a block label/skill slug (review r1 finding).
    // Object identity can't collide across tiers.
    const nowMs = now();
    const STAGE_ORD: Record<string, number> = { seedling: 0, budding: 1, evergreen: 2 };
    const noteIdByItem = new Map<{ ref: string; title: string; text: string }, string>();
    const noteCands: Array<{ item: RecallItem; relevance: number; views: number; stage: number; ageMs: number }> = [];
    for (const n of noteSummaries) {
      const row = rows.get(n.id);
      if (row && !row.deleted_at) {
        const text = row.body_md.slice(0, RecallService.NOTE_PREVIEW_CHARS);
        const item = {
          ref: row.slug,
          title: row.title,
          text,
          source_chars: row.body_md.length,
          source_tokens: estimateTokens(row.body_md),
          preview_truncated: text.length < row.body_md.length,
          source_type: "note" as const,
          ...writtenBy(row),
        };
        noteIdByItem.set(item, row.id);
        noteCands.push({ item, relevance: n.relevance, views: row.view_count, stage: STAGE_ORD[row.stage] ?? 0, ageMs: nowMs - row.updated_at });
      }
    }
    // Salience-fused re-ranking (research P0): only when a query gave us a real
    // relevance signal — the no-query branch is an intentional recency listing, so
    // leave its order alone. orderBySalience is stable and collapses to relevance
    // order when importance/recency are uniform, so it never reshuffles gratuitously.
    const orderedCands = q ? orderBySalience(noteCands) : noteCands;
    const noteItems = orderedCands.map((c) => c.item);

    const ambientItems: RecallItem[] = [];
    for (const a of ambient) {
      const row = rows.get(a.id);
      if (row && !row.deleted_at) {
        const text = row.body_md.slice(0, 240);
        const item = {
          ref: row.slug,
          title: `evergreen:${row.title}`,
          text,
          source_chars: row.body_md.length,
          source_tokens: estimateTokens(row.body_md),
          preview_truncated: text.length < row.body_md.length,
          source_type: "note" as const,
          ...writtenBy(row),
        };
        ambientItems.push(item);
        noteIdByItem.set(item, row.id);
      }
    }

    const tiers: RecallTier[] = [
      { ...workingTier([]), items: blockItems },
      { tier: "archival", label: q ? `Relevant notes for "${q}"` : "Recent notes", items: noteItems },
      { tier: "procedural", label: "Relevant skills", items: skillItems },
      { tier: "ambient", label: "Ambient (evergreen)", items: ambientItems },
    ];
    const pack = packContext(q || "(recent)", tiers, budget, opts.maxChars);
    const includedNoteIds = new Set<string>();
    for (const item of pack.included) {
      const id = noteIdByItem.get(item);
      if (id) includedNoteIds.add(id);
    }
    const viewStarted = Date.now();
    const views = this.notes.incrementRecallViews(principal, [...includedNoteIds], context);
    // Delivery must not await a slow, non-content D1 telemetry write. The
    // request owner retains this promise with waitUntil; no floating work or
    // changed ACL/scope/lifecycle predicate. Direct callers keep awaited views.
    if (this.deferViews) await this.deferViews(views.catch(() => {
      console.error('[recall] view tracking failed');
    }).finally(() => logSlowRead('recall_views', viewStarted)));
    else await views;
    timings.pack_views_ms = Date.now() - phaseStarted;
    logSlowRead('recall', started, undefined, timings);
    return { ...pack, retrieval: { mode: q ? "keyword" : "recent", semantic_status: SEMANTIC_STATUS, lexical_focus: leadingQuestion(q) ? "leading_question" : "full_query", japanese_lexical_focus: japaneseProseMatch(q) !== null } };
  }

}

export interface Services {
  guided: GuidedSearchService;
  portability: PortabilityService;
  capture: import('./capture').CaptureService;
  logs: LogService;
  notes: NotesRepo;
  skills: SkillsRepo;
  search: SearchService;
  memory: MemoryService;
  recall: RecallService;
}

/** server_status / GET /version: schema + build flags plus the log database. */
export async function serverStatus(services: Services, principal: Principal) {
  const [base, logs] = await Promise.all([services.capture.status(principal), services.logs.status(principal)]);
  return { ...base, logs };
}

export function makeServices(db: D1Database, bundles: R2Bucket | null = null, env?: Env, deferRecallViews?: DeferRecallViews): Services {
  const notes = new NotesRepo(db);
  const skills = new SkillsRepo(db, bundles);
  const search = new SearchService(db);
  const memory = new MemoryService(db, notes);
  const recall = new RecallService(notes, search, memory, skills, deferRecallViews, db, env?.OWNER_HANDLE || "owner");
  const retention = Number(env?.CF_MEMORY_RAW_EVENT_RETENTION_DAYS || '7');
  const capture = new CaptureService(db, Number.isFinite(retention) ? Math.max(1, Math.min(30, retention)) : 7, { git_sha: env?.BUILD_GIT_SHA || 'unknown', build_date: env?.BUILD_DATE || 'unknown', guided_search: env?.RESOURCE_URI && (env?.INTROSPECTION_SECRET?.length || 0) >= 32 ? 'configured' : 'disabled' });
  const logs = new LogService(env?.LOGS ?? null, logSettings(env));
  return { notes, skills, search, memory, recall, portability: new PortabilityService(db,notes,skills), capture, logs,
    guided: new GuidedSearchService(search,capture,env?.INTROSPECTION_SECRET,env?.RESOURCE_URI) };
}
