import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeServices } from '../src/services';
import { handleMcp } from '../src/mcp';
import { principalFixture } from './helpers';
import { boundToolPayload, redactPayload } from '../cf-memory-agent/scripts/redact.mjs';
const alice = principalFixture({ userId: 'alice', handle: 'alice', scopes: new Set(['notes:read', 'notes:write']) });
const bob = principalFixture({ userId: 'bob', handle: 'bob', scopes: new Set(['notes:read', 'notes:write']) });
let mf: Miniflare, db: D1Database, services: ReturnType<typeof makeServices>;
const eid = (n: number) => n.toString(16).padStart(64, '0');
const event = (n: number, visibility = 'personal') => ({ id: eid(n), session_id: eid(100), tool_use_id: eid(n), event_type: 'PostToolUse', tool_name: 'Read', payload_redacted: { output: 'API_KEY=fixture-secret', cookie: 'fixture-secret' }, payload_hash: eid(200), occurred_at: Date.now() - 10000 + n, visibility, repo_context: ['https://github.com/acme/cf-memory'], file_refs: ['src/db.ts'], client: 'claude-code' });
async function copies(seed: number, session: number, count: number, payload: string) {
  await services.capture.put(alice, { ...event(seed), session_id: eid(session), payload_redacted: { output: payload }, occurred_at: 1000 });
  await db.batch(Array.from({ length: count - 1 }, (_, i) => db.prepare(`INSERT INTO capture_events
    (user_id,id,session_id,event_type,tool_name,tool_use_id,payload_redacted,payload_hash,metadata_json,visibility,occurred_at,expires_at)
    SELECT user_id,?,session_id,event_type,tool_name,?,payload_redacted,payload_hash,metadata_json,visibility,occurred_at,expires_at FROM capture_events WHERE user_id=? AND id=?`)
    .bind(eid(seed + i + 1), eid(seed + i + 1), alice.userId, eid(seed))));
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {};', d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    const raw = readFileSync(join('migrations', name), 'utf8').split('\n').map(l => l.split('--')[0]).join('\n');
    for (const sql of raw.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const p of [alice, bob]) await db.prepare("INSERT INTO users(id,handle,display_name,email,bio_md,created_at,updated_at) VALUES (?,?,?,?,'',0,0)").bind(p.userId, p.handle, p.handle, p.handle + '@example.com').run();
  services = makeServices(db);
});
afterAll(async () => { await mf?.dispose(); });
it('credential ancestors from old clients are suppressed before D1, JSON-string output and private timeline', async () => {
  const opaque='fixture-unlabelled-credential';
  const source={...event(994),session_id:eid(994),payload_redacted:{output:{
    credentials:{value:opaque},nested:{clientCredentials:{value:opaque}},
    stdout:JSON.stringify({credentials:{value:opaque},safe:'Observed safe adjacent field.'}),
    safe:'Observed safe adjacent field.'}}};
  expect(await services.capture.put(alice,source)).toMatchObject({created:true});
  expect(await services.capture.put(alice,source)).toMatchObject({created:false});
  const row=await db.prepare('SELECT payload_redacted FROM capture_events WHERE user_id=? AND id=?')
    .bind(alice.userId,source.id).first<{payload_redacted:string}>();
  expect(row!.payload_redacted).not.toContain(opaque);
  expect(JSON.parse(row!.payload_redacted).output).toEqual({credentials:'[REDACTED]',nested:{clientCredentials:'[REDACTED]'},
    stdout:JSON.stringify({credentials:'[REDACTED]',safe:'Observed safe adjacent field.'}),safe:'Observed safe adjacent field.'});
  expect(JSON.stringify(await services.capture.timeline(alice,{anchor_event_id:source.id}))).not.toContain(opaque);
  expect(await services.capture.timeline(bob,{anchor_event_id:source.id})).toEqual({found:false,events:[]});
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId,source.session_id).run();
});
it('known credential-reader command origin suppresses opaque output on the Worker without trusting client denial', async () => {
  const source = { ...event(995, 'project'), session_id: eid(995), tool_name: 'Bash', denied: false,
    payload_redacted: { input: { command: 'gh auth token' }, output: 'fixture-opaque-credential' } };
  expect(await services.capture.put(alice, source)).toMatchObject({ created: true });
  const own = await services.capture.timeline(alice, { anchor_event_id: source.id });
  expect(own.events[0].visibility).toBe('personal');
  expect(own.events[0].metadata.denied).toBe(true);
  expect(own.events[0].metadata.file_refs).toEqual([]);
  expect(JSON.stringify(own)).not.toContain('fixture-opaque-credential');
  expect(await services.capture.timeline(bob, { anchor_event_id: source.id })).toEqual({ found: false, events: [] });
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId, source.session_id).run();
});
it('encoded media from an older or untrusted client is scrubbed again before D1 and owner-only retrieval', async () => {
  const opaque = 'dW5sYWJlbGxlZC1wcml2YXRlLWZpeHR1cmU=';
  const source = { ...event(995), session_id: eid(995), tool_name: 'view_image', payload_redacted: {
    input: { path: 'public.png' }, output: [
      { type: 'image_url', image_url: 'data:image/png;base64,' + opaque },
      { type: 'audio', data: opaque, mimeType: 'audio/wav' },
      { type: 'text', text: 'Safe adjacent observation.' },
    ], serialized: JSON.stringify({ type: 'image', data: opaque, mimeType: 'image/png' })
  } };
  expect(await services.capture.put(alice, source)).toMatchObject({ created: true });
  expect(await services.capture.put(alice, source)).toMatchObject({ created: false });
  const row = await db.prepare('SELECT payload_redacted FROM capture_events WHERE user_id=? AND id=?')
    .bind(alice.userId, source.id).first<{ payload_redacted: string }>();
  expect(row!.payload_redacted).not.toContain(opaque);
  expect(row!.payload_redacted).not.toContain('data:image/png');
  expect(row!.payload_redacted).toContain('Safe adjacent observation.');
  const own = await services.capture.timeline(alice, { anchor_event_id: source.id });
  expect(JSON.stringify(own)).not.toContain(opaque);
  expect(await services.capture.timeline(bob, { anchor_event_id: source.id })).toEqual({ found: false, events: [] });
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId, source.session_id).run();
});
it('JSON-string credentials are scrubbed again before D1 and remain stable on duplicate delivery', async () => {
  const opaque = 'fixture-encoded-credential';
  const source = { ...event(996), session_id: eid(996), tool_name: 'Bash', payload_redacted: {
    output: { stdout: JSON.stringify({ result: JSON.stringify({ password: opaque }),
      headers: { Cookie: 'session=' + opaque, Authorization: 'Custom ' + opaque } }) }
  } };
  expect(await services.capture.put(alice, source)).toMatchObject({ created: true });
  expect(await services.capture.put(alice, source)).toMatchObject({ created: false });
  const own = await services.capture.timeline(alice, { anchor_event_id: source.id });
  expect(JSON.stringify(own)).not.toContain(opaque);
  const output = own.events[0].payload_redacted as { output: { stdout: string } };
  expect(JSON.parse(output.output.stdout)).toEqual({ result: JSON.stringify({ password: '[REDACTED]' }),
    headers: { Cookie: '[REDACTED]', Authorization: '[REDACTED]' } });
  expect(await services.capture.timeline(bob, { anchor_event_id: source.id })).toEqual({ found: false, events: [] });
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId, source.session_id).run();
});
it('new bounded input/output survives server scrubbing and caller-only D1 retrieval without flattening', async () => {
  const clean = redactPayload({ file_path: 'src/db.ts', query: 'input.onlyClaim' },
    { file: { content: 'observed.member();\n' + 'safe line\n'.repeat(15000) + '\nAPI_KEY=fixture-tail-secret' } });
  const bounded = boundToolPayload(clean);
  const source = { ...event(997), session_id: eid(997), payload_redacted: bounded.payload, truncated: bounded.truncated };
  expect(bounded.truncated).toBe(true);
  expect(await services.capture.put(alice, source)).toMatchObject({ created: true });
  expect(await services.capture.put(alice, source)).toMatchObject({ created: false });
  const row = await db.prepare('SELECT payload_redacted FROM capture_events WHERE user_id=? AND id=?')
    .bind(alice.userId, source.id).first<{ payload_redacted: string }>();
  expect(JSON.parse(row!.payload_redacted)).toEqual(bounded.payload);
  expect(row!.payload_redacted).not.toContain('fixture-tail-secret');
  expect(new TextEncoder().encode(row!.payload_redacted).length).toBeLessThanOrEqual(32768);
  const own = await services.capture.timeline(alice, { anchor_event_id: source.id });
  expect(own.events[0].payload_redacted).toMatchObject({ input: { query: 'input.onlyClaim' }, output: { file: { content: expect.stringContaining('observed.member();\n') } } });
  expect(await services.capture.timeline(bob, { anchor_event_id: source.id })).toEqual({ found: false, events: [] });
  await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId, source.session_id).run();
});
describe('capture: short-lived private originals, durable provenance', () => {
  it('manual Recall mode is healthy without a hook stamp; enabled and legacy automatic Recall still require one', async () => {
    const client_id = eid(704);
    const status = { client: 'codex', ok: true, capture_enabled: true, distill_enabled: true };
    await services.capture.heartbeat(alice, { client_id, status: { ...status, recall_enabled: false } });
    expect((await services.capture.health(alice)).find(c => c.client_id === client_id)?.state).toBe('healthy');
    for (const extra of [{ recall_enabled: true }, {}]) {
      await services.capture.heartbeat(alice, { client_id, status: { ...status, ...extra } });
      expect((await services.capture.health(alice)).find(c => c.client_id === client_id)?.state).toBe('degraded');
    }
    await services.capture.heartbeat(alice, { client_id, status: { ...status, recall_enabled: false, pending: 1 } });
    expect((await services.capture.health(alice)).find(c => c.client_id === client_id)?.state).toBe('degraded');
    expect((await services.capture.health(bob)).some(c => c.client_id === client_id)).toBe(false);
    await db.prepare('DELETE FROM client_heartbeats WHERE user_id=? AND client_id=?').bind(alice.userId, client_id).run();
  });
  it('provider attempt holds remain degraded independently of an optimistic client ok flag and are owner-private', async () => {
    for (const key of ['blocked','waiting','in_flight','cooldowns','invalid']) {
      await services.capture.heartbeat(alice,{client_id:eid(703),status:{ok:true,distill_enabled:true,provider_attempts:{[key]:1}}});
      expect((await services.capture.health(alice)).find(c=>c.client_id===eid(703))?.state).toBe('degraded');
      expect((await services.capture.health(bob)).some(c=>c.client_id===eid(703))).toBe(false);
    }
    await services.capture.heartbeat(alice,{client_id:eid(703),status:{ok:true,distill_enabled:false,provider_attempts:{blocked:1}}});
    expect((await services.capture.health(alice)).find(c=>c.client_id===eid(703))?.state).toBe('healthy');
    await db.prepare('DELETE FROM client_heartbeats WHERE user_id=? AND client_id=?').bind(alice.userId,eid(703)).run();
  });
  it('heartbeat shows a stale session lacking Stop as degraded while fresh active work stays healthy', async () => {
    await services.capture.heartbeat(alice, { client_id: eid(702), status: { ok: true, distill_enabled: true, awaiting_checkpoint: 2, stale_awaiting_checkpoint: 0 } });
    expect((await services.capture.health(alice)).find(c => c.client_id === eid(702))?.state).toBe('healthy');
    await services.capture.heartbeat(alice, { client_id: eid(702), status: { ok: true, distill_enabled: true, awaiting_checkpoint: 2, stale_awaiting_checkpoint: 1 } });
    expect((await services.capture.health(alice)).find(c => c.client_id === eid(702))?.state).toBe('degraded');
    expect(await services.capture.health(bob)).toEqual([]);
    await db.prepare('DELETE FROM client_heartbeats WHERE user_id=? AND client_id=?').bind(alice.userId, eid(702)).run();
  });
  it('out-of-order repeated SessionEnd cannot shorten an acknowledged session or modify another caller', async () => {
    const source = { ...event(998), session_id: eid(998) };
    await services.capture.put(alice, source);
    const latest = Date.now() - 1000;
    await services.capture.end(alice, source.session_id, latest);
    await services.capture.end(alice, source.session_id, latest - 1000);
    await services.capture.end(bob, source.session_id, Date.now());
    const row = await db.prepare('SELECT ended_at FROM capture_sessions WHERE user_id=? AND id=?').bind(alice.userId, source.session_id).first<{ ended_at: number }>();
    expect(row?.ended_at).toBe(latest);
    await db.prepare('DELETE FROM capture_events WHERE user_id=? AND session_id=?').bind(alice.userId, source.session_id).run();
  });
  it('duplicate tool use is stored once and server scrubs again', async () => {
    expect(await services.capture.put(alice, event(1))).toMatchObject({ created: true });
    expect(await services.capture.put(alice, event(1))).toMatchObject({ created: false });
    const duplicate = await services.capture.put(alice, { ...event(1), id: eid(900) });
    expect(duplicate).toMatchObject({ id: eid(1), created: false });
    expect((await services.capture.timeline(alice, { anchor_event_id: duplicate.id })).found).toBe(true);
    const r = await db.prepare('SELECT payload_redacted FROM capture_events WHERE user_id=?').bind('alice').all<{ payload_redacted: string }>();
    expect(r.results).toHaveLength(1);
    expect(r.results[0].payload_redacted).not.toContain('fixture-secret');
  });
  it('same identifiers are isolated across users; timeline is caller-only', async () => {
    await services.capture.put(bob, event(1));
    for (const n of [2, 3, 4]) await services.capture.put(alice, event(n));
    const around = await services.capture.timeline(alice, { anchor_event_id: eid(2), before: 1, after: 1 });
    expect(around.events.map(e => e.id)).toEqual([eid(1), eid(2), eid(3)]);
    expect(await services.capture.timeline(bob, { anchor_event_id: eid(2) })).toEqual({ found: false, events: [] });
  });
  it('capture events do not become a fifth Recall tier', async () => {
    const pack = await services.recall.recall(alice, 'API_KEY', 4000);
    expect(pack.text).not.toContain('fixture-secret');
    expect(pack.candidates?.some(c => String(c.source_type).includes('capture'))).toBe(false);
  });
  it('personal original cannot attach to shared memory; project original has traceable provenance', async () => {
    const { note } = await services.notes.upsert(alice, { slug: 'capture-project', title: 'Database', body_md: 'The database uses PostgreSQL.', type: 'project' });
    await expect(services.capture.attach(alice, { memory_id: note.id, source_event_ids: [eid(1)], confidence: 0.98 })).rejects.toThrow('personal source');
    await services.capture.put(alice, event(5, 'project'));
    await services.capture.attach(alice, { memory_id: note.id, source_event_ids: [eid(5)], confidence: 0.98, generated_by: 'cf-memory-agent/subscription' });
    const response = await handleMcp(new Request('https://memory.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_get', arguments: { id: note.id } } }) }), { principal: bob, services, budget: 4000 });
    const out = JSON.parse((await response.json() as any).result.content[0].text);
    expect(out.provenance[0]).toMatchObject({ event_id: eid(5), source_session_id: eid(100), actor_id: 'alice', confidence: 0.98, source: { file_refs: ['src/db.ts'], visibility: 'project' } });
    expect(JSON.stringify(out.provenance)).not.toContain('payload_redacted');
    expect(out.provenance[0].source.occurred_at).toBeGreaterThan(0);
    expect(out.provenance[0].source.event_type).toBe('PostToolUse');
    expect((await services.recall.recall(bob, 'PostgreSQL', 4000)).text).toContain('PostgreSQL');
    await expect(services.capture.attach(bob, { memory_id: note.id, source_event_ids: [eid(1)] })).rejects.toThrow('owned durable');
  });
  it('expired raw sources disappear while provenance survives', async () => {
    await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=?').bind('alice').run();
    expect((await services.capture.timeline(alice, { anchor_event_id: eid(5) })).found).toBe(false);
    await services.capture.prune();
    expect((await db.prepare('SELECT count(*) AS n FROM memory_provenance').first<{ n: number }>())?.n).toBe(1);
  });
  it('health isolates clients and version verifies migration readiness', async () => {
    await services.capture.heartbeat(alice, { client_id: eid(700), status: { ok: false, pending: 3 } });
    expect((await services.capture.health(alice))[0].state).toBe('degraded');
    expect(await services.capture.health(bob)).toEqual([]);
    await expect(services.capture.heartbeat(alice, { client_id: eid(701), status: 'invalid' })).rejects.toThrow('object');
    expect(await services.capture.status()).toMatchObject({ schema_version: 34, schema_ready: true, capture_lookup: true });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});

it('expired originals can be replayed from spool; private markers are suppressed server-side', async () => {
  const source = { ...event(800), occurred_at: Date.now() - 40 * 86400000, payload_redacted: { output: '<private>private-fixture</private>' } };
  await services.capture.put(alice, source);
  let row = await db.prepare('SELECT payload_redacted,visibility FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, source.id).first<{ payload_redacted: string; visibility: string }>();
  expect(row?.payload_redacted).not.toContain('private-fixture');
  expect(row?.visibility).toBe('personal');
  await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=? AND id=?').bind(alice.userId, source.id).run();
  expect(await services.capture.put(alice, source)).toMatchObject({ created: true });
  const restored = await services.capture.timeline(alice, { anchor_event_id: source.id });
  expect(restored.found).toBe(true);
  expect(restored.events.find(e => e.id === source.id)?.occurred_at).toBe(source.occurred_at);
});

// Fifty real Capture service calls populate the originals before attach is tested.
// Allow CI's workerd RPC setup time; this is not a production request deadline.
it('fifty-source provenance uses bounded set-based operations and preserves metadata', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const source = { ...event(2000 + i, 'project'), payload_redacted: { output: 'Supported database contract' }, cwd: '/Users/private-person/work/project' };
    await services.capture.put(alice, source); ids.push(source.id);
  }
  const { note } = await services.notes.upsert(alice, { slug: 'many-sources', title: 'Observed contract', body_md: 'The database has a verified transaction contract.', type: 'project' });
  await services.capture.attach(alice, { memory_id: note.id, source_event_ids: ids, confidence: 0.98, rationale: 'ADD: supported fact' });
  const provenance = await services.capture.provenance('note', note.id);
  expect(provenance).toHaveLength(50);
  expect(provenance[0].rationale).toBe('ADD: supported fact');
  expect(provenance[0].source.occurred_at).toBeGreaterThan(0);
  expect(provenance[0].source).not.toHaveProperty('cwd');
  expect(JSON.stringify(provenance)).not.toContain('private-person');
}, 20_000);

it('source lookup obeys shared/personal and current lifecycle, even after raw expiry', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'source-old', title: 'Source database', body_md: 'Old database uses MySQL.', type: 'project' })).note;
  const current = (await services.notes.upsert(alice, { slug: 'source-new', title: 'Source database', body_md: 'Current database uses PostgreSQL.', type: 'project', supersedes: old.id })).note;
  const personal = (await services.notes.upsert(alice, { slug: 'source-personal', title: 'Private source preference', body_md: 'Private lasting database preference.', type: 'user' })).note;
  for (const [n, memory, visibility] of [[901, old, 'project'], [902, current, 'project'], [903, personal, 'personal']] as const) {
    await services.capture.put(alice, { ...event(n, visibility), file_refs: ['src/source-lookup.ts'] });
    await services.capture.attach(alice, { memory_id: memory.id, source_event_ids: [eid(n)] });
  }
  const args = { file_refs: ['src/source-lookup.ts'], limit: 10 };
  expect((await services.capture.memoriesBySource(alice, args)).hits.map(h => h.id).sort()).toEqual([current.id, personal.id].sort());
  expect((await services.capture.memoriesBySource(bob, args)).hits.map(h => h.id)).toEqual([current.id]);
  expect((await services.capture.memoriesBySource(alice, { ...args, shared_only: true })).hits.map(h => h.id)).toEqual([current.id]);
  await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=?').bind(alice.userId).run(); await services.capture.prune();
  expect((await services.capture.memoriesBySource(bob, args)).hits.map(h => h.id)).toEqual([current.id]);
  await db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(current.id).run();
  // Existing lifecycle restores a predecessor when its superseding row is deleted.
  expect((await services.capture.memoriesBySource(bob, args)).hits.map(h => h.id)).toEqual([old.id]);
  await db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(old.id).run();
  expect((await services.capture.memoriesBySource(bob, args)).hits).toEqual([]);
  expect((await services.capture.memoriesBySource(alice, { file_refs: ['.env'] })).hits).toEqual([]);
});

describe('capture retrieval: caller-only bounded progressive disclosure', () => {
  it('new MCP readers enforce read scope and checkpoint requires write scope', async () => {
    const call = async (name: string, args: Record<string, unknown>, scopes: string[]) => {
      const response = await handleMcp(new Request('https://memory.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { principal: { ...alice, scopes: new Set(scopes) }, services, budget: 4000 });
      return await response.json() as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
    };
    for (const [name, args] of [['capture_sessions', {}], ['capture_search', {}], ['capture_get_many', { ids: [eid(5999)] }], ['capture_session_timeline', { session_id: eid(5999) }]] as const) {
      const denied = await call(name, args, ['notes:write']);
      expect(denied.result?.isError).toBe(true);
      const allowed = await call(name, args, ['notes:read']);
      expect(allowed.error).toBeUndefined(); expect(allowed.result?.isError).not.toBe(true);
    }
    expect((await call('capture_checkpoint', { source_event_ids: [eid(5999)], mode: 'apply' }, ['notes:read'])).result?.isError).toBe(true);
    const applied = await call('capture_checkpoint', { source_event_ids: [eid(5999)], mode: 'apply' }, ['notes:write']);
    expect(JSON.parse(applied.result!.content[0].text)).toEqual({ ok: true, updated: 0 });
  });
  it('an empty keyword window has a continuation; tied timestamps neither skip nor repeat hits', async () => {
    await copies(5000, 5100, 121, 'unrelated output');
    await db.prepare('UPDATE capture_events SET payload_redacted=? WHERE user_id=? AND id=?').bind(JSON.stringify({ output: 'needle 日本語' }), alice.userId, eid(5000)).run();
    const first = await services.capture.search(alice, { session_id: eid(5100), q: 'needle 日本語' });
    expect(first).toMatchObject({ hits: [], scanned: 100, scan_limit: 100 });
    expect(first.next_cursor).toBeTruthy();
    const last = await services.capture.search(alice, { session_id: eid(5100), q: 'needle 日本語', cursor: first.next_cursor });
    expect(last.hits.map(h => h.id)).toEqual([eid(5000)]);
    expect(last.next_cursor).toBeNull();
    const found: string[] = []; let cursor: string | null = null;
    do {
      const page = await services.capture.search(alice, { session_id: eid(5100), q: 'unrelated output', limit: 7, cursor });
      found.push(...page.hits.map(h => h.id)); cursor = page.next_cursor;
    } while (cursor);
    expect(found).toHaveLength(120); expect(new Set(found).size).toBe(120);
  });
  it('search indices omit full payload/identity/private cwd and bound metadata; details are opt-in', async () => {
    const refs = Array.from({ length: 20 }, (_, i) => `src/${i}-${'x'.repeat(400)}.ts`);
    await services.capture.put(alice, { ...event(5300), session_id: eid(5301), file_refs: refs, cwd: '/workspace/private-context', payload_redacted: { output: 'bounded-index ' + 'x'.repeat(12000) } });
    const result = await services.capture.search(alice, { q: 'bounded-index', session_id: eid(5301) });
    expect(result.index_only).toBe(true); const hit = result.hits[0];
    expect(hit.preview).toHaveLength(400); expect(hit.preview_truncated).toBe(true);
    expect(hit.metadata.file_refs).toHaveLength(3); expect(hit.metadata.file_refs[0].length).toBeLessThanOrEqual(180);
    expect(hit).not.toHaveProperty('payload_redacted'); expect(hit).not.toHaveProperty('user_id'); expect(hit.metadata).not.toHaveProperty('cwd');
    expect(JSON.stringify(hit).length).toBeLessThan(2000);
    const details = await services.capture.getMany(alice, { ids: [hit.id, eid(5302), hit.id] });
    expect(details.events.map(e => e.id)).toEqual([hit.id]); expect(details.missing_ids).toEqual([eid(5302)]);
    expect(JSON.stringify(details.events[0].payload_redacted).length).toBeGreaterThan(10000);
    expect(await services.capture.getMany(bob, { ids: [hit.id] })).toEqual({ events: [], missing_ids: [hit.id] });
    expect((await services.capture.search(bob, { session_id: eid(5301) })).hits).toEqual([]);
    expect(await services.capture.sessionTimeline(bob, { session_id: eid(5301) })).toEqual({ found: false, events: [], next_cursor: null });
  });
  it('rare metadata and expired originals stay inside a bounded indexed search window', async () => {
    await copies(6200, 6400, 121, 'metadata window fixture');
    await db.prepare("UPDATE capture_events SET metadata_json=json_set(metadata_json,'$.file_refs',json_array('src/rare.ts')) WHERE user_id=? AND id=?").bind(alice.userId, eid(6200)).run();
    await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=? AND session_id=? AND id>?').bind(alice.userId, eid(6400), eid(6309)).run();
    const first = await services.capture.search(alice, { session_id: eid(6400), file_ref: 'src/rare.ts' });
    expect(first.hits).toEqual([]); expect(first.scanned).toBe(100); expect(first.next_cursor).toBeTruthy();
    const next = await services.capture.search(alice, { session_id: eid(6400), file_ref: 'src/rare.ts', cursor: first.next_cursor });
    expect(next.hits.map(h => h.id)).toEqual([eid(6200)]); expect(next.next_cursor).toBeNull();
    const keyword = await services.capture.search(alice, { session_id: eid(6400), q: 'metadata window', limit: 50 });
    expect(keyword.hits.some(h => h.id === eid(6320))).toBe(false);
    const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT * FROM capture_events WHERE user_id=? ORDER BY occurred_at DESC,id DESC LIMIT 101').bind(alice.userId).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes('capture_recent'))).toBe(true);
  });
  it('exact file/repo/type/date filters and session pages preserve caller isolation and raw TTL', async () => {
    await copies(5400, 5401, 4, 'filtered output');
    expect((await services.capture.search(alice, { session_id: eid(5401), file_ref: 'src/db.ts', repo: 'https://github.com/acme/cf-memory', tool_name: 'Read', event_type: 'PostToolUse', since: 1000, until: 1001 })).hits).toHaveLength(4);
    for (const filter of [{ file_ref: 'src/other.ts' }, { repo: 'other' }, { until: 1000 }, { since: 1001 }]) {
      expect((await services.capture.search(alice, { session_id: eid(5401), ...filter })).hits).toEqual([]);
    }
    const first = await services.capture.sessionTimeline(alice, { session_id: eid(5401), limit: 2 });
    const next = await services.capture.sessionTimeline(alice, { session_id: eid(5401), limit: 2, cursor: first.next_cursor });
    expect([...first.events, ...next.events].map(e => e.id)).toEqual([5400, 5401, 5402, 5403].map(eid));
    expect(next.next_cursor).toBeNull();
    await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=? AND session_id=?').bind(alice.userId, eid(5401)).run();
    expect((await services.capture.sessionTimeline(alice, { session_id: eid(5401) })).events).toEqual([]);
    expect((await services.capture.getMany(alice, { ids: [eid(5400)] })).missing_ids).toEqual([eid(5400)]);
    expect((await services.capture.sessions(bob)).sessions.some(s => s.id === eid(5401))).toBe(false);
    const a = await services.capture.sessions(alice, { limit: 1 });
    const b = await services.capture.sessions(alice, { limit: 1, cursor: a.next_cursor });
    expect(a.sessions[0].id).not.toBe(b.sessions[0].id);
    expect(a.sessions[0]).not.toHaveProperty('repo_context_json');
    for (const args of [{ cursor: 'bad' }, { since: 'bad' }, { until: -1 }, { q: 'x'.repeat(201) }]) {
      await expect(services.capture.search(alice, args)).rejects.toThrow();
    }
  });
  it('200-event checkpoints are bounded, idempotent and never downgrade provenance or foreign originals', async () => {
    await copies(5500, 5800, 200, 'checkpoint source');
    await services.capture.put(bob, { ...event(5500), session_id: eid(5800) });
    await db.prepare("UPDATE capture_events SET distill_status='applied' WHERE user_id=? AND id=?").bind(alice.userId, eid(5500)).run();
    const ids = Array.from({ length: 200 }, (_, i) => eid(5500 + i));
    expect(await services.capture.checkpoint(alice, { source_event_ids: ids, mode: 'shadow' })).toEqual({ ok: true, updated: 199 });
    expect(await services.capture.checkpoint(alice, { source_event_ids: ids, mode: 'apply' })).toEqual({ ok: true, updated: 0 });
    const result = await db.prepare('SELECT user_id,distill_status FROM capture_events WHERE id=? ORDER BY user_id').bind(eid(5500)).all<{ user_id: string; distill_status: string }>();
    expect(result.results).toEqual([{ user_id: 'alice', distill_status: 'applied' }, { user_id: 'bob', distill_status: 'pending' }]);
    expect(await services.capture.checkpoint(bob, { source_event_ids: [eid(5999)], mode: 'apply' })).toEqual({ ok: true, updated: 0 });
  });
  it('missing lookup migration is visible before release and restored indexes do not mutate sources', async () => {
    const before = await db.prepare('SELECT count(*) AS n FROM capture_events').first<{ n: number }>();
    await db.prepare('DROP INDEX capture_recent').run();
    expect(await services.capture.status()).toMatchObject({ schema_version: 33, required_schema_version: 34, schema_ready: false, capture_lookup: false, capture_checkpoint: true });
    await db.prepare('CREATE INDEX capture_recent ON capture_events(user_id,occurred_at DESC,id DESC)').run();
    expect(await services.capture.status()).toMatchObject({ schema_version: 34, schema_ready: true });
    expect(await db.prepare('SELECT count(*) AS n FROM capture_events').first()).toEqual(before);
  });
});

async function atomicTool(name: string, args: Record<string, unknown>, principal = alice): Promise<Record<string, unknown>> {
  const response = await handleMcp(new Request('https://memory.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { principal, services, budget: 4000 });
  const message = await response.json() as { error?: unknown; result?: { isError?: boolean; content: { text: string }[] } };
  if (!message.result || message.error || message.result.isError) throw Error(JSON.stringify(message));
  return JSON.parse(message.result.content[0].text);
}
it('guarded supersession refuses a target edited after the caller inspected it', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'guard-original', title: 'Guard database', body_md: 'MySQL is the original contract.', shared: false })).note;
  const guard = { id: old.id, content_hash: old.content_hash, scope: old.scope, shared: false, updated_at: old.updated_at, provenance_count: 0 };
  await services.notes.upsert(alice, { slug: old.slug, body_md: 'A human has independently corrected the contract to SQLite.' });
  await expect(atomicTool('notes_put', { slug: 'guard-stale', title: old.title, body_md: 'PostgreSQL replaces the old MySQL contract.', create_only: true, supersedes: old.id, supersedes_guard: guard })).rejects.toThrow('supersession conflict');
  expect(await services.notes.getRowBySlug(alice.userId, 'guard-stale')).toBeNull();
  expect(await services.notes.isCurrent(old.id)).toBe(true);
});
it('notes_get and notes_get_many expose an owned correction snapshot without granting teammates writes', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'guard-dto', title: 'Guard DTO', body_md: 'A shared owned target.', type: 'project' })).note;
  const expected = { id: old.id, content_hash: old.content_hash, scope: 'global', shared: true, updated_at: old.updated_at, provenance_count: 0 };
  expect((await atomicTool('notes_get', { id: old.id })).supersession_guard).toEqual(expected);
  const many = await atomicTool('notes_get_many', { ids: [old.id] });
  expect((many.notes as Record<string, unknown>[])[0].supersession_guard).toEqual(expected);
  expect((await atomicTool('notes_get', { id: old.id }, bob)).supersession_guard).toBeNull();
  await expect(atomicTool('notes_put', { slug: 'guard-foreign', body_md: 'A teammate cannot supersede this owned row.', shared: true, create_only: true, supersedes: old.id, supersedes_guard: expected }, bob)).rejects.toThrow('supersession conflict');
});
it('an owner may supersede their own personal note with a shared correction; never the reverse', async () => {
  // User decision 2026-10-24: a decision first saved personal (read through Bash) and later
  // corrected in shared project files could not be retired, so both stayed current.
  const old = (await services.notes.upsert(alice, { slug: 'guard-promote-old', title: 'Guard promote', body_md: 'The cache store is Redis 7.', shared: false })).note;
  await services.capture.put(alice, event(9700, 'project')); // the correction edited shared project files
  const snapshot = (await atomicTool('notes_get', { id: old.id })).supersession_guard;
  const created = await atomicTool('notes_put', { slug: 'guard-promote-new', title: 'Guard promote', body_md: 'The cache store is Valkey 8.', shared: true, type: 'project', create_only: true, supersedes: old.id, supersedes_guard: snapshot, provenance: { source_event_ids: [eid(9700)] } });
  expect(await services.notes.isCurrent(old.id)).toBe(false);
  expect(await services.notes.isCurrent(String(created.id))).toBe(true);
  const seen = await atomicTool('notes_get', { id: created.id }, bob);
  expect(seen.found).toBe(true);expect(seen.body_md).toBe('The cache store is Valkey 8.');
  expect((await atomicTool('notes_get', { id: old.id }, bob)).found).toBe(false);
  // A shared note can never be retired by a personal one (team knowledge would disappear).
  const team = (await services.notes.upsert(alice, { slug: 'guard-demote-old', title: 'Guard demote', body_md: 'Team rule.', type: 'project' })).note;
  await services.capture.put(alice, event(9701));
  const teamSnapshot = (await atomicTool('notes_get', { id: team.id })).supersession_guard;
  await expect(atomicTool('notes_put', { slug: 'guard-demote-new', title: 'Guard demote', body_md: 'Private rule.', shared: false, create_only: true, supersedes: team.id, supersedes_guard: teamSnapshot, provenance: { source_event_ids: [eid(9701)] } })).rejects.toThrow('supersession conflict');
  expect(await services.notes.isCurrent(team.id)).toBe(true);
});
it('guarded correction atomically creates provenance, hides the predecessor and preserves personal isolation', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'guard-accepted-old', title: 'Guard accepted', body_md: 'The old database is MySQL.', shared: false })).note;
  await services.capture.put(alice, event(9000));
  const snapshot = (await atomicTool('notes_get', { id: old.id })).supersession_guard;
  const created = await atomicTool('notes_put', { slug: 'guard-accepted-new', title: old.title, body_md: 'The new database is PostgreSQL.', shared: false, create_only: true, supersedes: old.id, supersedes_guard: snapshot, provenance: { source_event_ids: [eid(9000)] } });
  expect(created.provenance_stored).toBe(true);
  expect(await services.notes.isCurrent(old.id)).toBe(false);
  expect(await services.notes.isCurrent(String(created.id))).toBe(true);
  expect((await atomicTool('notes_get', { id: created.id })).supersedes).toBe(old.id);
  expect(await services.capture.provenance('note', String(created.id), alice)).toHaveLength(1);
  const newRow = await services.notes.getRowById(String(created.id));
  expect((await services.capture.provenance('note', String(created.id), alice))[0].source.derived_memory_content_hash).toBe(newRow?.content_hash);
  expect((await atomicTool('notes_get', { id: created.id }, bob)).found).toBe(false);
  expect((await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, eid(9000)).first<{ distill_status: string }>())?.distill_status).toBe('applied');
  await services.notes.softDelete(alice, String(created.id));
  expect(await services.notes.isCurrent(old.id)).toBe(true);
});
it('target changes just before the D1 transaction leave no correction, orphan trace or applied source', async () => {
  const mutations: [string, (id: string) => Promise<unknown>][] = [
    ['body', id => db.prepare("UPDATE notes SET content_hash=?,body_md='Human SQLite correction' WHERE id=?").bind(eid(9200), id).run()],
    ['visibility', id => db.prepare('UPDATE notes SET shared=1 WHERE id=?').bind(id).run()],
    ['scope', id => db.prepare("UPDATE notes SET scope='https://github.com/other/repo' WHERE id=?").bind(id).run()],
    ['editor', id => db.prepare('UPDATE notes SET updated_at=updated_at+1 WHERE id=?').bind(id).run()],
    ['owner', id => db.prepare('UPDATE notes SET user_id=? WHERE id=?').bind(bob.userId, id).run()],
    ['archive', id => db.prepare('UPDATE notes SET archived_at=1 WHERE id=?').bind(id).run()],
    ['delete', id => db.prepare('UPDATE notes SET deleted_at=1 WHERE id=?').bind(id).run()],
    ['expired', id => db.prepare('UPDATE notes SET valid_until=1 WHERE id=?').bind(id).run()],
    ['future', id => db.prepare('UPDATE notes SET valid_from=? WHERE id=?').bind(Date.now()+86400000, id).run()],
    ['block', id => db.prepare("UPDATE notes SET kind='block' WHERE id=?").bind(id).run()],
    ['block-marker', id => db.prepare("UPDATE notes SET pinned_block_label='private' WHERE id=?").bind(id).run()],
    ['new-source', async id => { await services.capture.put(alice, event(9299)); return services.capture.attach(alice, { memory_id: id, source_event_ids: [eid(9299)], relation: 'confirms' }); }],
    ['superseded', async id => services.notes.upsert(alice, { slug: 'guard-race-winner', body_md: 'Another correction already won.', supersedes: id })],
  ];
  for (const [index, [name, mutate]] of mutations.entries()) {
    const old = (await services.notes.upsert(alice, { slug: 'guard-race-old-'+name, body_md: 'MySQL old contract '+name, shared: false })).note;
    const snapshot = await services.notes.supersessionGuard(old), sourceId = eid(9100+index);
    await services.capture.put(alice, event(9100+index));
    let allocated = '';
    await expect(services.notes.upsert(alice, { slug: 'guard-race-new-'+name, body_md: 'PostgreSQL new contract '+name, shared: false, createOnly: true, supersedes: old.id, supersedesGuard: snapshot }, async (id, shared) => {
      allocated = id;
      const statements = await services.capture.prepareCreation(alice, 'note', id, shared, { source_event_ids: [sourceId] });
      await mutate(old.id); // after resolution/preparation, before actual commit
      return statements;
    }), name).rejects.toThrow('supersession conflict');
    expect(await services.notes.getRowBySlug(alice.userId, 'guard-race-new-'+name), name).toBeNull();
    for (const [table, field] of [['memory_provenance','memory_id'],['note_revisions','note_id'],['events','target_id'],['embedding_jobs','memory_id']] as const)
      expect((await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${field}=?`).bind(allocated).first<{ n: number }>())?.n, table+':'+name).toBe(0);
    expect((await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, sourceId).first<{ distill_status: string }>())?.distill_status, name).toBe('pending');
  }
}, 15000);
it('guard validation rejects malformed snapshots and incompatible writes rather than silently ignoring them', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'guard-validation', body_md: 'The target remains unchanged.', shared: false })).note;
  const guard = await services.notes.supersessionGuard(old);
  const input = { slug: 'guard-invalid', body_md: 'Invalid requests must create nothing.', create_only: true, supersedes: old.id };
  for (const bad of [null, [], {}, { ...guard, extra: 1 }, { ...guard, content_hash: 'bad' }, { ...guard, shared: 0 }, { ...guard, updated_at: NaN }, { ...guard, provenance_count: -1 }, { ...guard, scope: 'not-a-remote' }])
    await expect(atomicTool('notes_put', { ...input, supersedes_guard: bad })).rejects.toThrow('invalid supersedes_guard');
  for (const extra of [{ create_only: false }, { supersedes: old.slug }, { supersedes: undefined }])
    await expect(atomicTool('notes_put', { ...input, ...extra, supersedes_guard: guard })).rejects.toThrow('requires create_only');
  expect(await services.notes.getRowBySlug(alice.userId, input.slug)).toBeNull();
});
it('two concurrent guarded corrections have a single winner and only its source is applied', async () => {
  const old = (await services.notes.upsert(alice, { slug: 'guard-concurrent-old', body_md: 'Original concurrent database contract.', shared: false })).note;
  const snapshot = await services.notes.supersessionGuard(old);
  await services.capture.put(alice, event(9300));
  await services.capture.put(alice, event(9301));
  const results = await Promise.allSettled([0,1].map(i => atomicTool('notes_put', { slug: 'guard-concurrent-'+i, body_md: 'New concurrent database contract '+i, shared: false, create_only: true, supersedes: old.id, supersedes_guard: snapshot, provenance: { source_event_ids: [eid(9300+i)] } })));
  expect(results.filter(r => r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status==='rejected')).toHaveLength(1);
  const winner = results.findIndex(r => r.status==='fulfilled');
  for (let i=0;i<2;i++) {
    const row = await services.notes.getRowBySlug(alice.userId, 'guard-concurrent-'+i);
    expect(Boolean(row)).toBe(i===winner);
    expect((await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, eid(9300+i)).first<{ distill_status: string }>())?.distill_status).toBe(i===winner?'applied':'pending');
  }
});
it('create-only notes commit fifty derived snapshots with the content, preserving team visibility and bounded metadata', async () => {
  await copies(8000, 8500, 50, 'Atomic creation evidence');
  await db.prepare("UPDATE capture_events SET visibility='project' WHERE user_id=? AND session_id=?").bind(alice.userId, eid(8500)).run();
  const created = await atomicTool('notes_put', { slug: 'atomic-fifty', title: 'Atomic creation evidence', body_md: 'This shared fact has an atomic creation trace.', type: 'project', create_only: true, provenance: { source_event_ids: Array.from({ length: 50 }, (_, i) => eid(8000 + i)), generated_by: 'cf-memory-agent/fixture', confidence: 0.99 } });
  expect(created.provenance_stored).toBe(true);
  const trace = await services.capture.provenance('note', String(created.id), bob);
  expect(trace).toHaveLength(50);
  expect(trace.every(p => p.relation === 'derived_from' && p.actor_id === alice.userId && p.source.visibility === 'project')).toBe(true);
  expect(JSON.stringify(trace)).not.toContain('payload_redacted');
  expect((await atomicTool('notes_get', { id: created.id }, bob)).found).toBe(true);
});
it('atomic creation rejects personal-to-shared, foreign, expired and absent originals before creating any memory', async () => {
  await services.capture.put(alice, event(8600));
  await services.capture.put(bob, event(8601));
  await services.capture.put(alice, event(8602));
  await db.prepare('UPDATE capture_events SET expires_at=0 WHERE user_id=? AND id=?').bind(alice.userId, eid(8602)).run();
  for (const [n, shared] of [[8600, true], [8601, false], [8602, false], [8603, false]] as const) {
    const slug = 'atomic-reject-' + n;
    await expect(atomicTool('notes_put', { slug, title: 'Rejected source', body_md: 'An unavailable original must never create a durable memory.', type: 'project', shared, create_only: true, provenance: { source_event_ids: [eid(n)] } })).rejects.toThrow('source');
    expect(await services.notes.getRowBySlug(alice.userId, slug)).toBeNull();
  }
});
it('a provenance statement failure rolls back both new note/skill content and applied source status', async () => {
  await services.capture.put(alice, event(8700));
  await db.prepare("CREATE TRIGGER reject_atomic_trace BEFORE INSERT ON memory_provenance WHEN NEW.rationale='atomic-failure-fixture' BEGIN SELECT RAISE(ABORT,'atomic provenance fixture failure'); END").run();
  try {
    const provenance = { source_event_ids: [eid(8700)], rationale: 'atomic-failure-fixture' };
    await expect(atomicTool('notes_put', { slug: 'atomic-rollback-note', title: 'Rollback', body_md: 'A failed trace must roll back the note.', create_only: true, provenance })).rejects.toThrow(/Internal error in notes_put \(code [0-9a-f]{8}\)/);
    await expect(atomicTool('skills_put', { slug: 'atomic-rollback-skill', name: 'Rollback procedure', instructions: 'A failed trace must roll back the procedure.', create_only: true, provenance })).rejects.toThrow(/Internal error in skills_put \(code [0-9a-f]{8}\)/);
    expect(await services.notes.getRowBySlug(alice.userId, 'atomic-rollback-note')).toBeNull();
    expect(await services.skills.getBySlug(alice.userId, 'atomic-rollback-skill')).toBeNull();
    expect((await db.prepare('SELECT distill_status FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, eid(8700)).first<{ distill_status: string }>())?.distill_status).toBe('pending');
    expect((await db.prepare("SELECT memory_id FROM memory_provenance WHERE rationale='atomic-failure-fixture'").all()).results).toHaveLength(0);
  } finally { await db.prepare('DROP TRIGGER reject_atomic_trace').run(); }
}, 15000);
it('creation provenance cannot revise human memories; validated snapshots survive concurrent raw expiry', async () => {
  await services.capture.put(alice, { ...event(8800), cwd: '/private/fixture-cwd' });
  const human = await atomicTool('notes_put', { slug: 'atomic-human', title: 'Human-owned original', body_md: 'Keep this original untouched.' });
  const before = await services.notes.getRowById(String(human.id));
  const provenance = { source_event_ids: [eid(8800)] };
  await expect(atomicTool('notes_put', { slug: 'atomic-human', body_md: 'Unauthorized replacement.', provenance })).rejects.toThrow('create_only');
  await expect(atomicTool('notes_put', { slug: 'atomic-human', body_md: 'Unauthorized replacement.', create_only: true, provenance })).rejects.toThrow();
  expect((await services.notes.getRowById(String(human.id)))?.content_hash).toBe(before?.content_hash);
  expect(await services.capture.provenance('note', String(human.id), alice)).toHaveLength(0);
  const { note } = await services.notes.upsert(alice, { slug: 'atomic-expiry-snapshot', title: 'Snapshot survives', body_md: 'The validated creation trace survives raw expiry.', createOnly: true }, async (id, shared) => {
    const statements = await services.capture.prepareCreation(alice, 'note', id, shared, provenance);
    await db.prepare('DELETE FROM capture_events WHERE user_id=? AND id=?').bind(alice.userId, eid(8800)).run();
    return statements;
  });
  const trace = await services.capture.provenance('note', note.id, alice);
  expect(trace).toHaveLength(1);
  expect(trace[0]).toMatchObject({ relation: 'derived_from', event_id: eid(8800), source: { visibility: 'personal' } });
  expect(JSON.stringify(trace)).not.toContain('/private/fixture-cwd');
});

it('provenance time display is additive across single/batch/timezones and leaves snapshots, stored metadata and paid comparison inputs unchanged',async()=>{
 const source={...event(68001,'project'),occurred_at:1791988971552,payload_redacted:{output:'The observed contract uses PostgreSQL.'}};
 await services.capture.put(alice,source);
 const note=(await services.notes.upsert(alice,{slug:'clock-shared',title:'Clock display contract',body_md:'The contract uses PostgreSQL.',type:'project'})).note;
 await services.capture.attach(alice,{memory_id:note.id,source_event_ids:[source.id],generated_by:'cf-memory-agent/fixture',rationale:'verified local fixture'});
 const original=JSON.parse(JSON.stringify(await services.capture.provenance('note',note.id,alice)));
 const before=(await db.prepare('SELECT source_metadata_json,created_at FROM memory_provenance WHERE memory_id=?').bind(note.id).all()).results;
 const utc=await atomicTool('notes_get',{id:note.id}),many=await atomicTool('notes_get_many',{ids:[note.id],time_zone:'Asia/Tokyo'});
 const tokyo=(many.notes as Record<string,unknown>[])[0];
 expect(utc.provenance).toEqual(original);expect(tokyo.provenance).toEqual(original);
 expect(utc.provenance_time_display).toMatchObject({time_zone:'UTC',entries:[{event_id:source.id,source_time:{utc_iso:'2026-10-14T14:42:51.552Z',basis:'recorded_source_event'}}]});
 expect(tokyo.provenance_time_display).toMatchObject({time_zone:'Asia/Tokyo',entries:[{event_id:source.id,source_time:{local:{date_time:'2026-10-14T23:42:51.552',utc_offset_seconds:32400}}}]});
 expect(tokyo.content_hash).toBe(utc.content_hash);expect(tokyo.supersession_guard).toEqual(utc.supersession_guard);
 expect((await db.prepare('SELECT source_metadata_json,created_at FROM memory_provenance WHERE memory_id=?').bind(note.id).all()).results).toEqual(before);
 const raw=await services.capture.getMany(alice,{ids:[source.id]});expect(raw.events[0].payload_redacted).toEqual(source.payload_redacted);expect(raw.events[0]).not.toHaveProperty('provenance_time_display');
});
it('time display follows existing shared/personal and imported-provenance isolation, never fills hidden dates',async()=>{
 const shared=await services.notes.getRowBySlug(alice.userId,'clock-shared');expect(shared).not.toBeNull();
 const bobShared=await atomicTool('notes_get',{id:shared!.id,time_zone:'America/New_York'},bob);
 expect(bobShared.supersession_guard).toBeNull();expect(bobShared.provenance_time_display).toMatchObject({entries:[{event_id:eid(68001)}]});
 const personal=(await services.notes.upsert(alice,{slug:'clock-personal',title:'Private clock',body_md:'Personal only.',type:'user'})).note;
 for(const name of ['notes_get','notes_get_many']){
  const reply=await atomicTool(name,name==='notes_get'?{id:personal.id,time_zone:'Asia/Tokyo'}:{ids:[personal.id],time_zone:'Asia/Tokyo'},bob);
  expect(reply.found).toBe(false);expect(reply).not.toHaveProperty('provenance_time_display');expect(JSON.stringify(reply)).not.toContain('Private clock');
 }
 const imported=(await services.notes.upsert(alice,{slug:'clock-imported',title:'Imported clock',body_md:'A portable claim.',type:'project',shared:false})).note;
 await services.portability.importProvenance(alice,{kind:'note',id:imported.id,expected_content_hash:imported.content_hash,expected_scope:imported.scope,
  origin:{instance:eid(68010),owner_id:'foreign-owner',memory_id:'foreign-memory'},snapshots:[{event_id:eid(68011),source_session_id:eid(68012),actor_id:'foreign-actor',relation:'derived_from',generated_by:'imported-fixture',confidence:.99,rationale:'unverified import',created_at:1000,source:{occurred_at:0}}]});
 await services.notes.upsert(alice,{slug:imported.slug,body_md:imported.body_md,shared:true});
 const own=await atomicTool('notes_get',{id:imported.id,time_zone:'Asia/Tokyo'}),other=await atomicTool('notes_get',{id:imported.id,time_zone:'Asia/Tokyo'},bob);
 expect(own.provenance_time_display).toMatchObject({entries:[{source_time:{utc_iso:'1970-01-01T00:00:00.000Z',basis:'imported_claim'}}]});
 expect(other.provenance).toEqual([]);expect(other.provenance_time_display).toMatchObject({entries:[]});expect(JSON.stringify(other)).not.toContain('foreign-actor');
});
it('invalid time_zone refuses before a note view or metadata read and never echoes raw supplied values',async()=>{
 const note=await services.notes.getRowBySlug(alice.userId,'clock-shared');expect(note).not.toBeNull();
 const before=await db.prepare('SELECT view_count,last_viewed_at FROM notes WHERE id=?').bind(note!.id).first();
 for(const name of ['notes_get','notes_get_many']){
  const bad='invalid/time_zone_DO_NOT_ECHO';
  try{await atomicTool(name,name==='notes_get'?{id:note!.id,time_zone:bad}:{ids:[note!.id],time_zone:bad});throw Error('unexpected success');}
  catch(e){expect(String(e)).toContain('invalid_time_zone');expect(String(e)).not.toContain(bad);}
 }
 expect(await db.prepare('SELECT view_count,last_viewed_at FROM notes WHERE id=?').bind(note!.id).first()).toEqual(before);
});
it('skills_get uses the same authorized time display while original skill/provenance stay unchanged',async()=>{
 await services.capture.put(alice,{...event(68020),occurred_at:0,payload_redacted:{output:'Run the repeatable verification procedure.'}});
 await atomicTool('skills_put',{slug:'clock-procedure',name:'Clock procedure',description:'Repeatable fixture.',instructions:'Run the local verification procedure.',create_only:true,provenance:{source_event_ids:[eid(68020)]}});
 const own=await atomicTool('skills_get',{slug:'clock-procedure',time_zone:'Asia/Tokyo'});
 expect(own.provenance_time_display).toMatchObject({time_zone:'Asia/Tokyo',entries:[{event_id:eid(68020),source_time:{utc_iso:'1970-01-01T00:00:00.000Z',basis:'recorded_source_event'}}]});
 expect(own.instructions_md).toBe('Run the local verification procedure.');
 expect((await atomicTool('skills_get',{slug:'clock-procedure',time_zone:'UTC'})).provenance).toEqual(own.provenance);
 expect((await atomicTool('skills_get',{slug:'clock-procedure',time_zone:'UTC'},bob)).found).toBe(false);
});
