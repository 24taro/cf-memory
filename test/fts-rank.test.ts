import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { normalizeScopes, scopeClause } from '../src/context';
import { ftsQuery, validityClause } from '../src/search';
import { makeServices } from '../src/services';
import { readableSql } from '../src/visibility';
import type { Principal } from '../src/types';
import { principalFixture } from './helpers';

const alice = principalFixture({ userId: 'rank-alice', handle: 'rank-alice' });
const bob = principalFixture({ userId: 'rank-bob', handle: 'rank-bob' });
const context = 'https://github.com/team/rank-a', other = 'https://github.com/team/rank-b';
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const f of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const source = readFileSync('migrations/' + f, 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const sql of source.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,'fixture@example.test','',0,0)").bind(p.userId,p.handle,p.handle).run();
  services = makeServices(db);
  for (let i = 0; i < 24; i++) {
    await services.notes.upsert(alice, { slug: 'rank-note-' + i, title: i % 3 === 0 ? 'Database contract rankprobe ' + i : 'Database supplement ' + i,
      body_md: ('Database contract rankprobe プロジェクト知識 ' + i + ' ').repeat(i + 1), type: i % 5 === 0 ? 'user' : 'project', scope: i % 4 === 0 ? other : i % 4 === 1 ? 'global' : context });
    await services.skills.upsert(i % 5 === 0 ? bob : alice, { slug: 'rank-skill-' + i, name: i % 3 === 0 ? 'Database contract rankprobe ' + i : 'Database supplement ' + i,
      description: 'Database contract rankprobe', instructions: ('Database contract rankprobe プロジェクト知識 ' + i + ' ').repeat(i + 1), scope: i % 4 === 0 ? other : i % 4 === 1 ? 'global' : context });
  }
  for (const [slug, change] of [['rank-archived','archived_at=1'], ['rank-expired','valid_until=1'], ['rank-future','valid_from=9999999999999'], ['rank-deleted','deleted_at=1']] as const) {
    const { note } = await services.notes.upsert(alice, { slug, title: 'rankprobe', body_md: 'rankprobe', type: 'project', scope: context });
    await db.prepare(`UPDATE notes SET ${change} WHERE id=?`).bind(note.id).run();
  }
  const old = (await services.notes.upsert(alice, { slug: 'rank-obsolete', title: 'rankprobe', body_md: 'rankprobe', type: 'project', scope: context })).note;
  await services.notes.upsert(alice, { slug: 'rank-new', title: 'Current database', body_md: 'Current contract', type: 'project', scope: context, supersedes: old.id });
  const live = (await services.notes.upsert(alice, { slug: 'rank-private-sup-target', title: 'rankprobe', body_md: 'rankprobe', type: 'project', scope: context })).note;
  await services.notes.upsert(bob, { slug: 'rank-private-sup', title: 'Personal replacement', body_md: 'Personal contract', type: 'user', supersedes: live.id });
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

// Independent old SQL oracle: keep the previous outer bm25() sort and compare
// results through the public service, not a duplicated rank implementation.
async function oldOrder(principal: Principal, query: string, kind: 'note' | 'skill', current: boolean, scoped: boolean, limit: number) {
  const table = kind === 'note' ? 'notes' : 'skills', fts = table + '_fts';
  const vis = readableSql('n', principal), scope = scopeClause('n', scoped ? normalizeScopes(context) : []), valid = validityClause(kind, current);
  const sql = `SELECT n.id FROM ${fts} f JOIN ${table} n ON n.rowid=f.rowid WHERE ${fts} MATCH ? AND n.deleted_at IS NULL AND ${kind === 'note' ? "n.kind!='block' AND " : ''}${kind === 'note' && current ? 'n.archived_at IS NULL AND ' : ''}${valid.sql}(${vis.sql}${scope.sql}) ORDER BY bm25(${fts},5.0,1.0,1.0) LIMIT ?`;
  return (await db.prepare(sql).bind(ftsQuery(query), ...valid.args(Date.now()), ...vis.args, ...scope.args, limit).all<{id: string}>()).results.map(r => r.id);
}
for (const kind of ['note', 'skill'] as const) it(`preserves weighted BM25 ${kind} ordering for both principals, scopes and historical/current reads`, async () => {
  for (const principal of [alice,bob]) for (const current of [false,true]) for (const scoped of [false,true]) for (const query of ['Database contract rankprobe', 'プロジェクト知識']) {
    const limit = 10;
    const expected = await oldOrder(principal,query,kind,current,scoped,limit);
    const actual = await services.search.hybrid(principal,query,{mode:'keyword',scope:kind === 'note' ? 'notes' : 'skills',current_only:current,context:scoped ? context : undefined,limit});
    expect(actual.map(r => r.id),JSON.stringify({kind,current,scoped,query,viewer:principal.handle})).toEqual(expected);
  }
});
it('filters strong private, foreign-scope and obsolete matches before a one-result limit', async () => {
  const current = await services.search.hybrid(bob,'rankprobe',{mode:'keyword',current_only:true,context,limit:1});
  expect(current).toHaveLength(1);
  // A different author's private supersession cannot hide Alice's shared fact.
  expect(current[0].slug).toBe('rank-private-sup-target');
  const history = await services.search.hybrid(bob,'rankprobe',{mode:'keyword',context,limit:50});
  expect(history.map(r => r.slug)).toContain('rank-obsolete');
  expect(history.map(r => r.slug)).not.toContain('rank-deleted');
  const live = await services.search.hybrid(bob,'rankprobe',{mode:'keyword',current_only:true,context,limit:50});
  for (const slug of ['rank-archived','rank-expired','rank-future','rank-deleted','rank-obsolete']) expect(live.map(r => r.slug)).not.toContain(slug);
});
