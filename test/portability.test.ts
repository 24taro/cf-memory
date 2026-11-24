import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';
// Node-only CLI is deliberately outside the Worker TypeScript build.
// @ts-expect-error integration exercises the shipped JavaScript entry points
import { exportArchive, importArchive, validateArchive } from '../cf-memory-agent/scripts/portability.mjs';
const alice = principalFixture({ userId: 'alice', handle: 'alice', scopes: new Set(['notes:read', 'notes:write']) });
const bob = principalFixture({ userId: 'bob', handle: 'bob', scopes: new Set(['notes:read', 'notes:write']) });
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
const hash = (n: number) => n.toString(16).padStart(64, '0');
const snapshot = (n: number) => ({ event_id: hash(n), source_session_id: hash(1), actor_id: 'original-actor', relation: 'derived_from', generated_by: 'original-agent', confidence: 0.99, rationale: 'API_KEY=do-not-store', created_at: 1000, source: { file_refs: ['src/private-import.ts'], tool_name: 'Read', payload: 'must-not-cross', payload_hash: hash(2), cwd: '/private/context' } });
async function call(name: string, args: Record<string, unknown>, p = alice) {
  const response = await handleMcp(new Request('https://memory.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { principal: p, services, budget: 4000 });
  const result = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
  if (result.result.isError) throw Error('tool rejected');
  return JSON.parse(result.result.content[0].text);
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'], r2Buckets: ['BUNDLES'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const raw = readFileSync('migrations/' + name, 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const sql of raw.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle, p.handle + '@example.com').run();
  services = makeServices(db, await mf.getR2Bucket('BUNDLES') as unknown as R2Bucket);
});
afterAll(async () => { await mf?.dispose(); });
it('rejects repeating provenance pages with the same continuation', async () => {
  const source = { ...snapshot(41), rationale: 'Fixture' };
  const cursor = { at: source.created_at, event_id: source.event_id, relation: source.relation };
  let pages = 0;
  const mock = async (name: string) => {
    if (name === 'whoami') return { user_id: 'owner' };
    if (name === 'memory_export') return { format: 'cf-memory-memory/v1', records: [{ id: 'example' }], next_cursor: null };
    if (name === 'memory_export_provenance') {
      pages++;
      return { found: true, before: 3000, snapshots: [source], next_cursor: cursor };
    }
    throw Error('unexpected tool');
  };
  await expect(exportArchive(mock, { url: 'https://memory.test/mcp', token: 'fixture' })).rejects.toThrow('non-progressing provenance cursor');
  expect(pages).toBe(2);
});

it('preflights a long supersession chain without recursively walking the stack', async () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const record = {
    memory_kind: 'note', kind: 'note', stage: 'seedling', title: 'Record', body_md: 'Text', tags: [], shared: false,
    type: null, scope: 'global', slug: 'record', frontmatter: {}, provenance: [],
    created_at: 10, updated_at: 10, content_hash: sha('Record\nText\n'),
  };
  const count = 10_000;
  const records = Array.from({ length: count }, (_, index) => ({
    ...record, id: 'record-' + index, supersedes: index + 1 < count ? 'record-' + (index + 1) : null,
  }));
  const payload = { format: 'cf-memory-memory/v1', source: { instance: hash(1), owner_id: 'owner' }, created_at: 11, records };
  const checked: string[] = [];
  const simulate = async (tool: string) => {
    checked.push(tool);
    return { found: false };
  };
  await expect(importArchive(simulate, { ...payload, checksum: sha(JSON.stringify(payload)) })).resolves.toMatchObject({
    mode: 'dry-run', create: count, missing_predecessors: 0,
  });
  expect(checked).toHaveLength(count);
  expect(new Set(checked)).toEqual(new Set(['notes_get']));
}, 30_000);

it('owner export follows stable pages, includes archived history/lifecycle, excludes teammates, embeddings and raw capture', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'export-old', title: 'Database', body_md: 'MySQL', scope: 'https://github.com/example/repo.git', type: 'project' })).note;
  const next = (await services.notes.upsert(alice, { slug: 'export-new', title: 'Database', body_md: 'PostgreSQL', supersedes: old.id, type: 'project', tags: ['database'] })).note;
  await services.notes.setArchived(alice, old.id);
  await services.notes.upsert(bob, { slug: 'bob-shared', title: 'Bob shared', body_md: 'foreign body', type: 'project' });
  const records: Record<string, unknown>[] = []; let cursor: unknown = null;
  do { const page = await services.portability.exportPage(alice, { kind: 'note', limit: 1, cursor }); records.push(...page.records); cursor = page.next_cursor; } while (cursor);
  expect(records.map(r => r.id)).toEqual([old.id, next.id].sort());
  expect(records.find(r => r.id === old.id)?.archived_at).toBeTruthy();
  expect(records.find(r => r.id === next.id)?.supersedes).toBe(old.id);
  expect(records.find(r => r.id === next.id)?.tags).toEqual(['database']);
  expect(JSON.stringify(records)).not.toMatch(/embedding|foreign body|payload_redacted/);
  await expect(services.portability.exportPage({ ...alice, scopes: new Set(['notes:write']) }, { kind: 'note' })).rejects.toThrow();
  await expect(services.portability.exportPage(alice, { kind: 'note', limit: 6 })).rejects.toThrow();
});
it('oversized documents fail explicitly instead of exporting a truncated successful backup', async () => {
  const note = (await services.notes.upsert(alice, { slug: 'too-large-export', title: 'Large', body_md: 'initial' })).note;
  await db.prepare('UPDATE notes SET body_md=? WHERE id=?').bind('x'.repeat(1048577), note.id).run();
  await expect(services.portability.exportPage(alice, { kind: 'note' })).rejects.toThrow('exceeds');
  await services.notes.softDelete(alice, note.id);
});
it('imports are idempotent unverified private metadata, not forged original actors or raw Capture', async () => {
  const note = (await services.notes.upsert(alice, { slug: 'import-private', title: 'Portable API', body_md: 'Portable API behavior', type: 'project', shared: false })).note;
  const args = { kind: 'note', id: note.id, expected_content_hash: note.content_hash, expected_scope: note.scope, origin: { instance: hash(3), owner_id: 'original-owner', memory_id: 'original-memory' }, snapshots: [snapshot(4)] };
  for (let i = 0; i < 10; i++) expect(await services.portability.importProvenance(alice, args)).toMatchObject({ created: i ? 0 : 1, imported: true, verified: false });
  const rows = await services.capture.provenance('note', note.id, alice);
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ actor_id: 'alice', confidence: 0, generated_by: 'cf-memory-import/v1' });
  expect(rows[0].source.imported).toBe(true);
  expect(rows[0].source.imported_origin).toMatchObject({ actor_id: 'original-actor', confidence: 0.99 });
  expect(JSON.stringify(rows)).not.toMatch(/do-not-store|must-not-cross|private\/context/);
  expect(await db.prepare('SELECT count(*) AS n FROM capture_events').first()).toEqual({ n: 0 });
  await expect(services.portability.importProvenance(bob, args)).rejects.toThrow();
  await expect(services.portability.importProvenance(alice, { ...args, expected_content_hash: hash(9) })).rejects.toThrow();
  await expect(services.portability.importProvenance(alice, { ...args, expected_scope: 'other/repo' })).rejects.toThrow();
  await db.prepare('UPDATE notes SET shared=1 WHERE id=?').bind(note.id).run();
  expect((await call('notes_get', { id: note.id }, bob)).found).toBe(true);
  expect((await call('notes_get', { id: note.id }, bob)).provenance).toEqual([]);
  expect((await services.capture.memoriesBySource(bob, { file_refs: ['src/private-import.ts'] })).hits).toEqual([]);
  expect(await services.search.hybrid(bob, 'Portable', { scope: 'notes', mode: 'keyword', file_ref: 'src/private-import.ts' })).toEqual([]);
  expect((await services.capture.memoriesBySource(alice, { file_refs: ['src/private-import.ts'] })).hits.map(h => h.id)).toContain(note.id);
  expect((await services.portability.exportProvenance(bob, { kind: 'note', id: note.id })).found).toBe(false);
  await expect(services.portability.importProvenance(alice, args)).rejects.toThrow();
});
it('provenance export pages all tied timestamps without losing history beyond the UI cap', async () => {
  const note = (await services.notes.upsert(alice, { slug: 'long-provenance', title: 'Long', body_md: 'Evidence' })).note;
  const args = { kind: 'note', id: note.id, expected_content_hash: note.content_hash, expected_scope: note.scope, origin: { instance: hash(3), owner_id: 'source', memory_id: 'long' } };
  for (let n = 0; n < 125; n += 25) await services.portability.importProvenance(alice, { ...args, snapshots: Array.from({ length: 25 }, (_, i) => snapshot(100 + n + i)) });
  await db.prepare('UPDATE memory_provenance SET created_at=1000 WHERE memory_id=?').bind(note.id).run();
  const ids: string[] = []; let cursor: unknown = null;
  do { const page = await services.portability.exportProvenance(alice, { kind: 'note', id: note.id, before: 2000, cursor }); ids.push(...page.snapshots.map(s => s.event_id)); cursor = page.next_cursor; } while (cursor);
  expect(ids).toHaveLength(125); expect(new Set(ids).size).toBe(125);
});
it('core create-only never overwrites or resurrects a live/deleted block and normal writes still work', async () => {
  await call('memory_set', { label: 'portable-core', value: 'Original', create_only: true });
  await expect(call('memory_set', { label: 'portable-core', value: 'Replacement', create_only: true })).rejects.toThrow();
  expect((await services.memory.getBlock(alice, 'portable-core'))?.value).toBe('Original');
  await call('memory_set', { label: 'portable-core', value: 'Normal edit' });
  const row = await services.notes.getRowBySlug(alice.userId, 'block-portable-core');
  await services.notes.softDelete(alice, row!.id);
  await expect(call('memory_set', { label: 'portable-core', value: 'Resurrect', create_only: true })).rejects.toThrow();
});
it('bundle restore preserves bytes, never overwrites a path and rejects secrets, denied files and foreign writes', async () => {
  const skill = (await services.skills.upsert(alice, { slug: 'portable-skill', name: 'Portable', description: 'Procedure', instructions: 'Run safely' })).skill;
  const args = { id: skill.id, path: 'assets/data.bin', content_base64: Buffer.from([0, 1, 2, 255]).toString('base64'), content_type: 'application/octet-stream' };
  const first = await call('skills_file_create', args); expect(await call('skills_file_create', args)).toEqual(first);
  expect(Array.from((await services.skills.getFile(skill.id, args.path))!.bytes)).toEqual([0, 1, 2, 255]);
  await expect(call('skills_file_create', { ...args, content_base64: Buffer.from('changed').toString('base64') })).rejects.toThrow();
  await expect(call('skills_file_create', args, bob)).rejects.toThrow();
  await expect(call('skills_file_create', { ...args, path: 'assets/secrets.txt' })).rejects.toThrow();
  await expect(call('skills_file_create', { ...args, path: 'assets/token.txt', content_base64: Buffer.from('TOKEN=fixture-secret').toString('base64') })).rejects.toThrow();
  await expect(call('skills_file_create', { ...args, content_base64: 'bad=' })).rejects.toThrow();
  const row = (await services.skills.getFileRow(skill.id, args.path))!;
  const bucket = await mf.getR2Bucket('BUNDLES') as unknown as R2Bucket;
  await bucket.put(row.r2_key, new Uint8Array([9, 9, 9, 9]));
  await expect(call('skills_file_create', args)).rejects.toThrow();
});
it('actual portable pipeline restores private notes/correction/skill bytes, retries without duplicates and keeps core opt-in', async () => {
  // Use a fresh owner without the deliberately oversized/secret fixtures above.
  const source = principalFixture({ userId: 'source', handle: 'source', scopes: new Set(['notes:read', 'notes:write']) });
  const target = principalFixture({ userId: 'target', handle: 'target', scopes: new Set(['notes:read', 'notes:write']) });
  for (const p of [source, target]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle, p.handle + '@example.com').run();
  const old = (await services.notes.upsert(source, { slug: 'db-before', title: 'Product database', body_md: 'Product database was MySQL.', type: 'project', tags: ['Zebra', 'alpha'], frontmatter: { date: 1234567 }, scope: 'https://github.com/example/product.git' })).note;
  const current = (await services.notes.upsert(source, { slug: 'db-after', title: 'Product database', body_md: 'Product database is PostgreSQL.', type: 'project', scope: 'https://github.com/example/product.git', supersedes: old.id })).note;
  await services.notes.setArchived(source, old.id);
  const literal = '---\nslug: this-is-body-text\n---\n\nPrefer concise answers.';
  await services.notes.upsert(source, { slug: 'user-fact', title: 'Preference', type: 'user', append_md: literal });
  const skill = (await services.skills.upsert(source, { slug: 'source-procedure', name: 'Procedure', description: 'Safe export', instructions: 'Use backup then verify.', frontmatter: { custom: 'preserved' } })).skill;
  await call('skills_file_create', { id: skill.id, path: 'references/example.txt', content_type: 'text/plain', content_base64: Buffer.from('Procedure fixture').toString('base64') }, source);
  const coreText = 'Read current evidence. '.repeat(180).trim();
  await call('memory_set', { label: 'test-operating-rule', value: coreText, char_limit: null }, source);
  await services.capture.put(source, { id: hash(600), session_id: hash(601), tool_use_id: hash(600), event_type: 'PostToolUse', tool_name: 'Read', payload_redacted: { output: 'Verified DB correction' }, payload_hash: hash(602), occurred_at: Date.now() - 1000, visibility: 'project', repo_context: ['github.com/example/product'], file_refs: ['src/database.ts'] });
  await services.capture.attach(source, { memory_id: current.id, source_event_ids: [hash(600)] });
  const bridge = (p: typeof source) => (name: string, args: Record<string, unknown>) => call(name, args, p);
  const archive = await exportArchive(bridge(source), { url: 'https://memory.test/mcp', token: 'not-persisted' });
  expect(archive.records).toHaveLength(5);
  expect(JSON.stringify(archive)).not.toContain('not-persisted');
  expect(validateArchive(archive)).toBe(archive);
  expect(await importArchive(bridge(target), archive)).toMatchObject({ mode: 'dry-run', create: 4, skipped_core: 1 });
  expect(await db.prepare('SELECT count(*) AS n FROM notes WHERE user_id=?').bind(target.userId).first()).toEqual({ n: 0 });
  // Fail after a durable write, before evidence attachment. Retry must resume
  // that stable origin row without another LLM call or a duplicate note.
  let failed = false;
  await expect(importArchive(async (name: string, args: Record<string, unknown>) => {
    if (name === 'memory_import_provenance' && !failed) { failed = true; throw Error('offline'); }
    return call(name, args, target);
  }, archive, { apply: true })).rejects.toThrow('offline');
  for (let i = 0; i < 10; i++) await importArchive(bridge(target), archive, { apply: true });
  const copies = await db.prepare('SELECT id,body_md,shared,supersedes,scope FROM notes WHERE user_id=?').bind(target.userId).all<{ id: string; body_md: string; shared: number; supersedes: string | null; scope: string }>();
  // 2026-11-14: a stored body never opens with a liftable frontmatter block (it
  // was re-applied as metadata by whoever saved that body next), so the source
  // note keeps this text with its opening fence rewritten; restore is exact from there.
  expect(copies.results).toHaveLength(3); expect(copies.results.some(n => n.body_md === literal.replace(/^---/, '***'))).toBe(true); expect(copies.results.every(n => n.shared === 0)).toBe(true);
  const restored = copies.results.find(n => n.body_md.includes('PostgreSQL'))!;
  expect(restored.supersedes).toBe(copies.results.find(n => n.body_md.includes('MySQL'))!.id);
  expect(await db.prepare('SELECT created_at FROM notes WHERE id=?').bind(restored.supersedes).first()).toEqual({ created_at: 1234567 });
  const pack = await services.recall.recall(target, 'Product database', 4000, undefined, 'https://github.com/example/product.git');
  expect(pack.text).toContain('PostgreSQL'); expect(pack.text).not.toContain('was MySQL');
  const targetSkill = (await db.prepare('SELECT id,frontmatter_json FROM skills WHERE user_id=?').bind(target.userId).first<{ id: string; frontmatter_json: string }>())!;
  expect((await services.skills.getFile(targetSkill.id, 'references/example.txt'))!.bytes).toEqual(new TextEncoder().encode('Procedure fixture'));
  expect(JSON.parse(targetSkill.frontmatter_json).custom).toBe('preserved');
  expect((await services.capture.provenance('note', restored.id, target))[0].source.imported).toBe(true);
  expect((await services.capture.provenance('note', restored.id, target))[0].source).toMatchObject({ visibility: 'project', import_verified: false });
  expect((await call('notes_get', { id: restored.id }, bob)).found).toBe(false);
  expect((await services.capture.provenance('note', restored.id, bob))).toEqual([]);
  await importArchive(bridge(target), archive, { apply: true, includeCore: true });
  expect(await services.memory.getBlock(target, 'test-operating-rule')).toMatchObject({ value: coreText, char_limit: null });
  const corrupt = structuredClone(archive); corrupt.records[0].body_md += 'corrupt';
  await expect(importArchive(bridge(target), corrupt, { apply: true })).rejects.toThrow('checksum');
}, 20_000); // Ten complete MCP/D1/R2 retries, including integrity reads, on CI.
it('real write-time sharing/hash/scope races cannot attach imported provenance', async () => {
  let n = 0;
  for (const change of ["shared=1", "content_hash='changed'", "scope='other/repo'"]) {
    const note = (await services.notes.upsert(alice, { slug: 'provenance-race-' + n++, title: 'Race', body_md: 'Stable memory', shared: false })).note;
    let mutated = false;
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(target, prop) {
      if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      if (prop === 'run') return async () => { if (!mutated) { mutated = true; await db.prepare(`UPDATE notes SET ${change} WHERE id=?`).bind(note.id).run(); } return target.run(); };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const racingDb = new Proxy(db, { get(target, prop) {
      if (prop === 'prepare') return (sql: string) => sql.includes('INSERT OR IGNORE INTO memory_provenance') ? wrap(target.prepare(sql)) : target.prepare(sql);
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const svc = makeServices(racingDb);
    await expect(svc.portability.importProvenance(alice, { kind: 'note', id: note.id, expected_content_hash: note.content_hash, expected_scope: note.scope, origin: { instance: hash(3), owner_id: 'source', memory_id: 'race' }, snapshots: [snapshot(700)] })).rejects.toThrow('changed');
    expect(mutated).toBe(true);
    expect(await db.prepare('SELECT count(*) AS n FROM memory_provenance WHERE memory_id=?').bind(note.id).first()).toEqual({ n: 0 });
  }
});
it('a concurrent bundle writer keeps its manifest and bytes, and a deleted target gets no manifest', async () => {
  const bucket = await mf.getR2Bucket('BUNDLES') as unknown as R2Bucket;
  let beforePut: (() => Promise<void>) | null = null;
  const racingBucket = new Proxy(bucket, { get(target, prop) {
    if (prop === 'put') return async (...args: Parameters<R2Bucket['put']>) => { const change = beforePut; beforePut = null; if (change) await change(); return target.put(...args); };
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const svc = makeServices(db, racingBucket);
  const skill = (await svc.skills.upsert(alice, { slug: 'asset-race', name: 'Race', instructions: 'Procedure' })).skill;
  beforePut = () => svc.skills.putFile(alice, skill, 'assets/race.txt', new TextEncoder().encode('winner'), 'text/plain').then(() => {});
  await expect(svc.skills.putFile(alice, skill, 'assets/race.txt', new TextEncoder().encode('loser'), 'text/plain', true)).rejects.toThrow();
  expect(new TextDecoder().decode((await svc.skills.getFile(skill.id, 'assets/race.txt'))!.bytes)).toBe('winner');
  expect((await bucket.list({ prefix: `skills/${skill.id}/` })).objects).toHaveLength(1);
  const deleted = (await svc.skills.upsert(alice, { slug: 'asset-deleted-race', name: 'Deleted', instructions: 'Procedure' })).skill;
  beforePut = () => db.prepare('UPDATE skills SET deleted_at=1 WHERE id=?').bind(deleted.id).run().then(() => {});
  await expect(svc.skills.putFile(alice, deleted, 'assets/example.txt', new TextEncoder().encode('safe'), 'text/plain', true)).rejects.toThrow();
  expect(await svc.skills.getFileRow(deleted.id, 'assets/example.txt')).toBeNull();
  expect((await bucket.list({ prefix: `skills/${deleted.id}/` })).objects).toHaveLength(0);
});
it('guarded archive cannot hide a note changed/shared/re-scoped after restore verification', async () => {
  const note = (await services.notes.upsert(alice, { slug: 'archive-restore-guard', title: 'Archive', body_md: 'Stable fact.', shared: false })).note;
  const guard = { id: note.id, expected_content_hash: note.content_hash, expected_scope: note.scope, private_only: true };
  expect(await call('notes_archive', { ...guard, expected_content_hash: hash(42) })).toMatchObject({ archived: false });
  await db.prepare('UPDATE notes SET shared=1 WHERE id=?').bind(note.id).run();
  expect(await call('notes_archive', guard)).toMatchObject({ archived: false });
  await db.prepare("UPDATE notes SET shared=0,scope='other/repo' WHERE id=?").bind(note.id).run();
  expect(await call('notes_archive', guard)).toMatchObject({ archived: false });
  await db.prepare('UPDATE notes SET scope=? WHERE id=?').bind(note.scope, note.id).run();
  expect(await call('notes_archive', guard)).toMatchObject({ archived: true });
});
