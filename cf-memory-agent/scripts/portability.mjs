import { createHash, randomUUID } from 'node:crypto';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { credentials, createMcp } from './transport.mjs';
import { scrubText, markedPrivate, deniedPath } from './redact.mjs';
import { normalizeScope } from './scope.mjs';

const FORMAT = 'cf-memory-memory/v1', MAX_ARCHIVE = 128 * 1048576, MAX_RECORDS = 10000;
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,100}$/;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function fail(message) { throw Error(message); }
// A refusal whose message is safe to print: ids and numbers only, never memory content.
export class PortabilityRefusal extends Error {}

// What the server stores for a note's text (src/notes.ts: MAX_NOTE_BODY_CHARS,
// singleLine, normalizeTags, inertBody; src/frontmatter.ts parseFrontmatter;
// src/slug.ts slugify). A restore compares the row it created with this, not
// with the archive's text: an archive may hold rows stored before these rules.
export const MAX_NOTE_BODY_CHARS = 262144;
const CONTROL_RUN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, LEADING_BLANK = /^[\uFEFF\s]+/;
const singleLine = value => value.replace(CONTROL_RUN, ' ').trim();
const tagKey = tag => tag.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'untitled';
// A leading `---` block with at least one `key: value` line: the block the server would lift as frontmatter.
function keyedBlock(value) {
  const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(value);
  // The server's parser assigns onto a plain object, so a `__proto__` line adds no key of its own.
  return Boolean(block) && block[1].split(/\r?\n/).some(line => { const key = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line)?.[1]; return key !== undefined && key !== '__proto__'; });
}
/** The stored form of a note record: { title, body_md, tags, content_hash }. */
export function storedNote(r) {
  // The first non-blank line of a stored body is never a liftable `---` fence: it is rewritten to `***`.
  const lead = LEADING_BLANK.exec(r.body_md)?.[0].length ?? 0, rest = r.body_md.slice(lead);
  const body_md = keyedBlock(rest) ? r.body_md.slice(0, lead) + '***' + rest.slice(3) : r.body_md;
  // Each run of control characters in a title or tag becomes one space.
  const title = singleLine(r.title) || 'Untitled', tags = [], seen = new Set();
  for (const raw of r.tags) {
    const tag = singleLine(String(raw)).replace(/^#/, ''), key = tag && tagKey(tag);
    if (!tag || key === 'untitled' || seen.has(key)) continue;
    seen.add(key); tags.push(tag);
  }
  return { title, body_md, tags, content_hash: digest(title + '\n' + body_md + '\n' + tags.join(',')) };
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function known(value, fields) { if (Object.keys(value).some(k => !fields.includes(k))) fail('unknown portable schema field'); }
function safe(value, depth = 0) {
  if (depth > 32) fail('portable data exceeds nesting limit');
  if (typeof value === 'string' && (scrubText(value) !== value || markedPrivate(value))) fail('portable data contains private or recognized sensitive content');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (/(?:authorization|cookie|password|passwd|private[_-]?key|api[_-]?key|token|secret|oauth)/i.test(key) && child !== '[REDACTED]') fail('portable data contains a sensitive field');
    safe(key, depth + 1); safe(child, depth + 1);
  }
}
function integer(v, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('invalid portable integer'); }
function text(v, max = 1048576) { if (typeof v !== 'string' || Buffer.byteLength(v) > max) fail('invalid portable text'); }
function nullableTime(v) { if (v != null) integer(v); }
function filePath(path) {
  if (typeof path !== 'string' || path.length > 255 || !/^(scripts|references|assets)\//.test(path) || /[\\\"\x00-\x1f\x7f]/.test(path) || path.normalize('NFC') !== path || path.split('/').length > 10 || path.split('/').some(p => !p || p.startsWith('.') || p.length > 100) || deniedPath(path)) fail('unsafe portable bundle path');
}
function assetBytes(file) {
  filePath(file.path); integer(file.size, 5 * 1048576); text(file.content_type, 160);
  if (!HASH.test(file.sha256) || typeof file.content_base64 !== 'string' || file.content_base64.length > Math.ceil(5 * 1048576 / 3) * 4) fail('invalid portable asset');
  const bytes = Buffer.from(file.content_base64, 'base64');
  if (bytes.toString('base64') !== file.content_base64 || bytes.length !== file.size || digest(bytes) !== file.sha256) fail('portable asset integrity mismatch');
  safe(bytes.toString('utf8')); return bytes;
}
export function validateArchive(archive) {
  if (!object(archive) || archive.format !== FORMAT || !object(archive.source) || !HASH.test(archive.source.instance) || !ID.test(archive.source.owner_id) || !HASH.test(archive.checksum)) fail('invalid portable archive');
  integer(archive.created_at);
  known(archive, ['format','source','created_at','records','checksum']); known(archive.source, ['instance','owner_id']);
  if (!Array.isArray(archive.records) || archive.records.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(archive)) > MAX_ARCHIVE) fail('portable archive exceeds limits');
  const { checksum, ...payload } = archive;
  if (digest(payload) !== checksum) fail('portable archive checksum mismatch');
  safe(payload); const ids = new Set();
  for (const r of archive.records) {
    if (!object(r) || !['note', 'skill', 'block'].includes(r.memory_kind) || !ID.test(r.id) || ids.has(r.memory_kind + ':' + r.id) || !HASH.test(r.content_hash)) fail('invalid or duplicate portable record');
    ids.add(r.memory_kind + ':' + r.id); text(r.slug, 500); text(r.scope, 500);
    known(r, ['memory_kind','id','slug','scope','content_hash','frontmatter','created_at','updated_at','provenance', ...(r.memory_kind === 'skill' ? ['name','description','version','parent_skill_id','skill_md','instructions_md','files'] : ['title','kind','stage','type','shared','pinned_block_label','char_limit','archived_at','valid_from','valid_until','supersedes','superseded_by','body_md','tags'])]);
    if (normalizeScope(r.scope) !== r.scope) fail('portable scope must be canonical; refusing scope widening');
    if (!object(r.frontmatter)) fail('invalid portable frontmatter');
    integer(r.created_at); integer(r.updated_at);
    if (!Array.isArray(r.provenance) || r.provenance.length > 10000) fail('invalid portable provenance');
    for (const p of r.provenance) {
      if (!object(p) || !HASH.test(p.event_id) || !HASH.test(p.source_session_id) || !ID.test(p.actor_id) || !['derived_from', 'confirms', 'contradicts'].includes(p.relation) || !object(p.source)) fail('invalid portable provenance snapshot');
      integer(p.created_at); text(p.generated_by, 160); text(p.rationale, 500);
      known(p, ['event_id','source_session_id','actor_id','relation','generated_by','confidence','rationale','created_at','source']);
      known(p.source, ['file_refs','repo_context','tool_name','event_type','actor','client','client_version','plugin_version','truncated','denied','occurred_at','payload_hash','visibility','imported','import_verified','imported_origin','previous_import_origin']);
      if (p.source.visibility !== undefined && !['personal','project'].includes(p.source.visibility)) fail('invalid portable source visibility');
      if (p.source.payload_hash != null && !HASH.test(p.source.payload_hash)) fail('invalid portable source hash');
      if (p.source.occurred_at != null) integer(p.source.occurred_at);
      if (p.source.imported === true) { const o = p.source.imported_origin; if (!object(o) || !HASH.test(o.instance) || !HASH.test(o.event_id) || !HASH.test(o.session_id) || !ID.test(o.actor_id) || !ID.test(o.owner_id) || !ID.test(o.memory_id)) fail('invalid imported origin'); integer(o.created_at); }
    }
    if (r.memory_kind === 'skill') {
      text(r.name, 500); text(r.description, 1048576); text(r.skill_md); text(r.instructions_md); text(r.version, 100);
      if (digest(r.name + '\n' + r.description + '\n' + r.instructions_md) !== r.content_hash) fail('portable skill content hash mismatch');
      if (!Array.isArray(r.files) || r.files.length > 100) fail('invalid portable files');
      const paths = new Set(); let total = 0;
      for (const file of r.files) { assetBytes(file); if (paths.has(file.path)) fail('duplicate portable asset'); paths.add(file.path); total += file.size; }
      if (total > 25 * 1048576) fail('portable bundle exceeds limit');
    } else {
      text(r.title, 2000); text(r.body_md); text(r.stage, 100);
      if (!['seedling','budding','evergreen'].includes(r.stage)) fail('invalid portable stage');
      if (!(r.type == null || ['user', 'feedback', 'project', 'reference'].includes(r.type)) || typeof r.shared !== 'boolean' || !Array.isArray(r.tags) || r.tags.length > 1000) fail('invalid portable note metadata');
      for (const tag of r.tags) text(tag, 100);
      if (!['note','journal','observation','block'].includes(r.kind) || (r.memory_kind === 'block') !== (r.kind === 'block')) fail('invalid portable note kind');
      if (digest(r.title + '\n' + r.body_md + '\n' + r.tags.join(',')) !== r.content_hash) fail('portable note content hash mismatch');
      for (const name of ['valid_from', 'valid_until', 'archived_at']) nullableTime(r[name]);
      for (const name of ['supersedes', 'superseded_by']) if (r[name] != null && !ID.test(r[name])) fail('invalid portable lifecycle reference');
      if (r.memory_kind === 'block') { if (typeof r.pinned_block_label !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.pinned_block_label)) fail('invalid portable block label'); if (r.char_limit != null) integer(r.char_limit, 1048576); }
    }
  }
  return archive;
}
async function boundedBytes(response, limit) {
  if (!response.ok || !response.body) fail('portable asset download failed');
  const reader = response.body.getReader(), pieces = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); fail('portable asset exceeds limit'); } pieces.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(pieces);
}
export async function exportArchive(call, connection, fetcher = fetch) {
  const identity = await call('whoami');
  const owner = identity.user_id ?? identity.userId ?? identity.id;
  if (!ID.test(owner || '')) fail('authenticated owner identity unavailable');
  const endpoint = new URL(connection.url); const records = [];
  for (const kind of ['note', 'skill', 'block']) {
    let cursor = null; const seen = new Set();
    do {
      const page = await call('memory_export', { kind, cursor, limit: 5 });
      if (page.format !== FORMAT || !Array.isArray(page.records)) fail('server lacks compatible portability');
      for (const value of page.records) {
        const r = { ...value, memory_kind: kind, provenance: [] }; safe(r);
        let pc = null, before;
        do {
          const p = await call('memory_export_provenance', { kind, id: r.id, cursor: pc, ...(before ? { before } : {}) });
          if (!p.found) fail('memory changed during backup');
          before = p.before; r.provenance.push(...p.snapshots); pc = p.next_cursor;
          if (r.provenance.length > 10000) fail('portable provenance exceeds limit');
        } while (pc);
        if (kind === 'skill') {
          const files = [];
          for (const file of r.files) {
            filePath(file.path);
            const result = await call('skills_file_read', { id: r.id, path: file.path });
            let bytes;
            if (result.found !== true) fail('portable asset missing');
            if (result.encoding === 'utf8') bytes = Buffer.from(result.content);
            else if (result.encoding === 'base64') bytes = Buffer.from(result.content, 'base64');
            else if (result.url) {
              const target = new URL(result.url, endpoint);
              if (target.origin !== endpoint.origin || target.username || target.password || target.hash || target.search || !(target.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) fail('unsafe portable asset URL');
              bytes = await boundedBytes(await fetcher(target, { headers: { Authorization: 'Bearer ' + connection.token }, redirect: 'error', signal: AbortSignal.timeout(15000) }), 5 * 1048576);
            } else fail('invalid portable asset response');
            const packed = { ...file, content_base64: bytes.toString('base64') }; assetBytes(packed); files.push(packed);
          }
          r.files = files;
        }
        const current = await call('memory_export', { kind, id: r.id, limit: 1 });
        if (current.records?.length !== 1 || JSON.stringify(current.records[0]) !== JSON.stringify(value)) fail('memory changed during backup; retry');
        safe(r); records.push(r);
        if (records.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(records)) > MAX_ARCHIVE) fail('portable archive exceeds limits');
      }
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor)) fail('non-progressing export cursor');
      seen.add(cursor);
    } while (cursor);
  }
  const payload = { format: FORMAT, source: { instance: digest(endpoint.origin + endpoint.pathname), owner_id: owner }, created_at: Date.now(), records };
  return validateArchive({ ...payload, checksum: digest(payload) });
}
export async function writeArchive(filename, archive) {
  validateArchive(archive); const target = resolve(filename), temporary = target + '.' + randomUUID() + '.tmp';
  const out = await open(temporary, 'wx', 0o600);
  try { await out.writeFile(JSON.stringify(archive) + '\n'); await out.sync(); await out.close(); await link(temporary, target); const dir = await open(dirname(target), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  finally { await out.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export async function readArchive(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_ARCHIVE) fail('portable archive exceeds limits');
    const pieces = []; let size = 0;
    for (;;) { const buffer = Buffer.alloc(1048576); const { bytesRead } = await file.read(buffer); if (!bytesRead) break; size += bytesRead; if (size > MAX_ARCHIVE) fail('portable archive exceeds limits'); pieces.push(buffer.subarray(0, bytesRead)); }
    return validateArchive(JSON.parse(Buffer.concat(pieces).toString('utf8')));
  }
  finally { await file.close(); }
}
function originKey(archive, r) { return digest([archive.source.instance, archive.source.owner_id, r.memory_kind, r.id]); }
function targetSlug(archive, r) { return 'import-' + originKey(archive, r).slice(0, 48); }
function ordered(records) {
  const byId = new Map(records.filter(r => r.memory_kind === 'note').map(r => [r.id, r])), done = new Set(), active = new Set(), result = [];
  const visit = r => { const k = r.memory_kind + ':' + r.id; if (done.has(k)) return; if (active.has(k)) fail('portable supersession cycle'); active.add(k); if (r.memory_kind === 'note' && r.supersedes && byId.has(r.supersedes)) visit(byId.get(r.supersedes)); active.delete(k); done.add(k); result.push(r); };
  records.forEach(visit); return result;
}
export async function importArchive(call, input, { apply = false, includeCore = false } = {}) {
  const archive = validateArchive(input), records = ordered(archive.records.filter(r => r.memory_kind !== 'block' || includeCore));
  const plan = [], mapping = new Map();
  // Complete schema/privacy + conflict preflight before the first durable write.
  // A row restored earlier matches when it holds the archive's text or its stored form.
  for (const r of records) {
    const kind = r.memory_kind, marker = originKey(archive, r), slug = targetSlug(archive, r);
    const stored = kind === 'skill' ? null : storedNote(r), hashes = [r.content_hash, stored?.content_hash];
    // Refused here, in a dry run too, and not after the records before it were written.
    const tooLarge = () => { throw new PortabilityRefusal('portable ' + kind + ' ' + r.id + ' has a body of ' + r.body_md.length + ' characters; the server stores at most ' + MAX_NOTE_BODY_CHARS + ' per note. Shorten or split it at the source and export again. Nothing was written.'); };
    if (kind === 'block') {
      const page = await call('memory_export', { kind: 'block' }); let rows = [...page.records], cursor = page.next_cursor;
      while (cursor) { const p = await call('memory_export', { kind: 'block', cursor }); rows.push(...p.records); cursor = p.next_cursor; }
      const own = rows.find(x => x.pinned_block_label === r.pinned_block_label);
      if (own && (![r.body_md, stored.body_md].includes(own.body_md) || own.char_limit !== r.char_limit)) fail('existing core block conflicts with restore');
      if (!own && r.body_md.length > MAX_NOTE_BODY_CHARS) tooLarge();
      plan.push({ r, slug, marker, hashes, existing: own, skip: Boolean(own) }); if (own) mapping.set(kind + ':' + r.id, own.id); continue;
    }
    const own = await call(kind === 'skill' ? 'skills_get' : 'notes_get', { slug });
    if (own.found && (own.frontmatter?.cf_memory_import_origin !== marker || !hashes.includes(own.content_hash) || own.scope !== r.scope || (kind !== 'skill' && (own.shared || own.type !== r.type || own.kind !== r.kind || own.stage !== r.stage || own.valid_from !== r.valid_from || own.valid_until !== r.valid_until || own.supersedes !== (mapping.get('note:' + r.supersedes) ?? null) || (r.archived_at == null && own.archived_at != null))))) fail('existing import conflicts; refusing overwrite');
    if (!own.found && kind !== 'skill' && r.body_md.length > MAX_NOTE_BODY_CHARS) tooLarge();
    plan.push({ r, slug, marker, hashes, existing: own.found ? own : null }); if (own.found) mapping.set(kind + ':' + r.id, own.id);
  }
  const missingPredecessors = records.filter(r => r.memory_kind === 'note' && r.supersedes && !records.some(x => x.memory_kind === 'note' && x.id === r.supersedes)).length;
  if (!apply) return { ok: true, mode: 'dry-run', records: plan.length, create: plan.filter(p => !p.existing).length, existing: plan.filter(p => p.existing).length, missing_predecessors: missingPredecessors, skipped_core: archive.records.filter(r => r.memory_kind === 'block').length - records.filter(r => r.memory_kind === 'block').length, sharing: 'private' };
  let created = 0, provenance = 0, files = 0;
  for (const { r, slug, marker, hashes, existing, skip } of plan) {
    if (skip) continue;
    const kind = r.memory_kind;
    const fm = { ...r.frontmatter, cf_memory_import_origin: marker, cf_memory_imported_at: Date.now(), date: r.created_at, cf_memory_import_source_lifecycle: { archived_at: r.archived_at ?? null, supersedes: r.supersedes ?? null, superseded_by: r.superseded_by ?? null, created_at: r.created_at, updated_at: r.updated_at } };
    const result = existing || (kind === 'skill'
      ? await call('skills_put', { slug, name: r.name, description: r.description, skill_md: r.skill_md, instructions: r.instructions_md, version: r.version, scope: r.scope, frontmatter: fm, create_only: true })
      : kind === 'block' ? await call('memory_set', { label: r.pinned_block_label, value: r.body_md, char_limit: r.char_limit, create_only: true })
        : await call('notes_put', { slug, title: r.title, body_md: '---\ncf_memory_import_body_literal: true\n---\n\n' + r.body_md, type: r.type, kind: r.kind, stage: r.stage, scope: r.scope, tags: r.tags, shared: false, frontmatter: fm, valid_from: r.valid_from, valid_until: r.valid_until, ...(r.supersedes && mapping.has('note:' + r.supersedes) ? { supersedes: mapping.get('note:' + r.supersedes) } : {}), create_only: true }));
    if (!existing) created++;
    let id = result.id;
    if (kind === 'block') { let p = await call('memory_export', { kind: 'block' }); while (!id) { id = p.records.find(x => x.pinned_block_label === r.pinned_block_label)?.id; if (!id && p.next_cursor) p = await call('memory_export', { kind: 'block', cursor: p.next_cursor }); else break; } }
    if (!id) fail('restore acknowledgement missing'); mapping.set(kind + ':' + r.id, id);
    if (kind === 'skill') for (const file of r.files) { await call('skills_file_create', { id, path: file.path, content_type: file.content_type, content_base64: file.content_base64 }); files++; }
    const current = await call('memory_export', { kind, id, limit: 1 }), row = current.records?.[0];
    if (!row || !hashes.includes(row.content_hash) || row.scope !== r.scope || row.shared) fail('restored memory changed or widened');
    for (let i = 0; i < r.provenance.length; i += 25) { const attached = await call('memory_import_provenance', { kind, id, expected_content_hash: row.content_hash, expected_scope: row.scope, origin: { ...archive.source, memory_id: r.id }, snapshots: r.provenance.slice(i, i + 25) }); provenance += attached.created; }
    if (kind === 'note' && r.archived_at != null && row.archived_at == null) { const archived = await call('notes_archive', { id, expected_content_hash: row.content_hash, expected_scope: row.scope, private_only: true }); if (!archived.archived) fail('restored note changed before archive'); }
  }
  return { ok: true, mode: 'apply', records: plan.length, created, provenance, files, missing_predecessors: missingPredecessors, sharing: 'private' };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const [command, filename, ...flags] = args;
  if (!['export', 'import'].includes(command) || !filename || flags.some(f => !['--apply', '--include-core'].includes(f)) || (command === 'export' && flags.length)) fail('usage: portability.mjs export FILE | import FILE [--apply] [--include-core]');
  const input = command === 'import' ? await readArchive(filename) : null;
  if (command === 'export') { try { await lstat(filename); fail('backup file already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const connection = await credentials(env), call = createMcp(connection, 20000, fetch, 16 * 1048576);
  if (command === 'export') { const archive = await exportArchive(call, connection); await writeArchive(filename, archive); return { ok: true, records: archive.records.length, mode: 'export' }; }
  return importArchive(call, input, { apply: flags.includes('--apply'), includeCore: flags.includes('--include-core') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error instanceof PortabilityRefusal ? 'cf-memory portability refused: ' + error.message + '\n' : 'cf-memory portability failed; no credentials or memory content logged. Check archive, conflicts, server capability and authentication.\n'); process.exitCode = 1; });
}
