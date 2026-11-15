import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeServices } from '../src/services';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';
const scopes = new Set(['notes:read','notes:write']);
const alice = principalFixture({ userId: 'alice', handle: 'alice', scopes });
const bob = principalFixture({ userId: 'bob', handle: 'bob', scopes });
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const raw = readFileSync(join('migrations', name), 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const sql of raw.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,bio_md,created_at,updated_at) VALUES (?,?,?,'',0,0)").bind(p.userId,p.handle,p.handle).run();
  services = makeServices(db);
});
afterAll(async () => { await mf?.dispose(); });
async function tool(name: string, args: Record<string,unknown>, principal = alice) {
  const r = await handleMcp(new Request('https://memory.test/mcp', {method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}), {principal,services,budget:4000});
  const m = await r.json() as { error?: unknown; result?: {isError?: boolean;content:{text:string}[]} };
  if (m.error || !m.result || m.result.isError) throw Error(JSON.stringify(m));
  return JSON.parse(m.result.content[0].text);
}
async function note(slug: string, shared = false) {
  return (await services.notes.upsert(alice,{slug,title:slug,body_md:'A retractable contract.',shared})).note;
}
const deletedEvents = async (id: string) => (await db.prepare("SELECT count(*) AS n FROM events WHERE target_id=? AND verb='note.deleted'").bind(id).first<{n:number}>())?.n;
const eid = (n: number) => n.toString(16).padStart(64,'0');
async function source(n: number, visibility = 'personal', owner = alice) {
  await services.capture.put(owner,{id:eid(n),session_id:eid(n+10000),event_type:'PostToolUse',tool_name:'Read',tool_use_id:eid(n),payload_hash:eid(n+30000),occurred_at:Date.now(),visibility,repo_context:['https://github.com/acme/cf-memory'],file_refs:['src/db.ts'],payload_redacted:{input:{file_path:'src/db.ts'},output:'The earlier database claim was confirmed false by the implementation.'},client:'claude-code'});
  return eid(n);
}
async function request(slug: string, n: number, shared = false) {
  const row=await note(slug,shared), event=await source(n,shared?'project':'personal');
  return {id:row.id,deletion_guard:(await tool('notes_get',{id:row.id})).supersession_guard,retraction_id:eid(n+20000),provenance:{source_event_ids:[event],generated_by:'cf-memory-agent/subscription/review-v6',confidence:0.99,rationale:'Confirmed false claim; checked source and owned target.'}};
}
it('atomically retracts the note with contradiction provenance, audit and source checkpoint',async()=>{
  const a=await request('atomic-delete-success',2101);
  expect(await tool('server_status',{})).toMatchObject({atomic_retraction_provenance:true});
  expect(await tool('notes_delete',a)).toMatchObject({deleted:true,id:a.id,provenance_stored:true,retraction_id:a.retraction_id});
  expect((await services.notes.getRowById(a.id))?.deleted_at).not.toBeNull();
  const p=await services.capture.provenance('note',a.id,alice);
  expect(p).toHaveLength(1);expect(p[0]).toMatchObject({relation:'contradicts',event_id:eid(2101),actor_id:'alice'});
  expect(p[0].source).toMatchObject({retracted_memory_content_hash:a.deletion_guard.content_hash,retraction_id:a.retraction_id});
  expect(p[0].source).not.toHaveProperty('cwd');
  expect(await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(2101)).first()).toMatchObject({distill_status:'applied'});
  expect(await deletedEvents(a.id)).toBe(1);
  expect(await tool('notes_retraction_status',{id:a.id,retraction_id:a.retraction_id})).toMatchObject({completed:true,id:a.id,provenance:a.provenance,deletion_guard:a.deletion_guard});
});
it('lost response retry survives expired originals without another deletion or trace',async()=>{
  const a=await request('atomic-delete-retry',2102);await tool('notes_delete',a);
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(2102)).run();
  expect(await tool('notes_delete',a)).toMatchObject({deleted:true,replayed:true,provenance_stored:true});
  expect(await deletedEvents(a.id)).toBe(1);expect(await services.capture.provenance('note',a.id,alice)).toHaveLength(1);
});
it('a replay never deletes a human-restored target or erases its new FTS row',async()=>{
  const a=await request('atomic-delete-restore',2103);await tool('notes_delete',a);
  await db.prepare("UPDATE notes SET deleted_at=NULL,updated_at=updated_at+1,body_md='A human restored this.' WHERE id=?").bind(a.id).run();
  await db.prepare("INSERT INTO notes_fts(rowid,title,body,tags) SELECT rowid,title,body_md,'' FROM notes WHERE id=?").bind(a.id).run();
  expect(await tool('notes_delete',a)).toMatchObject({deleted:true,replayed:true,current_deleted:false});
  expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
  expect(await db.prepare('SELECT count(*) AS n FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?)').bind(a.id).first()).toMatchObject({n:1});
});
it('failed provenance insertion rolls back deletion, audit, search, links and source status',async()=>{
  const a=await request('atomic-delete-rollback',2104);
  const inbound=await services.notes.upsert(alice,{slug:'atomic-delete-link',body_md:'See [[atomic-delete-rollback]].'});
  await db.prepare("CREATE TRIGGER reject_retraction BEFORE INSERT ON memory_provenance WHEN NEW.relation='contradicts' BEGIN SELECT RAISE(ABORT,'fixture provenance failure'); END").run();
  try{await expect(tool('notes_delete',a)).rejects.toThrow(/Internal error in notes_delete \(code [0-9a-f]{8}\)/);}finally{await db.prepare('DROP TRIGGER reject_retraction').run();}
  expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();expect(await deletedEvents(a.id)).toBe(0);
  expect(await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind('alice',eid(2104)).first()).toMatchObject({distill_status:'pending'});
  expect(await db.prepare('SELECT resolved FROM links WHERE src_note_id=?').bind(inbound.note.id).first()).toMatchObject({resolved:1});
  expect(await db.prepare('SELECT count(*) AS n FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?)').bind(a.id).first()).toMatchObject({n:1});
});
it('stale target has no receipt, contradiction or applied source',async()=>{
  const a=await request('atomic-delete-stale',2105);await services.notes.upsert(alice,{slug:'atomic-delete-stale',body_md:'A human edited independently.'});
  await expect(tool('notes_delete',a)).rejects.toThrow('deletion conflict');
  expect(await deletedEvents(a.id)).toBe(0);expect(await services.capture.provenance('note',a.id,alice)).toEqual([]);
  expect(await tool('notes_retraction_status',{id:a.id,retraction_id:a.retraction_id})).toMatchObject({completed:false});
});
it('personal, foreign, missing, denied and expired evidence cannot authorize a shared retraction',async()=>{
  for(const kind of ['personal','foreign','missing','denied','expired']){
    const n=2110+['personal','foreign','missing','denied','expired'].indexOf(kind),a=await request('atomic-delete-source-'+kind,n,true);
    if(kind==='personal') await db.prepare("UPDATE capture_events SET visibility='personal' WHERE user_id='alice' AND id=?").bind(eid(n)).run();
    if(kind==='foreign'){a.provenance.source_event_ids=[await source(n+100,'project',bob)];}
    if(kind==='missing')a.provenance.source_event_ids=[eid(99999)];
    if(kind==='denied')await db.prepare("UPDATE capture_events SET metadata_json=json_set(metadata_json,'$.denied',1) WHERE user_id='alice' AND id=?").bind(eid(n)).run();
    if(kind==='expired')await db.prepare("UPDATE capture_events SET expires_at=1 WHERE user_id='alice' AND id=?").bind(eid(n)).run();
    await expect(tool('notes_delete',a)).rejects.toThrow();expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();expect(await deletedEvents(a.id)).toBe(0);
  }
});
it('another owner cannot retract or inspect the owner receipt',async()=>{
  const a=await request('atomic-delete-owner',2120,true);
  expect(await tool('notes_delete',a,bob)).toMatchObject({deleted:false});
  await tool('notes_delete',a);
  expect(await tool('notes_retraction_status',{id:a.id,retraction_id:a.retraction_id},bob)).toMatchObject({completed:false});
});
it('concurrent identical requests have one mutation/audit/provenance and both can acknowledge',async()=>{
  const a=await request('atomic-delete-concurrent',2121);
  const result=await Promise.all([tool('notes_delete',a),tool('notes_delete',a)]);
  expect(result.every(r=>r.deleted&&r.provenance_stored)).toBe(true);
  expect(await deletedEvents(a.id)).toBe(1);expect(await services.capture.provenance('note',a.id,alice)).toHaveLength(1);
});
it('reusing an operation with different input is refused and never retracts a different target',async()=>{
  const a=await request('atomic-delete-bound',2122);await tool('notes_delete',a);
  await expect(tool('notes_delete',{...a,provenance:{...a.provenance,rationale:'A different request.'}})).rejects.toThrow('retraction receipt conflict');
  const b=await request('atomic-delete-other-target',2123);b.retraction_id=a.retraction_id;
  await expect(tool('notes_delete',b)).rejects.toThrow();expect((await services.notes.getRowById(b.id))?.deleted_at).toBeNull();
});
it('partial atomic requests and private rationale refuse instead of falling through to manual deletion',async()=>{
  for(const kind of ['missing-guard','missing-operation','missing-provenance','bad-operation','unknown-field','private-rationale']){
    const a:Record<string,any>=await request('atomic-delete-invalid-'+kind,2130+['missing-guard','missing-operation','missing-provenance','bad-operation','unknown-field','private-rationale'].indexOf(kind));
    if(kind==='missing-guard')delete a.deletion_guard;if(kind==='missing-operation')delete a.retraction_id;if(kind==='missing-provenance')delete a.provenance;
    if(kind==='bad-operation')a.retraction_id='bad';if(kind==='unknown-field')a.provenance.extra='not allowed';if(kind==='private-rationale')a.provenance.rationale='Authorization: Bearer fixture-atomic-private-secret';
    await expect(tool('notes_delete',a)).rejects.toThrow();expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
  }
});
it('atomic auto-retraction refuses a live superseder instead of reviving its old misinformation',async()=>{
  const old=await note('atomic-delete-predecessor'),a=await request('atomic-delete-successor',2140);
  await db.prepare('UPDATE notes SET supersedes=? WHERE id=?').bind(old.id,a.id).run();
  await expect(tool('notes_delete',a)).rejects.toThrow('deletion conflict');expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
  expect(await services.notes.isCurrent(old.id)).toBe(false);
});

it('a new operation cannot silently reuse an old contradiction trace after restoration', async () => {
  const a = await request('atomic-delete-trace-collision', 2150);
  await tool('notes_delete', a);
  await db.prepare('UPDATE notes SET deleted_at=NULL,updated_at=updated_at+1 WHERE id=?').bind(a.id).run();
  const next = {...a, retraction_id:eid(5150), deletion_guard:(await tool('notes_get',{id:a.id})).supersession_guard};
  await expect(tool('notes_delete',next)).rejects.toThrow();
  expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
  expect(await deletedEvents(a.id)).toBe(1);
  expect(await tool('notes_retraction_status',{id:a.id,retraction_id:next.retraction_id})).toEqual({completed:false});
});
it('a concurrent same-millisecond manual deletion cannot manufacture an atomic receipt', async () => {
  const clock = vi.spyOn(Date,'now').mockReturnValue(Date.now());
  try {
    const a = await request('atomic-delete-same-millisecond',2151);
    await expect(services.notes.retract(alice,a.id,a.deletion_guard,a.retraction_id,a.provenance,async(receipt,hash,shared)=>{
      const statements = await services.capture.prepareRetraction(alice,a.id,shared,receipt,hash,a.provenance);
      await services.notes.softDelete(alice,a.id,a.deletion_guard);
      return statements;
    })).rejects.toThrow('deletion conflict');
    expect(await deletedEvents(a.id)).toBe(1);
    expect(await services.capture.provenance('note',a.id,alice)).toEqual([]);
    expect(await tool('notes_retraction_status',{id:a.id,retraction_id:a.retraction_id})).toEqual({completed:false});
  } finally { clock.mockRestore(); }
});
it('known memory echoes, authored, imported, truncated and secret-bearing sources are ineligible', async () => {
  const cases=['echo','receipt','authored','imported','truncated','secret','payload-truncated','wrong-event'];
  for (const [index,kind] of cases.entries()) {
    const n=2160+index,a=await request('atomic-delete-ineligible-'+kind,n);
    if(kind==='echo'||kind==='receipt')await db.prepare('UPDATE capture_events SET tool_name=? WHERE user_id=? AND id=?').bind(kind==='echo'?'mcp__cf-memory__notes_get':'mcp__cf-memory__notes_retraction_status','alice',eid(n)).run();
    if(kind==='authored')await db.prepare("UPDATE capture_events SET metadata_json=json_set(metadata_json,'$.source_kind','authored_memory') WHERE user_id=? AND id=?").bind('alice',eid(n)).run();
    if(kind==='imported'||kind==='truncated')await db.prepare("UPDATE capture_events SET metadata_json=json_set(metadata_json,?,1) WHERE user_id=? AND id=?").bind('$.'+kind,'alice',eid(n)).run();
    if(kind==='secret')await db.prepare('UPDATE capture_events SET payload_redacted=? WHERE user_id=? AND id=?').bind(JSON.stringify({input:{},output:'[REDACTED]'}),'alice',eid(n)).run();
    if(kind==='payload-truncated')await db.prepare('UPDATE capture_events SET payload_redacted=? WHERE user_id=? AND id=?').bind(JSON.stringify({preview:'Partial source prefix',truncated:true}),'alice',eid(n)).run();
    if(kind==='wrong-event')await db.prepare("UPDATE capture_events SET event_type='UserPromptSubmit' WHERE user_id=? AND id=?").bind('alice',eid(n)).run();
    await expect(tool('notes_delete',a)).rejects.toThrow('ineligible retraction source');
    expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
    expect(await deletedEvents(a.id)).toBe(0);
  }
});
it('repository calls enforce operation and provenance validation before preparing mutations', async () => {
  const a=await request('atomic-delete-repo-validation',2180);
  let prepared=false;
  const prepare=async()=>{prepared=true;return [];};
  await expect(services.notes.retract(alice,a.id,a.deletion_guard,'unsafe-operation',a.provenance,prepare)).rejects.toThrow('invalid retraction_id');
  await expect(services.notes.retract(alice,a.id,a.deletion_guard,a.retraction_id,{...a.provenance,generated_by:'opaque-private-value'},prepare)).rejects.toThrow('invalid retraction provenance');
  await expect(services.notes.retractionStatus(alice,a.id,'unsafe-operation')).rejects.toThrow('invalid retraction_id');
  expect(prepared).toBe(false);expect((await services.notes.getRowById(a.id))?.deleted_at).toBeNull();
});

