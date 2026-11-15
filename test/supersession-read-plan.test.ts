import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { validityClause } from '../src/search';

let mf: Miniflare, db: D1Database;
const at = 1000;
// Schema34 has no index on supersedes. Retain the same TEXT/NOT NULL key
// constraints, and deliberately allow legacy NULL ids like SQLite's TEXT PK.
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  await db.prepare('CREATE TABLE notes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,supersedes TEXT,shared INTEGER,deleted_at INTEGER,valid_from INTEGER,valid_until INTEGER)').run();
});
beforeEach(async () => { await db.prepare('DELETE FROM notes').run(); });
afterAll(async () => { await mf?.dispose(); });
const original = 'NOT EXISTS (SELECT 1 FROM notes sup WHERE sup.supersedes=n.id AND sup.deleted_at IS NULL AND (sup.user_id=n.user_id OR sup.shared=1)) AND (n.valid_from IS NULL OR n.valid_from<=?) AND (n.valid_until IS NULL OR n.valid_until>?)';
type Row = [string | null, string, string | null, number | null, number | null, number | null, number | null];
async function insert(rows: Row[]) {
  for (let i = 0; i < rows.length; i += 100) await db.batch(rows.slice(i, i + 100).map(r => db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?)').bind(...r)));
}
function query(sql: string, prefix = '') {
  return db.prepare(prefix + 'SELECT n.id,n.user_id FROM notes n WHERE ' + sql + ' ORDER BY n.rowid').bind(at, at);
}
const current = () => validityClause('note', true).sql.replace(/ AND $/, '');

it('preserves author/shared/deleted/temporal behavior and NULL-pointer safety', async () => {
  await insert([
    ['alice-old', 'alice', null, 1, null, null, null],
    ['bob-private', 'bob', 'alice-old', 0, null, null, null],
    ['alice-own', 'alice', 'alice-old', 0, null, null, null],
    ['old-shared', 'alice', null, 1, null, null, null],
    ['shared-replacement', 'bob', 'old-shared', 1, null, 2000, 500],
    ['old-deleted', 'alice', null, 1, null, null, null],
    ['deleted-replacement', 'alice', 'old-deleted', 1, 0, null, null],
    ['unrelated', 'bob', null, null, null, null, null],
    [null, 'alice', null, 1, null, null, null],
    ['', 'alice', null, 0, null, null, null],
    ['empty-replacement', 'alice', '', 0, null, null, null],
    ['future', 'alice', null, 0, null, 1001, null],
    ['boundary', 'alice', null, 0, null, 1000, 1000],
  ]);
  expect((await query(current()).all()).results).toEqual((await query(original).all()).results);
  await db.prepare("UPDATE notes SET deleted_at=1 WHERE id='alice-own'").run();
  const result = await query(current()).all<{ id: string | null }>();
  expect(result.results).toEqual((await query(original).all()).results);
  // Another author's private replacement never hides Alice's shared memory.
  expect(result.results.some(r => r.id === 'alice-old')).toBe(true);
  expect(result.results.some(r => r.id === 'old-shared')).toBe(false);
  expect(result.results.some(r => r.id === 'old-deleted')).toBe(true);
  expect(result.results.some(r => r.id === null)).toBe(true);
});

it('keeps composite identities distinct even with delimiters, quotes, NUL and Unicode', async () => {
  await insert([
    ['b\0c', 'a', null, 1, null, null, null],
    ['c', 'a\0b', null, 1, null, null, null],
    ['replacement', 'a', 'b\0c', 0, null, null, null],
    ['"\\日本語', 'alice|bob', null, 1, null, null, null],
    ['quoted-replacement', 'alice|bob', '"\\日本語', 0, null, null, null],
  ]);
  const result = await query(current()).all<{ id: string }>();
  expect(result.results).toEqual((await query(original).all()).results);
  expect(result.results.some(r => r.id === 'c')).toBe(true);
  expect(result.results.some(r => r.id === 'b\0c')).toBe(false);
});

it('matches the reference over a deterministic mixed lifecycle corpus and avoids per-row correlated scans', async () => {
  await insert(Array.from({ length: 1024 }, (_, i): Row => [
    'note-' + i, 'user-' + (i % 5), i < 512 ? 'note-' + ((i * 19) % 1024) : null,
    i % 3 === 0 ? 1 : 0, i % 7 === 0 ? 1 : null,
    i % 11 === 0 ? 1001 : null, i % 13 === 0 ? 1000 : null,
  ]));
  const reference = await query(original).all(), result = await query(current()).all();
  expect(result.results).toEqual(reference.results);
  const oldPlan = await query(original, 'EXPLAIN QUERY PLAN ').all<{ detail: string }>();
  const newPlan = await query(current(), 'EXPLAIN QUERY PLAN ').all<{ detail: string }>();
  expect(oldPlan.results.some(r => /CORRELATED/i.test(r.detail))).toBe(true);
  expect(newPlan.results.some(r => /CORRELATED/i.test(r.detail))).toBe(false);
  expect(newPlan.results.filter(r => /LIST SUBQUERY/i.test(r.detail))).toHaveLength(2);
// This includes 1,024 D1 fixture writes and the intentionally slow original
// reference query. Shared CI runners can exceed Vitest's 5s default; assertions
// on equivalence and the optimized query plan remain the performance contract.
}, 30_000);
