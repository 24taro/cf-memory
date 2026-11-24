import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeEntry } from '../scripts/entries.mjs';
import { appendEntries, BATCH_BYTES, flush, pendingStats, REJECTED_CAP_BYTES, rejectedFile, rejectedStats, replayRejected, spoolFile } from '../scripts/spool.mjs';
import { createMcp, failureCode, McpFailure } from '../scripts/transport.mjs';

const TS0 = 1790000000000;
import { fakeServer, tempDir, TEST_TOKEN } from './helpers/fake-server.mjs';

const entries = (count, kind = 'action', size = 10) => Array.from({ length: count }, (_, i) =>
  makeEntry({ client: 'codex', session_id: 'session-' + (i % 3), repo: 'example/demo', ts: 1790000000000 + i, kind, text: kind + ' ' + i + ' ' + 'x'.repeat(size) }));

test('append writes one JSON line per valid entry', async () => {
  const dir = tempDir();
  try {
    const result = await appendEntries(dir.path, 'codex', [...entries(3), { id: 'bad' }]);
    assert.deepEqual(result, { appended: 3, dropped: 1 });
    const lines = readFileSync(spoolFile(dir.path, 'codex'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['client', 'id', 'kind', 'repo', 'session_id', 'text', 'ts']);
    assert.deepEqual(await pendingStats(dir.path, 'codex', { count: true }), { bytes: readFileSync(spoolFile(dir.path, 'codex')).length, entries: 3 });
  } finally { dir.cleanup(); }
});

test('flush sends batches of at most 50 and empties the spool', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(120));
    const batches = [];
    const result = await flush(dir.path, 'codex', async batch => { batches.push(batch.length); return { stored: batch.length, duplicates: 0, dropped_over_cap: 0 }; });
    assert.deepEqual(batches, [50, 50, 20]);
    assert.equal(result.sent, 120); assert.equal(result.stored, 120); assert.equal(result.pending_bytes, 0);
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 0);
  } finally { dir.cleanup(); }
});

test('flush also bounds a batch by bytes', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(10, 'prompt', 60000));
    const batches = [];
    await flush(dir.path, 'codex', async batch => { batches.push(batch.length); return {}; }, { batchBytes: 200000 });
    assert.ok(batches.length > 1 && batches.every(n => n <= 3), String(batches));
    assert.equal(batches.reduce((a, b) => a + b, 0), 10);
  } finally { dir.cleanup(); }
});

test('every log_append request stays within 2,000,000 bytes; 50 full-length Japanese prompts take several', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    assert.equal(BATCH_BYTES, 2000000);
    const prompts = Array.from({ length: 50 }, (_, i) => makeEntry({ client: 'codex', session_id: 'long', repo: 'example/demo', ts: 1790000000000 + i, kind: 'prompt', text: i + ' ' + 'あ'.repeat(70000) }));
    await appendEntries(dir.path, 'codex', prompts);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 10000);
    const result = await flush(dir.path, 'codex', batch => call('log_append', { entries: batch }));
    const requests = server.named('log_append');
    assert.ok(requests.length >= 5, requests.length + ' requests');
    for (const request of requests) assert.ok(request.bytes <= BATCH_BYTES, request.bytes + ' bytes');
    assert.equal(requests.reduce((sum, request) => sum + request.args.entries.length, 0), 50);
    assert.deepEqual([result.sent, server.stored.size, result.pending_bytes], [50, 50, 0]);
    assert.equal(server.stored.get(prompts[49].id).text, prompts[49].text, 'multi-byte text arrives intact');
  } finally { await server.close(); dir.cleanup(); }
});

test('an entry larger than the byte limit on its own is sent alone', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', [...entries(1), ...entries(1, 'prompt', 60000), ...entries(1, 'reply')]);
    const batches = [];
    const result = await flush(dir.path, 'codex', async batch => { batches.push(batch.map(e => e.kind)); return {}; }, { batchBytes: 50000 });
    assert.deepEqual(batches, [['action'], ['prompt'], ['reply']]);
    assert.equal(result.pending_bytes, 0);
  } finally { dir.cleanup(); }
});

test('an entry the server rejects as invalid is set aside and the rest of its batch is delivered', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('BAD') });
  try {
    const all = Array.from({ length: 6 }, (_, i) => makeEntry({ client: 'codex', session_id: 's', ts: 1790000000000 + i, kind: 'action', text: (i === 1 || i === 4 ? 'BAD ' : 'Bash: echo ') + i }));
    await appendEntries(dir.path, 'codex', all);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    const result = await flush(dir.path, 'codex', send);
    assert.equal(result.error, undefined);
    assert.deepEqual([result.sent, result.rejected, result.pending_bytes], [4, 2, 0]);
    assert.deepEqual([...server.stored.keys()].sort(), [0, 2, 3, 5].map(i => all[i].id).sort());
    assert.equal(server.named('log_append').length, 3, 'resent twice, each time without the entry the server named');
    const kept = readFileSync(rejectedFile(dir.path, 'codex'), 'utf8').trim().split('\n').map(line => JSON.parse(line).id);
    assert.deepEqual(kept, [all[1].id, all[4].id]);
    assert.equal((await rejectedStats(dir.path, 'codex')).entries, 2);
    assert.equal((await flush(dir.path, 'codex', send)).sent, 0);
    assert.equal(server.named('log_append').length, 3, 'nothing is resent');
  } finally { await server.close(); dir.cleanup(); }
});

test('retryable server errors and request-level validation errors keep the batch in the spool', async () => {
  let message = null;
  const dir = tempDir(), server = await fakeServer({ appendError: () => message });
  try {
    await appendEntries(dir.path, 'codex', entries(5));
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    for (const [text, code] of [
      ['log_append conflicted with concurrent writes; retry the same entries', 'rejected'],
      ['logs database is not configured on this server (LOGS binding missing)', 'rejected'],
      ["Forbidden: missing scope 'notes:write'", 'rejected'],
      ["log_append: unknown field 'extra' (allowed: entries)", 'invalid_batch'],
    ]) {
      message = text;
      const result = await flush(dir.path, 'codex', send);
      assert.equal(failureCode(result.error), code, text);
      assert.deepEqual([result.sent, result.rejected], [0, 0]);
      assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 5);
    }
    message = null;
    assert.equal((await flush(dir.path, 'codex', send)).sent, 5);
    assert.equal(existsSync(rejectedFile(dir.path, 'codex')), false);
  } finally { await server.close(); dir.cleanup(); }
});

test('pendingStats finds the oldest waiting entry and can stop counting early', async () => {
  const dir = tempDir();
  try {
    assert.deepEqual(await pendingStats(dir.path, 'codex', { count: true, countLimit: 40, oldest: true }), { bytes: 0, entries: 0, oldest_ts: null });
    await appendEntries(dir.path, 'codex', entries(120));
    assert.deepEqual(await pendingStats(dir.path, 'codex', { count: true, countLimit: 40, oldest: true }).then(s => [s.entries, s.oldest_ts]), [40, 1790000000000]);
    let calls = 0;
    await flush(dir.path, 'codex', async () => { if (++calls === 2) throw Error('network down'); return {}; });
    assert.deepEqual(await pendingStats(dir.path, 'codex', { count: true, oldest: true }).then(s => [s.entries, s.oldest_ts]), [70, 1790000000050]);
  } finally { dir.cleanup(); }
});

test('a failed batch keeps it and everything after it for the next hook', async () => {
  const dir = tempDir();
  try {
    const all = entries(120);
    await appendEntries(dir.path, 'codex', all);
    let calls = 0;
    const first = await flush(dir.path, 'codex', async batch => { if (++calls === 2) throw Error('network down'); return { stored: batch.length }; });
    assert.equal(first.sent, 50);
    assert.ok(first.error);
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 70);
    const sentIds = [];
    const second = await flush(dir.path, 'codex', async batch => { sentIds.push(...batch.map(e => e.id)); return { stored: batch.length }; });
    assert.equal(second.sent, 70);
    assert.deepEqual(sentIds, all.slice(50).map(e => e.id), 'resumes exactly after the delivered batch, in order');
  } finally { dir.cleanup(); }
});

test('entries appended while flushing are kept', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(60));
    const late = entries(5, 'reply'), seen = [];
    let appended = false;
    await flush(dir.path, 'codex', async batch => {
      seen.push(...batch.map(e => e.id));
      if (!appended) { appended = true; await appendEntries(dir.path, 'codex', late); }
      return { stored: batch.length };
    });
    await flush(dir.path, 'codex', async batch => { seen.push(...batch.map(e => e.id)); return {}; });
    for (const entry of late) assert.ok(seen.includes(entry.id));
    assert.equal(seen.length, 65);
    assert.equal((await pendingStats(dir.path, 'codex')).bytes, 0);
  } finally { dir.cleanup(); }
});

test('a crash after delivery but before the cursor write resends; the server ignores duplicates', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const all = entries(30);
    await appendEntries(dir.path, 'codex', all);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    // Deliver, then lose the cursor (as if the process died before writing it).
    await send(all);
    const resent = await flush(dir.path, 'codex', send);
    assert.equal(resent.sent, 30); assert.equal(resent.stored, 0); assert.equal(resent.duplicates, 30);
    assert.equal(server.stored.size, 30);
    // A second flush has nothing left.
    const again = await flush(dir.path, 'codex', send);
    assert.equal(again.sent, 0);
  } finally { await server.close(); dir.cleanup(); }
});

test('flush through the fake server: partial failure keeps unsent entries, resend is idempotent', async () => {
  const dir = tempDir(), server = await fakeServer({ failAppend: n => n === 2 });
  try {
    await appendEntries(dir.path, 'claude-code', entries(130).map(e => ({ ...e, client: 'claude-code' })).map(e => makeEntry(e)));
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    const first = await flush(dir.path, 'claude-code', send);
    assert.equal(first.sent, 50);
    assert.equal(first.error.kind, 'http');
    assert.equal(server.stored.size, 50);
    const second = await flush(dir.path, 'claude-code', send);
    assert.equal(second.sent, 80); assert.equal(second.error, undefined);
    assert.equal(server.stored.size, 130);
    assert.ok(server.named('log_append').every(c => c.args.entries.length <= 50));
  } finally { await server.close(); dir.cleanup(); }
});

test('malformed lines are skipped and a partial last line waits', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(2));
    appendFileSync(spoolFile(dir.path, 'codex'), 'not json\n{"id":"short"}\n');
    await appendEntries(dir.path, 'codex', entries(1, 'reply'));
    appendFileSync(spoolFile(dir.path, 'codex'), '{"partial":');
    const sent = [];
    const result = await flush(dir.path, 'codex', async batch => { sent.push(...batch); return {}; });
    assert.equal(sent.length, 3); assert.equal(result.invalid, 2);
    assert.ok(result.pending_bytes > 0, 'the partial line stays');
  } finally { dir.cleanup(); }
});

test('only one flush runs at a time; a stale lock is taken over', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(5));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const slow = flush(dir.path, 'codex', async () => { await gate; return {}; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const busy = await flush(dir.path, 'codex', async () => ({}));
    assert.equal(busy.busy, true);
    release();
    assert.equal((await slow).sent, 5);
    writeFileSync(join(dir.path, 'spool', 'codex.lock'), '999999');
    utimesSync(join(dir.path, 'spool', 'codex.lock'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    await appendEntries(dir.path, 'codex', entries(2, 'reply'));
    assert.equal((await flush(dir.path, 'codex', async () => ({}))).sent, 2);
  } finally { dir.cleanup(); }
});

test('a sealed segment left by a crash is finished first, then deleted whole', async () => {
  const dir = tempDir();
  try {
    const all = entries(4);
    await appendEntries(dir.path, 'codex', all);
    let calls = 0;
    await flush(dir.path, 'codex', async () => { if (++calls > 1) throw Error('down'); return {}; }, { batchEntries: 2 });
    // A crash right after the seal: the live file was renamed, the cursor (by inode) still points into it.
    renameSync(spoolFile(dir.path, 'codex'), join(dir.path, 'spool', 'codex.001790000000000-0123abcd.seg'));
    const late = entries(1, 'reply');
    await appendEntries(dir.path, 'codex', late);
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 3);
    const sent = [];
    await flush(dir.path, 'codex', async batch => { sent.push(...batch.map(e => e.id)); return {}; });
    assert.deepEqual(sent, [all[2].id, all[3].id, late[0].id], 'the segment from its cursor, then the live file');
    assert.deepEqual(readdirSync(join(dir.path, 'spool')).filter(name => !name.endsWith('.cursor.json')), [], 'segment, live file, lock and temporaries are gone');
  } finally { dir.cleanup(); }
});

test('a deadline in the past sends nothing and keeps everything (`budget`, not a server timeout)', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(3));
    const result = await flush(dir.path, 'codex', async () => { throw Error('must not send'); }, { deadline: performance.now() - 1 });
    assert.equal(result.sent, 0); assert.equal(result.error, 'budget');
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 3);
  } finally { dir.cleanup(); }
});

test('the deadline after the server answered stops the flush as `timeout` (progress, not `budget`)', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(120));
    const result = await flush(dir.path, 'codex', async () => { await new Promise(resolve => setTimeout(resolve, 1100)); return {}; }, { deadline: performance.now() + 1000 });
    assert.deepEqual([result.sent, result.error], [50, 'timeout']);
  } finally { dir.cleanup(); }
});

// ---- Concurrency: other hook processes append and flush while a flush runs ----

const helper = name => join(import.meta.dirname, 'helpers', name);
const child = (script, args) => new Promise((resolve, reject) => {
  const process_ = spawn(process.execPath, [helper(script), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  process_.stdout.on('data', data => { out += data; });
  process_.on('close', code => code === 0 ? resolve(JSON.parse(out || '{}')) : reject(Error(script + ' exited ' + code)));
});
const spoolNames = home => readdirSync(join(home, 'spool'));

test('sealing a large spool while another hook appends loses no entry and leaves no garbage line', async () => {
  const dir = tempDir();
  try {
    // ~10 MB of full-length Japanese prompts: the first flush delivers past 8 MB, fails, and seals the file.
    const big = Array.from({ length: 52 }, (_, i) => makeEntry({ client: 'codex', session_id: 'big', repo: 'x/y', ts: 1790000000000 + i, kind: 'prompt', text: i + ' ' + 'あ'.repeat(65000) }));
    await appendEntries(dir.path, 'codex', big);
    const appending = child('appender.mjs', [dir.path, '2500', 'a']);
    await new Promise(resolve => setTimeout(resolve, 300));
    const delivered = new Set();
    let bytes = 0;
    const first = await flush(dir.path, 'codex', async batch => {
      if (bytes > 8.5e6) throw Object.assign(Error('net'), { kind: 'network' });
      for (const e of batch) { delivered.add(e.id); bytes += Buffer.byteLength(JSON.stringify(e)); }
      return {};
    }, { batchBytes: 1000000 });
    assert.ok(first.error && first.sent > 40, 'stopped after ' + first.sent);
    assert.ok(spoolNames(dir.path).some(name => name.endsWith('.seg')), 'the delivered file was sealed, not rewritten');
    const appended = await appending;
    const second = await flush(dir.path, 'codex', async batch => { for (const e of batch) delivered.add(e.id); return {}; });
    assert.equal(first.invalid + second.invalid, 0, 'no line was split');
    assert.deepEqual([big.filter(e => !delivered.has(e.id)).length, appended.filter(id => !delivered.has(id)).length], [0, 0]);
    assert.ok(appended.length > 100);
    assert.ok(!spoolNames(dir.path).some(name => name.endsWith('.seg')));
  } finally { dir.cleanup(); }
});

test('repeated full flushes (each one seals) while three hook processes append lose nothing', async () => {
  const dir = tempDir();
  try {
    const delivered = [], expected = [];
    for (let round = 0; round < 12; round++) {
      const first = makeEntry({ client: 'codex', session_id: 'flush', ts: TS0 + round, kind: 'reply', text: 'Round ' + round });
      await appendEntries(dir.path, 'codex', [first]);
      expected.push(first.id);
      // Begin the child writes while the first batch is in flight. Every round
      // exercises concurrent writes regardless of process and filesystem speed.
      const result = await flush(dir.path, 'codex', async batch => {
        delivered.push(...batch.map(entry => entry.id));
        if (batch[0].id === first.id) {
          const appended = await Promise.all(['a', 'b', 'c'].map(tag =>
            child('appender.mjs', [dir.path, 'count=32', `${round}-${tag}`])));
          assert.deepEqual(appended.map(ids => ids.length), [32, 32, 32]);
          expected.push(...appended.flat());
        }
        return {};
      });
      assert.ifError(result.error);
      assert.deepEqual([result.sent, result.invalid, result.pending_bytes], [97, 0, 0]);
      assert.equal(existsSync(spoolFile(dir.path, 'codex')), false, 'the live spool was sealed and removed');
    }
    assert.deepEqual(delivered.sort(), expected.sort());
  } finally { dir.cleanup(); }
});

test('a stale lock taken over by several hooks at once: sends never overlap and nothing is lost', async () => {
  for (let round = 0; round < 8; round++) {
    const dir = tempDir();
    try {
      const initial = Array.from({ length: 200 }, (_, i) => makeEntry({ client: 'codex', session_id: 's', ts: 1790000000000 + i, kind: 'reply', text: 'r' + i + ' ' + 'z'.repeat(3000) }));
      await appendEntries(dir.path, 'codex', initial);
      const lock = join(dir.path, 'spool', 'codex.lock'), log = join(dir.path, 'delivered.txt');
      writeFileSync(lock, 'stale-token'); utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
      writeFileSync(log, ''); writeFileSync(log + '.spans', '');
      const startAt = String(Date.now() + 400);
      const appender = child('appender.mjs', [dir.path, '700', 'r' + round, '2']);
      const results = await Promise.all(Array.from({ length: 6 }, () => child('flusher.mjs', [dir.path, startAt, log, '40'])));
      const appended = await appender;
      const spans = readFileSync(log + '.spans', 'utf8').trim().split('\n').map(line => JSON.parse(line)).sort((x, y) => x.start - y.start);
      for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i].pid === spans[i - 1].pid || spans[i].start >= spans[i - 1].end, 'round ' + round + ': two holders sent at once ' + JSON.stringify([spans[i - 1], spans[i]]));
      }
      assert.ok(results.some(r => r.busy), 'the others found the lock held');
      const delivered = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean));
      await flush(dir.path, 'codex', async batch => { for (const e of batch) delivered.add(e.id); return {}; });
      assert.equal([...initial.map(e => e.id), ...appended].filter(id => !delivered.has(id)).length, 0, 'round ' + round);
      assert.deepEqual(spoolNames(dir.path).filter(name => /\.(?:old|takeover|tmp)$/.test(name)), []);
    } finally { dir.cleanup(); }
  }
});

test('a flush whose lock was taken over stops without moving the cursor or sealing', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(120));
    const later = entries(30, 'reply'), delivered = new Set();
    let first = true;
    const result = await flush(dir.path, 'codex', async batch => {
      batch.forEach(e => delivered.add(e.id));
      if (first) {
        first = false;
        // What a takeover looks like from here: the lock goes, another hook flushes everything and seals, more is queued.
        unlinkSync(join(dir.path, 'spool', 'codex.lock'));
        await flush(dir.path, 'codex', async b => { b.forEach(e => delivered.add(e.id)); return {}; });
        await appendEntries(dir.path, 'codex', later);
      }
      return {};
    });
    assert.equal(result.busy, true);
    assert.equal(result.sent, 50, 'nothing after the takeover is sent');
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 30, 'the newer entries are still waiting');
    await flush(dir.path, 'codex', async b => { b.forEach(e => delivered.add(e.id)); return {}; });
    assert.equal(later.filter(e => !delivered.has(e.id)).length, 0);
  } finally { dir.cleanup(); }
});

test('the lock carries a token, is refreshed before every send, and release removes only its own lock', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(120));
    const lock = join(dir.path, 'spool', 'codex.lock'), old = new Date(Date.now() - 20000);
    const tokens = new Set(), mtimes = [];
    let calls = 0;
    await flush(dir.path, 'codex', async () => {
      tokens.add(readFileSync(lock, 'utf8')); mtimes.push(statSync(lock).mtimeMs);
      if (++calls < 3) utimesSync(lock, old, old);
      else { unlinkSync(lock); writeFileSync(lock, 'another-holder'); } // taken over during the last send
      return {};
    });
    assert.equal(tokens.size, 1);
    assert.match([...tokens][0], /^[0-9a-f-]{36}$/);
    assert.ok(mtimes.slice(1).every(mtime => mtime > old.getTime() + 10000), 'refreshed: ' + mtimes.map(m => Math.round(Date.now() - m)));
    assert.equal(readFileSync(lock, 'utf8'), 'another-holder', "another hook's lock is left in place");
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 20, 'the batch sent after the takeover is not committed');
  } finally { dir.cleanup(); }
});

// ---- Entries the server refuses ----

test('entries the server rejects are set aside once and never resent, even when the deadline cuts every flush', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('BAD'), delay: () => 60 });
  try {
    const all = Array.from({ length: 12 }, (_, i) => makeEntry({ client: 'codex', session_id: 's', ts: 1790000000000 + i, kind: 'action', text: (i % 4 === 3 ? 'Bash: ok ' : 'BAD ') + i }));
    await appendEntries(dir.path, 'codex', all);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    let flushes = 0, rejected = 0;
    while ((await pendingStats(dir.path, 'codex')).bytes > 0 && flushes < 20) {
      const result = await flush(dir.path, 'codex', batch => call('log_append', { entries: batch }), { deadline: performance.now() + 200 });
      flushes++; rejected += result.rejected;
    }
    assert.ok(flushes > 1, 'the deadline cut the work into ' + flushes + ' flushes');
    assert.equal(rejected, 9);
    const kept = readFileSync(rejectedFile(dir.path, 'codex'), 'utf8').trim().split('\n').map(line => JSON.parse(line).id);
    assert.deepEqual(kept.sort(), all.filter(e => e.text.startsWith('BAD')).map(e => e.id).sort(), 'each set aside exactly once');
    // The fake server names the first bad entry of a batch: once named, an entry is never sent again.
    const named = new Set();
    for (const { args } of server.named('log_append')) {
      assert.ok(args.entries.every(e => !named.has(e.id)), 'a set-aside entry was resent');
      const bad = args.entries.find(e => e.text.startsWith('BAD'));
      if (bad) named.add(bad.id);
    }
    assert.equal(server.named('log_append').length, 9 + 1, 'one round trip per rejection, one to deliver the rest');
    assert.deepEqual([...server.stored.keys()].sort(), all.filter(e => !e.text.startsWith('BAD')).map(e => e.id).sort());
  } finally { await server.close(); dir.cleanup(); }
});

test('log_append counters for the daily total cap and clamped timestamps are summed; neither is an error', async () => {
  const dir = tempDir(), server = await fakeServer({ droppedOverTotalCap: 2 });
  try {
    await appendEntries(dir.path, 'codex', [...entries(3), makeEntry({ client: 'codex', session_id: 's', ts: Date.now() + 7200000, kind: 'reply', text: 'fast clock' })]);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const result = await flush(dir.path, 'codex', batch => call('log_append', { entries: batch }));
    assert.deepEqual([result.error, result.sent, result.dropped_over_total_cap, result.ts_clamped, result.pending_bytes], [undefined, 4, 2, 1, 0]);
  } finally { await server.close(); dir.cleanup(); }
});

// ---- Round 2 ----

test('a torn tail never swallows the next entry; an old joined line is recovered', async () => {
  const dir = tempDir();
  try {
    const [first, torn, third] = entries(3, 'prompt');
    await appendEntries(dir.path, 'codex', [first]);
    appendFileSync(spoolFile(dir.path, 'codex'), JSON.stringify(torn).slice(0, 40)); // a write that failed halfway (ENOSPC, EIO)
    await appendEntries(dir.path, 'codex', [third]);
    const legacy = entries(1, 'reply')[0];
    appendFileSync(spoolFile(dir.path, 'codex'), JSON.stringify(torn).slice(0, 30) + JSON.stringify(legacy) + '\n'); // written by an older Agent
    const sent = [];
    const result = await flush(dir.path, 'codex', async batch => { sent.push(...batch.map(e => e.id)); return {}; });
    assert.deepEqual(sent, [first.id, third.id, legacy.id]);
    assert.equal(result.invalid, 2, 'the two torn fragments');
    assert.equal(result.pending_bytes, 0);
  } finally { dir.cleanup(); }
});

test('after 20 refusals in a row the spool is kept and the flush fails; replay-rejected queues them again', async () => {
  const dir = tempDir();
  let refuse = true;
  const server = await fakeServer({ rejectEntry: () => refuse });
  try {
    const all = entries(25);
    await appendEntries(dir.path, 'codex', all);
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    const first = await flush(dir.path, 'codex', send);
    assert.deepEqual([first.rejected, first.error, first.sent], [20, 'rejecting', 0]);
    assert.equal((await pendingStats(dir.path, 'codex', { count: true })).entries, 5, 'the rest stays queued');
    const calls = server.named('log_append').length;
    const second = await flush(dir.path, 'codex', send);
    assert.deepEqual([second.rejected, second.error, server.named('log_append').length - calls], [0, 'rejecting', 1], 'one request, nothing more diverted');
    assert.equal((await rejectedStats(dir.path, 'codex')).entries, 20);
    // The server is fixed: the rest goes, and the refused 20 can be sent again.
    refuse = false;
    assert.equal((await flush(dir.path, 'codex', send)).sent, 5);
    assert.deepEqual(await replayRejected(dir.path, 'codex'), { replayed: 20, invalid: 0 });
    assert.equal(existsSync(rejectedFile(dir.path, 'codex')), false);
    assert.equal((await flush(dir.path, 'codex', send)).sent, 20);
    assert.equal(server.stored.size, 25);
  } finally { await server.close(); dir.cleanup(); }
});

test('replayed entries the server still refuses go back aside one by one: they never trip the streak or block new entries (review r4)', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('bad') });
  try {
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    let ts = TS0;
    const entry = text => makeEntry({ client: 'codex', session_id: 's', repo: 'r', ts: ts++, kind: 'prompt', text });
    // 25 refused entries over time, each followed by a good one (no streak).
    for (let i = 0; i < 25; i++) { await appendEntries(dir.path, 'codex', [entry('bad ' + i), entry('good ' + i)]); await flush(dir.path, 'codex', send); }
    assert.equal((await rejectedStats(dir.path, 'codex')).entries, 25);
    assert.deepEqual(await replayRejected(dir.path, 'codex'), { replayed: 25, invalid: 0 });
    for (let round = 0; round < 2; round++) {
      await appendEntries(dir.path, 'codex', [entry('new after replay ' + round)]);
      const result = await flush(dir.path, 'codex', send);
      assert.deepEqual([result.rejected, result.sent, result.error, result.pending_bytes], [round ? 0 : 25, 1, undefined, 0]);
    }
    assert.equal((await rejectedStats(dir.path, 'codex')).entries, 25, 'each set aside again');
    assert.equal([...server.stored.values()].filter(e => e.text.startsWith('new after replay')).length, 2);
    assert.ok(server.named('log_append').every(c => c.args.entries.every(e => !('replayed' in e))), 'the mark never reaches the server');
    // Fresh refusals still count: the streak holds back fresh entries only.
    await appendEntries(dir.path, 'codex', Array.from({ length: 22 }, (_, i) => entry('bad fresh ' + i)));
    const fresh = await flush(dir.path, 'codex', send);
    assert.deepEqual([fresh.rejected, fresh.error], [20, 'rejecting']);
  } finally { await server.close(); dir.cleanup(); }
});

test('refused entries past the rejected-file cap are counted as dropped', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('BAD') });
  try {
    await appendEntries(dir.path, 'codex', [makeEntry({ client: 'codex', session_id: 's', ts: TS0, kind: 'action', text: 'BAD 1' }), ...entries(2)]);
    writeFileSync(rejectedFile(dir.path, 'codex'), 'x'.repeat(REJECTED_CAP_BYTES) + '\n');
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const result = await flush(dir.path, 'codex', batch => call('log_append', { entries: batch }));
    assert.deepEqual([result.rejected, result.rejected_dropped, result.sent], [1, 1, 2]);
  } finally { await server.close(); dir.cleanup(); }
});

test('a send that times out with nothing delivered halves the next batches (down to 1); success grows them back', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(200));
    const sizes = [];
    let slow = 3;
    const send = async batch => {
      sizes.push(batch.length);
      if (slow > 0) { slow--; throw new McpFailure('timeout', 'log_append'); }
      return {};
    };
    for (let i = 0; i < 3; i++) assert.equal(failureCode((await flush(dir.path, 'codex', send)).error), 'timeout');
    assert.deepEqual(sizes, [50, 25, 12], 'each timed-out flush halves the next');
    await flush(dir.path, 'codex', send);
    assert.deepEqual(sizes.slice(3, 7), [6, 12, 24, 48], 'then grows back after each success');
    assert.equal((await pendingStats(dir.path, 'codex')).bytes, 0);
  } finally { dir.cleanup(); }
});

test('a flush sweeps leftovers of crashed writers older than an hour', async () => {
  const dir = tempDir();
  try {
    await appendEntries(dir.path, 'codex', entries(1));
    mkdirSync(join(dir.path, 'health'), { recursive: true });
    const old = new Date(Date.now() - 2 * 3600000);
    const stale = [join(dir.path, 'spool', 'codex.cursor.json.1b2c.tmp'), join(dir.path, 'spool', 'codex.lock.1b2c.old'), join(dir.path, 'spool', 'codex.lock.takeover'), join(dir.path, 'health', 'codex.json.1b2c.tmp')];
    for (const file of stale) { writeFileSync(file, 'x'); utimesSync(file, old, old); }
    const fresh = join(dir.path, 'spool', 'claude-code.cursor.json.9f.tmp');
    writeFileSync(fresh, 'x');
    await flush(dir.path, 'codex', async () => ({}));
    assert.deepEqual(stale.filter(existsSync), []);
    assert.ok(existsSync(fresh), 'a recent one may belong to a running hook');
  } finally { dir.cleanup(); }
});

test('after a rejecting stop the streak decays, so refused entries are set aside in steps and the good ones behind them go (review 5)', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('bad') });
  try {
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    let ts = TS0;
    const entry = text => makeEntry({ client: 'codex', session_id: 's', repo: 'r', ts: ts++, kind: 'prompt', text });
    await appendEntries(dir.path, 'codex', [...Array.from({ length: 25 }, (_, i) => entry('bad ' + i)), ...Array.from({ length: 10 }, (_, i) => entry('good ' + i))]);
    const first = await flush(dir.path, 'codex', send);
    assert.deepEqual([first.rejected, first.sent, first.error], [20, 0, 'rejecting']);
    const held = await flush(dir.path, 'codex', send);
    assert.deepEqual([held.rejected, held.sent, held.error], [0, 0, 'rejecting'], 'held for a while');
    // Ten minutes later the streak decays: the rest are set aside and the good entries go.
    const path = join(dir.path, 'spool', readdirSync(join(dir.path, 'spool')).find(name => name.startsWith('codex') && name.includes('cursor')));
    const cursor = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...cursor, streak_at: Date.now() - 11 * 60000 }));
    const later = await flush(dir.path, 'codex', send);
    assert.deepEqual([later.rejected, later.sent, later.error], [5, 10, undefined]);
    assert.equal([...server.stored.values()].filter(e => e.text.startsWith('good')).length, 10);
  } finally { await server.close(); dir.cleanup(); }
});

test('the streak never drains refused entries past a full rejected file: they stay queued (review 6)', async () => {
  const dir = tempDir(), server = await fakeServer({ rejectEntry: entry => entry.text.startsWith('bad') });
  try {
    const call = createMcp({ url: server.url, token: TEST_TOKEN }, 5000);
    const send = batch => call('log_append', { entries: batch });
    let ts = TS0;
    const entry = text => makeEntry({ client: 'codex', session_id: 's', repo: 'r', ts: ts++, kind: 'prompt', text });
    await appendEntries(dir.path, 'codex', Array.from({ length: 30 }, (_, i) => entry('bad ' + i)));
    assert.equal((await flush(dir.path, 'codex', send)).error, 'rejecting');
    writeFileSync(rejectedFile(dir.path, 'codex'), 'x'.repeat(REJECTED_CAP_BYTES) + '\n');
    const path = join(dir.path, 'spool', 'codex.cursor.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), streak_at: Date.now() - 11 * 60000 }));
    const later = await flush(dir.path, 'codex', send);
    assert.deepEqual([later.rejected, later.rejected_dropped, later.error], [0, 0, 'rejecting']);
    assert.ok((await pendingStats(dir.path, 'codex')).bytes > 0, 'still queued');
  } finally { await server.close(); dir.cleanup(); }
});
