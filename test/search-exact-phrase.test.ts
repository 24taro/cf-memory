import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { principalFixture } from './helpers';

const alice = principalFixture({ userId: 'async-alice', handle: 'async-alice' });
const bob = principalFixture({ userId: 'async-bob', handle: 'async-bob' });
const repo = 'https://github.com/team/async', other = 'https://github.com/team/other';
const query = 'agent-queue-310fc43a-290e-47aa-9437-ae306131a766';
// Exact identifiers and phrases must outrank many older rows that merely share
// some of their words (the phrase lane), across notes, Recall and skills, with
// the same isolation and correction rules. (This used to be framed as "before
// asynchronous ANN delivery"; search is keyword-only since 2026-10-31.)
let mf: Miniflare, services: ReturnType<typeof makeServices>;
beforeAll(async()=>{
  mf = new Miniflare(convertV4MiniflareOptions({ modules:true,script:'export default {};',d1Databases:['DB'] }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for(const f of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()) for(const sql of readFileSync('migrations/'+f,'utf8').split('\n').map(l=>l.split('--')[0]).join('\n').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for(const p of [alice,bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId,p.handle,p.handle,p.handle+'@example.com').run();
  services = makeServices(db);
  // Many older partial keyword matches, then fresh exact knowledge.
  for(let i=0;i<18;i++) {
    await services.notes.upsert(alice,{slug:'async-old-'+i,title:'agent queue operations '+i,body_md:'agent queue operational guidance',type:'project',scope:repo});
  }
  for(const [suffix,type,scope] of [['repo','project',repo],['global','project','global'],['private','user',repo],['other','project',other]] as const) {
    await services.notes.upsert(alice,{slug:'async-fresh-'+suffix,title:query+' '+suffix,body_md:query+' verified '+suffix+' PostgreSQL fact',type,scope});
  }
  const obsolete = await services.notes.upsert(alice,{slug:'async-obsolete',title:query,body_md:query+' obsolete MySQL',type:'project',scope:repo});
  await services.notes.upsert(alice,{slug:'async-correction',title:query,body_md:query+' current PostgreSQL',type:'project',scope:repo,supersedes:obsolete.note.id});
  for(let i=0;i<8;i++) {
    await services.skills.upsert(alice,{slug:'async-old-skill-'+i,name:'agent queue operations '+i,description:'agent queue procedure'});
  }
  await services.skills.upsert(alice,{slug:'async-fresh-skill',name:query,description:query+' verified procedure'});
},20000);
afterAll(async()=>{await mf?.dispose();});
it('search finds newly committed exact knowledge ahead of many partial matches',async()=>{
  const hits = await services.search.hybrid(alice,query,{limit:5,context:repo,current_only:true});
  expect(hits.map(h=>h.slug)).toContain('async-fresh-repo');
  expect(hits.map(h=>h.slug)).toContain('async-fresh-global');
  expect(hits.map(h=>h.slug)).toContain('async-fresh-private');
  expect(hits.map(h=>h.slug)).not.toContain('async-fresh-other');
  expect(hits.map(h=>h.slug)).not.toContain('async-obsolete');
});
it('fresh exact matches still respect teammate isolation and correction in Recall',async()=>{
  const pack=await services.recall.recall(bob,query,4000,5,repo);
  expect(pack.text).toContain('verified repo PostgreSQL');
  expect(pack.text).toContain('verified global PostgreSQL');
  expect(pack.text).toContain('current PostgreSQL');
  expect(pack.text).not.toContain('verified private');
  expect(pack.text).not.toContain('verified other');
  expect(pack.text).not.toContain('obsolete MySQL');
});
it('new procedures are discoverable by exact identifier without exposing owner-only skills',async()=>{
  expect((await services.search.hybrid(alice,query,{limit:2,scope:'skills'})).map(h=>h.slug)).toContain('async-fresh-skill');
  expect(await services.search.hybrid(bob,query,{limit:2,scope:'skills'})).toEqual([]);
});
