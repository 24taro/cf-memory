// NotesRepo commits a note with its revisions, search index, tags, resolved
// links, and audit event.
//
// 2026-10-31: no embeddings. The legacy `embedding` / `embedding_model`
// columns are neither written nor read (NOTE_COLUMNS) until phase 5 drops them.

import { allows } from "./auth";
import { normalizeScope, normalizeScopes, scopeClause } from "./context";
import { clampLimit, now, sha256hex, ulid } from "./db";
import { asStringArray, parseFrontmatter } from "./frontmatter";
import { parseWikilinks } from "./links";
import { BlockFullError, resolveCharLimit } from "./memory";
import { slugify, slugifyPath } from "./slug";
import { resolveShared } from "./spaces";
import { validityClause } from './search';
import { readableSql, readableSqlFor } from "./visibility";
import type { NoteInput, NoteKind, NoteRow, NoteSummary, NoteType, Principal, SupersessionGuard } from "./types";
import { retractionEventId, retractionRequestHash, retractionId, retractionTarget, retractionProvenance } from './retraction';
import type { RetractionProvenance } from './retraction';
import { appendEventId, appendId, appendRequestHash, parseAppend, type AppendProvenance } from './append';

/** Every notes column except the legacy embedding pair. `SELECT *` would keep
 * reading a ~4 KB vector per row that nothing uses any more. */
const NOTE_COLUMN_LIST = ['id', 'user_id', 'slug', 'title', 'body_md', 'frontmatter_json', 'kind', 'pinned_block_label',
  'char_limit', 'content_hash', 'word_count', 'view_count', 'score', 'created_at', 'updated_at', 'deleted_at', 'stage',
  'scope', 'last_viewed_at', 'archived_at', 'valid_from', 'valid_until', 'superseded_by', 'supersedes', 'shared', 'type'];
export const NOTE_COLUMNS = NOTE_COLUMN_LIST.join(', ');
const NOTE_COLUMNS_N = NOTE_COLUMN_LIST.map(c => 'n.' + c).join(', ');

type NoteMutationGate = { sql: string; args: unknown[] };

export type RecallNoteRow = NoteRow & {
  recall_editor_ref: string | null;
  recall_revision_state: "missing" | "matching" | "mismatch";
};

export interface UpsertResult {
  note: NoteRow;
  created: boolean;
  /** 共有されたか。呼び出し側が引き直さずに結果へ添えられるように upsert が答える
   * —— 共有が黙って起きないための表示なので、経路は1本にしておく。 */
  shared: boolean;
  /** Set when the write went into ANOTHER member's shared row: that owner's
   * handle. The caller's result must say so — `stored: 'shared'` alone reads as
   * "my note, shared". */
  writtenThrough?: string;
}

/** Row binding for a door that already decided which row it may write.
 * `ownOnly`: only ever the caller's own row at this slug (the web edit form).
 * `expectedId`: an id-addressed write (PATCH /notes/:id) — the caller's own LIVE
 * row with exactly this id, or nothing is written. */
export interface UpsertBinding {
  ownOnly?: boolean;
  expectedId?: string;
}

/** The `stored` / `written_through` part of a write result, built in one place
 * so every door says the same thing about where the text went. */
export function storedAs(r: UpsertResult): { stored: "shared" | "personal"; written_through?: { owner: string } } {
  return { stored: r.shared ? "shared" : "personal", ...(r.writtenThrough ? { written_through: { owner: r.writtenThrough } } : {}) };
}

/** Thrown when an in-place upsert UPDATE matched no row because a concurrent
 * writer already moved the content_hash we read (optimistic-concurrency miss).
 * upsert retries this internally; with NoteInput.bubbleStaleConflict it is
 * surfaced so a read-modify-write caller can recompute against the fresh body. */
export class StaleUpsertError extends Error {
  constructor() {
    super("SQLITE_CONSTRAINT: stale upsert");
    this.name = "StaleUpsertError";
  }
}

export class SupersessionConflictError extends Error {
  constructor() { super('supersession conflict: re-read the current target before deciding again'); }
}

export class DeletionConflictError extends Error {
  constructor() { super('deletion conflict: re-read the current target before deciding again'); }
}

export class UpdateConflictError extends Error {
  constructor() { super('update conflict: re-read the current owned note before repairing text'); }
}

export class AppendConflictError extends Error {
  constructor() { super('append conflict: inspect the current owned note before proposing a new supplement'); }
}

function guardedTextWhere(g: SupersessionGuard, userId: string, slug: string, at: number) {
  const current=validityClause('note',true);
  return {sql:`n.id=? AND n.slug=? AND n.user_id=? AND n.deleted_at IS NULL
    AND n.archived_at IS NULL AND n.kind!='block' AND n.pinned_block_label IS NULL
    AND ${current.sql} n.content_hash=? AND n.scope=? AND COALESCE(n.shared,0)=? AND n.updated_at=?
    AND (SELECT count(*) FROM memory_provenance pv WHERE pv.memory_kind='note' AND pv.memory_id=n.id)=?`,
    args:[g.id,slug,userId,...current.args(at),g.content_hash,g.scope,g.shared?1:0,g.updated_at,g.provenance_count]};
}

export { parseSupersessionGuard, parseDeletionGuard, parseUpdateGuard } from './guards';
import { parseSupersessionGuard, parseDeletionGuard, parseUpdateGuard } from './guards';

export interface OutgoingLink {
  target_slug: string;
  target_note_id: string | null;
  target_title: string | null;
  anchor_text: string | null;
  resolved: number;
  position: number;
}

/** Caller input the repository refuses outright. Never retried by upsert's
 * conflict loop; the REST door answers with `status`, the MCP door with the message. */
export class NoteInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 = 400) {
    super(message);
    this.name = "NoteInputError";
  }
}

const NOTE_KINDS: readonly string[] = ["note", "journal", "observation", "block"];

/** Largest body a note row may GROW to, in UTF-16 code units (String.length).
 * Every write also copies the whole body into notes_fts and (when it changed)
 * note_revisions, so an unbounded body multiplies. 262,144 = four log entries
 * (65,536 characters each): far above any hand- or agent-written note, and at
 * most ~786 KB of UTF-8 — inside the 1 MiB a record may have to stay exportable
 * (portability.ts MAX_TEXT) and D1's 2 MB limit for one string or row.
 * A row already larger than this (stored before the bound) may still be
 * retitled or shrunk; it can no longer grow. */
export const MAX_NOTE_BODY_CHARS = 262144;

const tooLarge = () => new NoteInputError(`note body exceeds the ${MAX_NOTE_BODY_CHARS}-character limit; split it into several notes`, 413);

// Titles and tag names are written verbatim into line-oriented text: the `.md`
// twin's frontmatter, the CLI's pulled files, recall headings. A line break in
// one lets its author add `key: value` lines that the next person to push that
// text sends as their own metadata. Slugs, tags and scope are normalised rather
// than refused in this file, so a title is too: each run of control characters
// (C0, DEL, C1, U+2028/U+2029 — every line break included) becomes one space.
const CONTROL_RUN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;
function singleLine(text: string): string {
  return text.replace(CONTROL_RUN, " ").trim();
}

/** What may precede a block without protecting it: a BOM, line breaks, blank or
 * whitespace-only lines, indentation. A browser drops the first line break of a
 * textarea and many clients trim text, so a block behind any of these becomes a
 * leading block on the way back. */
const LEADING_BLANK = /^[\uFEFF\s]+/;

/** Stored body text must not be a metadata channel. Only ONE leading block is
 * lifted per write, so text that still opens with a liftable `--- key: value ---`
 * block (a stacked second block, an appended block that created the note, a
 * block behind a leading line break, an unclosed block that appended text
 * closes) would be stored as-is and then applied as metadata on whoever re-saves
 * that body next. Rewrite its opening fence to `***` — the same thematic break
 * in Markdown, so the note renders the same — and the block can never be parsed
 * as frontmatter again, whatever a client does to line endings or leading
 * whitespace on the way back. The rule is about the WHOLE body that gets stored. */
function inertBody(body: string): string {
  const lead = LEADING_BLANK.exec(body)?.[0].length ?? 0;
  const rest = body.slice(lead);
  // A browser form (and many editors) turns a bare CR into a line break, so a
  // block fenced with lone CRs is judged as the text it becomes on the way back.
  return Object.keys(parseFrontmatter(rest.replace(/\r\n?/g, "\n")).data).length ? body.slice(0, lead) + "***" + rest.slice(3) : body;
}

/** The stored frontmatter of a row another member is editing: the owner's keys,
 * with only the content fields (tags, and a title if one is stored) replaced. */
function contentFrontmatter(storedJson: string, title: string, tags: string[]): Record<string, unknown> {
  let kept: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(storedJson);
    if (v && typeof v === "object" && !Array.isArray(v)) kept = v as Record<string, unknown>;
  } catch { /* an unreadable stored value is replaced by the content fields alone */ }
  return { ...kept, ...("title" in kept ? { title } : {}), tags };
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = singleLine(String(raw)).replace(/^#/, "");
    if (!t) continue;
    const key = slugify(t);
    if (key === "untitled" || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function extractTagsFromFrontmatter(fm: Record<string, unknown> | undefined): string[] {
  if (!fm) return [];
  const t = fm.tags;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string") return t.split(/[,\s]+/).filter(Boolean);
  return [];
}

/** B1: parse a frontmatter `date`/`created` value into a ms epoch, or undefined.
 * Accepts a numeric ms epoch or an ISO/date string (via Date.parse). Unparseable
 * values return undefined so the caller falls back to now(). */
function parseFmDate(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v.trim());
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export class NotesRepo {
  /** Read-only bridge for old agent creations whose provenance predates the
   * per-body hash. This proves equality to a sole stored initial revision,
   * not semantic truth, complete history, or authority to write by itself. */
  async unchangedCreationSnapshot(principal: Principal, note: NoteRow, tags: string[]) {
    if(principal.anonymous || note.user_id!==principal.userId || note.kind==='block' || note.deleted_at!=null ||
      note.archived_at!=null || note.superseded_by || note.updated_at!==note.created_at ||
      !await this.isCurrent(note.id) || await sha256hex(`${note.title}\n${note.body_md}\n${tags.join(',')}`)!==note.content_hash)return null;
    const revisions=await this.db.prepare(`SELECT r.id,r.body_md,r.frontmatter_json,r.editor,r.content_hash,r.created_at
      FROM note_revisions r JOIN notes n ON n.id=r.note_id WHERE r.note_id=? AND n.user_id=? AND n.content_hash=? AND n.updated_at=?
      ORDER BY r.created_at,r.id LIMIT 2`).bind(note.id,principal.userId,note.content_hash,note.updated_at)
      .all<{id:string;body_md:string;frontmatter_json:string;editor:string;content_hash:string;created_at:number}>();
    const r=revisions.results[0];
    if(revisions.results.length!==1 || r.editor!=='agent' || r.body_md!==note.body_md || r.frontmatter_json!==note.frontmatter_json ||
      r.content_hash!==note.content_hash || r.created_at!==note.created_at)return null;
    return {protocol:'unchanged-agent-creation-v1',id:note.id,content_hash:note.content_hash,
      created_at:note.created_at,updated_at:note.updated_at,revision_id:r.id,revision_count:1};
  }
  async isCurrent(id: string): Promise<boolean> {
    const clause = validityClause('note', true);
    return Boolean(await this.db.prepare(`SELECT id FROM notes n WHERE ${clause.sql} n.id=? AND n.deleted_at IS NULL`).bind(...clause.args(Date.now()), id).first());
  }
  constructor(private db: D1Database) {}

  getRowBySlug(userId: string, slug: string): Promise<NoteRow | null> {
    return this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE user_id=? AND slug=?`).bind(userId, slug).first<NoteRow>();
  }

  /** decision 5: same-slug resolution for notes_get / resolveNote and friends.
   *
   * 自分の行を先に見る(直接指定はまず自分の名前空間)。無ければ共有された行を見る。
   *
   * 2026-08-20、本番実測で見つかった穴: 共有ノートは検索には出るのに、その検索結果が
   * 返す slug で開けなかった。ここが呼び出し者の user_id で束縛していたためで、
   * 「見えるが触れない」という、利用者からは理由の分からない壊れ方をしていた。
   * slug は user ごとに一意(UNIQUE(user_id,slug))なので、他人の共有行は自分の
   * 名前空間に存在しない —— だから自分優先で探し、無ければ共有を探す形になる。
   *
   * 同じ slug の共有行が複数の著者から存在しうるので、決定的に1つ選ぶ
   * (作成順で最古)。並び順を決めないと、同じ問い合わせが日によって違う行を返す。
   *
   * 2026-08-22: 自分の行が**墓標**(soft-delete 済み)のときは共有行へ進む。
   * getRowBySlug は deleted_at を見ないので、以前その slug で書いて消していると
   * 墓標が先に当たり、そこで打ち切っていた —— 呼び出し側は isReadable で null に
   * するため、検索には出るのに開けないという 2026-08-20 に直したはずの壊れ方が、
   * 「消したことがある人」にだけ残っていた(実測で再現)。墓標しか無いときは
   * 従来どおり墓標を返す(呼び出し側が「無い」と扱う)。 */
  async getRowBySlugForCaller(principal: Principal, slug: string): Promise<NoteRow | null> {
    if (principal.anonymous) return null;
    const own = await this.getRowBySlug(principal.userId, slug);
    if (own && !own.deleted_at) return own;
    return (await this.getSharedRowBySlug(slug)) ?? own;
  }

  /** 共有された行を slug で引く。同名が複数ありうるので作成順で決定的に1つ選ぶ。
   * getRowBySlugForCaller の後半と同じ規則 —— 読みと書きが同じ行に着くために、
   * 規則は1つでなければならない。 */
  getSharedRowBySlug(slug: string): Promise<NoteRow | null> {
    return this.db
      .prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE slug=? AND shared=1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`)
      .bind(slug)
      .first<NoteRow>();
  }

  getRowById(id: string): Promise<NoteRow | null> {
    return this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id=?`).bind(id).first<NoteRow>();
  }

  async supersessionGuard(note: NoteRow): Promise<SupersessionGuard> {
    // Provenance is append-only through public writes. Count ALL rows before
    // the caller's bounded provenance read; a concurrent attachment invalidates
    // the later commit rather than qualifying an incompletely inspected claim.
    const row = await this.db.prepare("SELECT count(*) AS n FROM memory_provenance WHERE memory_kind='note' AND memory_id=?").bind(note.id).first<{ n: number }>();
    return { id: note.id, content_hash: note.content_hash, scope: note.scope, shared: Boolean(note.shared), updated_at: note.updated_at, provenance_count: row?.n ?? 0 };
  }

  // Final Recall hydration must authorize the same snapshot that reads bodies,
  // after both search and ambient/recency selection. D1 is the authority even
  // when an earlier query already validated these candidate IDs.
  async getRowsByIds(principal: Principal, ids: string[], context: string[] = []): Promise<Map<string, RecallNoteRow>> {
    const out = new Map<string, RecallNoteRow>();
    const vis=readableSql('n',principal), scope=scopeClause('n',context), validity=validityClause('note',true);
    const args=[...validity.args(now()),...vis.args,...scope.args], cap=Math.max(1,90-args.length);
    for (let i = 0; i < ids.length; i += cap) {
      const batch = ids.slice(i, i + cap);
      const ph = batch.map(() => "?").join(",");
      // Read the body and latest committed revision in one D1 snapshot. Match
      // their content for older rows whose revision was saved separately.
      const res = await this.db
        .prepare(`SELECT ${NOTE_COLUMNS_N},
          CASE WHEN r.editor='agent' AND r.editor_ref='api-token' THEN 'machine:fixed-api-token'
               ELSE r.editor_ref END AS recall_editor_ref,
          CASE WHEN r.rowid IS NULL THEN 'missing'
               WHEN r.content_hash=n.content_hash AND r.frontmatter_json=n.frontmatter_json THEN 'matching'
               ELSE 'mismatch' END AS recall_revision_state
          FROM notes n
          LEFT JOIN note_revisions r ON r.rowid=(
            SELECT rev.rowid FROM note_revisions rev WHERE rev.note_id=n.id ORDER BY rev.rowid DESC LIMIT 1
          )
          WHERE n.id IN (${ph}) AND n.deleted_at IS NULL AND n.kind!='block' AND n.archived_at IS NULL AND ${validity.sql}${vis.sql}${scope.sql}`)
        .bind(...batch,...args)
        .all<RecallNoteRow>();
      for (const r of res.results ?? []) out.set(r.id, r);
    }
    return out;
  }

  async upsert(principal: Principal, input: NoteInput & UpsertBinding, creationProvenance?: (id: string, shared: boolean) => Promise<D1PreparedStatement[]>): Promise<UpsertResult> {
    if (creationProvenance && !input.createOnly) throw new Error("creation provenance requires create_only");
    const guard = input.supersedesGuard === undefined ? undefined : parseSupersessionGuard(input.supersedesGuard);
    const updateGuard=input.updateGuard===undefined?undefined:parseUpdateGuard(input.updateGuard);
    if(updateGuard && (typeof input.slug!=='string' || !input.slug.trim() || typeof input.body_md!=='string' ||
      input.title!==undefined && typeof input.title!=='string' || input.createOnly || creationProvenance ||
      (['frontmatter','tags','stage','kind','type','shared','scope','valid_from','valid_until','supersedes','supersedesGuard',
        'pinned_block_label','char_limit','append_md','expectedContentHash','expectedUpdatedAt'] as (keyof NoteInput)[]).some(key=>input[key]!==undefined)))
      throw new Error('update_guard permits only explicit slug, title and plain body text');
    if (guard && (!input.createOnly || input.supersedes !== guard.id || input.append_md !== undefined || input.kind === 'block' || input.pinned_block_label != null))
      throw new Error('supersedes_guard requires create_only and the explicit target id');
    // The table CHECK is the only other gate, and a CHECK failure is
    // indistinguishable from a write conflict below (twelve retries, then a 500).
    if (input.kind !== undefined && !NOTE_KINDS.includes(input.kind)) throw new NoteInputError("kind must be one of note, journal, observation");
    const userId = principal.userId;
    // A conflicting create or update retries from a fresh snapshot. The row
    // and its revision, event, tags, index, and links commit together.
    const MAX_ATTEMPTS = 12;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
    const startedAt = now();
    // B1: lift a leading `--- YAML ---` block out of the body into frontmatter.
    let parsed = parseFrontmatter(input.body_md ?? "");
    let hasFm = Object.keys(parsed.data).length > 0;
    if(updateGuard && hasFm)throw new Error('update_guard cannot alter metadata through YAML frontmatter');
    let body = hasFm ? parsed.body : (input.body_md ?? "");
    let fmTitle = typeof parsed.data.title === "string" ? parsed.data.title : undefined;
    const fmSlug = typeof parsed.data.slug === "string" ? parsed.data.slug : undefined;
    const fmDate = parseFmDate(parsed.data.date ?? parsed.data.created ?? input.frontmatter?.date ?? input.frontmatter?.created);
    let title = (input.title ?? fmTitle ?? input.slug ?? "Untitled").trim() || "Untitled";
    // B1: frontmatter `slug` beats title-derivation (an explicit input.slug still
    // wins) so a `.md` twin round-trip re-PUTs onto the SAME note instead of
    // forking a new one off the title.
    let slug = slugifyPath(input.slug ?? fmSlug ?? input.title ?? fmTitle ?? title);
    if (slug === "untitled" && (input.slug ?? "").trim().toLowerCase() !== "untitled") slug = `untitled-${ulid(startedAt).toLowerCase()}`;
    // 2026-08-21: 読みは「自分の行 → 無ければ共有行」で解決するのに、書きは自分の
    // 名前空間に固定されていた。共有ノートに追記すると自分の名前空間に同じ slug の
    // 別の行ができ、以後その人には自分のコピーだけが見える —— 共有ノートが永久に
    // 影に隠れる。読みと書きで同じ行に着かないのが原因なので、揃える。
    //
    // 2026-08-22: 自分の行が墓標のときは共有行を先に見る。読み(getRowBySlugForCaller)
    // と同じ順序でなければならない: 墓標を先に当てて蘇生させると、同じ slug に生きた
    // 行が2つ(自分の私物 + 共有)並び、以後その人の読みは自分の私物に着く —— この
    // コメントが防ごうとしている「永久に影に隠れる」がそのまま起きる(実測で再現)。
    // 共有行が無ければ従来どおり墓標を蘇生させる(それが soft-delete からの復帰)。
    //
    // 2026-11-14 (security audit): that write-through is for a collaborative edit
    // of a note the caller means to keep shared. A write that is personal by
    // intent — a personal type, shared:false, or a core-memory block — must never
    // resolve to a teammate's row: it stored the caller's private text in a row
    // they do not own and cannot read back, and the first memory_append to a label
    // landed in whoever held a shared note at `block-<label>`. Such a write only
    // ever sees the caller's own row (live, or a tombstone to revive). A shared
    // row is not a block, so a row carrying a block marker is never written
    // through either.
    //
    // 2026-11-14 (fix review, decided): a full-document write that names NO
    // audience (no type, no shared flag) is personal too — "omit it and the note
    // stays personal" — so it creates or revives the caller's own row instead of
    // replacing a teammate's shared body with text the caller never asked to
    // share. Writing through takes explicit shared intent (a shared type or
    // shared:true) or an append, which adds to the note and replaces nothing. A
    // door that bound the row itself (ownOnly, expectedId) never writes through.
    const ownRow = await this.getRowBySlug(userId, slug);
    const ownLive = ownRow && !ownRow.deleted_at ? ownRow : null;
    if (input.expectedId !== undefined && ownLive?.id !== input.expectedId) throw new NoteInputError("note not found", 404);
    const audience = input.shared !== undefined ? input.shared : input.type !== undefined ? resolveShared(input.type) : undefined;
    const personalIntent = input.ownOnly === true || input.expectedId !== undefined || input.kind === "block" || input.pinned_block_label != null ||
      audience === false || (audience === undefined && input.append_md === undefined);
    const sharedRow = ownLive || personalIntent ? null : await this.getSharedRowBySlug(slug);
    const existing = ownLive ?? (sharedRow && sharedRow.kind !== "block" && sharedRow.pinned_block_label == null ? sharedRow : null) ?? ownRow;
    const ts = Math.max(startedAt, (existing?.updated_at ?? -1) + 1);
    // A non-owner reaching a teammate's shared row edits CONTENT only: body, title
    // and tags. Audience and lifecycle — shared, type, kind, scope, stage, the
    // validity window, supersession, the block marker and its limit, archived
    // state — stay the owner's decision; delete, archive, rename and retract
    // already refuse a non-owner, and this door let them unshare, expire, re-scope
    // or re-kind the same note. `own` is what the caller may set on those axes:
    // nothing for a write-through, so every rule below that preserves the row on an
    // omitted field applies unchanged. Frontmatter in the body is read the same way.
    const writeThrough = !!existing && existing.user_id !== userId;
    const own: Pick<NoteInput, "kind" | "type" | "shared" | "scope" | "stage" | "valid_from" | "valid_until" | "supersedes" | "pinned_block_label" | "char_limit"> = writeThrough ? {} : input;
    const blockAppend = input.append_md !== undefined && input.append_separator !== undefined && own.kind === "block";
    const charLimit = blockAppend
      ? resolveCharLimit(own.char_limit, existing?.deleted_at ? null : existing)
      : own.char_limit !== undefined ? own.char_limit : existing?.char_limit ?? null;
    // 付随データ(タグ・リンク・ベクトルのメタデータ)は行の持ち主に紐づける。
    // 編集者に紐づけると、他人の共有ノートを編集しただけで自分のタグが増える。
    const rowOwner = existing?.user_id ?? userId;
    // A block the stored body already opens with was stored text, not metadata
    // sent with this request (a PATCH that changes only the title resubmits the
    // stored body; an editor resubmits it around its own changes). Lifting it
    // would apply another writer's `supersedes` or dates with this caller's
    // authority, so it stays body text. Compared as parsed data: line endings and
    // spacing differ between clients. inertBody below then rewrites its fence.
    // The stored block may sit behind leading blank text (stored before inertBody
    // looked past it); the client that dropped it must not make it metadata.
    if (hasFm && existing && !existing.deleted_at && JSON.stringify(parseFrontmatter(existing.body_md.replace(LEADING_BLANK, "")).data) === JSON.stringify(parsed.data)) {
      parsed = { data: {}, body: input.body_md ?? "" };
      hasFm = false;
      fmTitle = undefined;
      body = parsed.body;
      title = (input.title ?? input.slug ?? "Untitled").trim() || "Untitled";
    }
    const fmOwn = writeThrough ? {} : parsed.data;
    if(updateGuard) {
      // Guarded repair is UPDATE-only and owner-only. A slug miss, tombstone or
      // same-slug shared fallback must never create, resurrect or edit another row.
      if(!existing || existing.id!==updateGuard.id || existing.user_id!==userId)throw new UpdateConflictError();
      const where=guardedTextWhere(updateGuard,userId,slug,now());
      if(!await this.db.prepare(`SELECT n.id FROM notes n WHERE ${where.sql}`).bind(...where.args).first())throw new UpdateConflictError();
    }
    // Read-modify-write CAS (H-1): expectedContentHash === null means the caller
    // read NO live row for this slug and computed against an empty base.
    // If a live row exists now, a concurrent writer created it inside the read->
    // upsert window — surface a stale conflict so the caller recomputes against it
    // instead of clobbering it from the empty base. (A soft-deleted row is not a
    // conflict: this write resurrects it, CAS-guarded by its own content_hash below.)
    if (input.createOnly && existing) throw new StaleUpsertError();
    if (input.expectedContentHash === null && existing && !existing.deleted_at) throw new StaleUpsertError();
    if (input.expectedUpdatedAt !== undefined && (existing?.deleted_at || existing?.updated_at !== input.expectedUpdatedAt)) {
      throw new StaleUpsertError();
    }
    // Append contract: recompute the concatenated body from the FRESHLY-read
    // existing row on EVERY attempt so a writer that lost the CAS re-enters the
    // loop and appends onto the winner's body instead of clobbering it. Block
    // appends opt into block semantics via an explicit separator ("\n"): mirror
    // applyBlockOp by skipping the separator onto an empty base and clamping to
    // char_limit. Plain note appends keep the blank-line separator and no clamp.
    if (input.append_md !== undefined) {
      if (existing && (existing.kind === "block" || existing.pinned_block_label != null || existing.char_limit != null) && !allows(principal, "notes:read")) {
        throw new Error("Forbidden: missing scope 'notes:read' (this operation reads the block it changes)");
      }
      const blockSep = input.append_separator !== undefined;
      const sep = input.append_separator ?? "\n\n";
      const baseBody = existing && !existing.deleted_at ? existing.body_md : "";
      const hasBase = baseBody.length > 0 || (!blockSep && existing != null && !existing.deleted_at);
      body = (hasBase ? baseBody + sep : "") + input.append_md;
      // Forcing-function (P0): a char-limited append (core-memory blocks are the
      // only writers that pass char_limit) that would overflow is REJECTED here at
      // the CAS-safe write point, not silently truncated. Regular notes carry no
      // char_limit (cl=null) so this never fires for them.
      if (charLimit != null && charLimit > 0 && body.length > charLimit) throw new BlockFullError(body.length, charLimit);
    }
    body = inertBody(body);
    if (body.length > MAX_NOTE_BODY_CHARS && body.length > (existing && !existing.deleted_at ? existing.body_md.length : 0)) throw tooLarge();
    // Partial-update safety: no explicit title signal -> keep the note's current
    // title (matches kind/stage/tags preservation below).
    if (existing && input.title === undefined && fmTitle === undefined) title = existing.title;
    title = singleLine(title) || "Untitled";
    // Core-memory blocks are ALWAYS private working memory. The durable block
    // marker memory_get reads is pinned_block_label (independent of kind), so once
    // a row is a block the notes door must not be able to re-kind it to a plain
    // 'note' or flip it public — otherwise two ordinary notes_put writes (the
    // first clears kind, the second clears the old kind-only visibility guard)
    // would expose a private core-memory block to anonymous readers. Keep 'block'
    // sticky and force private whenever the row carries a block marker.
    const isBlock = own.kind === "block" || existing?.kind === "block" || existing?.pinned_block_label != null;
    const kind: NoteKind = isBlock ? "block" : (own.kind ?? existing?.kind ?? "note");
    const fmTags = parsed.data.tags !== undefined ? asStringArray(parsed.data.tags) : extractTagsFromFrontmatter(input.frontmatter);
    // Partial-update safety: no tag signal at all -> keep the note's current tags
    // (matches title/body preservation; PATCH and notes_append rely on this).
    const tagsSource = input.tags ?? (fmTags.length ? fmTags : existing ? await this.tagsFor(existing.id, principal.userId) : []);
    const tags = normalizeTags(tagsSource);
    // A write-through keeps the owner's stored frontmatter and replaces only its
    // content fields: the caller's `frontmatter` and the lifecycle keys of a body
    // block are not applied (fmOwn), so they must not be stored as if they were.
    const frontmatter = updateGuard ? existing!.frontmatter_json
      : writeThrough ? JSON.stringify(contentFrontmatter(existing!.frontmatter_json, title, tags))
      : JSON.stringify({ ...(input.frontmatter ?? {}), ...parsed.data, tags });
    const contentHash = await sha256hex(`${title}\n${body}\n${tags.join(",")}`);

    const id = existing?.id ?? ulid(ts);
    const created = !existing;
    // B1: a re-imported note keeps its original date — honor a parseable
    // frontmatter `date`/`created` on CREATE only (updates never move created_at).
    const createdAt = created ? (fmDate ?? ts) : ts;

    const wordCount = (body.match(/\S+/g) ?? []).length;
    const ftsTags = tags.join(" ");
    const pinned = own.pinned_block_label !== undefined ? own.pinned_block_label : (existing?.pinned_block_label ?? null);
    const STAGES = ["seedling", "budding", "evergreen"];
    const stage =
      own.stage && STAGES.includes(own.stage)
        ? own.stage
        : typeof fmOwn.stage === "string" && STAGES.includes(fmOwn.stage)
          ? fmOwn.stage
          : (existing?.stage ?? "seedling");
    // #117 project scope: an explicit input.scope is normalized+stamped; an
    // omitted scope on a NEW note defaults to 'global', on an EDIT preserves the
    // existing row's scope (so a scope-less edit — e.g. an append or fork — never
    // resets a note's project scope back to 'global').
    const scope = own.scope !== undefined ? normalizeScope(own.scope) : (existing?.scope ?? "global");
    // 記憶の種類。省略した編集は既存を保つ(scope/stage と同じ規則)。
    const noteType = own.type !== undefined ? own.type : ((existing?.type as NoteType | null) ?? null);
    // 共有するか。保存の瞬間に1度だけ解決して固定する。
    // 省略した編集で既存を保つのが要点 — ここで解決し直すと、追記しただけで
    // 共有が黙って外れる(あるいは付く)ことになる。
    const shared = isBlock
      ? // 2026-08-21: core-memory ブロックは常に個人の作業記憶。60行上のコメントは
        // 「kind を固定し、ブロック印がある行は private を強制する」と書いていたが、
        // 実装されていたのは kind の側だけだった。ordinary な notes_put を
        // `block-<label>` の slug に type:'project' で1回書くと shared=1 になり、
        // 以後の memory_set/memory_append は !!existing.shared を保つので汚染が残る。
        // 一覧と検索は kind != 'block' で除くので誰も気づかず、id/slug 直指定の
        // 扉だけが本文を返す —— 監査で end-to-end に再現された。
        false
      : own.shared !== undefined
        ? own.shared
        : own.type !== undefined || !existing
          ? resolveShared(noteType)
          : // 2026-08-21: 削除済みの行を蘇生させるときは共有状態を引き継がない。
            // getRowBySlug は deleted_at を見ないので、共有ノートを消したあと同じ
            // slug に別の内容を書くと、その新しい内容が黙って共有される。
            // 「種類を省いた編集は既存を保つ」が意図しているのは生きている行の話。
            existing.deleted_at
            ? false
            : !!existing.shared;
    // decision 10: bi-temporal validity. Explicit input wins (null clears);
    // else a parseable frontmatter value; else preserve the existing row (an
    // omitted field on an EDIT never resets it — mirrors stage/scope). Reuse the
    // same parseFmDate that honors a frontmatter `date` so ISO strings work.
    const validFrom =
      own.valid_from !== undefined ? own.valid_from : (parseFmDate(fmOwn.valid_from) ?? existing?.valid_from ?? null);
    const validUntil =
      own.valid_until !== undefined ? own.valid_until : (parseFmDate(fmOwn.valid_until) ?? existing?.valid_until ?? null);
    // This note stays whatever it already was on the supersession axis (a later
    // note may supersede IT); the supersede-stamp below writes the OTHER row.
    // `supersedes` = the note THIS one replaces. Accept a slug or an id, from the
    // structured input or frontmatter; resolve to an owner-owned note id (never
    // self). Preserve the existing backpointer when omitted.
    const supersedesInput =
      own.supersedes ?? (typeof fmOwn.supersedes === "string" ? fmOwn.supersedes : undefined);
    let supersedesId: string | null = existing?.supersedes ?? null;
    // `supersedeTargetId` = a target FRESHLY resolved on THIS write (the only row
    // to stamp below). Kept separate from the preserved backpointer so an edit
    // that merely preserves `supersedes` never re-stamps an old target.
    let supersedeTargetId: string | null = null;
    // Cycle guard: a note that is ITSELF currently superseded by a LIVE note may
    // not supersede another. A supersession cycle can only close if the writer
    // already sits on the (live) superseded chain, so refusing that single case
    // provably prevents ALL cycles — including the 2-cycle A<->B that would hide
    // both from recall. Recall hides via a LIVE superseder derived off the
    // never-overwritten forward pointer (a live note whose `supersedes` = the
    // writer), so the guard must test the SAME condition — NOT the writer's own
    // `superseded_by`, which is last-writer-wins and can be a stale pointer to a
    // deleted superseder even while another live note still supersedes the writer
    // (that stale pointer would let the guard wrongly admit a cycle-closing write).
    if (guard) {
      // The owner may promote: a shared correction can retire their own personal
      // note (user decision 2026-10-24). A personal note can never retire a
      // shared one, which would hide team knowledge. The guarded write below
      // still binds the target's owner, content, scope and audience.
      if (kind === 'block' || pinned != null || scope !== guard.scope || (shared !== guard.shared && !(shared && !guard.shared))) throw new SupersessionConflictError();
      supersedesId = guard.id;
      supersedeTargetId = guard.id;
    } else if (supersedesInput && supersedesInput.trim()) {
      const liveSuperseder = await this.db
        .prepare("SELECT 1 AS one FROM notes WHERE supersedes=? AND deleted_at IS NULL LIMIT 1")
        .bind(id)
        .first<{ one: number }>();
      const writerLiveSuperseded = !!liveSuperseder;
      const target = writerLiveSuperseded ? null : (await this.getRowBySlug(userId, supersedesInput.trim())) ?? (await this.getRowById(supersedesInput.trim()));
      if (target && target.user_id === userId && target.id !== id && !target.deleted_at) {
        supersedesId = target.id;
        supersedeTargetId = target.id;
      }
    }
    const commit = this.mutationEvent(userId, principal, created ? "note.created" : "note.updated", id, title, ts, {
      content_hash: contentHash,
      op: created ? "create" : "replace",
      ...(supersedeTargetId ? { supersedes: supersedeTargetId } : {}),
    });
    const { sql: committed, args: gate } = commit.gate;
    const recordRevision = !existing || existing.deleted_at || existing.content_hash !== contentHash || existing.frontmatter_json !== frontmatter;
    const revision = recordRevision ? this.db.prepare(`INSERT INTO note_revisions
      (id,note_id,body_md,frontmatter_json,editor,editor_ref,content_hash,created_at)
      SELECT ?,id,body_md,frontmatter_json,?,?,content_hash,? FROM notes WHERE id=? AND ${committed}`)
      .bind(ulid(ts), principal.actor, principal.viaKeyPrefix ?? principal.handle, ts, id, ...gate) : null;
    const related = [
      commit.event,
      ...(revision ? [revision] : []),
      ...this.tagStatements(rowOwner, id, tags, ts, commit.gate),
      ...this.indexStatements(id, ftsTags, commit.gate),
      ...this.outgoingLinkStatements(rowOwner, id, body, ts, commit.gate),
      // Resolve pending links from the owner, or from everyone when the note is shared.
      this.db.prepare(`UPDATE links SET target_note_id=?,resolved=1
        WHERE target_slug=? AND target_note_id IS NULL AND ${committed}${shared ? "" : " AND user_id=?"}`)
        .bind(id, slug, ...gate, ...(shared ? [] : [rowOwner])),
      // This pointer is for display. Recall derives supersession from live forward links.
      ...(supersedeTargetId ? [
        this.db.prepare(`UPDATE notes SET superseded_by=? WHERE id=? AND user_id=? AND ${committed}`)
          .bind(id, supersedeTargetId, userId, ...gate),
      ] : []),
    ];
    if (existing) {
      // Bind the write to the hash, timestamp, and slug read in this attempt.
      // The timestamp covers metadata-only edits, and the slug covers renames.
      // CAS token: a read-modify-write caller (block set/replace, H-1) passes the
      // content_hash of the base IT read (expectedContentHash) so the guard covers
      // the whole read->upsert window, not just upsert's own re-read; otherwise
      // fall back to the freshly-read existing hash (append + simple upserts).
      //
      // Owner bind (decided 2026-11-14): the UPDATE also names the owner it
      // resolved. For the caller's own row that is the caller, so an owner-only
      // write can never land in someone else's row whatever resolved the id. A
      // write-through instead requires the row to STILL be shared and live at the
      // write: unsharing does not move content_hash, so the CAS alone would let an
      // edit that raced the owner's unshare land in a now-private row. A miss is
      // the ordinary stale conflict — the retry re-resolves, finds no shared row,
      // and writes the caller's own. archived_at is cleared by the owner's edit
      // (as before).
      //
      // A write-through has its own UPDATE that names content columns only. The
      // lifecycle values above were read earlier in this attempt; writing them
      // back would undo an archive, expiry or re-scope the owner committed in
      // between (content_hash does not move for those, so the CAS cannot see it).
      // An id-addressed write must find its row still live: it never revives.
      const casHash = typeof input.expectedContentHash === "string" ? input.expectedContentHash : existing.content_hash;
      const where=updateGuard?guardedTextWhere(updateGuard,userId,slug,now()):undefined;
      const update = where ? this.db.prepare(`UPDATE notes AS n SET
        title=?, body_md=?, content_hash=?, word_count=?, updated_at=?
        WHERE ${where.sql}`).bind(title,body,contentHash,wordCount,ts,...where.args)
        : writeThrough ? this.db
        .prepare(
          `UPDATE notes SET title=?, body_md=?, frontmatter_json=?, content_hash=?, word_count=?, updated_at=?
           WHERE id=? AND content_hash=? AND user_id=? AND updated_at=? AND slug=? AND shared=1 AND deleted_at IS NULL`,
        )
        .bind(title, body, frontmatter, contentHash, wordCount, ts, id, casHash, rowOwner, existing.updated_at, slug)
        : this.db
        .prepare(
          `UPDATE notes SET title=?, body_md=?, frontmatter_json=?, kind=?, stage=?, scope=?, type=?, shared=?,
             pinned_block_label=?, char_limit=?, content_hash=?,
             word_count=?, valid_from=?, valid_until=?, supersedes=?,
             updated_at=?, deleted_at=NULL, archived_at=NULL
           WHERE id=? AND content_hash=? AND user_id=? AND updated_at=? AND slug=? AND deleted_at IS ?${input.expectedId !== undefined ? " AND deleted_at IS NULL" : ""}`,
        )
        .bind(title, body, frontmatter, kind, stage, scope, noteType, shared ? 1 : 0, pinned, charLimit, contentHash, wordCount, validFrom, validUntil, supersedesId, ts, id, casHash, rowOwner, existing.updated_at, slug, existing.deleted_at);
      const [result] = await this.db.batch([update, ...related]);
      if (result.meta.changes === 0) {if(updateGuard)throw new UpdateConflictError();throw new StaleUpsertError();}
    } else {
      const provenanceStatements = creationProvenance ? await creationProvenance(id, shared) : null;
      const current = validityClause('note', true);
      const values = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?';
      const insert = this.db
        .prepare(
          `INSERT INTO notes (id,user_id,slug,title,body_md,frontmatter_json,kind,stage,scope,type,shared,
             pinned_block_label,char_limit,content_hash,word_count,view_count,score,
             valid_from,valid_until,superseded_by,supersedes,created_at,updated_at)
           ${guard ? `SELECT ${values} WHERE EXISTS (
             SELECT 1 FROM notes n WHERE ${current.sql} n.id=? AND n.user_id=? AND n.content_hash=? AND n.scope=?
             AND COALESCE(n.shared,0)=? AND n.updated_at=? AND n.deleted_at IS NULL AND n.archived_at IS NULL
             AND n.kind!='block' AND n.pinned_block_label IS NULL
             AND (SELECT count(*) FROM memory_provenance pv WHERE pv.memory_kind='note' AND pv.memory_id=n.id)=?
           )` : `VALUES (${values})`}`,
        )
        .bind(id, userId, slug, title, body, frontmatter, kind, stage, scope, noteType, shared ? 1 : 0, pinned, charLimit, contentHash, wordCount, validFrom, validUntil, null, supersedesId, createdAt, ts,
          ...(guard ? [...current.args(now()), guard.id, userId, guard.content_hash, guard.scope, guard.shared ? 1 : 0, guard.updated_at, guard.provenance_count] : []));
      const [result] = await this.db.batch([insert, ...related, ...(provenanceStatements ?? [])]);
      if (guard && result.meta.changes === 0) throw new SupersessionConflictError();
    }

    const note = (await this.getRowById(id)) as NoteRow;
    if (!writeThrough) return { note, created, shared };
    // Answer from the row as it is now, not from the snapshot read above.
    const owner = await this.db.prepare("SELECT handle FROM users WHERE id=?").bind(rowOwner).first<{ handle: string }>();
    return { note, created, shared: Boolean(note.shared), writtenThrough: owner?.handle ?? rowOwner };
      } catch (err) {
        // A guard pins the caller's inspected base. Never retry into a different
        // snapshot, including after a constraint or post-commit auxiliary error.
        if(updateGuard)throw err;
        // A read-modify-write caller (the block set/replace path) needs to re-run
        // its transform against the winner's fresh body, so surface the CAS miss
        // instead of converging on the now-stale precomputed body.
        if (err instanceof StaleUpsertError && (input.bubbleStaleConflict || input.createOnly)) throw err;
        if (attempt < MAX_ATTEMPTS - 1 && (err instanceof StaleUpsertError || /SQLITE_CONSTRAINT|constraint failed/i.test(String(err)))) {
          // Jittered backoff so concurrent same-slug writers don't retry in
          // lockstep (the lockstep collisions are what exhausted the old fixed
          // budget and surfaced as 500s / dropped appends under contention).
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * (attempt + 1))));
          continue;
        }
        throw err;
      }
    }
    throw new Error("upsert: unreachable");
  }

  private indexStatements(id: string, tags: string, gate: NoteMutationGate): D1PreparedStatement[] {
    return [
      this.db.prepare(`DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?) AND ${gate.sql}`).bind(id, ...gate.args),
      this.db.prepare(`INSERT INTO notes_fts (rowid,title,body,tags)
        SELECT rowid,title,body_md,? FROM notes WHERE id=? AND ${gate.sql}`).bind(tags, id, ...gate.args),
    ];
  }

  private outgoingLinkStatements(userId: string, id: string, body: string, ts: number, gate: NoteMutationGate): D1PreparedStatement[] {
    const statements = [this.db.prepare(`DELETE FROM links WHERE src_note_id=? AND ${gate.sql}`).bind(id, ...gate.args)];
    const links = [], seen = new Set<string>();
    for (const match of parseWikilinks(body)) {
      if (seen.has(match.targetSlug)) continue;
      seen.add(match.targetSlug);
      links.push({ id: ulid(ts), slug: match.targetSlug, kind: match.kind, anchor: match.anchorText, position: match.position });
    }
    // Per-binding chunks keep the JSON supplied to D1 small for large notes.
    for (let offset = 0; offset < links.length; offset += 100) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO links
        (id,user_id,src_note_id,target_slug,target_note_id,kind,anchor_text,position,resolved)
        SELECT link_id,?,?,slug,target,kind,anchor,position,target IS NOT NULL FROM (
          SELECT json_extract(value,'$.id') AS link_id,json_extract(value,'$.slug') AS slug,
            json_extract(value,'$.kind') AS kind,json_extract(value,'$.anchor') AS anchor,json_extract(value,'$.position') AS position,
            COALESCE((SELECT id FROM notes WHERE user_id=? AND slug=json_extract(value,'$.slug') AND deleted_at IS NULL),
              (SELECT id FROM notes WHERE shared=1 AND slug=json_extract(value,'$.slug') AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1)) AS target
          FROM json_each(?) WHERE ${gate.sql}
        )`).bind(userId, id, userId, JSON.stringify(links.slice(offset, offset + 100)), ...gate.args));
    }
    return statements;
  }

  private tagStatements(userId: string, noteId: string, tags: string[], ts: number, gate: NoteMutationGate): D1PreparedStatement[] {
    const statements = [this.db.prepare(`DELETE FROM note_tags WHERE note_id=? AND ${gate.sql}`).bind(noteId, ...gate.args)];
    for (let offset = 0; offset < tags.length; offset += 100) {
      const entries = JSON.stringify(tags.slice(offset, offset + 100).map(name => ({ id: ulid(ts), name, slug: slugify(name) })));
      statements.push(
        this.db.prepare(`INSERT OR IGNORE INTO tags (id,user_id,name,slug)
          SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.slug')
          FROM json_each(?) WHERE ${gate.sql}`).bind(userId, entries, ...gate.args),
        this.db.prepare(`INSERT OR IGNORE INTO note_tags (note_id,tag_id)
          SELECT ?,t.id FROM json_each(?) JOIN tags t ON t.user_id=? AND t.slug=json_extract(value,'$.slug')
          WHERE ${gate.sql}`).bind(noteId, entries, userId, ...gate.args),
      );
    }
    return statements;
  }

  private mutationEvent(userId: string, principal: Principal, verb: string, targetId: string, summary: string, ts: number, payload: Record<string, unknown> = {}) {
    const eventId = ulid(ts);
    // This statement immediately follows the row mutation. Its unique ID gates
    // every related statement even when a competing request used the same clock tick.
    const event = this.db.prepare(`INSERT INTO events
      (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`)
      .bind(eventId, userId, principal.actor, principal.viaKeyPrefix ?? principal.handle, verb, "note", targetId, null, summary, JSON.stringify(payload), ts);
    return { event, gate: { sql: "EXISTS (SELECT 1 FROM events WHERE id=?)", args: [eventId] } };
  }

  private async event(userId: string, principal: Principal, verb: string, targetId: string, summary: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO events (id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(ulid(), userId, principal.actor, principal.viaKeyPrefix ?? principal.handle, verb, "note", targetId, null, summary, JSON.stringify(payload), now())
      .run();
  }

  async softDelete(principal: Principal, id: string, deletionGuard?: SupersessionGuard): Promise<boolean> {
    const guard = deletionGuard === undefined ? undefined : parseDeletionGuard(deletionGuard);
    if (guard && guard.id !== id) throw new Error('deletion_guard target mismatch');
    const note = await this.getRowById(id);
    if (!note || note.user_id !== principal.userId || note.deleted_at) return false;
    const ts = now();
    const current = validityClause('note', true);
    // Guard the mutation itself, not just the earlier read. A stale snapshot
    // must not delete an independently edited/shared/scoped/re-provenanced row,
    // nor clean up its FTS/links or emit a successful deletion event.
    const remove = this.db.prepare(`UPDATE notes AS n SET deleted_at=?, updated_at=?
      WHERE n.id=? AND n.user_id=? AND n.deleted_at IS NULL ${guard ? `
      AND ${current.sql} n.content_hash=? AND n.scope=? AND COALESCE(n.shared,0)=? AND n.updated_at=?
      AND n.archived_at IS NULL AND n.kind!='block' AND n.pinned_block_label IS NULL
      AND (SELECT count(*) FROM memory_provenance pv WHERE pv.memory_kind='note' AND pv.memory_id=n.id)=?` : ''}`)
      .bind(ts, ts, id, principal.userId, ...(guard ? [...current.args(ts), guard.content_hash, guard.scope, guard.shared ? 1 : 0, guard.updated_at, guard.provenance_count] : []));
    const commit = this.mutationEvent(principal.userId, principal, "note.deleted", id, note.title, ts);
    const { sql: committed, args: gate } = commit.gate;
    const [result] = await this.db.batch([
      remove,
      commit.event,
      this.db.prepare(`DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?) AND ${committed}`).bind(id, ...gate),
      this.db.prepare(`DELETE FROM links WHERE src_note_id=? AND ${committed}`).bind(id, ...gate),
      this.db.prepare(`UPDATE links SET target_note_id=NULL,resolved=0 WHERE target_note_id=? AND ${committed}`).bind(id, ...gate),
    ]);
    if (!result.meta.changes) {
      if (guard) throw new DeletionConflictError();
      return false;
    }
    return true;
  }

  async appendStatus(principal: Principal, id: string, operationId: string) {
    if (principal.anonymous) throw Error('authentication required');
    if (typeof id !== 'string' || !id.length || id.length > 80) throw Error('invalid append target');
    operationId = appendId(operationId);
    const receiptId = await appendEventId(principal.userId,operationId);
    const row = await this.db.prepare("SELECT payload_json,created_at FROM events WHERE id=? AND user_id=? AND target_id=? AND verb='note.appended'")
      .bind(receiptId,principal.userId,id).first<{payload_json:string;created_at:number}>();
    if (!row) return { completed:false as const };
    const receipt = JSON.parse(row.payload_json) as { request_hash:string; append_guard:SupersessionGuard; provenance:AppendProvenance; slug:string; content_hash:string };
    const note = await this.getRowById(id);
    return {completed:true as const,id,append_id:operationId,request_hash:receipt.request_hash,
      append_guard:receipt.append_guard,provenance:receipt.provenance,slug:receipt.slug,content_hash:receipt.content_hash,created_at:row.created_at,
      current_content_matches:Boolean(note && note.user_id===principal.userId && note.content_hash===receipt.content_hash)};
  }

  /** A separate MCP door prevents old servers silently ignoring these guards.
   * Content, source trace, receipt, FTS, revisions and links commit together
   * on the SAME note substrate. */
  async appendReviewed(principal: Principal, args: Record<string,unknown>,
      prepareProvenance: (id:string,shared:boolean,receiptId:string,requestHash:string,p:AppendProvenance,commitNonce:string)=>Promise<D1PreparedStatement[]>) {
    if (principal.anonymous) throw Error('authentication required');
    const {slug,text,operationId,guard,provenance}=parseAppend(args), id=guard.id;
    const receiptId=await appendEventId(principal.userId,operationId);
    const requestHash=await appendRequestHash(slug,text,guard,provenance);
    const replay=(receipt:Awaited<ReturnType<NotesRepo['appendStatus']>>)=>{
      if(!receipt.completed)throw new AppendConflictError();
      if(receipt.request_hash!==requestHash)throw Error('append receipt conflict');
      return {appended:true,id,slug:receipt.slug,append_id:operationId,content_hash:receipt.content_hash,provenance_stored:true,replayed:true};
    };
    // An exact retry acknowledges the old commit even after source TTL or a
    // human edit/delete. It neither re-appends nor repairs later user content.
    const previous=await this.appendStatus(principal,id,operationId);
    if(previous.completed)return replay(previous);
    const note=await this.getRowById(id), ts=now();
    const where=guardedTextWhere(guard,principal.userId,slug,ts);
    if(!note || !await this.db.prepare(`SELECT n.id FROM notes n WHERE ${where.sql}`).bind(...where.args).first())
      return replay(await this.appendStatus(principal,id,operationId));
    // The stored-body rule is about the concatenated body: a `---` line anywhere
    // in the appended text can close a block the note opens with.
    const tags=await this.tagsFor(id, principal.userId), body=inertBody(note.body_md+'\n\n'+text);
    // Same bound as upsert: this door always grows the body.
    if(body.length>MAX_NOTE_BODY_CHARS)throw tooLarge();
    const contentHash=await sha256hex(`${note.title}\n${body}\n${tags.join(',')}`);
    // Request identity is stable across retries; this nonce distinguishes the
    // winner of THIS invocation from an identical concurrent receipt. A loser
    // must not recreate history, links or traces from a winner.
    const commitNonce=ulid(ts);
    const provenanceStatements=await prepareProvenance(id,Boolean(note.shared),receiptId,requestHash,provenance,commitNonce);
    const payload=JSON.stringify({append_id:operationId,request_hash:requestHash,append_guard:guard,provenance,slug,content_hash:contentHash,commit_nonce:commitNonce});
    const committed=`EXISTS (SELECT 1 FROM events e JOIN notes n ON n.id=e.target_id
      WHERE e.id=? AND e.user_id=? AND e.verb='note.appended' AND json_extract(e.payload_json,'$.request_hash')=?
      AND n.id=? AND n.user_id=? AND n.updated_at=e.created_at AND n.content_hash=? AND json_extract(e.payload_json,'$.commit_nonce')=?)`;
    const gate=[receiptId,principal.userId,requestHash,id,principal.userId,contentHash,commitNonce];
    const mutationGate = { sql: committed, args: gate };
    const finalWhere=guardedTextWhere(guard,principal.userId,slug,now());
    const results=await this.db.batch([
      this.db.prepare(`UPDATE notes AS n SET body_md=?,content_hash=?,word_count=?,updated_at=?
        WHERE ${finalWhere.sql} AND NOT EXISTS (SELECT 1 FROM events WHERE id=?)`)
        .bind(body,contentHash,(body.match(/\S+/g)??[]).length,ts,...finalWhere.args,receiptId),
      // Must immediately follow the UPDATE: timestamp coincidence alone must
      // never manufacture a receipt for a stale or concurrent loser.
      this.db.prepare(`INSERT INTO events(id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? FROM notes n WHERE changes()=1 AND n.id=? AND n.user_id=? AND n.content_hash=?`)
        .bind(receiptId,principal.userId,principal.actor,principal.viaKeyPrefix??principal.handle,'note.appended','note',id,provenance.rationale,note.title,payload,ts,id,principal.userId,contentHash),
      ...provenanceStatements,
      ...this.indexStatements(id, tags.join(' '), mutationGate),
      this.db.prepare(`INSERT INTO note_revisions(id,note_id,body_md,frontmatter_json,editor,editor_ref,content_hash,created_at)
        SELECT ?,id,body_md,frontmatter_json,?,?,content_hash,? FROM notes n WHERE n.id=? AND ${committed}`)
        .bind(ulid(ts),principal.actor,principal.viaKeyPrefix??principal.handle,ts,id,...gate),
      ...this.outgoingLinkStatements(principal.userId, id, body, ts, mutationGate),
    ]);
    if(!results[0].meta.changes)return replay(await this.appendStatus(principal,id,operationId));
    return {appended:true,id,slug,append_id:operationId,content_hash:contentHash,provenance_stored:true,replayed:false};
  }

  async retractionStatus(principal: Principal, id: string, operationId: string) {
    if (principal.anonymous) throw Error('authentication required');
    id = retractionTarget(id); operationId = retractionId(operationId);
    const receiptId = await retractionEventId(principal.userId,operationId);
    const row = await this.db.prepare("SELECT payload_json,created_at FROM events WHERE id=? AND user_id=? AND target_id=? AND verb='note.deleted'")
      .bind(receiptId,principal.userId,id).first<{payload_json:string;created_at:number}>();
    if (!row) return { completed: false as const };
    const receipt = JSON.parse(row.payload_json) as { request_hash:string; deletion_guard:SupersessionGuard; provenance:RetractionProvenance; slug:string };
    const note = await this.getRowById(id);
    return { completed:true as const,id,retraction_id:operationId,request_hash:receipt.request_hash,
      deletion_guard:receipt.deletion_guard,provenance:receipt.provenance,slug:receipt.slug,created_at:row.created_at,
      current_deleted:Boolean(note && note.user_id === principal.userId && note.deleted_at != null) };
  }

  async retract(principal: Principal, id: string, guard: SupersessionGuard, operationId: string, provenance: RetractionProvenance,
      prepareProvenance: (receiptId:string,requestHash:string,shared:boolean) => Promise<D1PreparedStatement[]>) {
    if (principal.anonymous) throw Error('authentication required');
    id = retractionTarget(id); operationId = retractionId(operationId); provenance = retractionProvenance(provenance);
    guard = parseDeletionGuard(guard);
    if (guard.id !== id) throw Error('deletion_guard target mismatch');
    const receiptId = await retractionEventId(principal.userId,operationId);
    const requestHash = await retractionRequestHash(id,guard,provenance);
    const replay = (receipt: Awaited<ReturnType<NotesRepo['retractionStatus']>>) => {
      if (!receipt.completed) throw new DeletionConflictError();
      if (receipt.request_hash !== requestHash) throw Error('retraction receipt conflict');
      return { deleted:true,id,slug:receipt.slug,retraction_id:operationId,provenance_stored:true,replayed:true,current_deleted:receipt.current_deleted };
    };
    const previous = await this.retractionStatus(principal,id,operationId);
    if (previous.completed) return replay(previous);
    const note = await this.getRowById(id);
    if (!note || note.user_id !== principal.userId) return { deleted:false };
    if (note.deleted_at != null) throw new DeletionConflictError();
    const provenanceStatements = await prepareProvenance(receiptId,requestHash,Boolean(note.shared));
    const ts = now(), current = validityClause('note',true);
    const payload = JSON.stringify({ retraction_id:operationId,request_hash:requestHash,deletion_guard:guard,provenance,slug:note.slug });
    const committed = `EXISTS (SELECT 1 FROM events e JOIN notes n ON n.id=e.target_id
      WHERE e.id=? AND e.user_id=? AND e.verb='note.deleted' AND json_extract(e.payload_json,'$.request_hash')=?
      AND n.id=? AND n.user_id=? AND n.deleted_at=e.created_at AND n.content_hash=?)`;
    const gate = [receiptId,principal.userId,requestHash,id,principal.userId,guard.content_hash];
    const results = await this.db.batch([
      this.db.prepare(`UPDATE notes AS n SET deleted_at=?,updated_at=?
        WHERE n.id=? AND n.user_id=? AND n.deleted_at IS NULL AND ${current.sql}
        n.content_hash=? AND n.scope=? AND COALESCE(n.shared,0)=? AND n.updated_at=?
        AND n.archived_at IS NULL AND n.kind!='block' AND n.pinned_block_label IS NULL AND n.supersedes IS NULL
        AND (SELECT count(*) FROM memory_provenance pv WHERE pv.memory_kind='note' AND pv.memory_id=n.id)=?
        AND NOT EXISTS (SELECT 1 FROM events WHERE id=?)`)
        .bind(ts,ts,id,principal.userId,...current.args(ts),guard.content_hash,guard.scope,guard.shared?1:0,guard.updated_at,guard.provenance_count,receiptId),
      // changes() refers to the immediately preceding guarded UPDATE. There is
      // deliberately no intervening DML: a same-millisecond concurrent request
      // must never manufacture a successful receipt from a matching timestamp.
      this.db.prepare(`INSERT INTO events(id,user_id,actor,actor_ref,verb,target_kind,target_id,reason,summary,payload_json,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? FROM notes n WHERE changes()=1 AND n.id=? AND n.user_id=? AND n.deleted_at=?`)
        .bind(receiptId,principal.userId,principal.actor,principal.viaKeyPrefix??principal.handle,'note.deleted','note',id,provenance.rationale,note.title,payload,ts,id,principal.userId,ts),
      ...provenanceStatements,
      this.db.prepare(`DELETE FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?) AND ${committed}`).bind(id,...gate),
      this.db.prepare(`DELETE FROM links WHERE src_note_id=? AND ${committed}`).bind(id,...gate),
      this.db.prepare(`UPDATE links SET target_note_id=NULL,resolved=0 WHERE target_note_id=? AND ${committed}`).bind(id,...gate),
    ]);
    if (!results[0].meta.changes) return replay(await this.retractionStatus(principal,id,operationId));
    return { deleted:true,id,slug:note.slug,retraction_id:operationId,provenance_stored:true,replayed:false,current_deleted:true };
  }

  /** #119 cold tier: archive a note. Unlike softDelete this does NOT touch
   * deleted_at, the FTS index or links — the note stays fully
   * findable via notes_search / FTS; it only drops out of recall candidate
   * generation (recall queries add `archived_at IS NULL`). Reversible (unArchive).
   * Exposed directly as notes_archive / POST /notes/:id/archive (curator removed). */
  async setArchived(principal: Principal, id: string, guard?: { contentHash: string; scope: string; privateOnly: boolean }): Promise<boolean> {
    const note = await this.getRowById(id);
    // kind='block': core-memory blocks are outside the cold tier (always injected
    // into recall by label, never via candidate generation), so archiving one
    // would be a misleading no-op success — refuse instead.
    if (!note || note.user_id !== principal.userId || note.deleted_at || note.archived_at || note.kind === "block") return false;
    // The `archived_at IS NULL` guard makes the check-then-act race benign: two
    // concurrent archives -> one UPDATE wins, the loser writes no event.
    const res = await this.db.prepare(`UPDATE notes SET archived_at=? WHERE id=? AND archived_at IS NULL AND user_id=? AND deleted_at IS NULL ${guard ? 'AND content_hash=? AND scope=?' + (guard.privateOnly ? ' AND COALESCE(shared,0)=0' : '') : ''}`).bind(now(), id, principal.userId, ...(guard ? [guard.contentHash, guard.scope] : [])).run();
    if (!res.meta.changes) return false;
    await this.event(principal.userId, principal, "note.archived", id, note.title);
    return true;
  }

  /** Reverse setArchived — clears archived_at so the note re-enters recall. */
  async unArchive(principal: Principal, id: string): Promise<boolean> {
    const note = await this.getRowById(id);
    if (!note || note.user_id !== principal.userId || note.deleted_at || !note.archived_at) return false;
    await this.db.prepare("UPDATE notes SET archived_at=NULL WHERE id=?").bind(id).run();
    await this.event(principal.userId, principal, "note.unarchived", id, note.title);
    return true;
  }

  /** Rename a note's slug (fidelity C5). Moves the row IN PLACE — the note id is
   * stable, so resolved wikilinks/backlinks (keyed by links.target_note_id)
   * survive untouched — and writes a slug_redirects row so the old URL keeps
   * resolving (301). Never clobbers a live note already at newSlug. */
  async rename(principal: Principal, oldSlugRaw: string, newSlugRaw: string): Promise<{ ok: true; note: NoteRow } | { ok: false; reason: string }> {
    const oldSlug = slugifyPath(oldSlugRaw);
    const newSlug = slugifyPath(newSlugRaw);
    if (!newSlug) return { ok: false, reason: "invalid slug" };
    const note = await this.getRowBySlug(principal.userId, oldSlug);
    if (!note || note.deleted_at) return { ok: false, reason: "no such note" };
    if (newSlug === note.slug) return { ok: false, reason: "same slug" };
    // Any row occupying newSlug blocks the rename — INCLUDING a soft-deleted one:
    // notes' UNIQUE(user_id, slug) covers soft-deleted rows, and (unlike upsert)
    // rename can't resurrect it in place (the renamed note has a different id), so
    // the UPDATE would otherwise throw a raw UNIQUE-constraint 500.
    const clash = await this.getRowBySlug(principal.userId, newSlug);
    if (clash) return { ok: false, reason: "slug taken" };
    const ts = now();
    await this.db.prepare("UPDATE notes SET slug=?, updated_at=? WHERE id=?").bind(newSlug, ts, note.id).run();
    // A live note now occupies newSlug: drop any stale redirect keyed on it so we
    // never 301 away from a real note (or form a loop).
    await this.db.prepare("DELETE FROM slug_redirects WHERE user_id=? AND old_slug=?").bind(principal.userId, newSlug).run();
    // Record oldSlug -> this note (by id, so a rename chain A->B->C resolves in one
    // hop via the target note's CURRENT slug). Upsert in case oldSlug had a prior
    // redirect (e.g. it was itself a rename target earlier).
    await this.db
      .prepare(
        `INSERT INTO slug_redirects (id,user_id,old_slug,new_note_id,created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(user_id,old_slug) DO UPDATE SET new_note_id=excluded.new_note_id, created_at=excluded.created_at`,
      )
      .bind(ulid(), principal.userId, oldSlug, note.id, ts)
      .run();
    await this.event(principal.userId, principal, "note.renamed", note.id, note.title, { from: oldSlug, to: newSlug });
    const renamed = await this.getRowById(note.id);
    return renamed ? { ok: true, note: renamed } : { ok: false, reason: "rename failed" };
  }

  /** Resolve a slug_redirects entry to its target NOTE (fidelity C5). Returns null
   * when there is no redirect, or the target note is gone/soft-deleted. new_note_id
   * references the note (not a slug), so a rename chain collapses to a single hop.
   * Returns the ROW (not just the slug) so the caller can apply the SAME ownership
   * gate as a direct read before 301ing — otherwise the redirect would leak a
   * private note's existence + current slug to viewers who can't read it. */
  async redirectTarget(userId: string, oldSlugRaw: string): Promise<NoteRow | null> {
    const oldSlug = slugifyPath(oldSlugRaw);
    const row = await this.db.prepare("SELECT new_note_id FROM slug_redirects WHERE user_id=? AND old_slug=?").bind(userId, oldSlug).first<{ new_note_id: string }>();
    if (!row) return null;
    const note = await this.getRowById(row.new_note_id);
    if (!note || note.deleted_at) return null;
    return note;
  }

  async tagsFor(noteId: string, viewerId: string): Promise<string[]> {
    const access = readableSqlFor("n", viewerId);
    const res = await this.db
      .prepare(`SELECT t.name AS name FROM note_tags nt JOIN tags t ON t.id=nt.tag_id
        JOIN notes n ON n.id=nt.note_id WHERE nt.note_id=? AND n.deleted_at IS NULL AND ${access.sql} ORDER BY t.name`)
      .bind(noteId, ...access.args)
      .all<{ name: string }>();
    return (res.results ?? []).map((r) => r.name);
  }

  // これら3つ(backlinks / outgoing / backlinksBySlug)は閲覧者を束縛する。
  //
  // 2026-08-21: `kind != 'block'` も要る。core-memory ブロックにも [[wikilink]] の
  // リンク行は作られる(upsert は kind を問わずリンクを更新する)ので、
  // 条件が無いとブロックの slug と title がバックリンク一覧に出る。一覧と検索は
  // ブロックを除くのに、ここだけが露出口になっていた。
  async backlinks(noteId: string, viewerId: string): Promise<NoteSummary[]> {
    const vis = readableSqlFor("n", viewerId);
    const access = vis.sql;
    const anon = vis.args.length === 0;
    const args: unknown[] = [noteId, ...vis.args];
    const res = await this.db
      .prepare(
        `SELECT DISTINCT n.id AS id, n.slug AS slug, n.title AS title,
           n.kind AS kind, n.updated_at AS updated_at, n.created_at AS created_at
         FROM links l JOIN notes n ON n.id=l.src_note_id
         WHERE l.target_note_id=? AND n.deleted_at IS NULL AND n.kind != 'block' AND (${access})
         ORDER BY n.updated_at DESC`,
      )
      .bind(...args)
      .all<Omit<NoteSummary, "tags">>();
    return (res.results ?? []).map((r) => ({ ...r, tags: [] }));
  }

  async outgoing(noteId: string, viewerId: string): Promise<OutgoingLink[]> {
    const target = readableSqlFor("n", viewerId);
    const source = readableSqlFor("src", viewerId);
    const res = await this.db
      .prepare(
        `SELECT l.target_slug AS target_slug, n.id AS target_note_id, l.anchor_text AS anchor_text,
           CASE WHEN n.id IS NULL THEN 0 ELSE 1 END AS resolved, l.position AS position, n.title AS target_title
         FROM links l JOIN notes src ON src.id=l.src_note_id
         LEFT JOIN notes n ON n.id=l.target_note_id AND n.deleted_at IS NULL AND ${target.sql}
         WHERE l.src_note_id=? AND src.deleted_at IS NULL AND ${source.sql} ORDER BY l.position`,
      )
      .bind(...target.args, noteId, ...source.args)
      .all<OutgoingLink>();
    return res.results ?? [];
  }

  /** Inbound links to a slug, including dangling ones from notes that reference a
   * not-yet-written target (the "what to write next" signal). Owner-only. */
  async backlinksBySlug(slug: string, viewerId: string): Promise<NoteSummary[]> {
    const vis = readableSqlFor("n", viewerId);
    const access = vis.sql;
    const anon = vis.args.length === 0;
    const args: unknown[] = [slug, ...vis.args];
    const res = await this.db
      .prepare(
        `SELECT DISTINCT n.id AS id, n.slug AS slug, n.title AS title,
           n.kind AS kind, n.updated_at AS updated_at, n.created_at AS created_at
         FROM links l JOIN notes n ON n.id=l.src_note_id
         WHERE l.target_slug=? AND n.deleted_at IS NULL AND n.kind != 'block' AND (${access})
         ORDER BY n.updated_at DESC`,
      )
      .bind(...args)
      .all<Omit<NoteSummary, "tags">>();
    return (res.results ?? []).map((r) => ({ ...r, tags: [] }));
  }

  async list(
    principal: Principal,
    opts: { tag?: string; limit?: number; ownerId: string } ,
  ): Promise<NoteSummary[]> {
    const limit = clampLimit(opts.limit, 50);
    const visList = readableSql("n", principal);
    const args: unknown[] = [opts.ownerId, ...visList.args];
    let join = "";
    // その庭の主が書いた行のうち、閲覧者が読んでよいもの。個人ノートなら主 == 閲覧者の
    // ときだけ、共有ノートなら招待されていれば誰にでも。
    let where = `n.user_id=? AND n.deleted_at IS NULL AND ${visList.sql} AND n.kind != 'block'`;
    if (opts.tag) {
      join = "JOIN note_tags nt ON nt.note_id=n.id JOIN tags t ON t.id=nt.tag_id";
      where += " AND t.slug=?";
      args.push(slugify(opts.tag));
    }
    args.push(limit);
    const res = await this.db
      .prepare(
        `SELECT n.id AS id, n.slug AS slug, n.title AS title,
           n.kind AS kind, n.stage AS stage, n.scope AS scope, n.updated_at AS updated_at, n.created_at AS created_at
         FROM notes n ${join} WHERE ${where} ORDER BY n.updated_at DESC LIMIT ?`,
      )
      .bind(...args)
      .all<Omit<NoteSummary, "tags">>();
    return (res.results ?? []).map((r) => ({ ...r, tags: [] }));
  }

  /** Path A (discovery) listing of the caller's own notes (plus the public
   * garden for anonymous). #117: when `context` is set, narrow to that project
   * scope OR 'global'. */
  async listMine(principal: Principal, opts: { tag?: string; limit?: number; context?: string | string[] | null; excludeArchived?: boolean }): Promise<NoteSummary[]> {
    const limit = clampLimit(opts.limit, 50);
    const args: unknown[] = [];

    const visSearch = readableSql("n", principal);
    const access = visSearch.sql;
    args.push(...visSearch.args);
    // #117 の絞り込み。条件の組み立ては context.ts の scopeClause 1箇所に寄せてある
    // —— 以前はここで生の opts.context をそのまま束縛しており、search 側だけが
    // 正規化していたので、同じ値でも経路によって当たったり当たらなかったりした。
    const sc = principal.anonymous ? { sql: "", args: [] } : scopeClause("n", normalizeScopes(opts.context));
    const scopeClauseSql = sc.sql;
    args.push(...sc.args);
    // #119: recall passes excludeArchived; a plain notes_list listing does NOT
    // (archived notes stay visible in listings/search — cold tier ≠ deleted).
    const archivedClause = opts.excludeArchived ? " AND n.archived_at IS NULL" : "";
    // decision 10: recall also drops superseded / not-yet-or-no-longer-valid notes.
    // Gated on the SAME excludeArchived flag so a plain listing keeps showing them
    // (history). Two positional `?` bound to now, placed before the tag/limit args.
    const validityClause = opts.excludeArchived
      ? " AND NOT EXISTS (SELECT 1 FROM notes sup WHERE sup.supersedes = n.id AND sup.deleted_at IS NULL) AND (n.valid_from IS NULL OR n.valid_from <= ?) AND (n.valid_until IS NULL OR n.valid_until > ?)"
      : "";
    if (opts.excludeArchived) {
      const nowMs = now();
      args.push(nowMs, nowMs);
    }

    let join = "";
    let tagClause = "";
    if (opts.tag) {
      join = "JOIN note_tags nt ON nt.note_id=n.id JOIN tags t ON t.id=nt.tag_id";
      tagClause = " AND t.slug=?";
      args.push(slugify(opts.tag));
    }
    args.push(limit);

    const sql = `SELECT n.id,n.user_id,n.slug,n.title,n.kind,n.updated_at,n.created_at
                 FROM notes n ${join}
                 WHERE n.deleted_at IS NULL AND n.kind != 'block' AND (${access})${scopeClauseSql}${archivedClause}${validityClause}${tagClause}
                 ORDER BY n.updated_at DESC LIMIT ?`;
    const res = await this.db.prepare(sql).bind(...args).all<Omit<NoteSummary, "tags">>();
    return (res.results ?? []).map((r) => ({ ...r, tags: [] }));
  }

  async changes(
    ownerId: string,
    principal: Principal,
    limit = 30,
  ): Promise<Array<{ verb: string; created_at: number; title: string; slug: string | null; op: string; hash: string }>> {
    const res = await this.db
      .prepare(
        `SELECT e.verb AS verb, e.created_at AS created_at, COALESCE(n.title, e.summary) AS title, n.slug AS slug, e.payload_json AS payload
         FROM events e LEFT JOIN notes n ON n.id=e.target_id
         WHERE e.user_id=? AND e.verb IN ('note.created','note.updated','note.deleted')
           AND (n.id IS NULL OR (n.deleted_at IS NULL AND n.user_id=?))
           AND (n.id IS NULL OR n.kind != 'block')
         ORDER BY e.created_at DESC LIMIT ?`,
      )
      .bind(ownerId, principal.userId, limit)
      .all<{ verb: string; created_at: number; title: string; slug: string | null; payload: string }>();
    return (res.results ?? []).map((r) => {
      let op = r.verb === "note.created" ? "create" : r.verb === "note.deleted" ? "delete" : "replace";
      let hash = "";
      try {
        const p = JSON.parse(r.payload || "{}") as { op?: string; content_hash?: string };
        if (p.op) op = p.op;
        if (p.content_hash) hash = String(p.content_hash).slice(0, 12);
      } catch {
        // payload optional
      }
      return { verb: r.verb, created_at: r.created_at, title: r.title, slug: r.slug, op, hash };
    });
  }

  async incrementView(id: string): Promise<void> {
    // #119: stamp last_viewed_at alongside view_count so auto-demote keys off real
    // USE (delivery), not updated_at (last edit) — a frequently-recalled but rarely
    // edited evergreen must not read as "stale". Deliberately NOT updated_at, so a
    // view never looks like an edit (revisions/changes stay edit-only).
    await this.db.prepare("UPDATE notes SET view_count = view_count + 1, last_viewed_at = ? WHERE id=?").bind(now(), id).run();
  }

  /** Recall counts only the exact note IDs delivered by packContext. One UPDATE
   * per bounded chunk avoids a remote D1 write per preview on the hook path.
   * Recheck current access/scope/lifecycle at the write, without editing content
   * or updated_at. Duplicate IDs in a pack must still count exactly once. */
  async incrementRecallViews(principal: Principal, ids: string[], context: string[] = []): Promise<void> {
    if (principal.anonymous || !ids.length) return;
    const selected = [...new Set(ids)], timestamp = now();
    const vis = readableSql('n', principal), scope = scopeClause('n', context), validity = validityClause('note', true);
    const args = [timestamp, ...validity.args(timestamp), ...vis.args, ...scope.args];
    const cap = Math.max(1, 90 - args.length);
    for (let i = 0; i < selected.length; i += cap) {
      const chunk = selected.slice(i, i + cap);
      await this.db.prepare(`UPDATE notes AS n SET view_count = view_count + 1, last_viewed_at = ?
        WHERE n.deleted_at IS NULL AND n.kind!='block' AND n.archived_at IS NULL AND
        ${validity.sql}${vis.sql}${scope.sql} AND n.id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...args, ...chunk).run();
    }
  }

  /** Ranking surface: score = resolved-backlinks*3 + views, recency as tiebreak. */
  async ranking(ownerId: string, principal: Principal, limit = 30): Promise<Array<{ slug: string; title: string; inlinks: number; views: number; score: number }>> {
    // 2026-08-22: user_id を二重に束縛していた。結果は正しいが、共有ノートが
    // ランキングに出ない。inlinks の数え上げ側も同じで、共有ノートからの参照が
    // 数に入らず順位が実態とずれる。
    const vis = readableSql("n", principal);
    const inVis = readableSql("src", principal);
    const args: unknown[] = [...inVis.args, ownerId, ...vis.args, limit];
    const res = await this.db
      .prepare(
        `SELECT n.slug AS slug, n.title AS title, n.view_count AS views,
           (SELECT COUNT(DISTINCT l.src_note_id) FROM links l JOIN notes src ON src.id = l.src_note_id WHERE l.target_note_id = n.id AND l.resolved = 1 AND src.deleted_at IS NULL AND src.kind != 'block' AND ${inVis.sql}) AS inlinks
         FROM notes n
         WHERE n.user_id=? AND n.deleted_at IS NULL AND ${vis.sql} AND n.kind != 'block'
         ORDER BY (inlinks*3 + n.view_count) DESC, n.updated_at DESC
         LIMIT ?`,
      )
      .bind(...args)
      .all<{ slug: string; title: string; views: number; inlinks: number }>();
    return (res.results ?? []).map((r) => ({ ...r, score: r.inlinks * 3 + r.views }));
  }

  // ambient "surface": the caller's evergreen notes, excluding ones already in
  // hand. #117: when `context` is set, narrow to that project scope OR 'global'
  // (so cross-project evergreen wisdom left at 'global' still surfaces).
  async byStage(principal: Principal, stage: string, limit: number, exclude: Set<string> = new Set(), context: string | string[] | null = null): Promise<NoteSummary[]> {
    const visStage = readableSql("", principal);
    const access = visStage.sql;
    const args: unknown[] = [stage, ...visStage.args];
    const sc = principal.anonymous ? { sql: "", args: [] } : scopeClause("", normalizeScopes(context));
    const scopeClauseSql = sc.sql;
    args.push(...sc.args);
    // decision 10: the ambient surface feeds recall only, so (like archived) it also
    // excludes superseded / out-of-validity-window notes. Two `?` bound to now.
    const nowMs = now();
    args.push(nowMs, nowMs);
    args.push(limit + exclude.size);

    const res = await this.db
      .prepare(
        // #119: ambient surface feeds recall, so archived notes are excluded.
        // decision 10: …and so are superseded / not-currently-valid notes.
        `SELECT id, slug, title, kind, updated_at, created_at FROM notes
         WHERE deleted_at IS NULL AND archived_at IS NULL AND kind != 'block' AND stage = ? AND (${access})${scopeClauseSql}
           AND NOT EXISTS (SELECT 1 FROM notes sup WHERE sup.supersedes = notes.id AND sup.deleted_at IS NULL) AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(...args)
      .all<Omit<NoteSummary, "tags">>();
    return (res.results ?? []).filter((r) => !exclude.has(r.slug)).slice(0, limit).map((r) => ({ ...r, tags: [] }));
  }

}
