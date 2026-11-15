import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { SearchService, searchFilters, standaloneSearch } from '../src/search';
import { handleMcp } from '../src/mcp';
import { gatedDb, principalFixture, type DbGate } from './helpers';
const alice = principalFixture({ userId: 'filter-alice', handle: 'filter-alice' });
const bob = principalFixture({ userId: 'filter-bob', handle: 'filter-bob' });
const a = 'https://github.com/team/filter-a', b = 'https://github.com/team/filter-b';
const epoch = Date.parse('2026-09-01T00:00:00Z'), eid = (n: number) => n.toString(16).padStart(64, '0');
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
const ids: Record<string, string> = {};
async function note(slug: string, type: 'project' | 'user' = 'project', scope = a, ref = 'src/db.ts') {
  const { note } = await services.notes.upsert(alice, { slug, title: 'Filtered knowledge', body_md: 'Filtered knowledge about database 記憶', type, scope });
  const n = Object.keys(ids).length + 1; ids[slug] = note.id;
  await services.capture.put(alice, { id: eid(n), session_id: eid(800), event_type: 'PostToolUse', tool_name: 'Read', tool_use_id: eid(n), payload_redacted: { output: 'Verified database behavior' }, payload_hash: eid(999), occurred_at: Date.now(), visibility: type === 'project' ? 'project' : 'personal', file_refs: [ref], repo_context: [scope], client: 'claude-code' });
  await services.capture.attach(alice, { memory_id: note.id, source_event_ids: [eid(n)], confidence: 0.99 });
  await db.prepare('UPDATE notes SET created_at=?,updated_at=? WHERE id=?').bind(epoch, epoch + 1000, note.id).run();
  return note;
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] })); db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const f of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) for (const sql of readFileSync('migrations/' + f, 'utf8').split('\n').map(l => l.split('--')[0]).join('\n').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for (const p of [alice,bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId,p.handle,p.handle,p.handle+'@example.com').run();
  services = makeServices(db);
  await note('filter-a'); await note('filter-global','project','global'); await note('filter-b','project',b); await note('filter-private','user'); await note('filter-other-file','project',a,'src/cache.ts');
  await note('filter-old'); await db.prepare('UPDATE notes SET created_at=?,updated_at=? WHERE id=?').bind(epoch-1,epoch-1,ids['filter-old']).run();
  await services.skills.upsert(alice, { slug: 'filter-skill', name: 'Filtered knowledge', description: 'Filtered knowledge database 記憶', scope: a });
});
afterAll(async () => { await mf?.dispose(); });
it('standalone keyword search applies the same ACL and repository filters', async () => {
  const result = await standaloneSearch(services.search, bob, 'Filtered knowledge',
    { scope:'all', context:a, memory_type:'project', file_ref:'src/db.ts', current_only:true });
  expect(result.hits.map(h => h.slug).sort()).toEqual(['filter-a', 'filter-global', 'filter-old']);
  expect(result.retrieval).toMatchObject({ requested_lanes_complete:true, semantic_status:'not_requested' });
  expect(result.hits.map(h=>h.slug)).not.toContain('filter-private');
  expect(result.hits.map(h=>h.slug)).not.toContain('filter-b');
});
it('type/date/literal source filters prefilter every search lane while preserving repo+global and privacy', async () => {
  for (const mode of ['keyword','semantic','hybrid'] as const) {
    const hits = await services.search.hybrid(bob, 'Filtered knowledge', { mode, scope: 'all', context: a, memory_type: 'project', created_since: epoch, created_until: epoch+1, updated_since: epoch+1000, updated_until: epoch+1001, file_ref: 'src/db.ts' });
    expect(hits.map(h => h.slug).sort(),mode).toEqual(['filter-a','filter-global']);
    expect(hits.every(h => h.char_count > 0 && h.estimated_tokens > 0)).toBe(true);
  }
});
it('short Japanese LIKE fallback applies the same selective filters', async () => {
  const hits = await services.search.hybrid(bob,'記憶',{ mode:'keyword', context:a, file_ref:'src/cache.ts', memory_type:'project' });
  expect(hits.map(h=>h.slug)).toEqual(['filter-other-file']);
});
it('source lookup is context-scoped when requested and remains all-scope for dedup when omitted', async () => {
  const args = { file_refs:['src/db.ts'],limit:10 };
  const scoped = (await services.capture.memoriesBySource(bob,{...args,context:[a]})).hits.map(h=>h.id);
  expect(await services.search.listScopes(bob)).toEqual(['github.com/team/filter-a','github.com/team/filter-b']);
  expect(scoped).toContain(ids['filter-a']);expect(scoped).toContain(ids['filter-global']);expect(scoped).not.toContain(ids['filter-b']);expect(scoped).not.toContain(ids['filter-private']);
  expect((await services.capture.memoriesBySource(bob,args)).hits.map(h=>h.id)).toContain(ids['filter-b']);
  expect((await services.capture.memoriesBySource(alice,args)).hits.map(h=>h.id)).toContain(ids['filter-private']);
  expect((await services.capture.memoriesBySource(alice,{...args,shared_only:true})).hits.map(h=>h.id)).not.toContain(ids['filter-private']);
});
it('historical search remains default; current_only excludes archive, supersession and invalid windows', async () => {
  for (const [slug, sql] of [['filter-archived','archived_at=1'],['filter-expired','valid_until=1'],['filter-future','valid_from=9999999999999']] as const) {
    const row = await note(slug);await db.prepare(`UPDATE notes SET ${sql} WHERE id=?`).bind(row.id).run();
  }
  const old = await note('filter-superseded');await services.notes.upsert(alice,{slug:'filter-new',title:'Filtered knowledge',body_md:'Filtered knowledge current database',type:'project',supersedes:old.id});
  const history = await services.search.hybrid(bob,'Filtered knowledge',{ mode:'keyword',limit:50 });
  const current = await services.search.hybrid(bob,'Filtered knowledge',{ mode:'keyword',limit:50,current_only:true });
  for (const slug of ['filter-archived','filter-expired','filter-future','filter-superseded']) {expect(history.map(h=>h.slug)).toContain(slug);expect(current.map(h=>h.slug)).not.toContain(slug);}
  expect(current.map(h=>h.slug)).toContain('filter-new');
});
it('full-source hydration revalidates type, time and source metadata after real candidate selection', async () => {
  for (const [slug, change] of [
    ['filter-race-type',async (id:string)=> {await db.prepare("UPDATE notes SET type='reference' WHERE id=?").bind(id).run();}],
    ['filter-race-time',async (id:string)=> {await db.prepare('UPDATE notes SET updated_at=? WHERE id=?').bind(epoch+9000,id).run();}],
    ['filter-race-source',async (id:string)=> {await db.prepare('DELETE FROM memory_provenance WHERE memory_id=?').bind(id).run();}],
  ] as const) {
    const row = await note(slug), gate: DbGate = {};
    // The change lands after the FTS lane picked its candidates, before hydration.
    const search = new SearchService(gatedDb(db, gate, sql => sql.includes('FROM notes_fts f JOIN notes n')));
    let fired = false; gate.next = async () => { fired = true; await change(row.id); };
    const hits = await search.hybrid(bob,'database',{memory_type:'project',updated_until:epoch+2000,file_ref:'src/db.ts',limit:50});
    expect(fired).toBe(true);
    expect(hits.map(h=>h.id),slug).not.toContain(row.id);
  }
});
it('MCP supports the filters and reports invalid bounds instead of silently ignoring them', async () => {
  async function call(args:Record<string,unknown>) {const r=await handleMcp(new Request('https://memory.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'notes_search',arguments:args}})}),{principal:bob,services,budget:4000});return r.json() as Promise<any>;}
  const response=await call({q:'database',mode:'keyword',file_ref:'src/cache.ts',memory_type:'project',created_since:'2026-09-01T00:00:00Z'});
  expect(JSON.parse(response.result.content[0].text).hits.map((h:any)=>h.slug)).toEqual(['filter-other-file']);
  const invalid=await call({q:'database',created_since:epoch,created_until:epoch});expect(invalid.result?.isError ?? !!invalid.error).toBe(true);
});
it('strict filters accept zero/ISO bounds and reject unsupported types, infinity and reversed intervals',()=>{
  expect(searchFilters({created_since:0,updated_until:'2026-09-01',current_only:false})).toEqual({created_since:0,updated_until:epoch,current_only:false});
  for (const raw of [{memory_type:'secret'},{memory_type:['project']},{created_since:Infinity},{updated_since:-1},{updated_since:2,updated_until:1},{current_only:'true'},{file_ref:[]},{created_since:''}]) expect(()=>searchFilters(raw)).toThrow();
});
it('filtered hydration reserves bind slots across more than one D1 result chunk',async()=>{
  await db.batch(Array.from({length:120},(_,i)=>db.prepare(`INSERT INTO notes (id,user_id,slug,title,body_md,kind,stage,content_hash,type,shared,scope,created_at,updated_at)
    SELECT ?,user_id,?,title,body_md,kind,stage,content_hash,type,shared,scope,created_at,updated_at FROM notes WHERE id=?`)
    .bind('filter-chunk-'+i,'filter-chunk-'+i,ids['filter-a'])));
  await db.prepare("INSERT INTO notes_fts (rowid,title,body,tags) SELECT rowid,title,body_md,'' FROM notes WHERE id LIKE 'filter-chunk-%'").run();
  const hits=await services.search.hybrid(bob,'database',{limit:200,memory_type:'project',created_since:epoch,created_until:epoch+1,updated_since:epoch+1000,updated_until:epoch+1001,current_only:true,context:[a,b]});
  expect(hits.filter(h=>h.id.startsWith('filter-chunk-'))).toHaveLength(120);
});
