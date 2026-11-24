import { readableSql } from './visibility';
import { normalizeScopes, scopeClause } from './context';
import { validityClause } from './search';
import type { Principal } from './types';
import { parseValidTs } from './db';
import { scrub, scrubText, boundPayload, hasDeniedPath, hasCredentialReader, deniedPath, markedPrivate } from '../cf-memory-agent/scripts/redact.mjs';
import type { RetractionProvenance } from './retraction';
import { appendContentUnsafe, type AppendProvenance } from './append';
import { isMemoryEcho } from '../cf-memory-agent/scripts/memory-echo.mjs';

const ID = /^[a-f0-9]{64}$/;
export class CaptureInputError extends Error {}
function id(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw new CaptureInputError('capture id must be a SHA-256 hex digest');
  return v;
}
function text(v: unknown, length = 160): string { return scrubText(v ?? '').slice(0, length); }
function limit(v: unknown, fallback: number, max: number) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : fallback;
}
function requireCaller(p: Principal) { if (p.anonymous) throw new Error('authentication required'); }
/** Which provenance rows of a readable memory a caller may be shown; binds the
 * caller's user id once. provenanceSources refuses a personal event on a memory
 * that is shared WHEN the row is written, but a note can become shared afterwards
 * (shared:true, a shared type, a revive) and keeps its rows. So the rule is also
 * applied where rows are returned: the actor sees every row they attached, anyone
 * else only rows whose source snapshot is project-visible (and never an imported
 * one). A row with no recorded visibility counts as personal. Nothing is deleted,
 * so unsharing the note loses no trace. */
const provenanceReadable = (alias: string) => {
  const c = alias ? alias + '.' : '';
  return `(${c}actor_id=? OR (COALESCE(json_extract(${c}source_metadata_json,'$.imported'),0)!=1 AND json_extract(${c}source_metadata_json,'$.visibility')='project'))`;
};
interface CaptureRow {
  id: string; session_id: string; event_type: string; tool_name: string; tool_use_id: string | null;
  payload_redacted: string; payload_hash: string; metadata_json: string; occurred_at: number; visibility: string; distill_status: string;
  expires_at: number;
}
interface ProvenanceRow {
  event_id: string; source_session_id: string; actor_id: string;
  relation: string; generated_by: string; confidence: number; rationale: string;
  source_metadata_json: string; created_at: number;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function project(row: CaptureRow) {
  const payload: unknown = JSON.parse(row.payload_redacted);
  return { ...row, payload_redacted: payload, metadata: record(JSON.parse(row.metadata_json)), metadata_json: undefined };
}
export type CaptureEvent = ReturnType<typeof project>;
export interface CaptureSession {
  id: string; platform_source: string; client_version: string; started_at: number; ended_at: number | null;
  retained_events: number; last_event_at: number | null;
}
function cursor(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,16}:[a-f0-9]{64}$/.test(value)) throw new CaptureInputError('invalid capture cursor');
  const [ts, eventId] = value.split(':');
  if (!Number.isSafeInteger(Number(ts))) throw new CaptureInputError('invalid capture cursor');
  return { at: Number(ts), id: eventId };
}
function rowCursor(row: { id: string; occurred_at: number }) { return row.occurred_at + ':' + row.id; }
function compactIndex(row: CaptureRow) {
  const event = project(row), meta = event.metadata;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 3).map(v => v.slice(0, 180)) : [];
  const preview = JSON.stringify(event.payload_redacted);
  return {
    id: row.id, session_id: row.session_id, event_type: row.event_type, tool_name: row.tool_name,
    occurred_at: row.occurred_at, expires_at: row.expires_at, visibility: row.visibility, distill_status: row.distill_status,
    metadata: { file_refs: strings(meta.file_refs), repo_context: strings(meta.repo_context),
      truncated: meta.truncated === true, denied: meta.denied === true, client: text(meta.client, 80) },
    preview: preview.slice(0, 400), preview_truncated: preview.length > 400, source_chars: row.payload_redacted.length,
  };
}
export type CaptureHit = ReturnType<typeof compactIndex>;
function filters(p: Principal, args: Record<string, unknown>, direction: 'ASC' | 'DESC', boundedWindow = false) {
  const clauses = ['user_id=?'], binds: (string | number)[] = [p.userId];
  if (!boundedWindow) { clauses.push('expires_at>?'); binds.push(Date.now()); }
  if (args.session_id) { clauses.push('session_id=?'); binds.push(id(args.session_id)); }
  for (const field of ['since', 'until'] as const) if (args[field] != null && args[field] !== '') {
    const timestamp = parseValidTs(args[field]);
    if (timestamp == null || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new CaptureInputError('invalid capture date');
    clauses.push('occurred_at' + (field === 'since' ? '>=?' : '<?')); binds.push(timestamp);
  }
  const after = cursor(args.cursor);
  if (after) { clauses.push(`(occurred_at ${direction === 'ASC' ? '>' : '<'} ? OR (occurred_at=? AND id ${direction === 'ASC' ? '>' : '<'} ?))`); binds.push(after.at, after.at, after.id); }
  return { sql: clauses.join(' AND '), binds };
}
export class CaptureService {
  constructor(private db: D1Database, readonly retentionDays = 7, private runtime: Record<string, unknown> = {}) {}
  /** Schema/capability flags for server_status. 2026-10-31: the Vectorize,
   * embedding-provider and embedding-job fields are gone with semantic search.
   * `embedding_jobs` (migration 0033) still marks schema version 33 until
   * phase 5 drops it; nothing reads or writes its rows. `vectorize: 'disabled'`
   * stays until phase 5 too: installed 0.2.x doctors fail `vectorize_processing`
   * unless it is 'disabled' or 'configured'. */
  async status(_p?: Principal) {
    const tables = await this.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('capture_sessions','capture_events','memory_provenance','client_heartbeats','embedding_jobs','capture_recent','capture_sessions_recent')").all<{ name: string }>();
    const jobs = tables.results.some(t => t.name === 'embedding_jobs');
    const lookup = tables.results.some(t => t.name === 'capture_recent') && tables.results.some(t => t.name === 'capture_sessions_recent');
    return { bounded_search: true, atomic_append_provenance: tables.results.some(t => t.name === 'capture_events') && tables.results.some(t => t.name === 'memory_provenance'), guarded_note_update: tables.results.some(t => t.name === 'memory_provenance'), atomic_retraction_provenance: tables.results.some(t => t.name === 'capture_events') && tables.results.some(t => t.name === 'memory_provenance'), guarded_deletion: tables.results.some(t => t.name === 'memory_provenance'), guarded_supersession: tables.results.some(t => t.name === 'memory_provenance'), atomic_creation_provenance: tables.results.some(t => t.name === 'capture_events') && tables.results.some(t => t.name === 'memory_provenance'), portability: true, search_filters: true, source_lookup_context: tables.results.some(t => t.name === 'memory_provenance'), source_lookup: tables.results.some(t => t.name === 'memory_provenance'), capture_lookup: lookup, capture_checkpoint: tables.results.some(t => t.name === 'capture_events'), version: '0.1.0', git_sha: 'unknown', build_date: 'unknown', schema_version: lookup ? 34 : jobs ? 33 : tables.results.length === 4 ? 32 : null, required_schema_version: 34, schema_ready: tables.results.length === 7, raw_event_retention_days: this.retentionDays, vectorize: 'disabled', ...this.runtime };
  }
  async put(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    if (JSON.stringify(args).length > 100000) throw new Error('capture event exceeds request limit');
    const eventId = id(args.id), sessionId = id(args.session_id);
    const toolId = args.tool_use_id == null ? null : id(args.tool_use_id);
    const eventType = text(args.event_type, 80), tool = text(args.tool_name);
    const ts = Date.now();
    // Offline spool originals may be older than the raw retention window.
    // Retention starts at receipt; provenance must keep the actual source time.
    const occurred = typeof args.occurred_at === 'number' && Number.isFinite(args.occurred_at) ? Math.max(0, Math.min(ts, Math.floor(args.occurred_at))) : ts;
    const repos = Array.isArray(args.repo_context) ? args.repo_context.slice(0, 20).map(v => text(v, 500)) : [];
    const refs = Array.isArray(args.file_refs) ? args.file_refs.slice(0, 20).map(v => text(v, 500)) : [];
    const denied = args.denied === true || markedPrivate(args.payload_redacted) || hasDeniedPath(args.payload_redacted) || hasCredentialReader(args.payload_redacted) || refs.some(r => deniedPath(r));
    const metadata = { cwd: text(args.cwd, 1000), repo_context: repos, file_refs: denied ? [] : refs, tool_name: tool, actor: p.actor, client: text(args.client), client_version: text(args.client_version), plugin_version: text(args.plugin_version), truncated: args.truncated === true, denied };
    const payload = boundPayload(denied ? { input: '[DENIED PATH]', output: '[DENIED PATH]' } : scrub(args.payload_redacted)).payload;
    const session = this.db.prepare('INSERT INTO capture_sessions (user_id,id,actor_id,platform_source,client_version,repo_context_json,started_at,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET started_at=MIN(capture_sessions.started_at,excluded.started_at)')
      .bind(p.userId, sessionId, p.userId, text(args.client), text(args.client_version), JSON.stringify(repos), occurred, ts);
    const event = this.db.prepare('INSERT OR IGNORE INTO capture_events (user_id,id,session_id,event_type,tool_name,tool_use_id,payload_redacted,payload_hash,metadata_json,visibility,occurred_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(p.userId, eventId, sessionId, eventType, tool, toolId, JSON.stringify(payload), id(args.payload_hash), JSON.stringify(metadata), args.visibility === 'project' && !denied ? 'project' : 'personal', occurred, ts + Math.max(1, Math.min(30, this.retentionDays)) * 86400000);
    await this.prune();
    // An expired original may be re-uploaded from the no-loss local source.
    await this.db.prepare('DELETE FROM capture_events WHERE user_id=? AND id=? AND expires_at<?').bind(p.userId, eventId, ts).run();
    const results = await this.db.batch([session, event]);
    const created = results[1].meta.changes > 0;
    if (created) return { ok: true, id: eventId, created };
    // A second sender can derive a different event id for the same tool use.
    // Return the stored identity so timeline/provenance callers do not receive
    // an acknowledgement naming an event which was never inserted.
    const existing = await this.db.prepare('SELECT id FROM capture_events WHERE user_id=? AND (id=? OR (session_id=? AND event_type=? AND tool_use_id=?)) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1')
      .bind(p.userId, eventId, sessionId, eventType, toolId, eventId).first<{ id: string }>();
    if (!existing) throw new Error('capture acknowledgement unavailable; retry');
    return { ok: true, id: existing.id, created };
  }
  async end(p: Principal, sessionId: unknown, endedAt?: unknown) {
    requireCaller(p);
    const ended = typeof endedAt === 'number' && Number.isFinite(endedAt) ? Math.max(0, Math.min(Date.now(), Math.floor(endedAt))) : Date.now();
    await this.db.prepare('UPDATE capture_sessions SET ended_at=MAX(COALESCE(ended_at,started_at),started_at,?) WHERE user_id=? AND id=?').bind(ended, p.userId, id(sessionId)).run();
    return { ok: true };
  }
  async sessions(p: Principal, args: Record<string, unknown> = {}) {
    requireCaller(p);
    const count = Math.max(1, limit(args.limit, 20, 50)), after = cursor(args.cursor);
    const rows = await this.db.prepare(`SELECT s.id,s.platform_source,s.client_version,s.started_at,s.ended_at,
      (SELECT count(*) FROM capture_events e WHERE e.user_id=s.user_id AND e.session_id=s.id AND e.expires_at>?) AS retained_events,
      (SELECT max(occurred_at) FROM capture_events e WHERE e.user_id=s.user_id AND e.session_id=s.id AND e.expires_at>?) AS last_event_at
      FROM capture_sessions s WHERE s.user_id=? ${after ? 'AND (s.started_at<? OR (s.started_at=? AND s.id<?))' : ''}
      ORDER BY s.started_at DESC,s.id DESC LIMIT ?`)
      .bind(Date.now(), Date.now(), p.userId, ...(after ? [after.at, after.at, after.id] : []), count + 1).all<CaptureSession>();
    const page = rows.results.slice(0, count), last = page.at(-1);
    return { sessions: page, next_cursor: rows.results.length > count && last ? last.started_at + ':' + last.id : null };
  }
  async getMany(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 10) throw new CaptureInputError('provide 1-10 capture ids');
    const ids = [...new Set(args.ids.map(id))];
    const rows = await this.db.prepare(`SELECT * FROM capture_events WHERE user_id=? AND expires_at>? AND id IN (${ids.map(() => '?').join(',')})`).bind(p.userId, Date.now(), ...ids).all<CaptureRow>();
    return { events: ids.flatMap(eventId => rows.results.filter(row => row.id === eventId).map(project)), missing_ids: ids.filter(eventId => !rows.results.some(row => row.id === eventId)) };
  }
  async sessionTimeline(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    const sessionId = id(args.session_id), count = Math.max(1, limit(args.limit, 20, 50));
    const session = await this.db.prepare('SELECT id FROM capture_sessions WHERE user_id=? AND id=?').bind(p.userId, sessionId).first();
    if (!session) return { found: false, events: [], next_cursor: null };
    const f = filters(p, { session_id: sessionId, cursor: args.cursor }, 'ASC');
    const rows = await this.db.prepare(`SELECT * FROM capture_events WHERE ${f.sql} ORDER BY occurred_at,id LIMIT ?`).bind(...f.binds, count + 1).all<CaptureRow>();
    const page = rows.results.slice(0, count);
    return { found: true, events: page.map(project), next_cursor: rows.results.length > count ? rowCursor(page[page.length - 1]) : null };
  }
  async search(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    if (args.q != null && (typeof args.q !== 'string' || args.q.length > 200)) throw new CaptureInputError('capture query is too large');
    const q = text(args.q, 200).trim().normalize('NFKC').toLocaleLowerCase('en-US');
    const extraFilter = ['tool_name', 'event_type', 'file_ref', 'repo'].some(field => args[field] != null && args[field] !== '');
    for (const field of ['tool_name', 'event_type', 'file_ref', 'repo']) {
      const value = args[field];
      if (value != null && value !== '' && (typeof value !== 'string' || value.length > (field === 'file_ref' || field === 'repo' ? 500 : 160))) throw new CaptureInputError('invalid capture filter');
    }
    const count = Math.max(1, limit(args.limit, 20, 50)), scanLimit = q || extraFilter ? 100 : count;
    // Only indexed owner/session/date/cursor predicates enter the SQL window.
    // Apply non-indexed metadata/keyword/TTL filters afterward, so rare filters
    // and expired originals cannot turn LIMIT into an unbounded table scan.
    const f = filters(p, args, 'DESC', true), now = Date.now();
    const rows = await this.db.prepare(`SELECT * FROM capture_events WHERE ${f.sql} ORDER BY occurred_at DESC,id DESC LIMIT ?`).bind(...f.binds, scanLimit + 1).all<CaptureRow>();
    const window = rows.results.slice(0, scanLimit), terms = q.split(/\s+/).filter(Boolean);
    const matches = window.filter(row => {
      if (row.expires_at <= now || args.tool_name && row.tool_name !== args.tool_name || args.event_type && row.event_type !== args.event_type) return false;
      const meta = record(JSON.parse(row.metadata_json));
      if (args.file_ref && (!Array.isArray(meta.file_refs) || !meta.file_refs.includes(args.file_ref))) return false;
      if (args.repo && (!Array.isArray(meta.repo_context) || !meta.repo_context.includes(args.repo))) return false;
      const value = [row.tool_name, row.event_type, row.payload_redacted, row.metadata_json].join(' ').normalize('NFKC').toLocaleLowerCase('en-US');
      return terms.every(term => value.includes(term));
    });
    const page = matches.slice(0, count), moreHits = matches.length > count;
    const next = moreHits ? page.at(-1) : rows.results.length > scanLimit ? window.at(-1) : null;
    return { hits: page.map(compactIndex), scanned: window.length, scan_limit: scanLimit, next_cursor: next ? rowCursor(next) : null, index_only: true };
  }
  async checkpoint(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    if (!Array.isArray(args.source_event_ids) || !args.source_event_ids.length || args.source_event_ids.length > 200) throw new CaptureInputError('provide 1-200 capture ids');
    if (!['shadow', 'apply'].includes(String(args.mode))) throw new CaptureInputError('invalid distill mode');
    const ids = [...new Set(args.source_event_ids.map(id))], status = args.mode === 'shadow' ? 'shadow' : 'processed';
    let updated = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const page = ids.slice(i, i + 50);
      const result = await this.db.prepare(`UPDATE capture_events SET distill_status=? WHERE user_id=? AND distill_status='pending' AND id IN (${page.map(() => '?').join(',')})`).bind(status, p.userId, ...page).run();
      updated += result.meta.changes;
    }
    // Expired/not-owned originals are intentionally indistinguishable. Never
    // require a TTL-expired low-value original to be re-uploaded for this report.
    return { ok: true, updated };
  }
  async timeline(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    const anchor = await this.db.prepare('SELECT * FROM capture_events WHERE user_id=? AND id=? AND expires_at>?').bind(p.userId, id(args.anchor_event_id), Date.now()).first<CaptureRow>();
    if (!anchor) return { found: false, events: [] };
    const query = (direction: 'before' | 'after', count: number) => this.db.prepare(
      `SELECT * FROM capture_events WHERE user_id=? AND session_id=? AND expires_at>? AND (occurred_at ${direction === 'before' ? '<' : '>'} ? OR (occurred_at=? AND id ${direction === 'before' ? '<' : '>'} ?)) ORDER BY occurred_at ${direction === 'before' ? 'DESC' : 'ASC'},id ${direction === 'before' ? 'DESC' : 'ASC'} LIMIT ?`)
      .bind(p.userId, anchor.session_id, Date.now(), anchor.occurred_at, anchor.occurred_at, anchor.id, count).all<CaptureRow>();
    const [before, after] = await Promise.all([query('before', limit(args.before, 5, 10)), query('after', limit(args.after, 5, 10))]);
    return { found: true, events: [...(before.results ?? []).reverse(), anchor, ...(after.results ?? [])].map(project) };
  }
  async memoriesBySource(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    const refs = Array.isArray(args.file_refs) ? [...new Set(args.file_refs.slice(0, 20).filter((r): r is string => typeof r === 'string' && r.length <= 500 && !deniedPath(r)))] : [];
    if (!refs.length) return { hits: [], context_applied: args.context != null };
    const count = limit(args.limit, 5, 10), access = readableSql('n', p), now = Date.now();
    if (args.context != null && typeof args.context !== 'string' && !(Array.isArray(args.context) && args.context.every(c => typeof c === 'string'))) throw new CaptureInputError('invalid context');
    const scoped = scopeClause('n', normalizeScopes(args.context as string | string[] | undefined));
    const read = async (kind: 'note' | 'skill') => {
      const validity = validityClause(kind, true);
      const rows = await this.db.prepare(`SELECT n.id,${kind === 'note' ? 'n.title' : 'n.name'} AS title,n.user_id,n.scope,n.shared,${kind === 'note' ? 'n.type' : 'NULL'} AS memory_type,? AS kind,MAX(pv.created_at) AS source_at FROM ${kind === 'note' ? 'notes' : 'skills'} n
        JOIN memory_provenance pv ON pv.memory_id=n.id AND pv.memory_kind=?
        WHERE n.deleted_at IS NULL AND (${access.sql}${scoped.sql}) AND ${validity.sql}
        ${kind === 'note' ? "n.kind!='block' AND n.archived_at IS NULL AND" : ''}
        ${args.shared_only === true ? 'n.shared=1 AND' : ''}
        ${provenanceReadable('pv')} AND
        EXISTS (SELECT 1 FROM json_each(pv.source_metadata_json,'$.file_refs') f WHERE f.value IN (${refs.map(() => '?').join(',')}))
        GROUP BY n.id ORDER BY source_at DESC,n.id LIMIT ?`)
        .bind(kind, kind, ...access.args, ...scoped.args, ...validity.args(now), p.userId, ...refs, count).all<{ id: string; kind: string; source_at: number }>();
      return rows.results;
    };
    const rows = (await Promise.all([read('note'), read('skill')])).flat();
    return { hits: rows.sort((a, b) => b.source_at - a.source_at || a.id.localeCompare(b.id)).slice(0, count), context_applied: args.context != null };
  }
  async provenance(memoryKind: 'note' | 'skill', memoryId: string, p?: Principal) {
    if (!p || p.anonymous) return [];
    const access = readableSql('m', p);
    const table = memoryKind === 'note' ? 'notes' : 'skills';
    // Read the memory and source permissions together. The owner retains the
    // provenance of soft-deleted memories for retraction and restore.
    const rows = await this.db.prepare(`SELECT pv.event_id,pv.source_session_id,pv.actor_id,pv.relation,pv.generated_by,
      pv.confidence,pv.rationale,pv.source_metadata_json,pv.created_at
      FROM memory_provenance pv JOIN ${table} m ON m.id=pv.memory_id
      WHERE pv.memory_kind=? AND pv.memory_id=? AND ${access.sql}
        AND (m.deleted_at IS NULL OR m.user_id=?) AND ${provenanceReadable('pv')}
      ORDER BY pv.created_at,pv.event_id LIMIT 100`)
      .bind(memoryKind, memoryId, ...access.args, p.userId, p.userId).all<ProvenanceRow>();
    return (rows.results ?? []).map(row => ({ ...row, source: JSON.parse(row.source_metadata_json), source_metadata_json: undefined }));
  }
  private async provenanceSources(p: Principal, value: unknown, shared: boolean) {
    if (!Array.isArray(value) || !value.length || value.length > 50) throw new CaptureInputError('provide 1-50 source event ids');
    const eventIds = [...new Set(value.map(id))];
    const result = await this.db.prepare(`SELECT * FROM capture_events WHERE user_id=? AND expires_at>? AND id IN (${eventIds.map(() => '?').join(',')})`).bind(p.userId, Date.now(), ...eventIds).all<CaptureRow>();
    if (result.results.length !== eventIds.length) throw new CaptureInputError('source event unavailable');
    if (shared && result.results.some(event => event.visibility !== 'project')) throw new CaptureInputError('personal source cannot promote to shared memory');
    return { eventIds, rows: result.results };
  }
  // Internal create-only repository callback, never a client-addressable write.
  // The repository supplies its newly allocated owned ID and resolved sharing.
  async prepareCreation(p: Principal, kind: 'note' | 'skill', memoryId: string, shared: boolean, input: unknown): Promise<D1PreparedStatement[]> {
    requireCaller(p);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CaptureInputError('invalid creation provenance');
    const args = record(input);
    if (Object.keys(args).some(key => !['source_event_ids','generated_by','confidence','rationale'].includes(key))) throw new CaptureInputError('invalid creation provenance field');
    const { eventIds: ids, rows } = await this.provenanceSources(p, args.source_event_ids, shared);
    const snapshots = rows.map(event => {
      const metadata = { ...record(JSON.parse(event.metadata_json)), occurred_at: event.occurred_at, event_type: event.event_type, payload_hash: event.payload_hash, visibility: event.visibility };
      // The validated snapshot survives concurrent TTL cleanup; raw contents and
      // the user's local working-directory path never enter durable provenance.
      const source = record(metadata); delete source.cwd;
      return { id: event.id, session_id: event.session_id, metadata_json: JSON.stringify(source) };
    });
    const confidence = typeof args.confidence === 'number' && Number.isFinite(args.confidence) ? Math.max(0, Math.min(1, args.confidence)) : 0;
    // A guarded create can match zero rows. Gate BOTH statements on the fresh
    // owned row so a conflict cannot leave orphan provenance or applied sources.
    const created = `EXISTS (SELECT 1 FROM ${kind === 'note' ? 'notes' : 'skills'} WHERE id=? AND user_id=? AND deleted_at IS NULL)`;
    return [
      this.db.prepare(`INSERT INTO memory_provenance (memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at)
        SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.session_id'),?,?,?,?,?,
        json_set(json_extract(value,'$.metadata_json'),'$.derived_memory_content_hash',
          (SELECT content_hash FROM ${kind === 'note' ? 'notes' : 'skills'} WHERE id=? AND user_id=?)),?
        FROM json_each(?) WHERE ${created}`)
        .bind(kind, memoryId, p.userId, 'derived_from', text(args.generated_by), confidence, text(args.rationale, 500), memoryId, p.userId, Date.now(), JSON.stringify(snapshots), memoryId, p.userId),
      this.db.prepare(`UPDATE capture_events SET distill_status='applied' WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')}) AND ${created}`).bind(p.userId, ...ids, memoryId, p.userId),
    ];
  }
  private observedMutationSnapshots(rows: CaptureRow[], operation: 'append' | 'retraction') {
    return rows.map(event => {
      const meta = record(JSON.parse(event.metadata_json)), payload = JSON.parse(event.payload_redacted);
      if (!['PostToolUse','PostToolUseFailure'].includes(event.event_type) ||
          meta.denied === true || meta.denied === 1 || meta.truncated === true || meta.truncated === 1 ||
          meta.imported === true || meta.imported === 1 || meta.source_kind === 'authored_memory' ||
          record(payload).truncated === true || record(payload).imported === true || record(payload).source_kind === 'authored_memory' ||
          /\[REDACTED|\[DENIED PATH\]|\[TRUNCATED\]/.test(event.payload_redacted) ||
          ['mcp__cf-memory__notes_retraction_status','mcp__cf-memory__notes_append_status'].includes(event.tool_name) ||
          isMemoryEcho({ ...event, payload_redacted: payload }) ||
          operation === 'append' && appendContentUnsafe(payload)) throw new CaptureInputError('ineligible '+operation+' source');
      const source: Record<string,unknown> = { ...meta, occurred_at: event.occurred_at, event_type: event.event_type, payload_hash: event.payload_hash, visibility: event.visibility };
      delete source.cwd;
      return { id: event.id, session_id: event.session_id, metadata: source };
    });
  }
  async prepareAppend(p: Principal, memoryId: string, shared: boolean, receiptId: string, requestHash: string, args: AppendProvenance, commitNonce: string): Promise<D1PreparedStatement[]> {
    requireCaller(p);
    const { eventIds, rows } = await this.provenanceSources(p, args.source_event_ids, shared);
    const snapshots = this.observedMutationSnapshots(rows, 'append');
    // Only the winning guarded append inserts this receipt. The caller batches
    // these statements with that UPDATE: failures roll back content AND trace.
    const committed = `EXISTS (SELECT 1 FROM events e JOIN notes n ON n.id=e.target_id
      WHERE e.id=? AND e.user_id=? AND e.verb='note.appended'
      AND json_extract(e.payload_json,'$.request_hash')=? AND n.id=? AND n.user_id=?
      AND n.updated_at=e.created_at AND n.content_hash=json_extract(e.payload_json,'$.content_hash') AND json_extract(e.payload_json,'$.commit_nonce')=?)`;
    const gate = [receiptId,p.userId,requestHash,memoryId,p.userId,commitNonce];
    return [
      this.db.prepare(`INSERT INTO memory_provenance
        (memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at)
        SELECT 'note',?,json_extract(value,'$.id'),json_extract(value,'$.session_id'),?,'derived_from',?,?,?,
        json_set(json_extract(value,'$.metadata'),'$.derived_memory_content_hash',
          (SELECT content_hash FROM notes WHERE id=?),'$.append_id',
          (SELECT json_extract(payload_json,'$.append_id') FROM events WHERE id=?)),?
        FROM json_each(?) WHERE ${committed}`)
        .bind(memoryId,p.userId,args.generated_by,args.confidence,args.rationale,memoryId,receiptId,Date.now(),JSON.stringify(snapshots),...gate),
      this.db.prepare(`UPDATE capture_events SET distill_status='applied' WHERE user_id=? AND id IN (${eventIds.map(() => '?').join(',')}) AND ${committed}`)
        .bind(p.userId,...eventIds,...gate),
    ];
  }
  async prepareRetraction(p: Principal, memoryId: string, shared: boolean, receiptId: string, requestHash: string, args: RetractionProvenance): Promise<D1PreparedStatement[]> {
    requireCaller(p);
    const { eventIds, rows } = await this.provenanceSources(p, args.source_event_ids, shared);
    const snapshots = this.observedMutationSnapshots(rows, 'retraction');
    // The receipt is inserted immediately after the winning guarded UPDATE in
    // the same batch. A stale guard or an operation-ID collision gates every
    // dependent write off. Metadata snapshots survive concurrent TTL cleanup.
    const committed = `EXISTS (SELECT 1 FROM events e JOIN notes n ON n.id=e.target_id
      WHERE e.id=? AND e.user_id=? AND e.verb='note.deleted'
      AND json_extract(e.payload_json,'$.request_hash')=? AND n.id=? AND n.user_id=?
      AND n.deleted_at=e.created_at AND n.content_hash=json_extract(e.payload_json,'$.deletion_guard.content_hash'))`;
    const gate = [receiptId,p.userId,requestHash,memoryId,p.userId];
    // Skip an existing trace only for this exact committed operation. A prior
    // contradictory trace from another operation must fail the batch rather
    // than claiming new provenance was stored after a human restoration.
    return [
      this.db.prepare(`INSERT INTO memory_provenance
        (memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at)
        SELECT 'note',?,json_extract(value,'$.id'),json_extract(value,'$.session_id'),?,'contradicts',?,?,?,
        json_set(json_extract(value,'$.metadata'),'$.retracted_memory_content_hash',
          (SELECT content_hash FROM notes WHERE id=?),'$.retraction_id',
          (SELECT json_extract(payload_json,'$.retraction_id') FROM events WHERE id=?)),?
        FROM json_each(?) WHERE ${committed}
        AND NOT EXISTS (SELECT 1 FROM memory_provenance pv WHERE pv.memory_kind='note' AND pv.memory_id=?
          AND pv.event_id=json_extract(value,'$.id') AND pv.relation='contradicts' AND pv.actor_id=?
          AND json_extract(pv.source_metadata_json,'$.retraction_id')=
            (SELECT json_extract(payload_json,'$.retraction_id') FROM events WHERE id=?))`)
        .bind(memoryId,p.userId,args.generated_by,args.confidence,args.rationale,memoryId,receiptId,Date.now(),JSON.stringify(snapshots),...gate,memoryId,p.userId,receiptId),
      this.db.prepare(`UPDATE capture_events SET distill_status='applied' WHERE user_id=? AND id IN (${eventIds.map(() => '?').join(',')}) AND ${committed}`)
        .bind(p.userId,...eventIds,...gate),
    ];
  }
  async attach(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    if (args.memory_kind != null && !['note', 'skill'].includes(String(args.memory_kind))) throw new Error('invalid memory kind');
    const kind = args.memory_kind === 'skill' ? 'skill' : 'note';
    const memoryId = String(args.memory_id ?? '');
    const target = await this.db.prepare(`SELECT id,${kind === 'note' ? 'shared' : '0 AS shared'} FROM ${kind === 'note' ? 'notes' : 'skills'} WHERE id=? AND user_id=? AND deleted_at IS NULL`).bind(memoryId, p.userId).first<{ id: string; shared: number }>();
    if (!target) throw new Error('owned durable memory required');
    const relation = ['derived_from', 'confirms', 'contradicts'].includes(String(args.relation)) ? String(args.relation) : 'derived_from';
    const confidence = typeof args.confidence === 'number' && Number.isFinite(args.confidence) ? Math.max(0, Math.min(1, args.confidence)) : 0;
    const { eventIds } = await this.provenanceSources(p, args.source_event_ids, Boolean(target.shared));
    // Two set-based statements keep a 50-source attachment below D1's per-
    // invocation query ceiling. JSON metadata is already scrubbed on ingress.
    const placeholders = eventIds.map(() => '?').join(',');
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO memory_provenance (memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at)
        SELECT ?,?,id,session_id,?,?,?,?,?,json_set(json_remove(metadata_json,'$.cwd'),'$.occurred_at',occurred_at,'$.event_type',event_type,'$.payload_hash',payload_hash,'$.visibility',visibility),?
        FROM capture_events WHERE user_id=? AND id IN (${placeholders})`)
        .bind(kind, memoryId, p.userId, relation, text(args.generated_by), confidence, text(args.rationale, 500), Date.now(), p.userId, ...eventIds),
      this.db.prepare(`UPDATE capture_events SET distill_status='applied' WHERE user_id=? AND id IN (${placeholders})`).bind(p.userId, ...eventIds),
    ]);
    return { ok: true };
  }
  async heartbeat(p: Principal, args: Record<string, unknown>) {
    requireCaller(p);
    const clientId = id(args.client_id);
    const status = scrub(args.status ?? {});
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('heartbeat status must be an object');
    if (JSON.stringify(status).length > 4096) throw new Error('heartbeat too large');
    await this.db.prepare('INSERT INTO client_heartbeats(user_id,client_id,status_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET status_json=excluded.status_json,updated_at=excluded.updated_at').bind(p.userId, clientId, JSON.stringify(status), Date.now()).run();
    return { ok: true };
  }
  async health(p: Principal) {
    requireCaller(p);
    const r = await this.db.prepare('SELECT client_id,status_json,updated_at FROM client_heartbeats WHERE user_id=? ORDER BY updated_at DESC LIMIT 20').bind(p.userId).all<{ client_id: string; status_json: string; updated_at: number }>();
    return (r.results ?? []).map(row => {
      const status = record(JSON.parse(row.status_json)), recall = record(record(status.hooks).recall), attempts = record(status.provider_attempts);
      const positive = (value: unknown) => typeof value === 'number' && value > 0;
      const staleRecall = status.capture_enabled === true && status.recall_enabled !== false && (typeof recall.last_success !== 'number' || Date.now() - recall.last_success > 86400000);
      const providerHeld = status.distill_enabled === true && ['blocked','waiting','in_flight','cooldowns','invalid'].some(key => positive(attempts[key]));
      const state: 'offline' | 'degraded' | 'healthy' = Date.now() - row.updated_at > 86400000 ? 'offline' : status.ok === false || positive(status.pending) || status.distill_enabled === true && (positive(status.ready_to_distill) || positive(status.stale_awaiting_checkpoint)) || providerHeld || staleRecall ? 'degraded' : 'healthy';
      return { client_id: row.client_id, updated_at: row.updated_at, status, state };
    });
  }
  async prune(cutoff = Date.now(), maxBatches = 1) {
    const batchSize = 500;
    const statement = this.db.prepare('DELETE FROM capture_events WHERE rowid IN (SELECT rowid FROM capture_events WHERE expires_at<=? ORDER BY expires_at LIMIT ?)').bind(cutoff, batchSize);
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const { meta } = await statement.run();
      removed += meta.changes;
      if (meta.changes < batchSize) break;
    }
    return removed;
  }
}
