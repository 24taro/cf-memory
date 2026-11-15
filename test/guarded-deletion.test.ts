import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
it('guarded deletion retains revisions and existing retraction/link behavior', async () => {
  expect(await tool('server_status',{})).toMatchObject({guarded_deletion:true});
  const n=await note('delete-guard-success');
  const inbound=await services.notes.upsert(alice,{slug:'delete-guard-inbound',body_md:'See [[delete-guard-success]].'});
  const snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
  expect(await tool('notes_delete',{id:n.id,deletion_guard:snapshot})).toMatchObject({deleted:true});
  expect((await services.notes.getRowById(n.id))?.deleted_at).not.toBeNull();
  expect((await db.prepare('SELECT count(*) AS n FROM note_revisions WHERE note_id=?').bind(n.id).first<{n:number}>())?.n).toBe(1);
  expect(await db.prepare('SELECT target_note_id,resolved FROM links WHERE src_note_id=?').bind(inbound.note.id).first()).toMatchObject({target_note_id:null,resolved:0});
  expect(await deletedEvents(n.id)).toBe(1);
});
it('an edit after inspection cannot be deleted and emits no deletion side effects', async () => {
  const n=await note('delete-guard-edit'), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
  await services.notes.upsert(alice,{slug:n.slug,body_md:'A human corrected this independently.'});
  await expect(tool('notes_delete',{id:n.id,deletion_guard:snapshot})).rejects.toThrow('deletion conflict');
  expect((await services.notes.getRowById(n.id))?.body_md).toBe('A human corrected this independently.');
  expect((await services.notes.getRowById(n.id))?.deleted_at).toBeNull();
  expect(await deletedEvents(n.id)).toBe(0);
  expect((await db.prepare('SELECT count(*) AS n FROM notes_fts WHERE rowid=(SELECT rowid FROM notes WHERE id=?)').bind(n.id).first<{n:number}>())?.n).toBe(1);
});
it('same-content scope, sharing, timestamp and provenance changes invalidate the snapshot', async () => {
  for (const field of ['scope','shared','updated_at','provenance'] as const) {
    const n=await note('delete-guard-'+field), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
    if(field==='provenance') await db.prepare("INSERT INTO memory_provenance(memory_kind,memory_id,event_id,source_session_id,actor_id,relation,generated_by,confidence,rationale,source_metadata_json,created_at) VALUES ('note',?,'changed','source','alice','confirms','cf-memory-agent/fixture',1,'new trace','{}',1)").bind(n.id).run();
    else await db.prepare(`UPDATE notes SET ${field}=? WHERE id=?`).bind(field==='scope'?'github.com/team/new-repo':field==='shared'?1:n.updated_at+1,n.id).run();
    await expect(tool('notes_delete',{id:n.id,deletion_guard:snapshot})).rejects.toThrow('deletion conflict');
    expect((await services.notes.getRowById(n.id))?.deleted_at).toBeNull();
    expect(await deletedEvents(n.id)).toBe(0);
  }
});
it('guarded deletion requires a current ordinary unarchived note', async () => {
  for(const state of ['archived','expired','future','block','pinned','superseded']) {
    const n=await note('delete-guard-'+state), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
    if(state==='superseded') await services.notes.upsert(alice,{slug:n.slug+'-new',body_md:'A newer contract.',supersedes:n.id});
    else {
      const field=state==='archived'?'archived_at':state==='expired'?'valid_until':state==='future'?'valid_from':state==='block'?'kind':'pinned_block_label';
      await db.prepare(`UPDATE notes SET ${field}=? WHERE id=?`).bind(state==='block'?'block':state==='pinned'?'pinned':state==='future'?Date.now()+60000:Date.now()-1,n.id).run();
    }
    await expect(tool('notes_delete',{id:n.id,deletion_guard:snapshot})).rejects.toThrow('deletion conflict');
    expect((await services.notes.getRowById(n.id))?.deleted_at).toBeNull();
  }
});
it('malformed or differently bound deletion guards are refused without mutation', async () => {
  const n=await note('delete-guard-invalid'), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
  for(const bad of [null,{}, {...snapshot,shared:'false'}, {...snapshot,content_hash:'wrong'}, {...snapshot,extra:1}])
    await expect(tool('notes_delete',{id:n.id,deletion_guard:bad})).rejects.toThrow('invalid deletion_guard');
  await expect(tool('notes_delete',{id:n.id,deletion_guard:{...snapshot,id:'another-note'}})).rejects.toThrow('deletion_guard target mismatch');
  expect((await services.notes.getRowById(n.id))?.deleted_at).toBeNull();
});
it('a readable shared snapshot never grants another user deletion rights', async () => {
  const n=await note('delete-guard-other-owner',true), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
  expect((await tool('notes_get',{id:n.id},bob)).supersession_guard).toBeNull();
  expect(await tool('notes_delete',{id:n.id,deletion_guard:snapshot},bob)).toMatchObject({deleted:false});
  expect((await services.notes.getRowById(n.id))?.deleted_at).toBeNull();
});
it('concurrent guarded deletes have one winner and one deletion event', async () => {
  const n=await note('delete-guard-race'), snapshot=(await tool('notes_get',{id:n.id})).supersession_guard;
  const results=await Promise.allSettled([0,1].map(()=>tool('notes_delete',{id:n.id,deletion_guard:snapshot})));
  expect(results.filter(r=>r.status==='fulfilled'&&r.value.deleted===true)).toHaveLength(1);
  expect(await deletedEvents(n.id)).toBe(1);
});
it('unguarded existing manual deletion and superseder retraction stay compatible', async () => {
  const old=await note('delete-manual-old');
  const next=(await services.notes.upsert(alice,{slug:'delete-manual-next',body_md:'The next contract.',supersedes:old.id})).note;
  expect(await services.notes.isCurrent(old.id)).toBe(false);
  expect(await tool('notes_delete',{id:next.id})).toMatchObject({deleted:true});
  expect(await services.notes.isCurrent(old.id)).toBe(true);
  expect(await tool('notes_delete',{id:next.id})).toMatchObject({deleted:false});
});
