// LogService: the kept conversation (design B, 2026-10-31) in the separate
// `cf-memory-logs` D1 database (binding LOGS, migrations in migrations-logs/).
//
// What is kept: the user's prompt, the agent's final reply of a turn, one line
// per tool action, and the head of a failed action's output. Agents find it
// again by keyword (the same trigram FTS + ftsQuery tokenizer as notes) and
// read the neighbouring turns of a hit. Nothing is summarized or embedded.
//
// Every row belongs to the authenticated caller (`user_id` = principal). There
// is no sharing: every read binds user_id, and nothing here accepts a user id.

import { scrubEntryText } from '../cf-memory-agent/scripts/redact.mjs';
import { logSlowRead } from './read-timing';
import { lexicalTokens } from './search';
import type { Env, Principal } from './types';

export const LOG_KINDS = ['prompt', 'reply', 'action', 'error'] as const;
export type LogKind = typeof LOG_KINDS[number];
export const LOG_CLIENTS = ['claude-code', 'codex'] as const;
export type LogClient = typeof LOG_CLIENTS[number];
/** Per-entry text limits, in JavaScript string length (UTF-16 code units). */
export const LOG_TEXT_LIMITS: Record<LogKind, number> = { prompt: 65536, reply: 65536, action: 400, error: 2048 };
/** Appended to any text that was cut to its limit (the marker counts toward it). */
export const CUT_MARK = '…（以下省略）';
export const DEFAULT_ACTION_RETENTION_DAYS = 90;
export const DAILY_ROW_RETENTION_DAYS = 120;
export const MAX_APPEND_ENTRIES = 50;
const MAX_FUTURE_MS = 3600000;
const DAY_MS = 86400000;
const JST_MS = 9 * 3600000;
/** log_read returns at most this many chars of each text (text_offset pages the anchor). */
export const READ_TEXT_CHARS = 8000;
const HANDOFF_TEXT_CHARS = 4000;
const SESSION_SNIPPET_CHARS = 300;
const SEARCH_SNIPPET_CHARS = 240;
const SEARCH_QUERY_CHARS = 2000;
/** log_search sends at most this many distinct 3+ character words to MATCH. */
export const MAX_FTS_TERMS = 12;
/** At most this many 1–2 character words (LIKE fallback) or ranking words (boost). */
const MAX_LIKE_TERMS = 8;
/** The boost re-ranks this many best keyword hits by the literal words they contain. */
const BOOST_CANDIDATES = 200;
/** The LIKE fallback looks at most at this many newest actions and errors of the range. */
export const LIKE_SCAN_ROWS = 10000;
/** ... and, apart from them, at this many newest prompts and replies (kept
 * forever, but far fewer: about 4,000 in the first months). */
export const CONVERSATION_SCAN_ROWS = 50000;
/** Without `kind`, this share of a search's hits is kept for the best actions and errors. */
const WORK_SHARE = 0.3;
/** A reply hit's `question` (the prompt it answered) is at most this long. */
const QUESTION_CHARS = 200;

/** Without `kind`: prompts and replies first, then actions and errors, keeping
 * WORK_SHARE of `limit` for the latter when there are enough of both. */
function mixKinds<T>(conversation: T[], work: T[], limit: number): T[] {
  const kept = conversation.slice(0, limit - Math.min(work.length, Math.floor(limit * WORK_SHARE)));
  return [...kept, ...work.slice(0, limit - kept.length)];
}
/** log_sessions discovers sessions among this many newest entries. */
export const SESSION_SCAN_ROWS = 20000;
/** session_context's handoff looks at most at this many newest entries of the repo. */
export const HANDOFF_SCAN_ROWS = 5000;
const APPEND_ATTEMPTS = 12;
/** C0 controls except tab, LF and CR (and DEL): dropped from stored texts and queries. */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** scrubEntryText replaces any longer input whole. */
const SCRUB_MAX_CHARS = 1024 * 1024;

/** Invalid tool input. The message names the offending field. */
export class LogInputError extends Error {}
/** The LOGS binding is absent (the database has not been created/bound yet). */
export class LogsUnavailableError extends Error {
  constructor() { super('logs database is not configured on this server (LOGS binding missing)'); }
}
class AppendRace extends Error {}

export interface LogSettings {
  /** Stored `action` bytes allowed per user per UTC day; null (the default since
   * 2026-11-05) is no limit. 0 drops every action. */
  dailyActionBytes: number | null;
  /** Stored bytes of ALL kinds allowed per user per UTC day; null or absent is no limit. 0 drops everything. */
  dailyTotalBytes?: number | null;
  /** Days `action` and `error` rows are kept by scheduled(). */
  actionRetentionDays: number;
  /** Row budgets of the LIKE fallback and log_sessions (tests shrink them). */
  likeScanRows?: number;
  conversationScanRows?: number;
  sessionScanRows?: number;
}

function intSetting(raw: string | undefined, fallback: number, min: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

/** A daily byte cap: a non-negative whole number, else (unset, empty, invalid) no limit. */
function capSetting(raw: string | undefined): number | null {
  const n = intSetting(raw, -1, 0);
  return n >= 0 ? n : null;
}

/** The daily caps are off unless LOG_DAILY_ACTION_BYTES / LOG_DAILY_TOTAL_BYTES
 * are set (the owner removed them on 2026-11-05; D1's 10 GB is watched through
 * server_status.logs.size_bytes instead). */
export function logSettings(env?: Partial<Pick<Env, 'LOG_DAILY_ACTION_BYTES' | 'LOG_DAILY_TOTAL_BYTES' | 'LOG_ACTION_RETENTION_DAYS'>>): LogSettings {
  return {
    dailyActionBytes: capSetting(env?.LOG_DAILY_ACTION_BYTES),
    dailyTotalBytes: capSetting(env?.LOG_DAILY_TOTAL_BYTES),
    actionRetentionDays: intSetting(env?.LOG_ACTION_RETENTION_DAYS, DEFAULT_ACTION_RETENTION_DAYS, 1),
  };
}

// ---------------------------------------------------------------- pure helpers

/** Cut `text` to `limit` chars, ending with CUT_MARK. Never splits a surrogate
 * pair. `force` makes it end with the marker even when it already fits (unless
 * it already does) — used when the input was cut but scrubbing shortened it or
 * rewrote its marker. */
export function cutText(text: string, limit: number, force = false): { text: string; cut: boolean } {
  if (text.length <= limit && (!force || text.endsWith(CUT_MARK))) return { text, cut: false };
  let head = text.slice(0, Math.max(0, limit - CUT_MARK.length));
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return { text: head + CUT_MARK, cut: true };
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number { return encoder.encode(text).byteLength; }

/** `2026-10-28 23:46 JST` for an epoch-ms time. */
export function jstTime(ts: number): string {
  const d = new Date(ts + 9 * 3600000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`;
}

/** UTC calendar day `YYYY-MM-DD` (the log_daily key). */
export function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function flat(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

/** Move an index off the low half of a surrogate pair. */
function boundary(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return i > 0 && c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

/** A whitespace-flattened leading preview of at most `max` chars. */
function preview(text: string | null, max = SESSION_SNIPPET_CHARS): string | null {
  if (text == null) return null;
  const f = flat(text);
  return f.length > max ? f.slice(0, boundary(f, max - 1)) + '…' : f;
}

/** Occurrences of each snippet term that are tried as window anchors. */
const SNIPPET_OCCURRENCES = 20;

/** A window of about `max` chars where the query words meet: of the windows
 * placed around each occurrence (a third of it before), the one holding the
 * most distinct terms, a term weighing its length up to 8 characters (a 1–2
 * character word such as 日 occurs everywhere and anchors poorly); the
 * earliest on a tie. The head when no term occurs. */
export function snippetAround(text: string, terms: string[], max = SEARCH_SNIPPET_CHARS): string {
  const f = flat(text);
  if (f.length <= max) return f;
  const lower = f.toLowerCase();
  const words = [...new Set(terms.filter(Boolean).map(t => t.toLowerCase()))];
  const found: Array<{ at: number; word: number; len: number }> = [];
  words.forEach((w, word) => {
    for (let i = lower.indexOf(w), n = 0; i >= 0 && n < SNIPPET_OCCURRENCES; i = lower.indexOf(w, i + 1), n++) found.push({ at: i, word, len: w.length });
  });
  const place = (at: number) => Math.max(0, Math.min(at - Math.floor(max / 3), f.length - max));
  let best = -1, bestScore = 0;
  for (const anchor of found) {
    const from = place(anchor.at), seen = new Set<number>();
    let score = 0;
    for (const o of found) if (o.at >= from && o.at + o.len <= from + max && !seen.has(o.word)) { seen.add(o.word); score += Math.min(chars(words[o.word]), 8); }
    if (score > bestScore || score === bestScore && best >= 0 && from < best) { best = from; bestScore = score; }
  }
  const start = boundary(f, best < 0 ? 0 : best);
  const end = boundary(f, Math.min(f.length, start + max));
  return (start > 0 ? '…' : '') + f.slice(start, end) + (end < f.length ? '…' : '');
}

// ------------------------------------------------------------------ validation

function fail(message: string): never { throw new LogInputError(message); }

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unknown field '${key}' (allowed: ${allowed.join(', ')})`);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function shortString(value: unknown, field: string, max: number, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (!opts.allowEmpty && !value.trim()) fail(`${field} must not be empty`);
  if (value.length > max) fail(`${field} must be at most ${max} characters`);
  if (CONTROL.test(value)) fail(`${field} must not contain control characters`);
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(`${field} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

const JST_TIME = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?(?:\s*JST)?$/i;
/** A time with an explicit zone, which Date.parse reads without guessing the runtime's local zone. */
const ZONED = /\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i;

/** Epoch ms (number or all-digit string), a date/time with an explicit zone
 * (`Z`, `+09:00`, GMT), or a JST wall time: `2026-10-28`, `2026/10/28`,
 * `2026.10.28 9:05`, `2026-10-28 23:46` or the hits' own `2026-10-28 23:46 JST`.
 * A date without a time is 00:00 JST of that day, or with `endOfDay` (until)
 * the end of that JST day. Anything else (no zone, `10/28`) is rejected rather
 * than read in the Worker's UTC. */
function timeArg(value: unknown, field: string, endOfDay = false): number {
  let n = typeof value === 'number' ? value : NaN;
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    let m = JST_TIME.exec(s);
    const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (ymd) m = JST_TIME.exec(`${ymd[1]}-${ymd[2]}-${ymd[3]}`);
    else if (/^\d+$/.test(s)) n = Number(s);
    // The 4-digit year must be outside the zone suffix (+0900 is no year; V8 would fill in 2001).
    if (!m && !/^\d+$/.test(s)) n = ZONED.test(s) && /(?:^|\D)\d{4}(?:\D|$)/.test(s.replace(/\s*(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i, '')) ? Date.parse(s) : NaN;
    if (m) {
      const [y, mo, d, h, mi, sec] = [m[1], m[3], m[4], m[5], m[6], m[7]].map(v => Number(v ?? 0));
      const t = Date.UTC(y, mo - 1, d, h, mi, sec) + Number((m[8] ?? '').padEnd(3, '0')), back = new Date(t);
      // Reject what Date.UTC would roll over (2026-02-30, 24:00).
      if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === sec)
        n = t - JST_MS + (m[5] === undefined && endOfDay ? DAY_MS : 0);
    }
  }
  // Epoch seconds (1761650000) or an 8-digit number (20261028) would land in 1970: no log is that old.
  if (n > 0 && n < 1e11) n = NaN;
  if (!Number.isFinite(n) || n < 0 || n > 8640000000000000) fail(`${field} must be an ISO date/time, a JST time like "2026-10-28 23:46 JST", or epoch milliseconds`);
  return Math.floor(n);
}

function limitArg(value: unknown, field: string, fallback: number, max: number, min = 1): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be a number`);
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export interface LogEntryInput {
  id: string; session_id: string; client: LogClient; repo: string; ts: number; kind: LogKind; text: string; bytes: number;
  /** The client's ts was more than 1 hour ahead and was replaced by the receipt time. */
  clamped: boolean;
}

const ENTRY_FIELDS = ['id', 'session_id', 'client', 'repo', 'ts', 'kind', 'text'] as const;

/** Validate one log_append entry. The full text is scrubbed again with the
 * Agent's log scrubber (defence in depth; the client already scrubbed it) and
 * then cut to its kind's limit. A ts more than 1 hour ahead (a fast client
 * clock) is replaced by the receipt time rather than rejected. */
export function parseEntry(raw: unknown, index: number, nowMs: number): LogEntryInput {
  const where = `entries[${index}]`;
  const e = object(raw, where);
  onlyKeys(e, ENTRY_FIELDS, where);
  if (typeof e.id !== 'string' || !/^[0-9a-f]{64}$/.test(e.id)) fail(`${where}.id must be 64 lowercase hex characters (a sha256 digest)`);
  const session_id = shortString(e.session_id, `${where}.session_id`, 128);
  const client = oneOf(e.client, `${where}.client`, LOG_CLIENTS);
  const repo = e.repo === undefined ? '' : shortString(e.repo, `${where}.repo`, 200, { allowEmpty: true });
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts < 0) fail(`${where}.ts must be a finite epoch-millisecond number`);
  const clamped = e.ts > nowMs + MAX_FUTURE_MS;
  const kind = oneOf(e.kind, `${where}.kind`, LOG_KINDS);
  if (typeof e.text !== 'string') fail(`${where}.text must be a string`);
  const limit = LOG_TEXT_LIMITS[kind];
  // NUL and other C0 controls (binary output in an error head) would hide the
  // rest of the text from LIKE, length() and substr(); tab and newlines stay.
  const body = e.text.replace(TEXT_CONTROL, '');
  // Scrub, then cut. Only the head up to twice the limit is scrubbed (the
  // scrubber wipes anything over 1 MiB whole): a secret split at that window's
  // end lies past the limit and is cut away. If scrubbing shrank the window so
  // much that its end could be kept, a longer head (still under 1 MiB) is
  // scrubbed instead.
  const head = body.length > 2 * limit ? body.slice(0, 2 * limit) : body;
  let scrubbed = scrubEntryText(head);
  if (head !== body && scrubbed.length < limit + (limit >> 1)) scrubbed = scrubEntryText(body.slice(0, SCRUB_MAX_CHARS));
  // Input that was cut (longer than the limit, or already ending with the
  // Agent's marker) always ends with the marker, even when scrubbing shortened
  // it or rewrote a clipped redaction marker together with the cut marker.
  const text = cutText(scrubbed, limit, body.length > limit || body.endsWith(CUT_MARK)).text;
  return { id: e.id, session_id, client, repo, ts: clamped ? nowMs : Math.floor(e.ts), kind, text, bytes: utf8Bytes(text), clamped };
}

// ---------------------------------------------------------------------- shapes

interface LogRow {
  rowid: number; id: string; session_id: string; client: string; repo: string; ts: number; kind: string; text: string;
}
const COLUMNS = 'e.rowid AS rowid, e.id, e.session_id, e.client, e.repo, e.ts, e.kind, e.text';

export interface AppendResult {
  stored: number; duplicates: number; dropped_over_cap: number; dropped_over_total_cap: number; ts_clamped: number;
}
export interface ScanLimited { entries: number; until: number; time: string; kinds: string[] }
export interface LogHit { id: string; ts: number; time: string; client: string; repo: string; kind: string; session_id: string; snippet: string; question?: string }
export interface LogSession { session_id: string; client: string; repo: string; first_time: string; last_time: string; first_prompt: string | null; last_reply: string | null }
export interface LogHandoff { session_id: string; time: string; text: string }

function escapeLike(s: string): string { return s.replace(/[%_\\]/g, '\\$&'); }
const likePattern = (s: string) => '%' + escapeLike(s) + '%';
/** A substring test with no pattern-length limit (D1 refuses LIKE patterns over 50 bytes:
 * a path, a URL or a long repo would fail the whole call). SQLite lower() folds ASCII
 * only, like LIKE, so full-width and other non-ASCII text must match exactly. */
const contains = (column: string) => `instr(lower(${column}), lower(?)) > 0`;

/** Quotes, brackets and sentence punctuation around a word (`"db.ts",` → `db.ts`); a leading dot stays (`.env`). */
const WRAPPING = /^["'`(\[{<「『【（]+|["'`)\]}>」』】）.,;:!?、。]+$/gu;
const chars = (s: string) => [...s].length;

export interface LogQuery {
  /** Distinct FTS terms, at most MAX_FTS_TERMS: every 3+ character lexical
   * token (the notes tokenizer) and, for a space-separated word with
   * punctuation (a file name, version or error code), the whole word as one
   * literal trigram phrase. */
  match: string[];
  /** Literal words that rank the best keyword hits containing them first: the
   * punctuated words, then the 1–2 character words (which a trigram index
   * cannot match). */
  boost: string[];
  /** A query of only 1–2 character words: every one must appear (LIKE). */
  like: string[] | null;
  dropped: string[];
}

export function logQuery(query: string): LogQuery {
  const raw = [...new Set(query.split(/\s+/).filter(Boolean))], trimmed = [...new Set(raw.map(w => w.replace(WRAPPING, '')).filter(Boolean))];
  const words = trimmed.length ? trimmed : raw; // a query of only quotes/brackets is searched as written
  const match = new Set<string>(), phrases: string[] = [], short: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase(), tokens = lexicalTokens(word);
    if (chars(word) < 3) { short.push(word); continue; }
    if (!/^[\p{L}\p{N}]+$/u.test(word)) { match.add(lower); phrases.push(word); }
    for (const t of tokens) if (chars(t) >= 3) match.add(t);
  }
  const all = [...match], literal = [...phrases, ...short];
  const boost = literal.slice(0, MAX_LIKE_TERMS);
  const shortDropped = short.filter(w => !boost.includes(w));
  if (!all.length) return { match: [], boost: [], like: short.length ? short.slice(0, MAX_LIKE_TERMS) : null, dropped: short.slice(MAX_LIKE_TERMS) };
  return { match: all.slice(0, MAX_FTS_TERMS), boost, like: null, dropped: [...all.slice(MAX_FTS_TERMS), ...shortDropped] };
}

/** A ≤READ_TEXT_CHARS window of `text` from char `offset`, ending with
 * CUT_MARK when more remains; `next` is the offset of the rest. */
function textWindow(text: string, offset: number): { text: string; start: number; next: number | null } {
  const start = boundary(text, Math.min(offset, text.length));
  if (text.length - start <= READ_TEXT_CHARS) return { text: text.slice(start), start, next: null };
  const end = boundary(text, start + READ_TEXT_CHARS - CUT_MARK.length);
  return { text: text.slice(start, end) + CUT_MARK, start, next: end };
}

// --------------------------------------------------------------------- service

export class LogService {
  constructor(private db: D1Database | null, readonly settings: LogSettings = logSettings(), private clock: () => number = Date.now) {}

  get configured(): boolean { return this.db !== null; }

  private open(p: Principal): D1Database {
    if (p.anonymous) throw new Error('authentication required');
    if (!this.db) throw new LogsUnavailableError();
    return this.db;
  }

  /** log_append: 1–50 entries, idempotent on (user_id, id). When daily caps are
   * set (none by default), actions over the caller's daily action byte cap are
   * dropped (`dropped_over_cap`) and any entry over the daily total byte cap is
   * dropped (`dropped_over_total_cap`); the bytes are counted either way. Both
   * counters are diagnostics: a resent dropped entry is dropped and counted
   * again. `ts_clamped` counts stored entries whose ts was replaced by the
   * receipt time because it was more than 1 hour in the future. */
  async append(p: Principal, args: Record<string, unknown>): Promise<AppendResult> {
    const db = this.open(p);
    onlyKeys(args, ['entries'], 'log_append');
    const raw = args.entries;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_APPEND_ENTRIES) fail(`entries must be an array of 1-${MAX_APPEND_ENTRIES} entries`);
    const nowMs = this.clock();
    const parsed = raw.map((entry, i) => parseEntry(entry, i, nowMs));
    const seen = new Set<string>(), unique: LogEntryInput[] = [];
    let repeated = 0;
    for (const e of parsed) {
      if (seen.has(e.id)) { repeated++; continue; }
      seen.add(e.id); unique.push(e);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.tryAppend(db, p.userId, unique, nowMs);
        return { ...r, duplicates: repeated + r.duplicates };
      } catch (error) {
        if (!(error instanceof AppendRace)) throw error;
        if (attempt >= APPEND_ATTEMPTS) throw new Error('log_append conflicted with concurrent writes; retry the same entries');
        // Small jittered back-off: concurrent hooks of one user usually clear
        // within a few attempts.
        await new Promise(r => setTimeout(r, 1 + Math.floor(Math.random() * 8 * attempt)));
      }
    }
  }

  /** One optimistic attempt. D1 has no interactive transactions, so the batch
   * starts with guard statements that fail (NOT NULL violation → the whole
   * batch rolls back) when another writer changed what this attempt read:
   * one of these ids appeared, or today's byte counters moved. */
  private async tryAppend(db: D1Database, userId: string, entries: LogEntryInput[], nowMs: number): Promise<AppendResult> {
    const day = utcDay(nowMs);
    const actionCap = this.settings.dailyActionBytes ?? Infinity, totalCap = this.settings.dailyTotalBytes ?? Infinity;
    const ids = entries.map(e => e.id);
    const existing = await db.prepare(`SELECT id FROM log_entries WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`)
      .bind(userId, ...ids).all<{ id: string }>();
    const known = new Set(existing.results.map(r => r.id));
    const fresh = entries.filter(e => !known.has(e.id));
    const result: AppendResult = { stored: 0, duplicates: entries.length - fresh.length, dropped_over_cap: 0, dropped_over_total_cap: 0, ts_clamped: 0 };
    if (!fresh.length) return result;
    const daily = await db.prepare('SELECT action_bytes, total_bytes FROM log_daily WHERE user_id=? AND day=?').bind(userId, day)
      .first<{ action_bytes: number; total_bytes: number }>();
    const beforeAction = daily?.action_bytes ?? 0, beforeTotal = daily?.total_bytes ?? 0;
    let action = beforeAction, total = beforeTotal;
    const keep: LogEntryInput[] = [];
    for (const e of fresh) {
      if (e.kind === 'action' && action + e.bytes > actionCap) { result.dropped_over_cap++; continue; }
      if (total + e.bytes > totalCap) { result.dropped_over_total_cap++; continue; }
      if (e.kind === 'action') action += e.bytes;
      total += e.bytes;
      keep.push(e);
    }
    const statements: D1PreparedStatement[] = [];
    if (keep.length) {
      statements.push(db.prepare(`INSERT INTO log_daily (user_id, day) SELECT NULL, NULL WHERE EXISTS (SELECT 1 FROM log_entries WHERE user_id=? AND id IN (${keep.map(() => '?').join(',')}))`)
        .bind(userId, ...keep.map(e => e.id)));
    }
    statements.push(
      db.prepare('INSERT INTO log_daily (user_id, day) VALUES (?, ?) ON CONFLICT (user_id, day) DO NOTHING').bind(userId, day),
      db.prepare('INSERT INTO log_daily (user_id, day) SELECT NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM log_daily WHERE user_id=? AND day=? AND action_bytes=? AND total_bytes=?)')
        .bind(userId, day, beforeAction, beforeTotal),
      db.prepare('UPDATE log_daily SET action_bytes = action_bytes + ?, total_bytes = total_bytes + ?, dropped = dropped + ?, total_dropped = total_dropped + ? WHERE user_id=? AND day=?')
        .bind(action - beforeAction, total - beforeTotal, result.dropped_over_cap, result.dropped_over_total_cap, userId, day),
    );
    for (const e of keep) {
      statements.push(db.prepare('INSERT INTO log_entries (user_id, id, session_id, client, repo, ts, kind, text, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, e.id, e.session_id, e.client, e.repo, e.ts, e.kind, e.text, e.bytes, nowMs));
    }
    try {
      await db.batch(statements);
    } catch (error) {
      if (/NOT NULL constraint failed: log_daily|UNIQUE constraint failed: log_entries/i.test(String(error))) throw new AppendRace();
      throw error;
    }
    result.stored = keep.length;
    result.ts_clamped = keep.filter(e => e.clamped).length;
    return result;
  }

  /** log_search: keyword search over the caller's entries (logQuery): bm25
   * then newest, the best BOOST_CANDIDATES re-ranked first by how many literal
   * boost words they contain. Without `kind`, prompts and replies are ranked
   * apart from actions and errors and come first among hits with as many
   * boost words, WORK_SHARE of the hits kept for the best actions and errors
   * (mixKinds). A query of only 1–2 character
   * words is matched with LIKE kind by kind: among the newest
   * conversationScanRows prompts and as many replies, and the newest
   * likeScanRows actions and as many errors of the range, newest first;
   * `scan_limited` says when older entries of a kind were not looked at. A reply hit carries `question`, the start of the
   * prompt before it in its session. Words not used at all are listed in
   * `query_terms_dropped`. */
  async search(p: Principal, args: Record<string, unknown>): Promise<{ hits: LogHit[]; query_terms_dropped?: string[]; scan_limited?: ScanLimited }> {
    const db = this.open(p);
    onlyKeys(args, ['query', 'since', 'until', 'repo', 'kind', 'client', 'session_id', 'limit'], 'log_search');
    if (typeof args.query !== 'string' || !args.query.trim()) fail('query must be a non-empty string');
    const query = args.query.replace(TEXT_CONTROL, ' ').trim().slice(0, SEARCH_QUERY_CHARS);
    if (!query) fail('query must be a non-empty string');
    // `range` uses an index (log_user_ts / log_user_session); `filter` is checked per row.
    const range = ['e.user_id = ?'], rangeBinds: unknown[] = [p.userId], filter: string[] = [], filterBinds: unknown[] = [];
    const since = args.since == null ? null : timeArg(args.since, 'since');
    const until = args.until == null ? null : timeArg(args.until, 'until', true);
    if (since != null && until != null && since >= until) fail('since must be before until');
    if (since != null) { range.push('e.ts >= ?'); rangeBinds.push(since); }
    if (until != null) { range.push('e.ts < ?'); rangeBinds.push(until); }
    if (args.session_id != null) { range.push('e.session_id = ?'); rangeBinds.push(shortString(args.session_id, 'session_id', 128)); }
    if (args.repo != null && args.repo !== '') { filter.push(contains('e.repo')); filterBinds.push(shortString(args.repo, 'repo', 200)); }
    const kind = args.kind == null ? null : oneOf(args.kind, 'kind', LOG_KINDS);
    if (args.client != null) { filter.push('e.client = ?'); filterBinds.push(oneOf(args.client, 'client', LOG_CLIENTS)); }
    const limit = limitArg(args.limit, 'limit', 10, 20);
    const q = logQuery(query);
    const started = Date.now();
    try {
      let rows: LogRow[] = [], scanLimited: ScanLimited | undefined;
      if (q.match.length) {
        // Rank inside the candidates so no sorter carries full texts; only the
        // pool's texts are read for the boost. CROSS JOIN keeps the FTS match
        // as the outer loop: with a plain JOIN, since/until/kind or session_id
        // made SQLite walk the caller's ts range instead and probe log_fts once
        // per row (40 ms → 66 s at 60k rows). `c` splits prompts and replies
        // from actions and errors; each part keeps its own best `limit`.
        const where = [...range, ...filter, ...(kind ? ['e.kind = ?'] : [])].join(' AND ');
        const boost = q.boost.length ? q.boost.map(() => `(${contains('e.text')})`).join(' + ') : '0';
        const res = await db.prepare(`WITH cand AS (
            SELECT e.rowid AS rid, f.rank AS r, e.ts AS t, e.kind IN ('prompt', 'reply') AS c FROM log_fts f CROSS JOIN log_entries e ON e.rowid = f.rowid
            WHERE log_fts MATCH ? AND ${where}),
          pool AS (SELECT rid, r, t, c FROM (SELECT rid, r, t, c, ROW_NUMBER() OVER (PARTITION BY c ORDER BY r, t DESC) AS n FROM cand) WHERE n <= ?),
          scored AS (SELECT pool.rid, pool.r, pool.t, pool.c, ${boost} AS b FROM pool JOIN log_entries e ON e.rowid = pool.rid),
          top AS (SELECT rid, c, b, ROW_NUMBER() OVER (PARTITION BY c ORDER BY b DESC, r, t DESC) AS m FROM scored)
          SELECT ${COLUMNS}, top.c AS conv, top.b AS b FROM top JOIN log_entries e ON e.rowid = top.rid WHERE top.m <= ? ORDER BY top.c DESC, top.m`)
          .bind(q.match.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR '), ...rangeBinds, ...filterBinds, ...(kind ? [kind] : []), q.boost.length ? BOOST_CANDIDATES : limit, ...q.boost, limit)
          .all<LogRow & { conv: number; b: number }>();
        // Hits with more of the literal words (a file name, a 1–2 character word) still come first, as before.
        rows = (kind ? res.results : mixKinds(res.results.filter(r => r.conv), res.results.filter(r => !r.conv), limit)).sort((x, y) => y.b - x.b);
      } else if (q.like) {
        // Original case: SQLite LIKE already folds ASCII case, and full-width or
        // other non-ASCII text must match exactly. Prompts and replies have
        // their own window, so a day of tool actions does not hide them.
        const like = q.like;
        const groups = kind ? [[kind]] : [['prompt', 'reply'], ['action', 'error']];
        const found: LogRow[][] = [];
        for (const kinds of groups) {
          const group: LogRow[] = [];
          for (const k of kinds) {
            const scan = k === 'prompt' || k === 'reply' ? this.settings.conversationScanRows ?? CONVERSATION_SCAN_ROWS : this.settings.likeScanRows ?? LIKE_SCAN_ROWS;
            // The window is a co-routine read newest first, so the scan stops at `limit` hits or `scan` entries.
            const w = this.window(range, rangeBinds, k, scan);
            const res = await db.prepare(`SELECT ${COLUMNS} FROM (${w.sql}) w JOIN log_entries e ON e.rowid = w.rid
                WHERE ${[...filter, ...like.map(() => "e.text LIKE ? ESCAPE '\\'")].join(' AND ')} LIMIT ?`)
              .bind(...w.binds, ...filterBinds, ...like.map(likePattern), limit).all<LogRow>();
            group.push(...res.results);
            if (res.results.length < limit && !scanLimited) {
              // Fewer hits than asked for: is there an entry of this kind past the
              // window? (index only). `until` is the window's oldest ts + 1 (until
              // is exclusive), so entries sharing that ts (a failed call's action
              // and error) are looked at again rather than skipped.
              const e = this.window(range, rangeBinds, k, 2, scan - 1);
              const edge = await db.prepare(e.sql).bind(...e.binds).all<{ t: number }>();
              if (edge.results.length === 2) { const ts = edge.results[0].t + 1; scanLimited = { entries: scan, until: ts, time: jstTime(ts), kinds: [k] }; }
            }
          }
          found.push(group.sort((a, b) => b.ts - a.ts || b.rowid - a.rowid).slice(0, limit));
        }
        rows = found.length === 1 ? found[0] : mixKinds(found[0], found[1], limit);
      }
      const replies = rows.filter(r => r.kind === 'reply'), questions = new Map<number, string>();
      if (replies.length) {
        // The prompt before each reply in its session (log_user_session, read back from the reply).
        const res = await db.prepare(`SELECT h.value AS rid, (SELECT substr(p.text, 1, 1000) FROM log_entries p WHERE p.user_id = ?1 AND p.session_id = e.session_id
            AND p.ts <= e.ts AND p.kind = 'prompt' ORDER BY p.ts DESC, p.rowid DESC LIMIT 1) AS q FROM json_each(?2) h JOIN log_entries e ON e.rowid = h.value`)
          .bind(p.userId, JSON.stringify(replies.map(r => r.rowid))).all<{ rid: number; q: string | null }>();
        for (const r of res.results) if (r.q != null) questions.set(r.rid, preview(r.q, QUESTION_CHARS)!);
      }
      const terms = q.like ?? [...q.match, ...q.boost];
      const hits = rows.map(r => ({ id: r.id, ts: r.ts, time: jstTime(r.ts), client: r.client, repo: r.repo, kind: r.kind, session_id: r.session_id, snippet: snippetAround(r.text, terms),
        ...(questions.has(r.rowid) ? { question: questions.get(r.rowid)! } : {}) }));
      return { hits, ...(q.dropped.length ? { query_terms_dropped: q.dropped } : {}), ...(scanLimited ? { scan_limited: scanLimited } : {}) };
    } finally { logSlowRead('log_search', started); }
  }

  /** The newest `n` entries of one kind in the range (after skipping
   * `offset`), as `rid, t`, newest first: log_user_kind_ts
   * (migrations-logs/0004), or log_user_session within a session, so the
   * prompts behind a day of actions are reached without walking it. */
  private window(range: string[], rangeBinds: unknown[], kind: string, n: number, offset = 0): { sql: string; binds: unknown[] } {
    return { sql: `SELECT e.rowid AS rid, e.ts AS t FROM log_entries e WHERE ${range.join(' AND ')} AND e.kind = ? ORDER BY e.ts DESC, e.rowid DESC LIMIT ${n} OFFSET ${offset}`, binds: [...rangeBinds, kind] };
  }

  /** log_read: the entry and up to `before`/`after` neighbours in its session,
   * oldest first, each text at most READ_TEXT_CHARS. `text_offset` starts the
   * anchor's text there; a cut text carries `next_offset` to pass next. */
  async read(p: Principal, args: Record<string, unknown>) {
    const db = this.open(p);
    onlyKeys(args, ['id', 'before', 'after', 'text_offset'], 'log_read');
    if (typeof args.id !== 'string' || !/^[0-9a-f]{64}$/.test(args.id)) fail('id must be 64 lowercase hex characters (an id from log_search)');
    const before = limitArg(args.before, 'before', 3, 10, 0), after = limitArg(args.after, 'after', 3, 10, 0);
    const offset = limitArg(args.text_offset, 'text_offset', 0, Number.MAX_SAFE_INTEGER, 0);
    const anchor = await db.prepare(`SELECT ${COLUMNS} FROM log_entries e WHERE e.user_id=? AND e.id=?`).bind(p.userId, args.id).first<LogRow>();
    if (!anchor) return { found: false, id: args.id, entries: [] };
    const same = 'e.user_id=? AND e.session_id=?';
    const [older, newer] = await db.batch<LogRow>([
      // `ts <=` / `ts >=` first so log_user_session is used as a range from the anchor.
      db.prepare(`SELECT ${COLUMNS} FROM log_entries e WHERE ${same} AND e.ts <= ? AND (e.ts < ? OR e.rowid < ?) ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`)
        .bind(p.userId, anchor.session_id, anchor.ts, anchor.ts, anchor.rowid, before),
      db.prepare(`SELECT ${COLUMNS} FROM log_entries e WHERE ${same} AND e.ts >= ? AND (e.ts > ? OR e.rowid > ?) ORDER BY e.ts ASC, e.rowid ASC LIMIT ?`)
        .bind(p.userId, anchor.session_id, anchor.ts, anchor.ts, anchor.rowid, after),
    ]);
    const rows = [...older.results.reverse(), anchor, ...newer.results];
    return {
      found: true, id: anchor.id, session_id: anchor.session_id,
      entries: rows.map(r => {
        const anchored = r.id === anchor.id, w = textWindow(r.text, anchored ? offset : 0);
        return { id: r.id, ts: r.ts, time: jstTime(r.ts), client: r.client, repo: r.repo, kind: r.kind, text: w.text, chars: r.text.length, truncated: w.next !== null,
          ...(anchored ? { text_offset: w.start } : {}), ...(w.next !== null ? { next_offset: w.next } : {}), anchor: anchored };
      }),
    };
  }

  /** log_sessions: the caller's recent sessions, newest first, found among
   * the newest SESSION_SCAN_ROWS entries (`scan_limited` when older ones were
   * not looked at and fewer than `limit` sessions were found). */
  async sessions(p: Principal, args: Record<string, unknown>): Promise<{ sessions: LogSession[]; scan_limited?: { entries: number } }> {
    const db = this.open(p);
    onlyKeys(args, ['repo', 'client', 'limit'], 'log_sessions');
    const filter: string[] = [], binds: unknown[] = [];
    if (args.repo != null && args.repo !== '') { filter.push(contains('repo')); binds.push(shortString(args.repo, 'repo', 200)); }
    if (args.client != null) { filter.push('client = ?'); binds.push(oneOf(args.client, 'client', LOG_CLIENTS)); }
    const limit = limitArg(args.limit, 'limit', 10, 20), scan = this.settings.sessionScanRows ?? SESSION_SCAN_ROWS;
    const started = Date.now();
    try {
      // Discover sessions among the newest entries (log_user_ts), filtering
      // after the LIMIT so a selective repo/client filter examines at most
      // `scan` rows, then describe each one through log_user_session.
      const found = await db.prepare(`SELECT session_id, MAX(ts) AS last_ts FROM (
          SELECT session_id, ts, repo, client FROM log_entries WHERE user_id = ? ORDER BY ts DESC LIMIT ${scan})
        ${filter.length ? 'WHERE ' + filter.join(' AND ') : ''} GROUP BY session_id ORDER BY last_ts DESC LIMIT ?`).bind(p.userId, ...binds, limit).all<{ session_id: string }>();
      let scanLimited: { entries: number } | undefined;
      if (found.results.length < limit) {
        const edge = await db.prepare(`SELECT ts FROM log_entries WHERE user_id = ? ORDER BY ts DESC LIMIT 1 OFFSET ${scan}`).bind(p.userId).first();
        if (edge) scanLimited = { entries: scan };
      }
      if (!found.results.length) return { sessions: [], ...(scanLimited ? { scan_limited: scanLimited } : {}) };
      const one = (col: string, extra: string, order: string) =>
        `(SELECT ${col} FROM log_entries e WHERE e.user_id=?1 AND e.session_id=s.value${extra} ORDER BY e.ts ${order}, e.rowid ${order} LIMIT 1)`;
      const rows = await db.prepare(`SELECT s.value AS session_id,
          ${one('e.ts', '', 'ASC')} AS first_ts, ${one('e.ts', '', 'DESC')} AS last_ts,
          ${one('e.client', '', 'DESC')} AS client, ${one('e.repo', '', 'DESC')} AS repo,
          ${one('substr(e.text, 1, 1000)', " AND e.kind='prompt'", 'ASC')} AS first_prompt,
          ${one('substr(e.text, 1, 1000)', " AND e.kind='reply'", 'DESC')} AS last_reply
        FROM json_each(?2) s`).bind(p.userId, JSON.stringify(found.results.map(r => r.session_id)))
        .all<{ session_id: string; first_ts: number; last_ts: number; client: string; repo: string; first_prompt: string | null; last_reply: string | null }>();
      return {
        sessions: rows.results.sort((a, b) => b.last_ts - a.last_ts).map(r => ({
          session_id: r.session_id, client: r.client, repo: r.repo, first_time: jstTime(r.first_ts), last_time: jstTime(r.last_ts),
          first_prompt: preview(r.first_prompt), last_reply: preview(r.last_reply),
        })),
        ...(scanLimited ? { scan_limited: scanLimited } : {}),
      };
    } finally { logSlowRead('log_sessions', started); }
  }

  /** The latest `reply` in `repo` from a session other than `sessionId`, among
   * the repo's newest HANDOFF_SCAN_ROWS entries. Null when no repo is given
   * (there is no "same repo" to hand off from). */
  async handoff(p: Principal, repo: string, sessionId: string | null): Promise<LogHandoff | null> {
    const db = this.open(p);
    if (!repo) return null;
    // The window is a co-routine read newest first (log_user_repo_ts), so the
    // scan stops at the first match or after HANDOFF_SCAN_ROWS entries.
    const row = await db.prepare(`SELECT e.session_id, e.ts, e.text FROM (
          SELECT rowid AS rid FROM log_entries WHERE user_id=? AND repo=? ORDER BY ts DESC, rowid DESC LIMIT ${HANDOFF_SCAN_ROWS}) w
        JOIN log_entries e ON e.rowid = w.rid WHERE e.kind='reply'${sessionId ? ' AND e.session_id != ?' : ''} LIMIT 1`)
      .bind(p.userId, repo, ...(sessionId ? [sessionId] : [])).first<{ session_id: string; ts: number; text: string }>();
    return row ? { session_id: row.session_id, time: jstTime(row.ts), text: cutText(row.text, HANDOFF_TEXT_CHARS).text } : null;
  }

  /** server_status.logs. size_bytes is the whole database (D1 result
   * meta.size_after of the count query); entries and today's bytes are the
   * caller's own. `entries` is a count(*) over log_user_ts: one index entry
   * read per own row (no cheaper exact source; log_daily has no running total). */
  async status(p?: Principal) {
    const base = { configured: this.configured, daily_action_limit: this.settings.dailyActionBytes ?? null,
      daily_total_limit: this.settings.dailyTotalBytes ?? null, action_retention_days: this.settings.actionRetentionDays };
    const unknown = { size_bytes: null, entries: null, today_action_bytes: null, today_total_bytes: null };
    if (!this.db || !p || p.anonymous) return { ...base, ...unknown };
    try {
      const [count, daily] = await this.db.batch<{ n: number; action_bytes?: number; total_bytes?: number }>([
        this.db.prepare('SELECT count(*) AS n FROM log_entries WHERE user_id=?').bind(p.userId),
        this.db.prepare('SELECT action_bytes, total_bytes, 0 AS n FROM log_daily WHERE user_id=? AND day=?').bind(p.userId, utcDay(this.clock())),
      ]);
      const size = (count.meta as { size_after?: unknown } | undefined)?.size_after;
      return { ...base, size_bytes: typeof size === 'number' ? size : null, entries: count.results[0]?.n ?? 0,
        today_action_bytes: daily.results[0]?.action_bytes ?? 0, today_total_bytes: daily.results[0]?.total_bytes ?? 0 };
    } catch {
      return { ...base, ...unknown, error: 'unavailable' };
    }
  }
}

/** Validate session_context arguments. */
export function sessionContextArgs(args: Record<string, unknown>): { repo: string; session_id: string | null } {
  onlyKeys(args, ['repo', 'session_id'], 'session_context');
  const repo = args.repo == null ? '' : shortString(args.repo, 'repo', 200, { allowEmpty: true });
  const session_id = args.session_id == null || args.session_id === '' ? null : shortString(args.session_id, 'session_id', 128);
  return { repo, session_id };
}

export interface PruneResult { deleted_entries: number; deleted_daily: number; complete: boolean; elapsed_ms: number }

/** Daily maintenance: delete `action`/`error` rows older than the retention
 * window in batches (the delete trigger keeps log_fts in sync), then
 * `log_daily` rows older than 120 days. Stops at `budgetMs`; the rest waits
 * for the next run. */
export async function pruneLogs(db: D1Database, settings: LogSettings, opts: { now?: number; budgetMs?: number; batchSize?: number } = {}): Promise<PruneResult> {
  const started = Date.now(), nowMs = opts.now ?? started, budget = opts.budgetMs ?? 20000, batch = opts.batchSize ?? 500;
  const cutoff = nowMs - settings.actionRetentionDays * DAY_MS;
  const out: PruneResult = { deleted_entries: 0, deleted_daily: 0, complete: false, elapsed_ms: 0 };
  let done = false;
  while (Date.now() - started < budget) {
    // RETURNING gives the exact row count: D1's meta.changes also counts the
    // delete trigger's writes to log_fts and its shadow tables.
    const res = await db.prepare(`DELETE FROM log_entries WHERE rowid IN (
        SELECT rowid FROM log_entries WHERE kind IN ('action', 'error') AND ts < ? LIMIT ?) RETURNING rowid`).bind(cutoff, batch).all<{ rowid: number }>();
    const n = res.results.length;
    out.deleted_entries += n;
    if (n < batch) { done = true; break; }
  }
  if (done && Date.now() - started < budget) {
    const res = await db.prepare('DELETE FROM log_daily WHERE day < ?').bind(utcDay(nowMs - DAILY_ROW_RETENTION_DAYS * DAY_MS)).run();
    out.deleted_daily = res.meta.changes ?? 0;
    out.complete = true;
  }
  out.elapsed_ms = Date.now() - started;
  return out;
}
