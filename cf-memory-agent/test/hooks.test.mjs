import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BREAKER_CAP_MS, BREAKER_MS, BUDGET_MS, CONTEXT_MAX, failureLine, flushHealth, LOG_HINT, RECALL_HEADER, RECALL_MAX_CHARS, SESSION_HEADER, TOOL_FLUSH_AGE_MS, TOOL_FLUSH_ENTRIES, runHook } from '../scripts/hook.mjs';
import { doctor } from '../scripts/doctor.mjs';
import { makeEntry, sessionKey } from '../scripts/entries.mjs';
import { appendEntries, pendingStats, SPOOL_ACTION_CAP_BYTES } from '../scripts/spool.mjs';
import { McpFailure, queuedFor } from '../scripts/transport.mjs';
import { fakeServer, tempDir, testEnv, TEST_TOKEN } from './helpers/fake-server.mjs';

// Seed the same server and credential binding a real hook would record.
const queuedAt = f => queuedFor(f.env, f.home);

async function fixture(behavior, extraEnv = {}) {
  const dir = tempDir(), server = await fakeServer(behavior);
  const cwd = join(dir.path, 'work', 'demo');
  mkdirSync(cwd, { recursive: true });
  execFileSync('git', ['-C', cwd, 'init', '-q']);
  execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:example/demo.git']);
  const env = testEnv(dir.path, server.url, extraEnv);
  const home = env.CF_MEMORY_AGENT_HOME;
  const run = (client, event, payload, now) => runHook({ client, event, payload: { session_id: 'session-' + client, cwd, hook_event_name: event, ...payload }, env, ...(now ? { now } : {}) });
  const health = client => JSON.parse(readFileSync(join(home, 'health', client + '.json'), 'utf8'));
  return { dir, server, cwd, env, home, run, health, close: async () => { await server.close(); dir.cleanup(); } };
}

for (const client of ['claude-code', 'codex']) {
  test(client + ' UserPromptSubmit queues the prompt, flushes it and injects recall', async () => {
    const f = await fixture();
    try {
      const { output, entries } = await f.run(client, 'UserPromptSubmit', { prompt: 'Fix the login bug' });
      assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: RECALL_HEADER + '\n\nremembered: the fixture project uses vitest' } });
      assert.deepEqual(f.server.named('recall').map(c => c.args), [{ query: 'Fix the login bug', budget: 10000, core: false, max_chars: RECALL_MAX_CHARS, context: 'git@github.com:example/demo.git' }]);
      const sent = f.server.named('log_append').flatMap(c => c.args.entries);
      assert.deepEqual(sent.map(e => [e.client, e.kind, e.text, e.repo, e.session_id]), [[client, 'prompt', 'Fix the login bug', '//github.com/example/demo', 'session-' + client]]);
      assert.equal(sent[0].id, entries[0].id);
      assert.equal((await pendingStats(f.home, client)).bytes, 0);
      assert.equal(f.health(client).last_flush.ok, true);
    } finally { await f.close(); }
  });

  test(client + ' SessionStart injects core memory and the handoff', async () => {
    const f = await fixture();
    try {
      const { output, entries } = await f.run(client, 'SessionStart', { source: 'startup' });
      assert.equal(entries.length, 0);
      assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
      const text = output.hookSpecificOutput.additionalContext;
      assert.ok(text.startsWith(SESSION_HEADER));
      assert.match(text, /## core memory\n### persona\nThe owner prefers short answers\./);
      assert.match(text, /## 前回の続き\(同じリポジトリ \/\/github\.com\/example\/demo の別セッションの最後の返答, 2026-10-30 22:10 JST\)\nLast time we finished the spool design\./);
      assert.ok(text.endsWith(LOG_HINT));
      assert.deepEqual(f.server.named('session_context').map(c => c.args), [{ repo: '//github.com/example/demo', session_id: 'session-' + client }]);
    } finally { await f.close(); }
  });

  test(client + ' Stop queues and sends the reply; nothing is printed', async () => {
    const f = await fixture();
    try {
      const { output } = await f.run(client, 'Stop', { last_assistant_message: 'All done.', stop_hook_active: false });
      assert.equal(output, null);
      assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => [e.kind, e.text]), [['reply', 'All done.']]);
    } finally { await f.close(); }
  });
}

test('Claude PostToolUse and PostToolUseFailure only queue action and error entries; Stop sends them', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run('claude-code', 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, tool_response: { file: { content: 'body' } } })).output, null);
    assert.equal((await f.run('claude-code', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nboom' })).output, null);
    assert.equal(f.server.calls.length, 0, 'no network call from a tool hook');
    assert.equal((await pendingStats(f.home, 'claude-code', { count: true })).entries, 3);
    await f.run('claude-code', 'Stop', { last_assistant_message: 'done' });
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => [e.kind, e.text]),
      [['action', 'Read: src/a.ts'], ['action', 'Bash: npm test → 失敗'], ['error', 'Bash: npm test → 失敗\nExit code 1\nboom'], ['reply', 'done']]);
  } finally { await f.close(); }
});

test('Codex PostToolUse with a failed exit code queues action and error entries', async () => {
  const f = await fixture();
  try {
    await f.run('codex', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'cargo build' }, tool_response: { exit_code: 1, stderr: 'linker failed' }, turn_id: 't1' });
    assert.equal(f.server.calls.length, 0);
    await f.run('codex', 'UserPromptSubmit', { prompt: 'try again' });
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => [e.client, e.kind]), [['codex', 'action'], ['codex', 'error'], ['codex', 'prompt']]);
  } finally { await f.close(); }
});

for (const client of ['claude-code', 'codex']) {
  test(client + ' tool hooks flush once ' + TOOL_FLUSH_ENTRIES + ' entries are waiting', async () => {
    const f = await fixture();
    try {
      for (let i = 1; i < TOOL_FLUSH_ENTRIES; i++) await f.run(client, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/file-' + i + '.ts' } });
      assert.equal(f.server.calls.length, 0, (TOOL_FLUSH_ENTRIES - 1) + ' waiting entries stay local');
      await f.run(client, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/last.ts' } });
      const appends = f.server.named('log_append');
      assert.equal(appends.length, 1);
      assert.equal(appends[0].args.entries.length, TOOL_FLUSH_ENTRIES);
      assert.equal((await pendingStats(f.home, client)).bytes, 0);
      assert.equal(f.health(client).last_flush.ok, true);
    } finally { await f.close(); }
  });
}

test('a tool hook flushes when the oldest waiting entry is more than 5 minutes old', async () => {
  const f = await fixture();
  try {
    const start = Date.now();
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, () => start);
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }, () => start + TOOL_FLUSH_AGE_MS - 60000);
    assert.equal(f.server.calls.length, 0, 'four minutes old: still waiting');
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'date' } }, () => start + TOOL_FLUSH_AGE_MS + 1000);
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => e.text), ['Bash: ls', 'Bash: pwd', 'Bash: date']);
    assert.equal((await pendingStats(f.home, 'claude-code')).bytes, 0);
  } finally { await f.close(); }
});

test('acknowledgements recall with a small budget; CF_MEMORY_RECALL_BUDGET and config.json are honored', async () => {
  const f = await fixture();
  try {
    await f.run('claude-code', 'UserPromptSubmit', { prompt: 'ok' });
    assert.equal(f.server.named('recall')[0].args.budget, 600);
    mkdirSync(f.home, { recursive: true });
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ CF_MEMORY_RECALL_BUDGET: 2500 }));
    await f.run('claude-code', 'UserPromptSubmit', { prompt: 'what did we decide about the spool?' });
    assert.equal(f.server.named('recall')[1].args.budget, 2500);
    await runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload: { session_id: 's', cwd: f.cwd, prompt: 'again' }, env: { ...f.env, CF_MEMORY_RECALL_BUDGET: '900' } });
    assert.equal(f.server.named('recall')[2].args.budget, 900, 'environment wins over config.json');
  } finally { await f.close(); }
});

test('the injected text stays under Claude Code\'s 10,000-character hook cap, the recall text within max_chars', async () => {
  // Over 10,000 characters Claude Code shows only a 2,000-character preview and a file path.
  assert.ok(CONTEXT_MAX < 10000);
  assert.equal(RECALL_MAX_CHARS, CONTEXT_MAX - RECALL_HEADER.length - 2);
  // A server that ignores max_chars (before the 2026-11-05 deploy) is cut by the hook.
  const f = await fixture({ recallText: '# recall: x\n' + 'あ'.repeat(30000) });
  try {
    const text = (await f.run('claude-code', 'UserPromptSubmit', { prompt: 'long recall please' })).output.hookSpecificOutput.additionalContext;
    assert.ok(text.length <= CONTEXT_MAX);
    assert.ok(text.endsWith('…'));
  } finally { await f.close(); }
});

test('the session hint says how log_search orders hits and to open a hit with log_read', () => {
  assert.match(LOG_HINT, /log_search/);
  assert.match(LOG_HINT, /発言と最終回答が先/);
  assert.match(LOG_HINT, /log_read で開いて/);
  assert.match(LOG_HINT, /notes_put/);
});

test('CF_MEMORY_LOG_ENABLED=false queues and sends nothing but still recalls', async () => {
  const f = await fixture(undefined, { CF_MEMORY_LOG_ENABLED: 'false' });
  try {
    const { output, entries } = await f.run('claude-code', 'UserPromptSubmit', { prompt: 'hello there' });
    assert.equal(entries.length, 0);
    assert.ok(output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER));
    assert.equal(f.server.named('log_append').length, 0);
    assert.equal(existsSync(join(f.home, 'spool', 'claude-code.jsonl')), false);
  } finally { await f.close(); }
});

test('CF_MEMORY_RECALL_ENABLED=false injects nothing (recall and session context)', async () => {
  const f = await fixture(undefined, { CF_MEMORY_RECALL_ENABLED: '0' });
  try {
    assert.equal((await f.run('codex', 'UserPromptSubmit', { prompt: 'hello there' })).output, null);
    assert.equal((await f.run('codex', 'SessionStart', {})).output, null);
    assert.equal(f.server.named('recall').length + f.server.named('session_context').length, 0);
    assert.equal(f.server.named('log_append').length, 1, 'the prompt is still kept');
  } finally { await f.close(); }
});

test('a recall failure is visible in the context and in health', async () => {
  const f = await fixture({ failRecall: true });
  try {
    const { output } = await f.run('claude-code', 'UserPromptSubmit', { prompt: 'hello there' });
    assert.match(output.hookSpecificOutput.additionalContext, /^cf-memory 自動想起は今回失敗しました\(http_500\)/);
    const health = f.health('claude-code');
    assert.deepEqual([health.last_recall.ok, health.last_recall.code], [false, 'http_500']);
    assert.equal(health.last_flush.ok, true, 'the prompt was still delivered');
  } finally { await f.close(); }
});

test('without credentials entries stay in the spool and the failure is recorded', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env }; delete env.CF_MEMORY_ACCESS_TOKEN;
    const { output } = await runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload: { session_id: 's', cwd: f.cwd, prompt: 'keep me' }, env });
    assert.match(output.hookSpecificOutput.additionalContext, /no_credentials/);
    assert.ok((await pendingStats(f.home, 'claude-code')).bytes > 0);
    const health = f.health('claude-code');
    assert.equal(health.last_flush.error, 'no_credentials');
    assert.equal(f.server.calls.length, 0);
    // With credentials back, the next hook delivers its own bound entry.
    await f.run('claude-code', 'Stop', { last_assistant_message: 'done' });
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => e.kind), ['reply']);
    assert.equal(f.health('claude-code').last_flush.held, 1);
  } finally { await f.close(); }
});

test('after a failed flush, tool hooks stay off the network for a minute; other hooks retry', async () => {
  let failing = true;
  const f = await fixture({ failAppend: () => failing });
  try {
    // An entry left from ten minutes ago makes every tool hook due to flush.
    await appendEntries(f.home, 'claude-code', [makeEntry({ client: 'claude-code', session_id: 'old', ts: Date.now() - 10 * 60000, kind: 'action', text: 'Bash: old' })], await queuedAt(f));
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(f.server.named('log_append').length, 1);
    assert.equal(f.health('claude-code').last_flush.error, 'http_503');
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
    assert.equal(f.server.named('log_append').length, 1, 'backing off');
    const later = Date.now() + 61000;
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'whoami' } }, () => later);
    assert.equal(f.server.named('log_append').length, 2, 'retries once the minute is over');
    failing = false;
    await f.run('claude-code', 'Stop', { last_assistant_message: 'done' });
    assert.deepEqual(f.server.named('log_append').at(-1).args.entries.map(e => e.text), ['Bash: old', 'Bash: ls', 'Bash: pwd', 'Bash: whoami', 'done']);
  } finally { await f.close(); }
});

test('SessionStart reads only core_memory and handoff from session_context', async () => {
  const f = await fixture({ sessionContext: { core_memory: '', handoff: null, blocks: [{ label: 'persona', value: 'must not appear' }], core: 'must not appear', text: 'must not appear' } });
  try {
    const text = (await f.run('claude-code', 'SessionStart', {})).output.hookSpecificOutput.additionalContext;
    assert.equal(text, SESSION_HEADER + '\n\n' + LOG_HINT);
  } finally { await f.close(); }
});

test('session_context gets the session_id and repo exactly as the entries store them', async () => {
  const f = await fixture();
  try {
    const long = 'x'.repeat(300);
    const tabbed = join(f.dir.path, 'notes\tdraft');
    mkdirSync(tabbed);
    await f.run('claude-code', 'SessionStart', { session_id: long });
    await f.run('claude-code', 'SessionStart', { session_id: 'plain', cwd: tabbed });
    const { entries } = await f.run('claude-code', 'UserPromptSubmit', { session_id: long, prompt: 'hello' });
    const local = (await f.run('claude-code', 'UserPromptSubmit', { session_id: 'plain', cwd: tabbed, prompt: 'hello' })).entries[0].repo;
    assert.match(local, /^notes draft#[0-9a-f]{32}$/, 'no remote: the directory name and a hash of its path');
    assert.deepEqual(f.server.named('session_context').map(c => c.args), [{ repo: '//github.com/example/demo', session_id: sessionKey(long) }, { repo: local, session_id: 'plain' }]);
    assert.equal(entries[0].session_id, sessionKey(long));
    assert.equal(sessionKey(long).length, 64);
  } finally { await f.close(); }
});

test('the daily total cap and clamped timestamps are recorded in last_flush and are not errors', async () => {
  const f = await fixture({ droppedOverTotalCap: 1 });
  try {
    await f.run('codex', 'Stop', { last_assistant_message: 'done', timestamp: Date.now() });
    const health = f.health('codex');
    assert.equal(health.last_flush.ok, true);
    assert.deepEqual([health.last_flush.dropped_over_total_cap, health.last_flush.ts_clamped, health.last_flush.error], [1, 0, undefined]);
    assert.equal(health.last_error, undefined);
  } finally { await f.close(); }
});

test('a SessionStart flush delivers what tool hooks left waiting', async () => {
  const f = await fixture();
  try {
    await f.run('codex', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await f.run('codex', 'SessionStart', {});
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => e.text), ['Bash: ls']);
  } finally { await f.close(); }
});

test('SessionStart reports an undelivered backlog after failed flushes', async () => {
  const f = await fixture({ failAppend: () => true });
  try {
    await f.run('claude-code', 'Stop', { last_assistant_message: 'done' });
    const { output } = await f.run('claude-code', 'SessionStart', {});
    assert.match(output.hookSpecificOutput.additionalContext, /未送信のログが約 \d+ KB ある\(最後のエラー: http_503\)/);
  } finally { await f.close(); }
});

test('the health file carries no prompt text and no token', async () => {
  const f = await fixture();
  try {
    await f.run('claude-code', 'UserPromptSubmit', { prompt: 'a very particular prompt sentence' });
    const raw = readFileSync(join(f.home, 'health', 'claude-code.json'), 'utf8');
    assert.ok(!raw.includes('particular prompt'));
    assert.ok(!raw.includes(TEST_TOKEN));
  } finally { await f.close(); }
});

test('runHook never throws on bad input or a broken home', async () => {
  const f = await fixture();
  try {
    for (const payload of [null, 'text', [], { hook_event_name: 'UserPromptSubmit', prompt: { nested: true } }]) {
      const result = await runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload, env: f.env });
      assert.ok(result && 'output' in result);
    }
    assert.equal((await runHook({ client: 'codex', event: 'Interrupt', payload: {}, env: f.env })).output, null);
    const file = join(f.dir.path, 'not-a-directory');
    writeFileSync(file, 'x');
    const broken = await runHook({ client: 'claude-code', event: 'PostToolUse', payload: { session_id: 's', cwd: f.cwd, tool_name: 'Bash', tool_input: { command: 'ls' } }, env: { ...f.env, CF_MEMORY_AGENT_HOME: file } });
    assert.equal(broken.output, null);
    const child = await runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload: { prompt: 'x' }, env: { ...f.env, CF_MEMORY_AGENT_CHILD: '1' } });
    assert.deepEqual(child, { output: null, entries: [] });
  } finally { await f.close(); }
});

test('a backlog flush stops at its share of the prompt budget, counts as progress, and recall still answers', async () => {
  const f = await fixture({ delay: name => name === 'log_append' ? 400 : 0 });
  try {
    const { appendEntries } = await import('../scripts/spool.mjs');
    const { makeEntry } = await import('../scripts/entries.mjs');
    await appendEntries(f.home, 'claude-code', Array.from({ length: 600 }, (_, i) => makeEntry({ client: 'claude-code', session_id: 'old', ts: 1790000000000 + i, kind: 'action', text: 'Bash: echo ' + i })), await queuedAt(f));
    const started = performance.now();
    const { output } = await f.run('claude-code', 'UserPromptSubmit', { prompt: 'continue the work' });
    const ms = performance.now() - started;
    assert.ok(ms < 4000, 'returned after ' + Math.round(ms) + ' ms');
    assert.ok(output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER));
    const health = f.health('claude-code');
    assert.equal(health.last_flush.ok, true);
    assert.equal(health.last_flush.partial, true);
    assert.ok(health.last_flush.sent >= 50 && health.last_flush.sent < 601);
    assert.ok((await pendingStats(f.home, 'claude-code')).bytes > 0, 'the rest waits for the next hook');
  } finally { await f.close(); }
});

// ---- Round 2 ----

test('after a call times out, every call waits at most 1.5 s for 5 minutes; an answer closes the breaker', async () => {
  const behavior = { hang: () => true };
  const f = await fixture(behavior);
  try {
    const prompt = (text, started) => runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload: { session_id: 's', cwd: f.cwd, hook_event_name: 'UserPromptSubmit', prompt: text }, env: f.env, ...(started ? { started } : {}) });
    const before = Date.now();
    await prompt('first', performance.now() - (BUDGET_MS.UserPromptSubmit - 1000)); // runs out of time after ~1 s
    const opened = f.health('claude-code');
    assert.equal(opened.last_recall.code, 'timeout');
    assert.ok(opened.slow_until >= before + BREAKER_MS && opened.slow_until <= Date.now() + BREAKER_MS);
    let started = performance.now();
    const { output } = await prompt('second');
    const ms = performance.now() - started;
    assert.ok(ms >= BREAKER_CAP_MS - 200 && ms < BREAKER_CAP_MS + 1000, 'capped: ' + Math.round(ms) + ' ms');
    assert.equal(output.hookSpecificOutput.additionalContext, failureLine('自動想起', 'timeout'));
    started = performance.now();
    await runHook({ client: 'claude-code', event: 'SessionStart', payload: { session_id: 's2', cwd: f.cwd, hook_event_name: 'SessionStart' }, env: f.env });
    assert.ok(performance.now() - started < BREAKER_CAP_MS + 1000, 'session start is capped too');
    behavior.hang = () => false;
    assert.ok((await prompt('third')).output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER));
    assert.equal(f.health('claude-code').slow_until, 0, 'closed');
  } finally { await f.close(); }
});

test('a SessionStart whose session_context fails says so, like recall', async () => {
  const f = await fixture();
  try {
    const fetcher = async () => { throw new TypeError('fetch failed'); };
    const { output } = await runHook({ client: 'codex', event: 'SessionStart', payload: { session_id: 's', cwd: f.cwd, hook_event_name: 'SessionStart' }, env: f.env, fetcher });
    assert.equal(output.hookSpecificOutput.additionalContext, failureLine('セッション開始コンテキスト', 'network'));
    assert.equal(f.health('codex').last_session_context.code, 'network');
  } finally { await f.close(); }
});

test('a server that refuses everything: the flush fails, every hook backs off, and doctor warns', async () => {
  const f = await fixture({ rejectEntry: () => true });
  try {
    await appendEntries(f.home, 'claude-code', Array.from({ length: 24 }, (_, i) => makeEntry({ client: 'claude-code', session_id: 'old', ts: 1790000000000 + i, kind: 'action', text: 'Bash: echo ' + i })), await queuedAt(f));
    await f.run('claude-code', 'Stop', { last_assistant_message: 'done' });
    const health = f.health('claude-code');
    assert.deepEqual([health.last_flush.ok, health.last_flush.error, health.last_flush.rejected], [false, 'rejecting', 20]);
    const calls = f.server.named('log_append').length;
    await f.run('claude-code', 'UserPromptSubmit', { prompt: 'next' });
    await f.run('claude-code', 'Stop', { last_assistant_message: 'again' });
    assert.equal(f.server.named('log_append').length, calls, 'no hook sends for a minute after `rejecting`');
    assert.equal((await pendingStats(f.home, 'claude-code', { count: true })).entries, 7, 'nothing more was diverted');
    const report = await doctor({ env: f.env, versions: false });
    assert.equal(report.ok, false);
    assert.equal(report.clients['claude-code'].spool.rejected_entries, 20);
    assert.ok(report.warnings.some(w => w.includes('refused 20') && w.includes('replay-rejected')), JSON.stringify(report.warnings));
    assert.ok(report.warnings.some(w => w.includes('(rejecting)') && w.includes('server and the Agent versions match')), 'doctor explains `rejecting`');
    assert.ok(report.warnings.some(w => w.includes('once the server accepts entries again') && w.includes('replay-rejected')), 'replay comes after the fix');
  } finally { await f.close(); }
});

// ---- Round 3 ----

const writeHealth = (f, value) => { mkdirSync(join(f.home, 'health'), { recursive: true }); writeFileSync(join(f.home, 'health', 'claude-code.json'), JSON.stringify(value)); };
const promptAt = (f, text, { now, started } = {}) => runHook({ client: 'claude-code', event: 'UserPromptSubmit', payload: { session_id: 's', cwd: f.cwd, hook_event_name: 'UserPromptSubmit', prompt: text }, env: f.env, ...(now ? { now: () => now } : {}), ...(started ? { started } : {}) });

test('the breaker: a timeout at the reduced 1.5 s cap does not re-arm it; past half the window one call probes at the normal cap and an answer closes it (review r6)', async () => {
  const f = await fixture({ delay: () => 1800 }); // answers well inside the normal cap, never inside 1.5 s
  try {
    const armed = Date.now() + BREAKER_MS;
    writeHealth(f, { slow_until: armed });
    let started = performance.now();
    const first = await promptAt(f, 'first');
    assert.ok(performance.now() - started < BREAKER_CAP_MS + 1000, 'reduced cap');
    assert.equal(first.output.hookSpecificOutput.additionalContext, failureLine('自動想起', 'timeout'));
    assert.equal(f.health('claude-code').slow_until, armed, 'a reduced-cap timeout does not re-arm');
    const second = await promptAt(f, 'second', { now: armed - BREAKER_MS / 2 + 1000 });
    assert.ok(second.output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER), 'the probe recall waited for the answer');
    assert.equal(f.health('claude-code').slow_until, 0, 'closed');
    await f.run('claude-code', 'Stop', { last_assistant_message: 'reply' });
    assert.equal(f.health('claude-code').last_flush.ok, true);
    assert.deepEqual([...f.server.stored.values()].map(e => e.text).sort(), ['first', 'reply', 'second']);
    // A Stop hook probes with its flush.
    writeHealth(f, { slow_until: Date.now() + 60000 });
    started = performance.now();
    await f.run('claude-code', 'Stop', { last_assistant_message: 'reply 2' });
    assert.ok(performance.now() - started > BREAKER_CAP_MS, 'the flush got its normal budget');
    assert.equal(f.health('claude-code').slow_until, 0);
    assert.ok([...f.server.stored.values()].some(e => e.text === 'reply 2'));
  } finally { await f.close(); }
});

test('one probe per breaker window: once taken, calls keep the reduced cap; a probe that times out at its normal cap re-arms', async () => {
  const f = await fixture({ hang: () => true });
  try {
    const slow = Date.now() + 60000; // past half the window
    writeHealth(f, { slow_until: slow, slow_probe: slow });
    let started = performance.now();
    await promptAt(f, 'probe already taken');
    assert.ok(performance.now() - started < BREAKER_CAP_MS + 1000, 'reduced cap');
    assert.equal(f.health('claude-code').slow_until, slow, 'not re-armed');
    writeHealth(f, { slow_until: slow });
    const before = Date.now();
    started = performance.now();
    await promptAt(f, 'probe', { started: performance.now() - (BUDGET_MS.UserPromptSubmit - 2500) }); // 2.5 s left: the probe's normal cap
    assert.ok(performance.now() - started > BREAKER_CAP_MS + 500, 'the probe waited past the reduced cap');
    const health = f.health('claude-code');
    assert.ok(health.slow_until >= before + BREAKER_MS, 're-armed by a timeout at the normal cap');
    assert.equal(health.slow_probe, undefined, 'the new window has its own probe');
    assert.equal(health.last_flush_skipped.reason, 'budget', 'no flush time was left: skipped, not failed');
  } finally { await f.close(); }
});

test('flushHealth (hooks and agent.mjs flush): the deadline before the first send is no flush; after an answer it is progress', () => {
  assert.deepEqual(flushHealth({ sent: 0, rejected: 0, error: 'budget' }, 5), { last_flush_skipped: { at: 5, reason: 'budget' } });
  const partial = flushHealth({ sent: 50, rejected: 0, error: new McpFailure('timeout', 'log_append') }, 5);
  assert.deepEqual([partial.last_flush.ok, partial.last_flush.partial, partial.last_flush_ok_at, partial.last_flush_error_at, partial.last_error], [true, true, 5, undefined, undefined]);
  const refused = flushHealth({ sent: 0, rejected: 1, error: 'timeout' }, 5);
  assert.deepEqual([refused.last_flush.ok, refused.last_flush.partial], [true, true]);
  const failed = flushHealth({ sent: 0, rejected: 0, error: new McpFailure('timeout', 'log_append') }, 5);
  assert.deepEqual([failed.last_flush.ok, failed.last_flush.error, failed.last_flush_error_at, failed.last_error.code], [false, 'timeout', 5, 'timeout']);
});

// Fake macOS Keychain (an expired cf-memory entry) and a `claude mcp get` running `script`.
function refreshFixture(f, script) {
  const bin = join(f.dir.path, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'security'), `#!/bin/sh\nnow=$(($(date +%s)*1000))\nprintf '{"mcpOAuth":{"cf-memory|x":{"serverUrl":"${f.env.CF_MEMORY_MCP_URL}","accessToken":"${TEST_TOKEN}","refreshToken":"r","expiresAt":%s}}}' $((now-1000))\n`);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n' + script + '\n');
  chmodSync(join(bin, 'security'), 0o755); chmodSync(join(bin, 'claude'), 0o755);
  rmSync(join(f.home, 'health', 'oauth-refresh.json'), { force: true }); // no 10-minute pause
  const env = { ...f.env, CF_MEMORY_KEYCHAIN: 'on', CF_MEMORY_CLAUDE_BIN: join(bin, 'claude') };
  delete env.CF_MEMORY_ACCESS_TOKEN;
  return { bin, env };
}

test('a Stop-hook OAuth refresh that uses up the flush budget skips the flush: no server call, no breaker, no error (review r3)', { skip: process.platform !== 'darwin' && 'the Keychain path runs on macOS only' }, async () => {
  const f = await fixture(), path = process.env.PATH;
  try {
    const stop = (env, left) => runHook({ client: 'claude-code', event: 'Stop', payload: { session_id: 's', cwd: f.cwd, hook_event_name: 'Stop', last_assistant_message: 'a reply' }, env, started: performance.now() - (BUDGET_MS.Stop - left) });
    let fake = refreshFixture(f, 'sleep 1.8');
    process.env.PATH = fake.bin + ':' + path; // `security` is looked up on PATH
    await stop(fake.env, 3000); // the 1.8 s refresh leaves less than FLUSH_MIN_MS of the flush's share
    let health = f.health('claude-code');
    assert.equal(f.server.calls.length, 0);
    assert.deepEqual([health.last_flush, health.slow_until, health.last_error, health.last_flush_skipped?.reason], [undefined, undefined, undefined, 'budget']);
    assert.ok((await pendingStats(f.home, 'claude-code')).bytes > 0, 'the reply waits for the next hook');
    // A refresh that outlasts the hook (it ignores the kill): out of time, never `no_credentials`.
    fake = refreshFixture(f, "trap '' TERM\nsleep 3");
    await stop(fake.env, 2500);
    health = f.health('claude-code');
    assert.equal(f.server.calls.length, 0);
    assert.deepEqual([health.last_flush, health.slow_until, health.last_error, health.last_flush_skipped?.reason], [undefined, undefined, undefined, 'budget']);
    // With time to spare, the refreshed token is used and the backlog goes.
    await stop(refreshFixture(f, 'sleep 0.2').env, BUDGET_MS.Stop);
    assert.deepEqual(f.server.named('log_append').flatMap(c => c.args.entries).map(e => e.text), ['a reply', 'a reply', 'a reply']);
    assert.equal(f.health('claude-code').last_flush.ok, true);
    assert.equal((await pendingStats(f.home, 'claude-code')).bytes, 0);
  } finally { process.env.PATH = path; await f.close(); }
});

test('action entries dropped over the spool cap are counted, and doctor warns', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.home, 'spool'), { recursive: true });
    const live = join(f.home, 'spool', 'claude-code.jsonl');
    writeFileSync(live, ''); truncateSync(live, SPOOL_ACTION_CAP_BYTES + 1);
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await f.run('claude-code', 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
    const health = f.health('claude-code');
    assert.equal(health.spool_dropped_total, 2);
    const report = await doctor({ env: { ...f.env, CLAUDE_CONFIG_DIR: join(f.dir.path, '.claude'), CODEX_HOME: join(f.dir.path, '.codex') }, versions: false });
    assert.equal(report.clients['claude-code'].spool.dropped_entries, 2);
    assert.equal(report.clients['claude-code'].spool.last_dropped, new Date(health.spool_dropped_at).toISOString());
    assert.ok(report.warnings.some(w => w.startsWith('claude-code: the spool passed 64 MB') && w.includes('2 action entries were dropped')), JSON.stringify(report.warnings));
  } finally { await f.close(); }
});

test('a slow log_append in a prompt hook does not arm the breaker, and an answer in the same hook wins (review 4)', async () => {
  const f = await fixture({ delay: name => name === 'log_append' ? 3000 : 200 });
  try {
    const first = await promptAt(f, 'first');
    assert.ok(first.output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER), 'recall answered');
    assert.ok(!(f.health('claude-code').slow_until > Date.now()), 'not armed by the 2.5 s flush share');
    const second = await promptAt(f, 'second');
    assert.ok(second.output.hookSpecificOutput.additionalContext.startsWith(RECALL_HEADER), 'the next recall gets its normal cap');
  } finally { await f.close(); }
});
