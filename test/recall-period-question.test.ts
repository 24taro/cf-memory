import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices, type Services } from '../src/services';
import { principalFixture } from './helpers';

const context = 'https://github.com/team/timeline-focus';
const owner = principalFixture({ userId: 'timeline-owner', handle: 'timeline-owner' });
const bob = principalFixture({ userId: 'timeline-bob', handle: 'timeline-bob' });
// Actual no-tools prompt: the note was saved, but the 2000-token Hook context
// contained only unrelated operational notes during semantic timeout.
const query = 'cf-memoryのCapture timelineは他ユーザーの原典、期限切れの原典、別sessionの原典を返しますか。同時刻のeventの前後関係と返却順はどうなりますか。ファイルやWebを読まず、今回自動的に渡された記憶だけで説明してください。根拠が無い件数helperの詳細は不明と回答してください。';
const body = 'The timeline anchor query filters user_id, id and expires_at. If absent, it returns found:false. Neighbours use the same user and anchor session_id, excluding expired events. Their order uses occurred_at and id as a tie-breaker; before results are reversed, then the anchor and after results follow. Counts come from limit(args.before, 5, 10) and limit(args.after, 5, 10); the helper implementation was not observed.';
let mf: Miniflare, services: Services;
let failEmbedding = false;
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of readdirSync('migrations').filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join('migrations', file), 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const p of [owner, bob]) await db.prepare('INSERT INTO users(id,handle,display_name,created_at,updated_at) VALUES (?,?,?,0,0)').bind(p.userId, p.handle, p.handle).run();
  services = makeServices(db);
  await services.memory.setBlock(owner, 'contract', 'set', 'Keep current instructions and private memory boundaries. '.repeat(25));
  await services.notes.upsert(owner, { slug: 'timeline-answer', title: 'Capture timeline query: anchor lookup and before/after ordering', type: 'project', scope: context, body_md: body });
  for (let i = 0; i < 14; i++) await services.notes.upsert(owner, { slug: 'deadline-noise-' + i, title: 'cf-memory 自動記憶 原典保持と期限切れdeadline ' + i, type: 'reference', scope: context,
    body_md: '期限切れの原典と記憶を説明してください。ファイルやWebを読まずに詳細を回答する。cf-memory session event helper. 原典と記憶の期限切れ。'.repeat(12) });
  await services.notes.upsert(bob, { slug: 'private-timeline', title: 'Capture timeline', type: 'user', scope: context, body_md: body + ' private-timeline' });
  await services.notes.upsert(owner, { slug: 'other-timeline', title: 'Capture timeline', type: 'project', scope: 'https://github.com/team/other', body_md: body + ' other-timeline' });
  const archived = await services.notes.upsert(owner, { slug: 'archived-timeline', title: 'Capture timeline', type: 'project', scope: context, body_md: body + ' archived-timeline' });
  await db.prepare('UPDATE notes SET archived_at=1 WHERE id=?').bind(archived.note.id).run();
});
afterAll(async () => { await mf.dispose(); });
it('recalls the saved English timeline fact for a Japanese period-ended question without semantic retrieval', async () => {
  failEmbedding = true;
  const pack = await services.recall.recall(owner, query, 2000, undefined, context);
  expect(pack.included.some(n => n.ref === 'timeline-answer')).toBe(true);
  expect(pack.text).toContain('anchor session_id');
  expect(pack.used).toBeLessThanOrEqual(2000);
  expect(pack.retrieval).toMatchObject({ mode: 'keyword', lexical_focus: 'leading_question' });
  for (const forbidden of ['private-timeline', 'other-timeline', 'archived-timeline']) expect(pack.text).not.toContain(forbidden);
});
