import { allows } from './auth';
import type { Principal } from './types';
import type { NotesRepo } from './notes';
import type { SkillsRepo } from './skills';
import { sha256hex } from './db';
import { scrubText } from '../cf-memory-agent/scripts/redact.mjs';

export class PortabilityInputError extends Error {}
const MAX_TEXT = 1048576, MAX_PAGE = 3 * 1048576;
const HASH = /^[a-f0-9]{64}$/;
function record(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function key(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v)) throw new PortabilityInputError('invalid portable identifier');
  return v;
}
function hash(v: unknown): string { if (typeof v !== 'string' || !HASH.test(v)) throw new PortabilityInputError('invalid portable hash'); return v; }
function text(v: unknown, size = 500) { return scrubText(typeof v === 'string' ? v : '').slice(0, size); }
function caller(p: Principal, write = false) { if (p.anonymous || !allows(p,write ? 'notes:write' : 'notes:read')) throw new Error('authenticated scope required'); }
function kind(v: unknown): 'note' | 'skill' | 'block' {
  if (v !== 'note' && v !== 'skill' && v !== 'block') throw new PortabilityInputError('kind must be note, skill or block');
  return v;
}
function timestamp(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new PortabilityInputError('invalid portable timestamp');
  return v;
}
interface ExportRow extends Record<string, unknown> {
  id: string; frontmatter_json: string; body_md?: string | null; skill_md?: string | null; instructions_md?: string | null;
  scope: string; content_hash: string; updated_at: number;
}
interface SourceRow {
  event_id: string; source_session_id: string; actor_id: string; relation: string; generated_by: string;
  confidence: number; rationale: string; source_metadata_json: string; created_at: number;
}

/** Explicit owner-only backups, separate from retrieval and automatic memory.
 * Durable restores use existing writes on the client. This service only reads
 * metadata/text and records private, clearly unverified imported provenance. */
export class PortabilityService {
  constructor(private db: D1Database, private notes: NotesRepo, private skills: SkillsRepo) {}
  async exportPage(p: Principal, args: Record<string, unknown>) {
    caller(p); const memoryKind = kind(args.kind);
    const after = args.cursor == null ? '' : key(args.cursor);
    const selected = args.id == null ? null : key(args.id);
    if (args.limit != null && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 5)) throw new PortabilityInputError('limit must be 1-5');
    const count = typeof args.limit === 'number' ? args.limit : 5;
    // Bound the text IN SQL, before materializing it in Worker memory. A large
    // record is an explicit error, never a truncated successful backup.
    const fields = memoryKind === 'skill'
      ? `id,slug,name,description,version,scope,parent_skill_id,content_hash,created_at,updated_at,
         CASE WHEN length(CAST(skill_md AS BLOB))<=${MAX_TEXT} THEN skill_md END AS skill_md,
         CASE WHEN length(CAST(instructions_md AS BLOB))<=${MAX_TEXT} THEN instructions_md END AS instructions_md,`
      : `id,slug,title,kind,stage,scope,type,shared,pinned_block_label,char_limit,content_hash,created_at,updated_at,
         archived_at,valid_from,valid_until,supersedes,superseded_by,
         CASE WHEN length(CAST(body_md AS BLOB))<=${MAX_TEXT} THEN body_md END AS body_md,`;
    const table = memoryKind === 'skill' ? 'skills' : 'notes';
    const subset = memoryKind === 'skill' ? '' : memoryKind === 'block' ? " AND kind='block'" : " AND kind!='block'";
    const rows = await this.db.prepare(`SELECT ${fields} CASE WHEN length(CAST(frontmatter_json AS BLOB))<=65536 THEN frontmatter_json END AS frontmatter_json
      FROM ${table} WHERE user_id=? AND deleted_at IS NULL ${subset} AND id>? ${selected ? 'AND id=?' : ''} ORDER BY id LIMIT ?`)
      .bind(p.userId, after, ...(selected ? [selected] : []), count + 1).all<ExportRow>();
    const page: Record<string, unknown>[] = []; let bytes = 0;
    for (const row of rows.results.slice(0, count)) {
      if (row.frontmatter_json == null || (memoryKind === 'skill' ? row.skill_md == null || row.instructions_md == null : row.body_md == null)) throw new PortabilityInputError('record exceeds portable text/metadata limit');
      const frontmatter = JSON.parse(row.frontmatter_json);
      // content_hash includes tag order/spelling from the write, while the tag
      // join returns alphabetical shared tag names. Preserve the write's tags.
      const current = { ...row, frontmatter, frontmatter_json: undefined,
        ...(memoryKind !== 'skill' ? { shared: row.shared === 1, tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : await this.notes.tagsFor(row.id, p.userId) } : { files: (await this.skills.listFiles(row.id)).map(f => ({ path: f.path, content_type: f.content_type, size: f.size, sha256: f.sha256 })) }) };
      // Re-read the owner/liveness/current metadata after ancillary queries.
      // This prevents a deleted or changed candidate from being emitted stale.
      const live = await this.db.prepare(`SELECT ${fields} CASE WHEN length(CAST(frontmatter_json AS BLOB))<=65536 THEN frontmatter_json END AS frontmatter_json FROM ${table} WHERE user_id=? AND id=? AND deleted_at IS NULL ${subset}`).bind(p.userId, row.id).first<ExportRow>();
      if (!live || JSON.stringify(live) !== JSON.stringify(row)) throw new PortabilityInputError('record changed during export; retry');
      const size = new TextEncoder().encode(JSON.stringify(current)).byteLength;
      if (size > MAX_PAGE) throw new PortabilityInputError('record exceeds portable page limit');
      if (bytes + size > MAX_PAGE) break;
      page.push(current); bytes += size;
    }
    const last = page.at(-1);
    return { format: 'cf-memory-memory/v1', kind: memoryKind, records: page, next_cursor: rows.results.length > page.length && last ? last.id : null, max_text_bytes: MAX_TEXT };
  }
  private async owned(p: Principal, memoryKind: 'note' | 'skill' | 'block', memoryId: string) {
    const table = memoryKind === 'skill' ? 'skills' : 'notes';
    const row = await this.db.prepare(`SELECT id,scope,content_hash,${memoryKind === 'skill' ? '0 AS shared' : 'shared'} FROM ${table} WHERE user_id=? AND id=? AND deleted_at IS NULL ${memoryKind === 'block' ? "AND kind='block'" : memoryKind === 'note' ? "AND kind!='block'" : ''}`).bind(p.userId, memoryId).first<{ id: string; scope: string; content_hash: string; shared: number }>();
    return row;
  }
  async exportProvenance(p: Principal, args: Record<string, unknown>) {
    caller(p); const memoryKind = kind(args.kind), memoryId = key(args.id), row = await this.owned(p, memoryKind, memoryId);
    if (!row) return { found: false, snapshots: [], next_cursor: null };
    const before = args.before == null ? Date.now() : timestamp(args.before);
    if (before > Date.now()) throw new PortabilityInputError('future provenance boundary');
    const after = args.cursor == null ? null : record(args.cursor);
    if (after && (typeof after.relation !== 'string' || !['derived_from','confirms','contradicts'].includes(after.relation))) throw new PortabilityInputError('invalid provenance cursor');
    const snapshots = await this.db.prepare(`SELECT event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at
      FROM memory_provenance WHERE memory_kind=? AND memory_id=? AND created_at<?
      ${after ? 'AND (created_at>? OR (created_at=? AND (event_id>? OR (event_id=? AND relation>?))))' : ''}
      ORDER BY created_at,event_id,relation LIMIT 26`)
      .bind(memoryKind === 'skill' ? 'skill' : 'note', memoryId, before, ...(after ? [timestamp(after.at), timestamp(after.at), hash(after.event_id), hash(after.event_id), after.relation as string] : [])).all<SourceRow>();
    const items = snapshots.results.slice(0, 25);
    // The target is still owned/live after reading its private metadata.
    if (!await this.owned(p, memoryKind, memoryId)) return { found: false, snapshots: [], next_cursor: null };
    const last = items.at(-1);
    return { found: true, before, snapshots: items.map(s => ({ ...s, source: JSON.parse(s.source_metadata_json), source_metadata_json: undefined })), next_cursor: snapshots.results.length > 25 && last ? { at: last.created_at, event_id: last.event_id, relation: last.relation } : null };
  }
  async importProvenance(p: Principal, args: Record<string, unknown>) {
    caller(p,true); const memoryKind = kind(args.kind), memoryId = key(args.id), expectedHash = hash(args.expected_content_hash);
    if (typeof args.expected_scope !== 'string' || args.expected_scope.length > 500) throw new PortabilityInputError('expected scope required');
    const row = await this.owned(p, memoryKind, memoryId);
    if (!row || row.shared || row.content_hash !== expectedHash || row.scope !== args.expected_scope) throw new PortabilityInputError('owned private memory at expected hash/scope required');
    const origin = record(args.origin), instance = hash(origin.instance), sourceOwner = key(origin.owner_id), sourceMemory = key(origin.memory_id);
    if (!Array.isArray(args.snapshots) || !args.snapshots.length || args.snapshots.length > 25 || JSON.stringify(args.snapshots).length > 512000) throw new PortabilityInputError('provide 1-25 bounded provenance snapshots');
    const entries = [];
    for (const value of args.snapshots) {
      const snapshot = record(value), source = record(snapshot.source);
      const event = hash(snapshot.event_id), session = hash(snapshot.source_session_id);
      if (!['derived_from','confirms','contradicts'].includes(String(snapshot.relation))) throw new PortabilityInputError('invalid provenance relation');
      const clean: Record<string, unknown> = { imported: true, import_verified: false,
        imported_origin: { instance, owner_id: sourceOwner, memory_id: sourceMemory, event_id: event, session_id: session, actor_id: key(snapshot.actor_id), created_at: timestamp(snapshot.created_at), generated_by: text(snapshot.generated_by, 160), confidence: typeof snapshot.confidence === 'number' && Number.isFinite(snapshot.confidence) ? Math.max(0, Math.min(1, snapshot.confidence)) : 0 },
      };
      for (const name of ['tool_name','event_type','client','client_version','plugin_version']) clean[name] = text(source[name], 160);
      for (const name of ['repo_context','file_refs']) clean[name] = Array.isArray(source[name]) ? source[name].slice(0,20).map(v => text(v)) : [];
      for (const name of ['occurred_at']) if (source[name] != null) clean[name] = timestamp(source[name]);
      if (source.payload_hash != null) clean.payload_hash = hash(source.payload_hash);
      if (source.visibility !== undefined) {
        if (source.visibility !== 'personal' && source.visibility !== 'project') throw new PortabilityInputError('invalid portable source visibility');
        // An imported source claim is never a read permission or verified event.
        clean.visibility = source.visibility;
      }
      // Preserve a previous import's original claim without treating it as a
      // verified actor. Only the known bounded origin fields cross another hop.
      const previous = record(source.imported_origin);
      if (source.imported === true && HASH.test(String(previous.instance)) && HASH.test(String(previous.event_id))) clean.previous_import_origin = { instance: hash(previous.instance), event_id: hash(previous.event_id), session_id: hash(previous.session_id), owner_id: key(previous.owner_id), actor_id: key(previous.actor_id), memory_id: key(previous.memory_id), created_at: timestamp(previous.created_at), generated_by: text(previous.generated_by,160) };
      entries.push({ event_id: await sha256hex(JSON.stringify(['cf-memory-import/v1',instance,sourceOwner,event])), session_id: await sha256hex(JSON.stringify(['cf-memory-import-session/v1',instance,sourceOwner,session])), relation: snapshot.relation, rationale: text(snapshot.rationale), source: JSON.stringify(clean) });
    }
    const table = memoryKind === 'skill' ? 'skills' : 'notes', privateClause = memoryKind === 'skill' ? '' : 'AND COALESCE(shared,0)=0';
    const result = await this.db.prepare(`INSERT OR IGNORE INTO memory_provenance(memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at)
      SELECT ?,?,json_extract(e.value,'$.event_id'),json_extract(e.value,'$.session_id'),?,json_extract(e.value,'$.relation'),'cf-memory-import/v1',0,json_extract(e.value,'$.rationale'),json_extract(e.value,'$.source'),?
      FROM json_each(?) e WHERE EXISTS(SELECT 1 FROM ${table} WHERE id=? AND user_id=? AND deleted_at IS NULL ${privateClause} AND content_hash=? AND scope=?)`)
      .bind(memoryKind === 'skill' ? 'skill' : 'note', memoryId, p.userId, Date.now(), JSON.stringify(entries), memoryId, p.userId, expectedHash, args.expected_scope).run();
    const live = await this.owned(p, memoryKind, memoryId);
    if (!live || live.shared || live.content_hash !== expectedHash || live.scope !== args.expected_scope) throw new PortabilityInputError('memory changed during provenance import');
    return { ok: true, created: result.meta.changes, imported: true, verified: false };
  }
}
