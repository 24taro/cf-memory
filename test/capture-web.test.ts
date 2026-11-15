import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { makeServices } from '../src/services';
import { accessEnvVars, bearerKeyFixture, principalFixture } from './helpers';

const alice = principalFixture({ userId: 'capture-web-alice', handle: 'capture-alice' });
const bob = principalFixture({ userId: 'capture-web-bob', handle: 'capture-bob' });
const eid = (n: number) => n.toString(16).padStart(64, '0');
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
let env: Parameters<typeof app.request>[2], aliceToken: string, bobToken: string, writeOnly: string, readOnly: string;
let shared: string, personal: string;
async function get(path: string, token?: string) {
  return app.request(`https://memory.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env);
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const sql = readFileSync('migrations/' + name, 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle, p.handle + '@example.com').run();
  services = makeServices(db);
  env = { DB: db, OWNER_HANDLE: alice.handle, ...accessEnvVars(alice.handle + '@example.com') } as Parameters<typeof app.request>[2];
  aliceToken = await bearerKeyFixture(db, alice.userId); bobToken = await bearerKeyFixture(db, bob.userId);
  writeOnly = await bearerKeyFixture(db, alice.userId, 'notes:write'); readOnly = await bearerKeyFixture(db, alice.userId, 'notes:read');
  await services.capture.put(alice, { id: eid(1), session_id: eid(10), tool_use_id: eid(1), event_type: 'PostToolUse', tool_name: 'Read', payload_redacted: { output: '<script>fixtureAttack()</script> API_KEY=fixture-secret' }, payload_hash: eid(50), file_refs: ['src/capture.ts'], repo_context: ['https://github.com/acme/cf-memory'], visibility: 'project', client: 'claude-code', client_version: 'fixture' });
  await services.capture.put(alice, { id: eid(2), session_id: eid(20), event_type: 'Stop', tool_name: '', payload_redacted: { output: 'personal raw fixture' }, payload_hash: eid(50), visibility: 'personal' });
  shared = (await services.notes.upsert(alice, { slug: 'capture-shared', title: 'Verified shared fact', body_md: 'Shared transaction behavior.', type: 'project' })).note.id;
  personal = (await services.notes.upsert(alice, { slug: 'capture-personal', title: 'Private rule', body_md: 'Private lasting preference.', type: 'user' })).note.id;
  await services.capture.attach(alice, { memory_id: shared, source_event_ids: [eid(1)], confidence: .98, rationale: '<b>verified transaction</b>' });
  await services.capture.attach(alice, { memory_id: personal, source_event_ids: [eid(2)] });
  await services.capture.heartbeat(alice, { client_id: eid(100), status: { ok: false, pending: 2, plugin_version: '0.2.0', hooks: { capture: { ok: false, failures: 1, last_failure: Date.now() } } } });
  await services.capture.heartbeat(bob, { client_id: eid(101), status: { ok: true } });
  // Synthetic, authenticated SSR fixtures for local visual review. No token or
  // real source is written; normal CI does not create these optional artifacts.
  if (process.env.CF_MEMORY_CAPTURE_PREVIEW_DIR) {
    await mkdir(process.env.CF_MEMORY_CAPTURE_PREVIEW_DIR, { recursive: true });
    for (const [name, path] of [['capture', '/capture'], ['sessions', '/capture/sessions'], ['session', '/capture/sessions/' + eid(10)], ['event', '/capture/events/' + eid(1)], ['health', '/agent-health'], ['provenance', '/provenance/note/' + shared], ['durable-search', '/search?q=transaction&mode=keyword&memory_type=project&file_ref=src%2Fcapture.ts&current_only=true']]) {
      await writeFile(process.env.CF_MEMORY_CAPTURE_PREVIEW_DIR + '/' + name + '.html', await (await get(path, aliceToken)).text(), { mode: 0o600 });
    }
  }
});
afterAll(async () => { await mf?.dispose(); });

describe('Capture HTTP/SSR privacy through the real authentication door', () => {
  it('durable HTTP and SSR filters preserve values, boundaries and read scopes', async () => {
    const q = 'q=transaction&mode=keyword&memory_type=project&file_ref=src%2Fcapture.ts&current_only=true';
    const r = await get('/api/v1/search?' + q, bobToken);
    expect(r.status).toBe(200); expect((await r.json() as any).hits.map((h:any) => h.id)).toEqual([shared]);
    expect((await get('/api/v1/search?' + q, writeOnly)).status).toBe(403);
    const notPersonal = await get('/api/v1/search?q=preference&mode=keyword&memory_type=user', bobToken);
    expect((await notPersonal.json() as any).hits).toEqual([]);
    for (const bad of ['created_since=2&created_until=1','current_only=perhaps','updated_since=not-a-date']) expect((await get('/api/v1/search?q=transaction&'+bad, readOnly)).status).toBe(400);
    const html = await (await get('/search?' + q, bobToken)).text();
    expect(html).toContain('Verified shared fact'); expect(html).toContain('name="file_ref"'); expect(html).toContain('value="src/capture.ts"'); expect(html).toContain('現在有効な記憶のみ'); expect(html).toMatch(/<details open/);
    expect((await get('/search?q=transaction&created_since=2&created_until=1', bobToken)).status).toBe(400);
    expect((await get('/search?q=transaction&memory_type=&created_since=&file_ref=', bobToken)).status).toBe(200);
  });
  it('every new reader, health, provenance and version requires notes:read and is never cached', async () => {
    for (const path of ['/capture', '/capture/sessions', '/capture/sessions/' + eid(10), '/capture/events/' + eid(1), '/agent-health', '/version', '/provenance/note/' + shared,
      '/api/v1/capture/sessions', '/api/v1/capture/search', '/api/v1/capture/events?ids=' + eid(1), '/api/v1/capture/sessions/' + eid(10) + '/events']) {
      const anonymous = await get(path); expect(anonymous.status, path).toBe(401); expect(anonymous.headers.get('cache-control'), path).toBe('private, no-store');
      const forbidden = await get(path, writeOnly); expect(forbidden.status, path).toBe(403); expect(forbidden.headers.get('cache-control'), path).toBe('private, no-store');
      const allowed = await get(path, readOnly); expect(allowed.status, path).toBe(200); expect(allowed.headers.get('cache-control'), path).toBe('private, no-store');
    }
  });
  it('Bob may read shared provenance metadata but cannot follow it to Alice raw events/sessions', async () => {
    const provenance = await get('/provenance/note/' + shared, bobToken); expect(provenance.status).toBe(200);
    const html = await provenance.text(); expect(html).toContain('Verified shared fact'); expect(html).toContain('verified transaction');
    expect(html).not.toContain('href="/capture/events/' + eid(1)); expect(html).not.toContain('href="/capture/sessions/' + eid(10)); expect(html).not.toContain('fixtureAttack');
    expect((await get('/provenance/note/' + personal, bobToken)).status).toBe(404);
    for (const path of ['/capture/events/' + eid(1), '/capture/sessions/' + eid(10)]) expect((await get(path, bobToken)).status).toBe(404);
    expect(await (await get('/api/v1/capture/events?ids=' + eid(1), bobToken)).json()).toEqual({ events: [], missing_ids: [eid(1)] });
    expect(await (await get('/api/v1/capture/sessions/' + eid(10) + '/events', bobToken)).json()).toEqual({ found: false, events: [], next_cursor: null });
    const index = await (await get('/api/v1/capture/search?q=fixture', bobToken)).json() as { hits: unknown[] };
    expect(index.hits).toEqual([]);
  });
  it('import claims are labelled/escaped without raw links, and stay private after sharing the note', async () => {
    const note = (await services.notes.upsert(alice, { slug: 'imported-web', title: 'Imported memory', body_md: 'Portable verified fact.', type: 'project', shared: false })).note;
    await services.portability.importProvenance(alice, { kind: 'note', id: note.id, expected_content_hash: note.content_hash, expected_scope: note.scope, origin: { instance: eid(900), owner_id: 'source-owner', memory_id: 'source-memory' }, snapshots: [{ event_id: eid(901), source_session_id: eid(902), actor_id: 'source-actor', relation: 'derived_from', generated_by: 'unverified-agent', confidence: 0.99, rationale: '<b>imported reason</b>', created_at: 1000, source: { file_refs: ['src/private-import-web.ts'], tool_name: '<script>importAttack()</script>', occurred_at: 1000 } }] });
    const response = await get('/provenance/note/' + note.id, aliceToken), html = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(html).toContain('importされたmetadata（未検証）'); expect(html).toContain('source-actor');
    expect(html).toContain('&lt;script&gt;importAttack()&lt;/script&gt;'); expect(html).toContain('&lt;b&gt;imported reason&lt;/b&gt;');
    expect(html).not.toContain('<script>importAttack()'); expect(html).not.toContain('href="/capture/events/'); expect(html).not.toContain('href="/capture/sessions/');
    await db.prepare('UPDATE notes SET shared=1 WHERE id=?').bind(note.id).run();
    const publicPage = await get('/provenance/note/' + note.id, bobToken), publicHtml = await publicPage.text();
    expect(publicPage.status).toBe(200); expect(publicHtml).toContain('Imported memory');
    expect(publicHtml).not.toContain('source-actor'); expect(publicHtml).not.toContain('src/private-import-web.ts'); expect(publicHtml).not.toContain('unverified-agent');
    const api = await get('/api/v1/notes/' + note.id, bobToken);
    expect(api.status).toBe(200); expect((await api.json() as { provenance: unknown[] }).provenance).toEqual([]);
  });
  it('stored source, rationale and filter markup are escaped; deny/redaction and CSP remain enforced', async () => {
    const detail = await get('/capture/events/' + eid(1), aliceToken), html = await detail.text();
    expect(html).toContain('&lt;script&gt;fixtureAttack()&lt;/script&gt;'); expect(html).not.toContain('<script>fixtureAttack()'); expect(html).not.toContain('fixture-secret');
    expect(detail.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/);
    const provenance = await (await get('/provenance/note/' + shared, aliceToken)).text();
    expect(provenance).toContain('&lt;b&gt;verified transaction&lt;/b&gt;'); expect(provenance).toContain('href="/capture/events/' + eid(1));
    const filtered = await (await get('/capture?q=' + encodeURIComponent('"><img src=x onerror=fixtureAttack()>'), aliceToken)).text();
    expect(filtered).not.toContain('<img src=x onerror=fixtureAttack()>');
    expect(filtered).toContain('この範囲に一致する保持中');
    expect((await get('/api/v1/capture/search?cursor=bad', aliceToken)).status).toBe(400);
    expect((await get('/api/v1/capture/search?since=bad', aliceToken)).status).toBe(400);
    expect((await get('/api/v1/capture/events?ids=' + Array(11).fill(eid(1)).join(','), aliceToken)).status).toBe(400);
  });
  it('health is usable, caller-private and truthful about configured infrastructure', async () => {
    const response = await get('/agent-health', aliceToken), aliceHtml = await response.text();
    expect(aliceHtml).toContain('要確認'); expect(aliceHtml).toContain('送信待ち'); expect(aliceHtml).toContain('recover --session DIGEST'); expect(aliceHtml).toContain('required_schema_version');
    expect(aliceHtml).toContain('会話ログ（cf-memory-logs）'); expect(aliceHtml).toContain('未設定（LOGS binding なし）'); expect(aliceHtml).not.toContain('Vectorize'); expect(aliceHtml).not.toContain('at_test_');
    const nonce = response.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)![1];
    expect(aliceHtml).toContain(`<script nonce="${nonce}">`); expect(aliceHtml).toContain('自動更新（30秒');
    expect(aliceHtml).not.toContain('id="agent-refresh" type="checkbox" checked');
    const bobHtml = await (await get('/agent-health', bobToken)).text(); expect(bobHtml).toContain('正常'); expect(bobHtml).not.toContain('Plugin 0.2.0');
  });
  it('provider recovery counts and retry time are escaped and visible only to the reporting owner', async () => {
    await services.capture.heartbeat(alice,{client_id:eid(102),status:{ok:true,distill_enabled:true,provider_attempts:{blocked:2,waiting:1,in_flight:0,cooldowns:1,invalid:0,next_retry_at:Date.parse('2026-10-07T06:00:00Z')}}});
    const html=await (await get('/agent-health',aliceToken)).text();
    expect(html).toContain('復旧操作が必要');expect(html).toContain('2026-10-07 06:00:00 UTC');expect(html).toContain('--retry-model');expect(html).toContain('API料金');
    const bobHtml=await (await get('/agent-health',bobToken)).text();expect(bobHtml).not.toContain('復旧操作が必要');
    await services.capture.heartbeat(alice,{client_id:eid(102),status:{provider_attempts:{blocked:'<script>attemptAttack()</script>',next_retry_at:'<img src=x onerror=attemptAttack()>'}}});
    const bad=await (await get('/agent-health',aliceToken)).text();expect(bad).not.toContain('attemptAttack');
    await db.prepare('DELETE FROM client_heartbeats WHERE user_id=? AND client_id=?').bind(alice.userId,eid(102)).run();
  });
  it('version and health report the log database without Vectorize or embedding fields', async () => {
    const request = (path:string,token=readOnly) => app.request(`https://memory.test${path}`,{headers:{authorization:`Bearer ${token}`}},env);
    const response = await request('/version'); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body.logs).toMatchObject({ configured:false, size_bytes:null, entries:null, daily_action_limit:null, action_retention_days:90 });
    for (const removed of ['vectorize_processing','vectorize_search','vectorize_recall','vectorize_daily_query_limit','embedding_provider','embedding_model','embedding_jobs','queue','async_embedding']) expect(body, removed).not.toHaveProperty(removed);
    expect(body.vectorize).toBe('disabled'); // installed 0.2.x doctors require 'disabled' or 'configured' until phase 5
    expect((await request('/version',writeOnly)).status).toBe(403);
  });
  it('the actual nonce script refreshes only by opt-in every 30 seconds while visible', async () => {
    const html = await (await get('/agent-health', aliceToken)).text(), script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    const events = new Map<string, () => void>(), timers = new Map<number, { run: () => void; ms: number }>();
    let id = 0, reloads = 0, preference = 'false';
    const toggle = { checked: false, addEventListener: (name: string, run: () => void) => events.set(name, run) };
    const document = { hidden: false, getElementById: () => toggle, addEventListener: (name: string, run: () => void) => events.set(name, run) };
    runInNewContext(script, { document, location: { reload: () => reloads++ }, sessionStorage: { getItem: () => preference, setItem: (_key: string, value: string) => { preference = value; } },
      setTimeout: (run: () => void, ms: number) => { timers.set(++id, { run, ms }); return id; }, clearTimeout: (key: number) => timers.delete(key) });
    expect(timers.size).toBe(0);
    toggle.checked = true; events.get('change')!(); expect(preference).toBe('true'); expect([...timers.values()][0].ms).toBe(30000);
    document.hidden = true; events.get('visibilitychange')!(); expect(timers.size).toBe(0); expect(reloads).toBe(0);
    document.hidden = false; events.get('visibilitychange')!(); expect(timers.size).toBe(1); [...timers.values()][0].run(); expect(reloads).toBe(1);
    toggle.checked = false; events.get('change')!(); expect(preference).toBe('false'); expect(timers.size).toBe(0);
  });
  it('TTL-expired sources look unavailable; metadata provenance survives without exposing raw contents', async () => {
    await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=? AND id=?').bind(alice.userId, eid(1)).run();
    const expired = await get('/capture/events/' + eid(1), aliceToken), absent = await get('/capture/events/' + eid(999), aliceToken);
    expect(expired.status).toBe(404); expect(absent.status).toBe(404); expect(await expired.text()).toBe(await absent.text());
    const index = await (await get('/api/v1/capture/search?session_id=' + eid(10), aliceToken)).json() as { hits: unknown[] }; expect(index.hits).toEqual([]);
    const source = await get('/provenance/note/' + shared, bobToken); expect(source.status).toBe(200); expect(await source.text()).toContain('verified transaction');
    await db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(shared).run();
    expect((await get('/provenance/note/' + shared, aliceToken)).status).toBe(404);
  });
});
