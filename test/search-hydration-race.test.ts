import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { SearchService } from '../src/search';
import { gatedDb, principalFixture, type DbGate } from './helpers';

let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
const alice = principalFixture({ userId: 'hydration-alice', handle: 'hydration-alice' });
const bob = principalFixture({ userId: 'hydration-bob', handle: 'hydration-bob' });
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = readFileSync('migrations/' + name, 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle, p.handle + '@example.com').run();
  services = makeServices(db);
});
afterAll(async () => { await mf?.dispose(); });

// The genuine authoritative D1 candidate lookup (an FTS lane) completes first.
// A concurrent writer commits before hydration. This models a real
// inter-request race; hydration must recheck every predicate on the row it reads.
function racingSearch(change: () => Promise<void>) {
  const gate: DbGate = {};
  const state = { fired: false };
  gate.next = async () => { state.fired = true; await change(); };
  return { state, search: new SearchService(gatedDb(db, gate, sql => sql.includes('FROM notes_fts f JOIN notes n'))) };
}
it('a shared note becoming personal after candidate selection never leaks its new private body', async () => {
  const note = (await services.notes.upsert(alice, { slug: 'race-private', title: 'Transaction', body_md: 'Shared transaction contract', type: 'project' })).note;
  const { search, state } = racingSearch(async () => {
    await services.notes.upsert(alice, { slug: note.slug, title: note.title, body_md: 'Private lasting transaction preference', type: 'user' });
  });
  const hits = await search.hybrid(bob, 'transaction');
  expect(state.fired).toBe(true);
  expect(hits).toEqual([]);
  expect((await services.search.hybrid(alice, 'transaction', { mode: 'keyword' })).map(hit => hit.id)).toContain(note.id);
});
it('candidate scope/lifecycle changes are rechecked when full source rows are read', async () => {
  for (const [name, change] of [
    ['scope', "scope='github.com/team/other'"],
    ['archive', 'archived_at=1'],
    ['validity', 'valid_from=9999999999999'],
    ['deleted', 'deleted_at=1'],
  ] as const) {
    const slug = 'race-' + name, remote = 'https://github.com/team/' + name;
    const note = (await services.notes.upsert(alice, { slug, title: 'Transaction', body_md: 'Shared transaction contract', type: 'project', scope: remote })).note;
    const { search, state } = racingSearch(async () => { await db.prepare(`UPDATE notes SET ${change} WHERE id=?`).bind(note.id).run(); });
    const hits = await search.hybrid(bob, 'transaction', { context: remote, excludeArchived: true });
    expect(state.fired, name).toBe(true);
    expect(hits.map(hit => hit.id), name).not.toContain(note.id);
  }
});

it('Recall rechecks privacy, scope and current validity at its final pack hydration', async () => {
  for (const [name, change] of [
    ['private', "shared=0,type='user',body_md='PRIVATE RECALL RACE'"],
    ['scope', "scope='github.com/team/elsewhere'"],
    ['archive', 'archived_at=1'],
    ['expiry', 'valid_until=1'],
    ['future', 'valid_from=9999999999999'],
    ['block', "kind='block'"],
  ] as const) {
    const note=(await services.notes.upsert(alice,{slug:'pack-race-'+name,title:'Unique pack race '+name,body_md:'verified pack race '+name,type:'project',scope:'https://github.com/team/pack-'+name})).note;
    const original=services.notes.getRowsByIds.bind(services.notes);
    services.notes.getRowsByIds=async(...args)=>{await db.prepare(`UPDATE notes SET ${change} WHERE id=?`).bind(note.id).run();return original(...args);};
    try {
      const pack=await services.recall.recall(bob,'Unique pack race '+name,4000,12,'https://github.com/team/pack-'+name);
      expect(pack.text,name).not.toContain('PRIVATE RECALL RACE');
      expect(pack.candidates?.map(c=>c.ref),name).not.toContain(note.slug);
    } finally {services.notes.getRowsByIds=original;}
  }
});
it('no-query recency Recall does not revive a concurrently superseded fact',async()=>{
  const scope='https://github.com/team/pack-supersede';
  const note=(await services.notes.upsert(alice,{slug:'pack-race-obsolete',title:'Pack old database',body_md:'Pack old MySQL',type:'project',scope})).note;
  const original=services.notes.getRowsByIds.bind(services.notes);
  services.notes.getRowsByIds=async(...args)=>{await services.notes.upsert(alice,{slug:'pack-race-current',title:'Pack current database',body_md:'Pack current PostgreSQL',type:'project',scope,supersedes:note.id});return original(...args);};
  try {expect((await services.recall.recall(bob,'',4000,12,scope)).text).not.toContain('Pack old MySQL');}
  finally {services.notes.getRowsByIds=original;}
});
