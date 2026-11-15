import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { makeServices, type Services } from '../src/services';
import { principalFixture } from './helpers';

const context = 'https://github.com/team/question-focus';
const owner = principalFixture({ userId: 'focus-owner', handle: 'focus-owner' });
const bob = principalFixture({ userId: 'focus-bob', handle: 'focus-bob' });
// The genuine no-tools prompt that failed next-session acceptance. The response
// instructions must not crowd its question out of a 2000-token context pack.
const query = 'cf-memoryでVectorizeのACKが未処理なら、pendingが5分未満でもD1に退避しますか？5分の閾値の意味とANNへ戻る条件を、注入された過去memoryだけから短く説明してください。memoryのnote IDかタイトルも示してください。ファイル・コマンド・MCP・Web等のツールを一切使用せず、不明なら不明と答えてください。';
// The actual 0.2.20 next-session prompt missed newly saved source-role knowledge
// in the keyword lanes: generic cf-memory/Agent terms dominated the full query.
const roleQuery = 'cf-memory agentで技術的な記憶を保存するために必要な原典と、旧レビュー結果・試行回数の扱いを説明してください。回答要約だけを根拠にできるか、アップグレードで試行枠が増えるかも含めてください。ファイルやツールは使わず、知らない点は分からないとしてください。';
let mf: Miniflare;
let db: D1Database;
let services: Services;

// This populated ranking fixture applies every migration and writes 70+ notes
// through the real lifecycle services. Give setup its own CI-sized allowance;
// leave assertion timeouts and the other suites unchanged.
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of readdirSync('migrations').filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(join('migrations', file), 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const p of [owner, bob]) await db.prepare('INSERT INTO users(id,handle,display_name,created_at,updated_at) VALUES (?,?,?,0,0)').bind(p.userId, p.handle, p.handle).run();
  services = makeServices(db);
  await services.memory.setBlock(owner, 'focus-contract', 'set', 'Keep current instructions and private memory boundaries. '.repeat(25));
  await services.notes.upsert(owner, { slug: 'ack-answer', title: 'Vectorize未処理ACK時のRecall検索退避（D1）とstale閾値の意味', type: 'project', scope: context,
    body_md: '`src/vectorize-health.ts` の `VectorizeProcessing.health()` の挙動：\n' +
      '- Vectorize のACKは受理済みを意味するだけで、まだ検索できる状態ではない。\n' +
      '- 未処理のcheckpointがあれば、pending（5分未満）の間でも直ちにD1を返す。\n' +
      '- 5分はラグの健康分類にだけ使う閾値。pending/staleのどちらでもD1を使う。\n' +
      '- processedUpToMutationとprocessedUpToDatetimeで処理済みを確認してANNへ戻る。\n' +
      '同時実行のACKでcheckpointが変わった場合はD1検索を維持する。'.repeat(10) });
  // A populated corpus has plenty of real instructions using memory/MCP/Web.
  for (let i = 0; i < 14; i++) await services.notes.upsert(owner, { slug: 'instructions-' + i, title: 'cf-memory memory note MCP Web instructions ' + i, type: 'reference',
    body_md: 'cf-memory memory note MCP Web コマンド ファイル タイトル instructions. '.repeat(28) });
  for (let i = 0; i < 50; i++) await services.notes.upsert(owner, { slug: 'ordinary-' + i, title: 'Widget testing ' + i, type: 'reference', body_md: 'Unrelated product rules and debugging records.' });
  await services.notes.upsert(bob, { slug: 'bob-private-answer', title: 'Vectorize ACK pending D1 fallback', type: 'user', scope: context, body_md: 'Vectorize ACK pending D1 private-bob-answer' });
  await services.notes.upsert(owner, { slug: 'other-repo-answer', title: 'Vectorize ACK pending D1 fallback', type: 'project', scope: 'https://github.com/team/other', body_md: 'Vectorize ACK pending D1 other-repo-answer' });
  const archived = await services.notes.upsert(owner, { slug: 'archived-answer', title: 'Vectorize ACK pending D1 fallback', type: 'project', scope: context, body_md: 'Vectorize ACK pending D1 archived-answer' });
  await db.prepare('UPDATE notes SET archived_at=1 WHERE id=?').bind(archived.note.id).run();
  const old = await services.notes.upsert(owner, { slug: 'superseded-answer', title: 'Vectorize ACK pending D1 fallback', type: 'project', scope: context, body_md: 'Vectorize ACK pending D1 superseded-answer' });
  await services.notes.upsert(owner, { slug: 'replacement', title: 'Historical replacement', type: 'project', scope: context, body_md: 'Current explanation', supersedes: old.note.id });
  for (let i = 0; i < 14; i++) await services.notes.upsert(owner, { slug: 'agent-noise-' + i, title: 'cf-memory agent memory guidance ' + i, type: 'reference', body_md: 'cf-memory agent memory instructions and old operational status.' });
  const roleBody = '出典: `docs/AGENT-0220-SOURCE-ROLES.md`\nTool 観測には PostToolUse/Failure と空白でない tool_name が必要。UserPromptSubmit の decision/preference に tool_name は不要。Stop は技術的事実の独立原典にしない。';
  await services.notes.upsert(owner, { slug: 'source-role-answer', title: '0.2.20 validateCandidate source role 要件', type: 'project', scope: context, body_md: roleBody });
  await services.notes.upsert(bob, { slug: 'bob-private-role', title: '技術的な記憶の保存', type: 'user', scope: context, body_md: roleBody + ' private-role-answer' });
  await services.notes.upsert(owner, { slug: 'other-repo-role', title: '技術的な記憶の保存', type: 'project', scope: 'https://github.com/team/other', body_md: roleBody + ' other-role-answer' });
  const archivedRole = await services.notes.upsert(owner, { slug: 'archived-role', title: '技術的な記憶の保存', type: 'project', scope: context, body_md: roleBody + ' archived-role-answer' });
  await db.prepare('UPDATE notes SET archived_at=1 WHERE id=?').bind(archivedRole.note.id).run();
  const obsoleteRole = await services.notes.upsert(owner, { slug: 'obsolete-role', title: '技術的な記憶の保存', type: 'project', scope: context, body_md: roleBody + ' obsolete-role-answer' });
  await services.notes.upsert(owner, { slug: 'role-replacement', title: 'Historical role replacement', type: 'project', scope: context, body_md: 'Current role explanation', supersedes: obsoleteRole.note.id });
  // A pipeline-saved English note named by a code identifier inside a Japanese
  // question, against Japanese notes that merely share a Han term (observed
  // 2026-10-19: the bugfix note never reached recall for this exact question).
  await services.notes.upsert(owner, { slug: 'billing-answer', title: 'tidepool invoiceTotal (src/billing.js) sums in integer cents', type: 'project', scope: context,
    body_md: 'In tidepool src/billing.js, invoiceTotal floored a float total and dropped a cent (1.45 * 3); it now sums Math.round(unitPrice * 100) * quantity.' });
  for (let i = 0; i < 16; i++) await services.notes.upsert(owner, { slug: 'han-noise-' + i, title: '自治体ページ公開の不具合記録 ' + i, type: 'project', scope: context,
    body_md: '書き出しの不具合と直し方の記録。不具合の原因と直し方をまとめた。'.repeat(6) });
}, 60_000);

it('uses the supplementary question lane in recall, without changing ordinary search', async () => {
  const search = await services.search.hybrid(owner, query, { mode: 'keyword', context, excludeArchived: true, limit: 12 });
  expect(search[0].slug).toMatch(/^instructions-/);
  const pack = await services.recall.recall(owner, query, 2000, undefined, context);
  expect(pack.included.some(n => n.ref === 'ack-answer')).toBe(true);
  expect(pack.retrieval).toMatchObject({ mode: 'keyword', semantic_status: 'not_requested', lexical_focus: 'leading_question' });
  for (const forbidden of ['private-bob-answer', 'other-repo-answer', 'archived-answer', 'superseded-answer']) expect(pack.text).not.toContain(forbidden);
});

it('retains full-query matches when a later question contains the relevant topic', async () => {
  const q = 'What does an unknown subsystem do? Explain briefly from previous knowledge, then describe widget testing behavior.';
  const pack = await services.recall.recall(owner, q, 2000, undefined, context);
  expect(pack.included.some(n => n.ref.startsWith('ordinary-'))).toBe(true);
  expect(pack.retrieval?.lexical_focus).toBe('leading_question');
});
afterAll(async () => { await mf.dispose(); });

it('keeps the question answer ahead of response instructions', async () => {
  const pack = await services.recall.recall(owner, query, 2000, undefined, context);
  expect(pack.included.some(n => n.ref === 'ack-answer')).toBe(true);
  expect(pack.candidates.filter(n => n.tier === 'archival')[0]?.ref).toBe('ack-answer');
  expect(pack.used).toBeLessThanOrEqual(2000);
  for (const forbidden of ['private-bob-answer', 'other-repo-answer', 'archived-answer', 'superseded-answer']) expect(pack.text).not.toContain(forbidden);
  expect(pack.retrieval).toMatchObject({ mode: 'keyword', semantic_status: 'not_requested' });
});

it('finds technical source knowledge from ordinary Japanese prose', async () => {
  {
    const ordinary = await services.search.hybrid(owner, roleQuery, { mode: 'keyword', context, excludeArchived: true, limit: 4 });
    expect(ordinary.map(h => h.slug)).not.toContain('source-role-answer');
    const pack = await services.recall.recall(owner, roleQuery, 2000, undefined, context);
    expect(pack.included.some(n => n.ref === 'source-role-answer')).toBe(true);
    expect(pack.text).toContain('UserPromptSubmit の decision/preference に tool_name は不要');
    expect(pack.used).toBeLessThanOrEqual(2000);
    expect(pack.retrieval).toMatchObject({ mode: 'keyword', japanese_lexical_focus: true });
    for (const text of ['private-role-answer', 'other-role-answer', 'archived-role-answer', 'obsolete-role-answer']) expect(pack.text).not.toContain(text);
  }
});

it('keeps an English identifier note for a Japanese question that names the identifier', async () => {
  const q = 'tidepool invoiceTotal の端数の不具合と直し方を教えて';
  const pack = await services.recall.recall(owner, q, 2000, undefined, context);
  expect(pack.candidates.filter(n => n.tier === 'archival').map(n => n.ref)).toContain('billing-answer');
  expect(pack.included.some(n => n.ref === 'billing-answer')).toBe(true);
  for (const forbidden of ['private-bob-answer', 'other-repo-answer', 'archived-answer', 'superseded-answer']) expect(pack.text).not.toContain(forbidden);
});
