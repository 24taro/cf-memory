import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {makeServices} from '../src/services';
import {handleMcp} from '../src/mcp';
import {principalFixture} from './helpers';
import type {NoteInput} from '../src/types';
const alice=principalFixture({userId:'guard-alice',handle:'alice',scopes:new Set(['notes:read','notes:write'])});
const bob=principalFixture({userId:'guard-bob',handle:'bob',scopes:new Set(['notes:read','notes:write'])});
// A concurrent change lands after the guard check has passed and before the
// guarded UPDATE commits. (This window used to be the embedding call; with
// embeddings removed, the hook runs right after the guard's own check query.)
const gate:{next?:()=>Promise<void>}={};
function gated(real:D1Database):D1Database{
  const wrap=<T extends object>(target:T,get:(t:T,p:PropertyKey)=>unknown)=>new Proxy(target,{get:(t,p)=>{const v=get(t,p);return v!==undefined?v:(typeof (t as any)[p]==='function'?(t as any)[p].bind(t):(t as any)[p]);}});
  return wrap(real,(t,p)=>p!=='prepare'?undefined:(sql:string)=>{
    const stmt=t.prepare(sql);
    if(!sql.trimStart().startsWith('SELECT n.id FROM notes n WHERE'))return stmt;
    return wrap(stmt,(st,q)=>q!=='bind'?undefined:(...args:unknown[])=>wrap(st.bind(...args),(b,r)=>r!=='first'?undefined:async()=>{
      const row=await b.first();const fn=gate.next;gate.next=undefined;if(fn)await fn();return row;
    }));
  });
}
let mf:Miniflare,db:D1Database,services:ReturnType<typeof makeServices>;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {};',d1Databases:['DB']}));
  db=await mf.getD1Database('DB');
  for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())
    for(const sql of readFileSync(join('migrations',name),'utf8').split('\n').map(l=>l.split('--')[0]).join('\n').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const p of [alice,bob])await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(p.userId,p.handle,p.handle).run();
  services=makeServices(gated(db));
});
afterAll(async()=>{await mf?.dispose();});
async function rpc(name:string,args:Record<string,unknown>={},principal=alice):Promise<any>{
  const response=await handleMcp(new Request('https://memory.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{services,principal,budget:4000});
  const json:any=await response.json();if(json.error||json.result.isError)throw Error(JSON.stringify(json));
  return JSON.parse(json.result.content[0].text);
}
async function note(slug:string){
  const created=await rpc('notes_put',{slug,title:'Guarded text '+slug,body_md:'Original durable knowledge.',type:'project',scope:'https://github.com/example/guard.git',tags:['stable'],frontmatter:{purpose:'preserve metadata'},stage:'evergreen'});
  return rpc('notes_get',{id:created.id});
}
async function sideEffects(id:string){
  const counts:Record<string,number>={};
  for(const [table,where] of [['note_revisions','note_id=?'],['events','target_id=?'],['links','src_note_id=?'],['note_tags','note_id=?']])
    counts[table]=(await db.prepare('SELECT count(*) AS n FROM '+table+' WHERE '+where).bind(id).first<{n:number}>())!.n;
  return counts;
}
it('guarded text repair changes one existing body while preserving metadata and original lineage',async()=>{
  const n=await note('guard-success'),before=await sideEffects(n.id);
  const result=await rpc('notes_put',{slug:n.slug,title:n.title,body_md:'Corrected durable knowledge.',update_guard:n.supersession_guard});
  expect(result.id).toBe(n.id);expect(result.created).toBe(false);
  const after=await rpc('notes_get',{id:n.id});expect(after.body_md).toBe('Corrected durable knowledge.');expect(after.content_hash).not.toBe(n.content_hash);
  for(const key of ['id','slug','type','shared','scope','kind','stage','frontmatter','tags','provenance','valid_from','valid_until','supersedes','superseded_by','archived_at'])expect(after[key]).toEqual(n[key]);
  const counts=await sideEffects(n.id);expect(counts.note_revisions).toBe(before.note_revisions+1);expect(counts.events).toBe(before.events+1);
});
it('a stale inspected content hash cannot replace a newer body or mutate its auxiliary state',async()=>{
  const n=await note('guard-stale');await rpc('notes_put',{slug:n.slug,body_md:'Concurrent human correction.'});
  const current=await rpc('notes_get',{id:n.id}),before=await sideEffects(n.id);
  await expect(rpc('notes_put',{slug:n.slug,body_md:'Stale normalization.',update_guard:n.supersession_guard})).rejects.toThrow();
  expect((await rpc('notes_get',{id:n.id})).body_md).toBe(current.body_md);expect(await sideEffects(n.id)).toEqual(before);
});
it('a guard cannot insert a missing slug or revive a deleted note',async()=>{
  const n=await note('guard-delete');await rpc('notes_delete',{id:n.id});
  const before=await sideEffects(n.id);
  for(const slug of [n.slug,'guard-never-created'])await expect(rpc('notes_put',{slug,body_md:'Old body repair.',update_guard:n.supersession_guard})).rejects.toThrow();
  expect((await db.prepare('SELECT deleted_at FROM notes WHERE id=?').bind(n.id).first<{deleted_at:number}>())!.deleted_at).not.toBeNull();
  expect(await db.prepare("SELECT id FROM notes WHERE slug='guard-never-created'").first()).toBeNull();expect(await sideEffects(n.id)).toEqual(before);
});
it('same-hash visibility, scope or timestamp edits after the guard check veto the actual update',async()=>{
  for(const [label,sql] of [['visibility','UPDATE notes SET shared=0 WHERE id=?'],['scope',"UPDATE notes SET scope='github.com/example/elsewhere' WHERE id=?"],['timestamp','UPDATE notes SET updated_at=updated_at+1 WHERE id=?']]){
    const n=await note('guard-race-'+label),before=await sideEffects(n.id);
    gate.next=async()=>{await db.prepare(sql).bind(n.id).run();};
    await expect(rpc('notes_put',{slug:n.slug,body_md:'Proposed text repair.',update_guard:n.supersession_guard})).rejects.toThrow();
    expect((await rpc('notes_get',{id:n.id})).body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
  }
});
it('a guard denies foreign ownership, invalid metadata and supersession hidden in YAML',async()=>{
  const n=await note('guard-refused');const before=await sideEffects(n.id);
  await expect(rpc('notes_put',{slug:n.slug,body_md:'Foreign correction.',update_guard:n.supersession_guard},bob)).rejects.toThrow();
  for(const extra of [{shared:false},{scope:'global'},{create_only:true},{tags:['changed']},{frontmatter:{supersedes:n.id}},{body_md:'---\nsupersedes: '+n.id+'\n---\nHidden correction.'}])
    await expect(rpc('notes_put',{slug:n.slug,body_md:'Guarded body.',update_guard:n.supersession_guard,...extra})).rejects.toThrow();
  expect((await rpc('notes_get',{id:n.id})).body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
});
it('raw guarded MCP types and extra fields fail closed before normal coercion can erase them',async()=>{
  const n=await note('guard-wire'),before=await sideEffects(n.id);
  for(const body_md of [null,7,{text:'not markdown'}])await expect(rpc('notes_put',{slug:n.slug,body_md,update_guard:n.supersession_guard})).rejects.toThrow();
  for(const extra of [{shared:'false'},{frontmatter:'invalid-shape'},{create_only:false},{scope:7},{title:42},{unknown:'ignored'}])
    await expect(rpc('notes_put',{slug:n.slug,body_md:'Should not be accepted.',update_guard:n.supersession_guard,...extra})).rejects.toThrow();
  expect((await rpc('notes_get',{id:n.id})).body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
});
it('direct repository callers cannot bypass guarded body and title validation',async()=>{
  const n=await note('guard-direct'),before=await sideEffects(n.id);
  for(const body_md of [undefined,null,7,{text:'invalid'}])
    await expect(services.notes.upsert(alice,{slug:n.slug,body_md,updateGuard:n.supersession_guard} as NoteInput)).rejects.toThrow();
  await expect(services.notes.upsert(alice,{slug:n.slug,title:7,body_md:'Invalid title.',updateGuard:n.supersession_guard} as unknown as NoteInput)).rejects.toThrow();
  expect((await rpc('notes_get',{id:n.id})).body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
  const indexed=await db.prepare('SELECT body FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?)').bind(n.id).first<{body:string}>();
  expect(indexed?.body).toBe(n.body_md);
});
it('the mutation rechecks newly attached provenance even when the note body and timestamp do not change',async()=>{
  const n=await note('guard-provenance'),before=await sideEffects(n.id);
  gate.next=async()=>{await db.prepare("INSERT INTO memory_provenance(memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at) VALUES ('note',?,'guard-event','guard-session',?,'confirms','fixture',0.9,'','{}',0)").bind(n.id,alice.userId).run();};
  await expect(rpc('notes_put',{slug:n.slug,body_md:'Unreviewed provenance repair.',update_guard:n.supersession_guard})).rejects.toThrow();
  const after=await rpc('notes_get',{id:n.id});expect(after.body_md).toBe(n.body_md);expect(after.provenance).toHaveLength(1);expect(await sideEffects(n.id)).toEqual(before);
});
it('expiry during a slow write is checked with commit-time now, not the earlier write timestamp',async()=>{
  const n=await note('guard-expiry');await db.prepare('UPDATE notes SET valid_until=? WHERE id=?').bind(Date.now()+1000,n.id).run();
  const inspected=await rpc('notes_get',{id:n.id});expect(inspected.current).toBe(true);const before=await sideEffects(n.id);
  gate.next=async()=>{await new Promise(resolve=>setTimeout(resolve,1100));};
  await expect(rpc('notes_put',{slug:n.slug,body_md:'Late repair.',update_guard:inspected.supersession_guard})).rejects.toThrow();
  expect((await rpc('notes_get',{id:n.id})).body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
});
it('current ordinary ownership and slug are required after deletion, archive, pin, expiry and supersession',async()=>{
  for(const [label,sql] of [['archive','UPDATE notes SET archived_at=1 WHERE id=?'],['pin',"UPDATE notes SET pinned_block_label='guard-core' WHERE id=?"],['future','UPDATE notes SET valid_from=9999999999999 WHERE id=?'],['expired','UPDATE notes SET valid_until=1 WHERE id=?'],['rename',"UPDATE notes SET slug=slug||'-renamed' WHERE id=?"]]){
    const n=await note('guard-lifecycle-'+label);await db.prepare(sql).bind(n.id).run();const before=await sideEffects(n.id);
    await expect(rpc('notes_put',{slug:n.slug,body_md:'Old inspected repair.',update_guard:n.supersession_guard})).rejects.toThrow();
    expect((await db.prepare('SELECT body_md FROM notes WHERE id=?').bind(n.id).first<{body_md:string}>())!.body_md).toBe(n.body_md);expect(await sideEffects(n.id)).toEqual(before);
  }
  const n=await note('guard-live-superseder');await rpc('notes_put',{slug:'guard-new-fact',body_md:'Replacement knowledge.',supersedes:n.id,type:'project'});
  await expect(rpc('notes_put',{slug:n.slug,body_md:'Historical repair.',update_guard:n.supersession_guard})).rejects.toThrow();
});
it('two content-changing requests with one inspected guard have one winner and one revision',async()=>{
  const n=await note('guard-two-writers'),before=await sideEffects(n.id);
  const results=await Promise.allSettled(['First normalized body.','Second normalized body.'].map(body_md=>rpc('notes_put',{slug:n.slug,body_md,update_guard:n.supersession_guard})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const after=await sideEffects(n.id);expect(after.note_revisions).toBe(before.note_revisions+1);expect(after.events).toBe(before.events+1);
});
it('guard capability is discoverable and unguarded legacy edits retain their existing contract',async()=>{
  expect((await rpc('server_status')).guarded_note_update).toBe(true);
  const n=await note('guard-legacy');await rpc('notes_delete',{id:n.id});
  const restored=await rpc('notes_put',{slug:n.slug,body_md:'Explicit legacy restoration.'});expect(restored.id).toBe(n.id);
  await rpc('notes_append',{slug:n.slug,text:'Legacy addition.'});expect((await rpc('notes_get',{id:n.id})).body_md).toContain('Legacy addition.');
});
it('the dedicated text repair requires a guard and never falls back to legacy upsert',async()=>{
  const n=await note('guard-dedicated'),before=await sideEffects(n.id);
  for(const update_guard of [undefined,null,{}, {...n.supersession_guard,shared:'true'}])
    await expect(rpc('notes_update_text',{slug:n.slug,body_md:'Missing valid snapshot.',...(update_guard===undefined?{}:{update_guard})})).rejects.toThrow();
  for(const extra of [{body_md:null},{shared:false},{create_only:false}])
    await expect(rpc('notes_update_text',{slug:n.slug,body_md:'Refused.',update_guard:n.supersession_guard,...extra})).rejects.toThrow();
  await expect(rpc('notes_update_text',{slug:n.slug,body_md:'Foreign repair.',update_guard:n.supersession_guard},bob)).rejects.toThrow();
  expect(await sideEffects(n.id)).toEqual(before);
  const written=await rpc('notes_update_text',{slug:n.slug,body_md:'Explicit owned correction.',update_guard:n.supersession_guard});
  expect(written.id).toBe(n.id);expect(written.created).toBe(false);
  await expect(rpc('notes_update_text',{slug:n.slug,body_md:'Stale repair.',update_guard:n.supersession_guard})).rejects.toThrow();
  const current=await rpc('notes_get',{id:n.id});expect(current.body_md).toBe('Explicit owned correction.');
  await rpc('notes_delete',{id:n.id});
  await expect(rpc('notes_update_text',{slug:n.slug,body_md:'No resurrection.',update_guard:current.supersession_guard})).rejects.toThrow();
});
