import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { normalizeScopes } from '../src/context';
import { makeServices, type Services } from '../src/services';
import { principalFixture } from './helpers';

const alice = principalFixture({ userId: 'batch_alice', handle: 'batch-alice' });
const bob = principalFixture({ userId: 'batch_bob', handle: 'batch-bob' });
const repo = 'https://github.com/team/repo';
let mf: Miniflare, db: D1Database, services: Services;
const queries: string[] = [];
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of readdirSync('migrations').filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join('migrations', file), 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const user of [alice, bob]) await db.prepare('INSERT INTO users(id,handle,display_name,created_at,updated_at) VALUES (?,?,?,0,0)').bind(user.userId, user.handle, user.handle).run();
  // Miniflare's RPC proxy does not retain vi.spyOn replacements. Observe the
  // real forwarded queries instead, without replacing database execution.
  const counted = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { queries.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  services = makeServices(counted);
});
afterAll(async () => { await mf?.dispose(); });

it('counts delivered IDs once in one write, preserving body/hash/edit time and rechecking access/scope/lifecycle', async () => {
  const rows = [];
  for (const [slug, principal, type, scope] of [
    ['own', alice, 'user', repo], ['shared', bob, 'project', repo],
    ['private', bob, 'user', repo], ['other-repo', alice, 'project', 'https://github.com/team/other'],
    ['expired', alice, 'user', repo], ['archived', alice, 'user', repo],
    ['deleted', alice, 'user', repo], ['superseded', alice, 'user', repo],
  ] as const) {
    rows.push((await services.notes.upsert(principal, { slug: 'batch-' + slug, title: slug, body_md: 'batch fixture', type, scope })).note);
  }
  await db.prepare('UPDATE notes SET valid_until=1 WHERE id=?').bind(rows[4].id).run();
  await db.prepare('UPDATE notes SET archived_at=1 WHERE id=?').bind(rows[5].id).run();
  await db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(rows[6].id).run();
  await services.notes.upsert(alice, { slug: 'batch-correction', title: 'correction', body_md: 'current fixture', type: 'user', scope: repo, supersedes: rows[7].id });
  queries.length = 0;
  await services.notes.incrementRecallViews(alice, [...rows.map(r => r.id), rows[0].id], normalizeScopes(repo));
  expect(queries.filter(sql => sql.startsWith('UPDATE notes AS n SET view_count'))).toHaveLength(1);
  for (let i = 0; i < rows.length; i++) {
    const actual = await db.prepare('SELECT view_count,last_viewed_at,updated_at,content_hash,body_md FROM notes WHERE id=?').bind(rows[i].id).first();
    expect(actual).toMatchObject({ view_count: i < 2 ? 1 : 0, updated_at: rows[i].updated_at, content_hash: rows[i].content_hash, body_md: rows[i].body_md });
    if (i < 2) expect(actual!.last_viewed_at).toBeGreaterThan(0);
    else expect(actual!.last_viewed_at).toBeNull();
  }
});

it('does not write for an empty selection or an anonymous caller', async () => {
  queries.length = 0;
  await services.notes.incrementRecallViews(alice, []);
  await services.notes.incrementRecallViews(principalFixture({ anonymous: true }), ['untrusted-id']);
  expect(queries).toHaveLength(0);
});

it('chunks oversized selections below the D1 binding limit without double-counting', async () => {
  const result = await services.notes.upsert(alice, { slug: 'batch-chunk-real', title: 'chunk', body_md: 'body', type: 'user' });
  queries.length = 0;
  await services.notes.incrementRecallViews(alice, [result.note.id, ...Array.from({ length: 200 }, (_, i) => 'absent-' + i), result.note.id]);
  expect(queries.filter(sql => sql.startsWith('UPDATE notes AS n SET view_count'))).toHaveLength(3);
  expect(await db.prepare('SELECT view_count FROM notes WHERE id=?').bind(result.note.id).first('view_count')).toBe(1);
});
