import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';
import { NotesRepo } from '../src/notes';

const scopes=new Set(['notes:read','notes:write']);
const alice=principalFixture({userId:'alice',handle:'alice',scopes}), bob=principalFixture({userId:'bob',handle:'bob',scopes});
let mf:Miniflare,db:D1Database,services:ReturnType<typeof makeServices>;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {};',d1Databases:['DB']}));
  db=await mf.getD1Database('DB') as unknown as D1Database;
  for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
    const raw=readFileSync(join('migrations',name),'utf8').split('\n').map(l=>l.split('--')[0]).join('\n');
    for(const sql of raw.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  }
  for(const p of [alice,bob])await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(p.userId,p.handle,p.handle).run();
  services=makeServices(db);
});
afterAll(async()=>{await mf?.dispose();});
async function tool(name:string,args:Record<string,unknown>,principal=alice){
  const r=await handleMcp(new Request('https://memory.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{principal,services,budget:4000});
  const m=await r.json() as {error?:unknown;result?:{isError?:boolean;content:{text:string}[]}};
  if(m.error||!m.result||m.result.isError)throw Error(JSON.stringify(m));
  return JSON.parse(m.result.content[0].text);
}
const eid=(n:number)=>n.toString(16).padStart(64,'0');
async function source(n:number,visibility='personal',owner=alice){
  await services.capture.put(owner,{id:eid(n),session_id:eid(n+10000),event_type:'PostToolUse',tool_name:'Read',tool_use_id:eid(n),payload_hash:eid(n+30000),occurred_at:Date.now(),visibility,repo_context:['https://github.com/acme/cf-memory'],file_refs:['src/reindex.ts'],payload_redacted:{input:{file_path:'src/reindex.ts'},output:'A newly observed noncontradictory rule about the documented reindex contract.'},client:'claude-code'});
  return eid(n);
}
async function request(slug:string,n:number,shared=false){
  const row=(await services.notes.upsert(alice,{slug,title:slug,body_md:'Original supported contract.',shared,scope:'https://github.com/acme/cf-memory',tags:['Keep Me'],stage:'budding',frontmatter:{custom:'preserved'}})).note;
  const event=await source(n,shared?'project':'personal');
  return {slug,text:'An independently observed ultravioletguardedsupplement refines the same contract.',append_guard:(await tool('notes_get',{id:row.id})).supersession_guard,append_id:eid(n+20000),provenance:{source_event_ids:[event],generated_by:'cf-memory-agent/subscription/review-v6',confidence:0.6,rationale:'Independently source and target reviewed noncontradictory supplement.'}};
}
const count=async(table:string,id:string)=>await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table==='events'?"target_id=? AND verb='note.appended'":'note_id=?'}`).bind(id).first<{n:number}>();
const status=async(a:Awaited<ReturnType<typeof request>>)=>tool('notes_append_status',{id:a.append_guard.id,append_id:a.append_id});

it('commits one supplement with trace, receipt, FTS, history and links while preserving metadata',async()=>{
  await services.notes.upsert(alice,{slug:'append-link-target',body_md:'Target.'});
  const a=await request('append-success',3101,true);a.text+=' See [[append-link-target]].';
  const before=await services.notes.getRowById(a.append_guard.id),revisions=await count('note_revisions',a.append_guard.id);
  expect(await tool('server_status',{})).toMatchObject({atomic_append_provenance:true});
  const r=await tool('notes_append_guarded',a);expect(r).toMatchObject({appended:true,id:a.append_guard.id,provenance_stored:true,replayed:false});
  const after=await services.notes.getRowById(a.append_guard.id);
  expect(after?.body_md).toBe(before!.body_md+'\n\n'+a.text);
  for(const key of ['id','user_id','slug','title','frontmatter_json','type','kind','shared','scope','created_at','valid_from','valid_until','stage','supersedes','superseded_by','archived_at','deleted_at'] as const)expect(after?.[key]).toEqual(before?.[key]);
  expect(await services.notes.tagsFor(a.append_guard.id, alice.userId)).toEqual(['Keep Me']);
  const p=await services.capture.provenance('note',a.append_guard.id,alice);expect(p).toHaveLength(1);
  expect(p[0]).toMatchObject({relation:'derived_from',actor_id:'alice',event_id:eid(3101),confidence:.6});
  expect(p[0].source).toMatchObject({append_id:a.append_id,derived_memory_content_hash:r.content_hash});expect(p[0].source).not.toHaveProperty('cwd');
  expect(await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(3101)).first()).toMatchObject({distill_status:'applied'});
  expect(await count('events',a.append_guard.id)).toEqual({n:1});expect(await count('note_revisions',a.append_guard.id)).toEqual({n:revisions!.n+1});
  expect(await db.prepare('SELECT resolved FROM links WHERE src_note_id=?').bind(a.append_guard.id).first()).toEqual({resolved:1});
  const search=await tool('notes_search',{q:'ultravioletguardedsupplement',mode:'keyword'});expect(search.hits.some((h:{id:string})=>h.id===a.append_guard.id)).toBe(true);
  expect(await status(a)).toMatchObject({completed:true,append_guard:a.append_guard,provenance:a.provenance,current_content_matches:true});
  const returned=JSON.stringify(await status(a));expect(returned).not.toContain(a.text);expect(returned).not.toContain('payload_redacted');
  expect((await tool('notes_get',{id:a.append_guard.id},bob)).body_md).toBe(after?.body_md);
});
it('lost-response retry acknowledges once after source expiry and never modifies later human changes',async()=>{
  const a=await request('append-replay',3102);const first=await tool('notes_append_guarded',a);
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(3102)).run();
  expect(await tool('notes_append_guarded',a)).toMatchObject({...first,replayed:true});
  await services.notes.upsert(alice,{slug:a.slug,body_md:'A later human edit.'});
  await db.prepare('UPDATE notes SET archived_at=1,deleted_at=1 WHERE id=?').bind(a.append_guard.id).run();
  expect(await tool('notes_append_guarded',a)).toMatchObject({appended:true,replayed:true,content_hash:first.content_hash});
  expect(await services.notes.getRowById(a.append_guard.id)).toMatchObject({body_md:'A later human edit.',archived_at:1,deleted_at:1});
  expect(await status(a)).toMatchObject({completed:true,current_content_matches:false});
  expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(1);expect(await count('events',a.append_guard.id)).toEqual({n:1});
});
it('operation IDs cannot be reused with changed text, guard, provenance or target',async()=>{
  const a=await request('append-id-reuse',3103);await tool('notes_append_guarded',a);
  for(const changed of [{...a,text:a.text+' Changed.'},{...a,append_guard:{...a.append_guard,updated_at:a.append_guard.updated_at+1}},
    {...a,provenance:{...a.provenance,rationale:'Changed rationale.'}}])await expect(tool('notes_append_guarded',changed)).rejects.toThrow('receipt conflict');
  const b=await request('append-id-other-target',3104);b.append_id=a.append_id;
  await expect(tool('notes_append_guarded',b)).rejects.toThrow();expect((await services.notes.getRowById(b.append_guard.id))?.body_md).toBe('Original supported contract.');
});
it('concurrent same requests acknowledge one append and one trace',async()=>{
  const a=await request('append-concurrent-same',3105);const results=await Promise.all([tool('notes_append_guarded',a),tool('notes_append_guarded',a)]);
  expect(results.every(r=>r.appended&&r.provenance_stored)).toBe(true);
  expect((await services.notes.getRowById(a.append_guard.id))?.body_md).toBe('Original supported contract.\n\n'+a.text);
  expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(1);expect(await count('events',a.append_guard.id)).toEqual({n:1});
  expect(await count('note_revisions',a.append_guard.id)).toEqual({n:2});
});
it('concurrent different IDs cannot both use the same target snapshot',async()=>{
  const a=await request('append-concurrent-different',3106),b={...a,append_id:eid(666666),text:'A competing independent supplement.'};
  const result=await Promise.allSettled([tool('notes_append_guarded',a),tool('notes_append_guarded',b)]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await count('events',a.append_guard.id)).toEqual({n:1});
  expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(1);
});
it('provenance failure rolls back body, FTS, history, links, receipt and source status',async()=>{
  const a=await request('append-rollback',3107),before=await services.notes.getRowById(a.append_guard.id),rev=await count('note_revisions',a.append_guard.id);
  await db.prepare("CREATE TRIGGER fail_append BEFORE INSERT ON memory_provenance WHEN NEW.memory_id='"+a.append_guard.id+"' BEGIN SELECT RAISE(ABORT,'fixture append trace failure'); END").run();
  try{await expect(tool('notes_append_guarded',a)).rejects.toThrow(/Internal error in notes_append_guarded \(code [0-9a-f]{8}\)/);}finally{await db.prepare('DROP TRIGGER fail_append').run();}
  expect(await services.notes.getRowById(a.append_guard.id)).toEqual(before);expect(await count('note_revisions',a.append_guard.id)).toEqual(rev);
  expect(await status(a)).toEqual({completed:false});expect(await count('events',a.append_guard.id)).toEqual({n:0});
  expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(0);
  expect(await db.prepare('SELECT body FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?)').bind(a.append_guard.id).first()).toEqual({body:before!.body_md});
  expect(await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(3107)).first()).toEqual({distill_status:'pending'});
});
it('full guard refuses metadata-only changes, archival, deletion, supersession and block conversion',async()=>{
  for(const [i,mutation]of ["scope='global'","shared=1","updated_at=updated_at+1","archived_at=1","deleted_at=1","kind='block'","pinned_block_label='guarded-test'","valid_until=1","valid_from=9999999999999"].entries()){
    const a=await request('append-stale-'+i,3120+i);await db.prepare('UPDATE notes SET '+mutation+' WHERE id=?').bind(a.append_guard.id).run();
    await expect(tool('notes_append_guarded',a)).rejects.toThrow('append conflict');expect(await status(a)).toEqual({completed:false});
    expect((await services.notes.getRowById(a.append_guard.id))?.body_md).toBe('Original supported contract.');expect(await count('events',a.append_guard.id)).toEqual({n:0});
  }
  const a=await request('append-superseded',3130);await services.notes.upsert(alice,{slug:'append-new-version',body_md:'Replacement.',supersedes:a.append_guard.id});
  await expect(tool('notes_append_guarded',a)).rejects.toThrow('append conflict');
  const b=await request('append-more-provenance',3131);await services.capture.attach(alice,{memory_kind:'note',memory_id:b.append_guard.id,relation:'confirms',source_event_ids:b.provenance.source_event_ids});
  await expect(tool('notes_append_guarded',b)).rejects.toThrow('append conflict');
});
it('missing target or own tombstone never creates, resurrects or edits same-slug shared fallback',async()=>{
  const a=await request('append-missing',3140);a.append_guard.id='missing-note-id';
  await expect(tool('notes_append_guarded',a)).rejects.toThrow('append conflict');expect((await services.notes.getRowBySlug('alice',a.slug))?.body_md).toBe('Original supported contract.');
  const b=await request('append-tombstone',3141);await db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(b.append_guard.id).run();
  const other=(await services.notes.upsert(bob,{slug:b.slug,body_md:'Bob shared account.',shared:true})).note;
  await expect(tool('notes_append_guarded',b)).rejects.toThrow('append conflict');expect((await services.notes.getRowById(other.id))?.body_md).toBe('Bob shared account.');
});
it('metadata changes after preflight still make the final guarded transaction write nothing',async()=>{
  const a=await request('append-preflight-race',3142),before=await services.notes.getRowById(a.append_guard.id);
  await expect(services.notes.appendReviewed(alice,a,async(id,shared,receiptId,requestHash,p,nonce)=>{
    const statements=await services.capture.prepareAppend(alice,id,shared,receiptId,requestHash,p,nonce);
    await db.prepare('UPDATE notes SET shared=1,archived_at=1 WHERE id=?').bind(id).run();return statements;
  })).rejects.toThrow('append conflict');
  expect((await services.notes.getRowById(a.append_guard.id))?.body_md).toBe(before?.body_md);
  expect(await count('events',a.append_guard.id)).toEqual({n:0});expect(await count('note_revisions',a.append_guard.id)).toEqual({n:1});
  expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(0);
  expect(await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(3142)).first()).toEqual({distill_status:'pending'});
});
it('personal, foreign, expired, denied, truncated, imported and memory-echo sources never reach shared memory',async()=>{
  const kinds=['personal','foreign','expired','denied','truncated','imported','echo'];
  for(const [i,kind]of kinds.entries()){
    const n=3150+i,a=await request('append-source-'+kind,n,true);
    if(kind==='foreign')a.provenance.source_event_ids=[await source(n+100,'project',bob)];
    else if(kind==='personal')await db.prepare("UPDATE capture_events SET visibility='personal' WHERE user_id='alice' AND id=?").bind(eid(n)).run();
    else if(kind==='expired')await db.prepare('UPDATE capture_events SET expires_at=1 WHERE user_id=? AND id=?').bind('alice',eid(n)).run();
    else if(kind==='echo')await db.prepare("UPDATE capture_events SET tool_name='mcp__cf-memory__notes_append_status' WHERE user_id='alice' AND id=?").bind(eid(n)).run();
    else await db.prepare("UPDATE capture_events SET metadata_json=json_set(metadata_json,?,1) WHERE user_id='alice' AND id=?").bind('$.'+kind,eid(n)).run();
    await expect(tool('notes_append_guarded',a)).rejects.toThrow();expect(await status(a)).toEqual({completed:false});
    expect((await services.notes.getRowById(a.append_guard.id))?.body_md).toBe('Original supported contract.');
  }
});
it('owner-only mutation and receipt, malformed guards and secret text fail closed; legacy append remains',async()=>{
  const a=await request('append-owner',3160,true);await expect(tool('notes_append_guarded',a,bob)).rejects.toThrow('append conflict');
  await tool('notes_append_guarded',a);expect(await tool('notes_append_status',{id:a.append_guard.id,append_id:a.append_id},bob)).toEqual({completed:false});
  const b=await request('append-malformed',3161);
  for(const changed of [{slug:b.slug,text:b.text},{...b,append_guard:undefined},{...b,append_id:'bad'},
    {...b,text:'Authorization: Bearer fixture-secret-12345678901234567890'}, {...b,expected_content_hash:eid(5)}])await expect(tool('notes_append_guarded',changed)).rejects.toThrow();
  expect((await services.notes.getRowById(b.append_guard.id))?.body_md).toBe('Original supported contract.');
  await expect(tool('notes_append_guarded_old_server_unsupported',b)).rejects.toThrow();
  await tool('notes_append',{slug:'legacy-append-create',text:'Legacy journal content.'});
  expect((await services.notes.getRowBySlug('alice','legacy-append-create'))?.body_md).toBe('Legacy journal content.');
});
it('retained source snapshots survive concurrent TTL cleanup after validation',async()=>{
  const a=await request('append-source-snapshot',3162);
  const r=await services.notes.appendReviewed(alice,a,async(id,shared,receiptId,requestHash,p,commitNonce)=>{
    const statements=await services.capture.prepareAppend(alice,id,shared,receiptId,requestHash,p,commitNonce);
    await db.prepare('DELETE FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(3162)).run();return statements;
  });
  expect(r.provenance_stored).toBe(true);expect(await services.capture.provenance('note',a.append_guard.id,alice)).toHaveLength(1);
});
it('serialized private material is rejected in text, rationale and observed source payloads',async()=>{
  const a=await request('append-private-serialized',3164,true);
  const material=JSON.stringify({private:true,detail:'fixture explicitly private content'});
  const encodedSecret='{"API\\u005fKEY":"fixture-serialized-credential-1234567890"}';
  for(const text of [material,JSON.stringify(material),'```json\n'+material+'\n```','Context: '+material,encodedSecret])
    await expect(tool('notes_append_guarded',{...a,text})).rejects.toThrow();
  await expect(tool('notes_append_guarded',{...a,provenance:{...a.provenance,rationale:material}})).rejects.toThrow('invalid append provenance');
  await expect(tool('notes_append_guarded',{...a,provenance:{...a.provenance,rationale:encodedSecret}})).rejects.toThrow('invalid append provenance');
  for(const output of [material,encodedSecret]){
    await db.prepare('UPDATE capture_events SET payload_redacted=? WHERE user_id=? AND id=?').bind(JSON.stringify({output}),'alice',eid(3164)).run();
    await expect(tool('notes_append_guarded',a)).rejects.toThrow('ineligible append source');
  }
  expect((await services.notes.getRowById(a.append_guard.id))?.body_md).toBe('Original supported contract.');expect(await status(a)).toEqual({completed:false});
});
it('a guarded append writes no embedding and schedules no embedding job',async()=>{
  const repo=new NotesRepo(db),a=await request('append-job',3163);
  const prepare=(id:string,shared:boolean,receiptId:string,requestHash:string,p:Parameters<typeof services.capture.prepareAppend>[5],commitNonce:string)=>services.capture.prepareAppend(alice,id,shared,receiptId,requestHash,p,commitNonce);
  const r=await repo.appendReviewed(alice,a,prepare);
  expect(r.appended).toBe(true);
  expect(await db.prepare('SELECT count(*) AS n FROM embedding_jobs WHERE kind=? AND memory_id=?').bind('note',a.append_guard.id).first()).toEqual({n:0});
  expect(await db.prepare('SELECT embedding,embedding_model FROM notes WHERE id=?').bind(a.append_guard.id).first()).toEqual({embedding:null,embedding_model:null});
});
