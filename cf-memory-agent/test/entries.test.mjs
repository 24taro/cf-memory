import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { hookInput, OVERSIZED_OUTPUT } from '../scripts/bounded.mjs';
import {
  actionLine, buildEntries, claudeHook, codexFailure, codexHook, entryId, errorText, eventTime, isSkippedTool,
  LIMITS, makeEntry, TRUNCATED, FAILED, OVERSIZED_INPUT, validEntry, clip, repoKey, sensitiveInput, sessionKey,
} from '../scripts/entries.mjs';
import { serverRejects } from './helpers/fake-server.mjs';
// Time limits are for a fast laptop; a slower machine sets CF_MEMORY_TEST_TIME_SCALE (CI uses 10).
const SLOW = Number(process.env.CF_MEMORY_TEST_TIME_SCALE) || 1;

const TS = 1790000000000;
const claude = payload => buildEntries({ client: 'claude-code', event: payload.hook_event_name, hook: claudeHook(payload), repo: 'example/demo', ts: TS });
const codex = payload => buildEntries({ client: 'codex', event: payload.hook_event_name, hook: codexHook(payload), repo: 'example/demo', ts: TS });
const base = { session_id: 'session-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/work' };

test('Claude UserPromptSubmit queues the prompt', () => {
  const [entry, ...rest] = claude({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug please' });
  assert.equal(rest.length, 0);
  assert.deepEqual({ kind: entry.kind, text: entry.text, client: entry.client, session_id: entry.session_id, repo: entry.repo, ts: entry.ts },
    { kind: 'prompt', text: 'Fix the login bug please', client: 'claude-code', session_id: 'session-1', repo: 'example/demo', ts: TS });
  assert.ok(validEntry(entry));
});

test('Claude Stop queues last_assistant_message as the reply', () => {
  const entries = claude({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done. All tests pass.' });
  assert.deepEqual(entries.map(e => [e.kind, e.text]), [['reply', 'Done. All tests pass.']]);
  assert.deepEqual(claude({ ...base, hook_event_name: 'Stop' }), [], 'no message, no entry');
});

test('Claude SessionStart queues nothing', () => {
  assert.deepEqual(claude({ ...base, hook_event_name: 'SessionStart', source: 'startup' }), []);
});

test('Claude PostToolUse queues one action line; tool output is not stored', () => {
  const entries = claude({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test', description: 'Run tests' }, tool_response: { stdout: 'private output body', stderr: '' } });
  assert.deepEqual(entries.map(e => [e.kind, e.text]), [['action', 'Bash: npm test']]);
  assert.ok(!JSON.stringify(entries).includes('private output body'));
});

test('Claude PostToolUseFailure queues a failed action line and an error entry', () => {
  const entries = claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nFAIL src/a.test.ts', is_interrupt: false });
  assert.deepEqual(entries.map(e => e.kind), ['action', 'error']);
  assert.equal(entries[0].text, 'Bash: npm test' + FAILED);
  assert.equal(entries[1].text, 'Bash: npm test → 失敗\nExit code 1\nFAIL src/a.test.ts');
});

test('Claude PostToolUseFailure falls back to tool_response and marks interrupts', () => {
  assert.match(claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_response: 'File does not exist.' })[1].text, /File does not exist\.$/);
  assert.match(claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'sleep 99' }, is_interrupt: true })[1].text, /\ninterrupted$/);
});

test('Codex UserPromptSubmit and Stop map prompt and last_assistant_message', () => {
  const codexBase = { ...base, turn_id: 'turn-1', model: 'gpt-x' };
  assert.deepEqual(codex({ ...codexBase, hook_event_name: 'UserPromptSubmit', prompt: 'Add a CLI flag' }).map(e => [e.client, e.kind, e.text]), [['codex', 'prompt', 'Add a CLI flag']]);
  assert.deepEqual(codex({ ...codexBase, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Added --verbose.' }).map(e => [e.kind, e.text]), [['reply', 'Added --verbose.']]);
  assert.deepEqual(codex({ ...codexBase, hook_event_name: 'SessionStart', source: 'startup' }), []);
});

test('Codex PostToolUse: success, exit-code failure, text failure and MCP isError', () => {
  const ok = codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cargo test' }, tool_response: { exit_code: 0, stdout: 'ok', stderr: '' } });
  assert.deepEqual(ok.map(e => [e.kind, e.text]), [['action', 'Bash: cargo test']]);
  const failed = codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cargo test' }, tool_response: { exit_code: 101, stdout: '', stderr: 'error[E0425]: cannot find value' } });
  assert.deepEqual(failed.map(e => e.kind), ['action', 'error']);
  assert.equal(failed[0].text, 'Bash: cargo test → 失敗');
  assert.equal(failed[1].text, 'Bash: cargo test → 失敗\nExit code 101\nerror[E0425]: cannot find value');
  const text = codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: 'Exit code: 2\nWall time: 0.1 seconds\nOutput:\nmake: *** No rule' });
  assert.deepEqual(text.map(e => e.kind), ['action', 'error']);
  const mcp = codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__docs__search', tool_input: { query: 'hooks' }, tool_response: { isError: true, content: [{ type: 'text', text: 'search backend unavailable' }] } });
  assert.equal(mcp[0].text, 'mcp__docs__search: hooks → 失敗');
  assert.match(mcp[1].text, /search backend unavailable/);
  assert.equal(codexFailure('Exit code: 0\nOutput:\nfine'), null);
  assert.equal(codexFailure({ stdout: 'fine' }), null);
});

test('Codex apply_patch shows the patched files; command arrays are unwrapped', () => {
  const patch = '*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-a\n+b\n*** Add File: src/new.rs\n+x\n*** End Patch';
  assert.equal(codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success' })[0].text, 'apply_patch: src/lib.rs, src/new.rs');
  assert.equal(actionLine('Bash', { command: ['bash', '-lc', 'git status --short'] }), 'Bash: git status --short');
  assert.equal(actionLine('shell', { command: ['ls', '-la'] }), 'shell: ls -la');
});

test('action line picks command | file_path | path | url | query | pattern | description', () => {
  assert.equal(actionLine('Read', { file_path: 'src/app.ts', limit: 20 }), 'Read: src/app.ts');
  assert.equal(actionLine('Write', { file_path: 'notes.md', content: 'secret body text' }), 'Write: notes.md');
  assert.equal(actionLine('LS', { path: 'src' }), 'LS: src');
  assert.equal(actionLine('WebFetch', { url: 'https://example.com/docs', prompt: 'summarize' }), 'WebFetch: https://example.com/docs');
  assert.equal(actionLine('WebSearch', { query: 'node test runner' }), 'WebSearch: node test runner');
  assert.equal(actionLine('Glob', { pattern: '**/*.mjs' }), 'Glob: **/*.mjs');
  assert.equal(actionLine('Grep', { pattern: 'TODO', path: 'src', output_mode: 'content' }), 'Grep: TODO (src)');
  assert.equal(actionLine('Custom', { description: 'Build the docs' }), 'Custom: Build the docs');
  assert.equal(actionLine('mcp__cf-memory__notes_put', { slug: 'x', body_md: 'long body' }), 'mcp__cf-memory__notes_put');
  assert.equal(actionLine('NotebookEdit', { notebook_path: 'a.ipynb' }), 'NotebookEdit: a.ipynb');
});

test('action line is one line, at most 400 chars, and failure suffix survives the cut', () => {
  const long = 'echo ' + 'x'.repeat(1000) + '\n  && echo done';
  const line = actionLine('Bash', { command: long });
  assert.ok(line.length <= LIMITS.action);
  assert.ok(!/[\r\n]/.test(line));
  assert.ok(line.endsWith(TRUNCATED), 'the contract marker');
  const failed = actionLine('Bash', { command: long }, true);
  assert.ok(failed.length <= LIMITS.action);
  assert.ok(failed.endsWith(' → 失敗'));
  assert.equal(actionLine('Bash', { command: 'git  status\n--short' }), 'Bash: git status --short');
});

test('agent-to-agent and wait/clock tools are skipped', () => {
  for (const name of ['send_message', 'followup_task', 'list_agents', 'spawn_agent', 'wait_agent', 'interrupt_agent', 'close_agent', 'sleep', 'curr_time', 'SendMessage', 'Agent', 'Task', 'ScheduleWakeup', 'Monitor', 'TaskOutput', 'collab__spawn_agent']) {
    assert.equal(isSkippedTool(name), true, name);
    assert.deepEqual(codex({ ...base, hook_event_name: 'PostToolUse', tool_name: name, tool_input: { message: 'hi' } }), [], name);
  }
  for (const name of ['Bash', 'Read', 'apply_patch', 'TaskCreate', 'mcp__cf-memory__recall', 'TodoWrite']) assert.equal(isSkippedTool(name), false, name);
});

test('error entry is the action line plus the head of the output, 2,048 chars in all', () => {
  const line = 'Bash: npm test' + FAILED;
  const text = errorText(line, 'E'.repeat(5000));
  assert.equal(text.length, LIMITS.error);
  assert.ok(text.startsWith(line + '\nEEEE'));
  assert.ok(text.endsWith(TRUNCATED));
  assert.equal(errorText(line, ''), line);
  assert.equal(errorText(line, { stderr: 'boom' }), line + '\n{"stderr":"boom"}');
});

test('entry id is sha256 over client, session id, ts, kind and text', () => {
  const entry = makeEntry({ client: 'codex', session_id: 's-1', repo: 'a/b', ts: TS, kind: 'prompt', text: 'hello' });
  const expected = createHash('sha256').update(JSON.stringify(['codex', 's-1', TS, 'prompt', 'hello'])).digest('hex');
  assert.equal(entry.id, expected);
  assert.equal(entryId(entry), expected);
  assert.match(entry.id, /^[0-9a-f]{64}$/);
  assert.equal(makeEntry({ client: 'codex', session_id: 's-1', repo: 'other/repo', ts: TS, kind: 'prompt', text: 'hello' }).id, expected, 'repo is not part of the id');
  assert.notEqual(makeEntry({ client: 'codex', session_id: 's-1', ts: TS + 1, kind: 'prompt', text: 'hello' }).id, expected);
  assert.notEqual(makeEntry({ client: 'codex', session_id: 's-1', ts: TS, kind: 'reply', text: 'hello' }).id, expected);
  assert.notEqual(makeEntry({ client: 'claude-code', session_id: 's-1', ts: TS, kind: 'prompt', text: 'hello' }).id, expected);
});

test('long session ids are hashed to fit 128 chars; missing ones get a placeholder', () => {
  assert.equal(sessionKey('x'.repeat(300)).length, 64);
  assert.equal(sessionKey(undefined), 'unknown-session');
  assert.equal(sessionKey(' abc '), 'abc');
});

test('prompt and reply are cut at 65,536 chars with the server marker', () => {
  const [entry] = claude({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'a'.repeat(70000) });
  assert.equal(entry.text.length, LIMITS.prompt);
  assert.ok(entry.text.endsWith(TRUNCATED));
  assert.equal(clip('😀😀😀', 4, '…').length <= 4, true);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(clip('a😀😀😀', 3, '…')));
});

test('entries are scrubbed: structured secrets, prose secrets and home paths', () => {
  const prompt = claude({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'DBのパスワードはFake1234です。key sk-ant-' + 'A'.repeat(30) + ' in /Users/someone/project' })[0].text;
  assert.ok(!prompt.includes('Fake1234'));
  assert.ok(!prompt.includes('AAAAAAAAAAAAAAAAAAAA'));
  assert.ok(prompt.includes('~/project'));
  const action = claude({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer fixtureBearerValue123" https://x.test' } })[0].text;
  assert.ok(!action.includes('fixtureBearerValue123'));
  const error = claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'login' }, error: 'password is fixturepw99 rejected' })[1].text;
  assert.ok(!error.includes('fixturepw99'));
});

test('a secret straddling the cut is scrubbed before cutting', () => {
  const secret = 'ghp_' + 'B'.repeat(36);
  const prompt = 'x'.repeat(LIMITS.prompt - 20) + ' ' + secret;
  const [entry] = claude({ ...base, hook_event_name: 'UserPromptSubmit', prompt });
  assert.ok(!entry.text.includes('ghp_BBBB'));
});

test('event time uses a plausible payload timestamp, else now', () => {
  assert.equal(eventTime({}, TS), TS);
  assert.equal(eventTime({ timestamp: TS - 5000 }, TS), TS - 5000);
  assert.equal(eventTime({ timestamp: (TS - 5000) / 1000 }, TS), TS - 5000);
  assert.equal(eventTime({ timestamp: new Date(TS - 1000).toISOString() }, TS), TS - 1000);
  assert.equal(eventTime({ timestamp: TS + 3600000 }, TS), TS, 'future is clamped to now');
  assert.equal(eventTime({ timestamp: 'garbage' }, TS), TS);
});

test('validEntry accepts exactly what the server accepts', () => {
  const good = makeEntry({ client: 'codex', session_id: 's', ts: TS, kind: 'action', text: 'Bash: ls' });
  const { repo, ...noRepo } = good;
  const accepted = [good, noRepo, { ...good, ts: 0 }, { ...good, ts: TS + 30 * 86400000 }, { ...good, text: 'tab\there\u0000' }, { ...good, repo: '' }, { ...good, session_id: 'x'.repeat(128) }];
  const refused = [{ ...good, id: 'xyz' }, { ...good, id: good.id.toUpperCase() }, { ...good, client: 'other' }, { ...good, kind: 'note' }, { ...good, ts: NaN }, { ...good, ts: -1 }, { ...good, ts: String(TS) },
    { ...good, session_id: '' }, { ...good, session_id: '   ' }, { ...good, session_id: 'x'.repeat(129) }, { ...good, session_id: 'a\tb' }, { ...good, repo: 'r'.repeat(201) }, { ...good, repo: 'notes\tdraft' },
    { ...good, repo: 'x\u007f' }, { ...good, repo: null }, { ...good, text: 1 }, null, [good]];
  for (const entry of accepted) assert.deepEqual([validEntry(entry), serverRejects(entry)], [true, false], JSON.stringify(entry));
  for (const entry of refused) assert.deepEqual([validEntry(entry), serverRejects(entry)], [false, true], JSON.stringify(entry));
});

test('control characters in repo and session_id never reach an entry or session_context', () => {
  const [entry] = buildEntries({ client: 'codex', event: 'PostToolUse', hook: { session_id: 'abc\n', tool_name: 'Bash', tool_input: { command: 'make' } }, repo: 'notes\tdraft\u0000x', ts: TS });
  assert.equal(entry.repo, 'notes draft x');
  assert.equal(entry.session_id, 'abc', 'trailing whitespace is trimmed, as before');
  const [odd] = buildEntries({ client: 'codex', event: 'UserPromptSubmit', hook: { session_id: 'a\u0001b', prompt: 'hi' }, repo: 'x', ts: TS });
  assert.match(odd.session_id, /^[0-9a-f]{64}$/, 'an inner control character: hashed, so ids stay distinct');
  assert.equal(odd.session_id, sessionKey('a\u0001b'));
  assert.ok(validEntry(entry) && validEntry(odd) && !serverRejects(entry) && !serverRejects(odd));
  assert.equal(repoKey('r'.repeat(199) + '😀').length, 199, 'never cuts a surrogate pair');
});

// ---- Credential reads keep only the action line ----

test('a failed tool call that touches a deny path or reads credentials keeps only its action line', () => {
  const env = claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'diff .env .env.example' },
    error: 'Exit code 1\n3,5c3,5\n< SMTP_PASS=Hunter2xyz\n< SENDGRID_KEY=SG.FAKEfake.FAKEfake\n---\n> SMTP_PASS=\n' });
  assert.deepEqual(env.map(e => [e.kind, e.text]), [['action', 'Bash: diff .env .env.example' + FAILED]]);
  const netrc = codex({ ...base, hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_input: { command: ['bash', '-lc', 'cat ~/.netrc; exit 2'] }, tool_response: { exit_code: 2, stdout: 'machine api.example.com login me password Hunter2xyz\n' } });
  assert.deepEqual(netrc.map(e => [e.kind, e.text]), [['action', 'exec_command: cat ~/.netrc; exit …' + FAILED]]);
  const pem = claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_input: { file_path: '/srv/tls/server.pem' }, error: '-----BEGIN CERTIFICATE----- body' });
  assert.deepEqual(pem.map(e => e.kind), ['action']);
  for (const text of JSON.stringify([env, netrc, pem]).match(/Hunter2xyz|SG\.FAKE|BEGIN/g) ?? []) assert.fail('kept: ' + text);
  const ordinary = claude({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nFAIL' });
  assert.deepEqual(ordinary.map(e => e.kind), ['action', 'error'], 'other failures keep their output head');
});

test('sensitiveInput: deny paths in any path/command field (arrays and patches too) and credential printers', () => {
  const yes = [{ command: 'cat .env' }, { command: 'diff .env .env.example' }, { command: ['bash', '-lc', 'cat ~/.netrc; exit 2'] }, { command: ['cat', 'secrets.yaml'] },
    { file_path: '/x/certs/server.pem' }, { file_path: 'C:\\keys\\deploy.key' }, { file_path: '/x/.aws/credentials' }, { command: 'docker run --env-file=.env app' },
    { command: 'source .env&&npm start' }, { command: 'echo $(cat secrets.json)' }, { paths: ['a.txt', '~/.ssh/id_ed25519'] }, { path: '.git-credentials' },
    { file_path: '/Users/me/.docker/config.json' }, { command: 'gcloud auth print-access-token' }, { command: 'env | grep TOKEN' }, { command: 'printenv' },
    { command: 'security find-generic-password -s x -w' }, { command: 'gh auth token' }, { command: 'kubectl get secret db -o yaml' }, { command: 'echo url=https://x | git credential fill' },
    '*** Begin Patch\n*** Update File: config/.env.local\n@@', { input: '*** Begin Patch\n*** Add File: .npmrc\n' }];
  const no = [{ command: 'npm test' }, { command: 'cat .environment.md' }, { file_path: 'src/env.ts' }, { command: 'env FOO=1 node x.js' }, { command: '/usr/bin/env node x' },
    { file_path: '~/.ssh/id_rsa.pub' }, { command: 'grep -r monkey src' }, { query: 'how to read .env' }, { file_path: 'src/my-credentials-form.tsx' }, null, 'plain text'];
  for (const input of yes) assert.equal(sensitiveInput(input), true, JSON.stringify(input));
  for (const input of no) assert.equal(sensitiveInput(input), false, JSON.stringify(input));
  const line = 'const value = computeSomething(alpha, beta) + otherThing;\n';
  const started = performance.now();
  assert.equal(sensitiveInput({ command: "cat > out.js <<'EOF'\n" + line.repeat(20000) + 'EOF\ncat .env' }), true);
  assert.ok(performance.now() - started < 300 * SLOW, 'one linear scan of a 1 MB command');
});

// ---- Oversized hook payloads (over 4 MB) ----

const oversized = payload => hookInput(Readable.from([Buffer.from(JSON.stringify(payload))]));

test('an oversized Codex payload keeps the command and the exit code, never the output', async () => {
  const payload = { session_id: 's1', hook_event_name: 'PostToolUse', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_response: { exit_code: 2, stdout: 'x'.repeat(4200000), stderr: 'error TS2345' }, tool_use_id: 't' };
  const parsed = await oversized(payload);
  assert.equal(parsed.cf_memory_oversized, true);
  assert.deepEqual(parsed.tool_input, { command: 'npm run build' });
  const entries = codex(parsed);
  assert.deepEqual(entries.map(e => [e.kind, e.text]), [['action', 'Bash: npm run build' + FAILED], ['error', 'Bash: npm run build' + FAILED + '\nExit code 2\n' + OVERSIZED_OUTPUT]]);
  assert.ok(!JSON.stringify(entries).includes('xxxx'));
  const ok = codex(await oversized({ ...payload, tool_response: { exit_code: 0, stdout: 'x'.repeat(4200000) } }));
  assert.deepEqual(ok.map(e => [e.kind, e.text]), [['action', 'Bash: npm run build']]);
  const text = codex(await oversized({ ...payload, tool_response: 'Exit code: 1\nWall time: 3 s\nOutput:\n' + 'y'.repeat(4200000) }));
  assert.deepEqual(text.map(e => e.kind), ['action', 'error']);
});

test('an oversized Claude payload keeps file_path or the command, the failure and its exit code', async () => {
  const write = claude(await oversized({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'src/big.js', content: 'z'.repeat(4200000) }, tool_response: { type: 'create' } }));
  assert.deepEqual(write.map(e => [e.kind, e.text]), [['action', 'Write: src/big.js']]);
  const failed = claude(await oversized({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'make all', description: 'Build' }, error: 'Exit code 2\n' + 'e'.repeat(4200000) }));
  assert.deepEqual(failed.map(e => [e.kind, e.text]), [['action', 'Bash: make all' + FAILED], ['error', 'Bash: make all' + FAILED + '\nExit code 2\n' + OVERSIZED_OUTPUT]]);
  const unknown = claude(await oversized({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat <<EOF\n' + 'q'.repeat(4200000) + '\nEOF' } }));
  assert.deepEqual(unknown.map(e => [e.kind, e.text]), [['action', 'Bash: ' + OVERSIZED_INPUT]], 'the action line survives');
  const denied = claude(await oversized({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cat .env' }, error: 'Exit code 1\n' + 'S'.repeat(4200000) }));
  assert.deepEqual(denied.map(e => e.kind), ['action']);
});

// ---- Round 2: writes into credential files, more deny cases, cut markers ----

const fail = { failed: true, failure_output: 'Exit code 1\nboom' };
const run = (tool, input, extra = {}, client = 'claude-code') => buildEntries({ client, event: 'PostToolUse', hook: { session_id: 's', tool_name: tool, tool_input: input, ...extra }, repo: 'r', ts: TS });

test('a write into a credential file keeps no body in the action line', () => {
  const patch = '*** Begin Patch\n*** Add File: .env\n+DJANGO_SALT=Zx9fakeSaltValueQQ\n+SIGNING=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c\n*** End Patch\n';
  const cases = [
    ['Bash', { command: "echo 'db.internal:5432:app:appuser:Fak3PgPass!' >> ~/.pgpass && chmod 600 ~/.pgpass" }, 'Bash: echo … >> ~/.pgpass && chmod … ~/.pgpass'],
    ['Bash', { command: 'echo db.internal:5432:app:appuser:Fak3PgPass >> ~/.pgpass' }, 'Bash: echo … >> ~/.pgpass'],
    ['Bash', { command: "cat > ~/.docker/config.json <<'EOF'\n{\"auths\":{\"ghcr.io\":{\"auth\":\"YWxpY2U6RmFrZVBhc3N3b3JkMTIz\"}}}\nEOF" }, null],
    ['Bash', { command: "printf '_auth=YWxpY2U6RmFrZVBhc3N3b3JkMTIz\\n' >> ~/.npmrc" }, 'Bash: printf … >> ~/.npmrc'],
    ['Bash', { command: "cat > .dev.vars <<'EOF'\nSESSION_SALT=Zx9fakeSaltValueQQ\nEOF" }, null],
    ['Bash', { command: 'SIGNING=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c tee .env <<< Zx9fakeSaltValueQQ' }, null],
    ['shell', { command: ['apply_patch', patch] }, 'shell: apply_patch .env'],
    ['shell', { command: ['bash', '-lc', "apply_patch <<'EOF'\n" + patch + 'EOF'] }, 'shell: apply_patch .env'],
    ['exec_command', { cmd: "apply_patch <<'EOF'\n" + patch + 'EOF' }, 'exec_command: apply_patch .env'],
    ['apply_patch', patch, 'apply_patch: .env'],
    ['apply_patch', { input: patch }, 'apply_patch: .env'],
    ['Write', { file_path: '/repo/.env', content: 'SIGNING=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c' }, 'Write: /repo/.env'],
  ];
  for (const [tool, input, expected] of cases) {
    for (const extra of [{}, fail]) {
      const entries = run(tool, input, extra, 'codex');
      const text = JSON.stringify(entries);
      for (const secret of ['Fak3PgPass', 'YWxpY2U6', 'Zx9fakeSalt', '8f7a6b5c4d3e']) assert.ok(!text.includes(secret), tool + ' kept ' + secret + ': ' + text);
      assert.deepEqual(entries.map(e => e.kind), ['action'], 'no error entry: ' + text);
      if (expected) assert.equal(entries[0].text, expected + (extra.failed ? FAILED : ''));
    }
  }
  assert.equal(run('Bash', { command: 'cat > .env.example <<EOF\nA=\nEOF' })[0].text, 'Bash: cat > .env.example <<EOF');
  assert.equal(run('Bash', { command: 'echo hello > notes.txt' })[0].text, 'Bash: echo hello > notes.txt', 'other writes keep their command');
  assert.equal(run('shell', { command: ['apply_patch', patch.replaceAll('.env', 'src/a.rs')] })[0].text, 'shell: apply_patch src/a.rs', 'a patch shows its files');
});

test('sensitiveInput, round 2: more credential files, shell spellings and environment printers', () => {
  const yes = ['cat prod.env', 'docker run --env-file=prod.env img', 'cat .dev.vars', 'cat terraform.tfvars', 'cat ~/.config/gcloud/application_default_credentials.json',
    'cat ~/.config/gh/hosts.yml', 'cat .e""nv', "cat .e''nv", 'cat .en?', 'cat .[e]nv', 'cat .en*', 'cat *.pem', 'cat /repo/%2eenv', 'tail .env~',
    'heroku config', 'heroku config:get DATABASE_URL', 'kubectl config view --raw', 'docker compose config', 'docker-compose -f x.yml config', 'export -p', 'set', 'declare -x', 'declare -p',
    'cat /proc/self/environ', 'cat /proc/1234/environ', 'node -e "console.log(process.env)"', "python -c 'import os;print(os.environ)'",
    'aws ssm get-parameter --with-decryption --name x', 'aws secretsmanager get-secret-value --secret-id x', 'gcloud secrets versions access latest --secret=x',
    'az keyvault secret show --name x', 'pass show db/prod', 'bw get password github', 'gh auth status -t', 'firebase functions:config:get'];
  const no = ['cat *', 'ls *.ts', 'cp *.* dst', 'node -e "console.log(process.env.HOME)"', 'set -euo pipefail', 'declare -x FOO=1', 'export FOO=1', 'docker compose up',
    'kubectl config view', 'aws ssm get-parameter --name x', 'git config --get remote.origin.url', 'cat README.md', 'grep -r environment src'];
  for (const command of yes) assert.equal(sensitiveInput({ command }), true, command);
  for (const command of no) assert.equal(sensitiveInput({ command }), false, command);
  // Cases that were stored before: the value is gone with the output.
  const diff = buildEntries({ client: 'claude-code', event: 'PostToolUseFailure', hook: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'diff .dev.vars .dev.vars.example' }, failed: true, failure_output: 'Exit code 1\n1c1\n< SESSION_SALT=Zx9fakeSaltValueQQ\n---\n> SESSION_SALT=\n' }, repo: 'r', ts: TS });
  const cat = buildEntries({ client: 'claude-code', event: 'PostToolUseFailure', hook: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat prod.env missing.txt' }, failed: true, failure_output: 'Exit code 1\nSIGNING=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c\ncat: missing.txt: No such file' }, repo: 'r', ts: TS });
  assert.deepEqual([...diff, ...cat].map(e => [e.kind, e.text]), [['action', 'Bash: diff .dev.vars .dev.vars.example' + FAILED], ['action', 'Bash: cat prod.env …' + FAILED]]);
});

test('a cut never lands inside a redaction marker, and agent cuts end with the contract marker', () => {
  for (const marker of ['[REDACTED]', '[REDACTED TOKEN]', '[REDACTED PRIVATE KEY]', '[DENIED PATH]', '(email omitted)']) {
    for (let pad = 0; pad < marker.length + 2; pad++) {
      const text = 'x'.repeat(100 - TRUNCATED.length - pad) + marker + ' tail tail tail';
      const cut = clip(text, 100);
      assert.ok(cut.length <= 100 && cut.endsWith(TRUNCATED));
      const rest = cut.slice(0, -TRUNCATED.length).replace(/\[(?:REDACTED|DENIED)[A-Z ]*\]|\(email omitted\)/g, '');
      assert.ok(!/\[[A-Z]|\(e/.test(rest), 'half a marker: ' + JSON.stringify(cut));
    }
  }
  const secret = 'ghp_' + 'B'.repeat(36);
  const prompt = 'x'.repeat(LIMITS.prompt - TRUNCATED.length - 5) + ' ' + secret + ' more text after it';
  const [entry] = claude({ ...base, hook_event_name: 'UserPromptSubmit', prompt });
  assert.ok(entry.text.endsWith(TRUNCATED) && !/\[REDACT[^\]]*…/.test(entry.text), entry.text.slice(-40));
  const line = actionLine('Bash', { command: 'echo ' + 'y'.repeat(500) });
  assert.ok(line.endsWith(TRUNCATED) && line.length <= LIMITS.action);
  assert.ok(actionLine('Bash', { command: 'echo ' + 'y'.repeat(500) }, true).endsWith(TRUNCATED + FAILED), 'the failure mark follows the cut');
});

test('Codex exec_command {cmd} shows the command', () => {
  assert.equal(actionLine('exec_command', { cmd: 'cargo test --workspace', workdir: '/w' }), 'exec_command: cargo test --workspace');
  assert.equal(actionLine('exec_command', { cmd: ['bash', '-lc', 'npm run lint'] }), 'exec_command: npm run lint');
  assert.equal(sensitiveInput({ cmd: 'cat .env' }), true);
});

test('an oversized prompt or reply keeps its head, scrubbed and cut with the marker', async () => {
  const secret = 'sk-ant-' + 'Q'.repeat(30);
  const prompt = 'please fix this ' + secret + ' ' + 'あ'.repeat(2000000) + ' end';
  const parsed = await oversized({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/w', prompt });
  const [entry] = claude(parsed);
  assert.equal(entry.kind, 'prompt');
  assert.ok(entry.text.startsWith('please fix this ') && entry.text.endsWith(TRUNCATED) && entry.text.length === LIMITS.prompt);
  assert.ok(!entry.text.includes('QQQQQQQQQQ'), 'scrubbed');
  const reply = codex(await oversized({ session_id: 's1', hook_event_name: 'Stop', cwd: '/w', last_assistant_message: 'Done.\n' + 'z\\"'.repeat(1500000) }));
  assert.deepEqual(reply.map(e => e.kind), ['reply']);
  assert.ok(reply[0].text.startsWith('Done.\nz\\"z') && reply[0].text.endsWith(TRUNCATED));
  // A head cut in the middle of an escape sequence still decodes.
  for (const tail of ['\\', '\\u', '\\u00', '\\u004']) {
    const text = JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'x' }).replace('"x"', '"' + 'a'.repeat(4000000 - 60) + tail + 'b'.repeat(100000) + '"');
    const head = (await hookInput(Readable.from([Buffer.from(text)]))).prompt;
    assert.ok(typeof head === 'string' && head.startsWith('aaaa'), JSON.stringify(tail));
  }
});

test('round 3: a sensitive command keeps only program names, denied paths, operators and heredoc delimiters', () => {
  const cases = [
    ["node -e \"require('fs').appendFileSync('.env','STRIPE=hunter2horse')\"", 'Bash: node … .env', 'hunter2horse'],
    ['htpasswd -b .htpasswd admin hunter2horse', 'Bash: htpasswd … .htpasswd …', 'hunter2horse'],
    ['sed -i "" s/changeme/Tr0ub4dor3/ .env', 'Bash: sed … .env', 'Tr0ub4dor3'],
    ['docker run --env-file=.env -e PASS=hunter2horse img', 'Bash: docker … .env …', 'hunter2horse'],
    ['SIGNING=8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c tee .env <<< Zx9fakeSaltValueQQ', 'Bash: SIGNING=… tee .env <<< …', 'Zx9fakeSalt'],
    ["cat > ~/.docker/config.json <<'EOF'\n{}\nEOF", "Bash: cat > ~/.docker/config.json <<'EOF'", null],
    ['cat prod.env missing.txt', 'Bash: cat prod.env …', null],
    ['diff .env .env.example', 'Bash: diff .env .env.example', null],
  ];
  for (const [command, expected, secret] of cases) {
    for (const extra of [{}, fail]) {
      const entries = run('Bash', { command }, extra);
      assert.deepEqual(entries.map(e => e.kind), ['action'], command);
      assert.equal(entries[0].text, expected + (extra.failed ? FAILED : ''), command);
      if (secret) assert.ok(!JSON.stringify(entries).includes(secret), command);
    }
  }
});

test('round 3: a Codex cmd array that prints credentials is sensitive', () => {
  assert.equal(sensitiveInput({ cmd: ['bash', '-lc', 'gh auth token | pbcopy'] }), true);
  assert.equal(sensitiveInput({ cmd: ['bash', '-lc', 'security find-generic-password -s x -w'] }), true);
  assert.equal(sensitiveInput({ cmd: ['bash', '-lc', 'git status'] }), false);
  const entries = run('exec_command', { cmd: ['bash', '-lc', 'gh auth token'] }, { failed: true, failure_output: 'gho_FAKEfakeFAKEfake1234567890abcdefXYZ' }, 'codex');
  assert.deepEqual(entries.map(e => e.kind), ['action']);
  assert.ok(!JSON.stringify(entries).includes('gho_FAKE'));
});

test('round 3: more credential printers, shell spellings of denied paths, uri/url keys', () => {
  const yes = ['terraform output -raw db_password && psql x', 'terraform state pull', 'pulumi stack output --show-secrets', 'docker inspect web',
    'docker exec web env', 'kubectl exec pod -- env', '/usr/bin/env', 'command env', 'helm get values rel', 'sops -d secrets.enc.yaml',
    'ansible-vault view vault.yml', 'chamber export app', 'cat .e\\nv', 'cat .{e,}nv', 'wrangler secret bulk x.json'];
  const no = ['terraform plan', 'docker ps', 'kubectl exec pod -- ls', '/usr/bin/env python3 x.py', 'helm install x', 'cat .{a,b}rc', 'python -m venv .venv'];
  for (const command of yes) assert.equal(sensitiveInput({ command }), true, command);
  for (const command of no) assert.equal(sensitiveInput({ command }), false, command);
  assert.equal(sensitiveInput({ uri: 'file:///repo/.env' }), true);
  const entries = run('Bash', { command: 'terraform output -raw db_password' }, { failed: true, failure_output: 'Zx9FakeTfDbPw\nError: x' });
  assert.deepEqual(entries.map(e => e.kind), ['action']);
});

test('round 3: shell continuations are joined before command-argument scrubbing', () => {
  for (const command of ['docker login r \\\n -u a \\\n -p FakeDockerPw1', 'mysql -h db \\\n -pFakeMysqlPw1', 'curl https://x \\\n -u admin:FakeCurlPw1']) {
    const text = run('Bash', { command })[0].text;
    assert.ok(!/FakeDockerPw1|FakeMysqlPw1|FakeCurlPw1/.test(text), text);
  }
});

test('round 4: a lone "[" in a command or patch never throws, and wrapper assignments and comments are reduced', () => {
  for (const command of ['python3 -c "print(sys.argv[1:])"', "jq '.[0:3]' a.json", 'echo a[0', "df.loc[:, 'x']"]) {
    assert.equal(sensitiveInput({ command }), false, command);
    assert.deepEqual(run('Bash', { command }, fail).map(e => e.kind), ['action', 'error'], command);
  }
  const patch = '*** Begin Patch\n*** Update File: a.py\n+x = cfg["password"]\n*** End Patch\n';
  assert.equal(run('apply_patch', { input: patch }, {}, 'codex')[0].text, 'apply_patch: a.py');
  assert.equal(sensitiveInput({ command: 'cat .[e]nv' }), true);
  assert.equal(run('Bash', { command: 'env FOO=Fake1234x cat .env' })[0].text, 'Bash: env FOO=… cat .env');
  assert.equal(run('Bash', { command: 'cat .env # Fake1234x note' })[0].text, 'Bash: cat .env …');
});

test('round 5: the glob check stays linear on a long token next to a glob character', () => {
  const started = performance.now();
  assert.equal(sensitiveInput({ command: 'ls *.txt ' + 'a'.repeat(200000) }), false);
  assert.equal(sensitiveInput({ input: '*** Begin Patch\n*** Add File: a.py\n+x = arr[0]\n+' + 'f'.repeat(200000) + '\n*** End Patch' }), false);
  assert.ok(performance.now() - started < 500 * SLOW, 'took ' + Math.round(performance.now() - started) + ' ms');
  assert.equal(sensitiveInput({ command: 'cat .en?' }), true);
});

test('round 6: masked stars, long brace JSON and minified code stay linear in sensitiveInput', () => {
  const shapes = {
    stars: { command: 'grep -rn "************1234" src' },
    'star-qmarks': { command: 'ls ?*?*?*?*?*?*?*?*.envx' },
    'brace json': { command: 'cat <<EOF\n{"items":[' + Array.from({ length: 150000 }, (_, i) => i).join(',') + '],"meta":{"a":1}}\nEOF' },
    'minified js': { command: 'cat <<EOF\n' + 'a=b;c(d);e|f&g;'.repeat(70000) + '\nEOF' },
    semicolons: { command: 'echo ' + ';'.repeat(1000000) },
  };
  for (const [name, input] of Object.entries(shapes)) {
    const started = performance.now();
    assert.equal(sensitiveInput(input), false, name);
    assert.ok(performance.now() - started < 300 * SLOW, name + ' took ' + Math.round(performance.now() - started) + ' ms');
  }
  for (const command of ['cat .en?', 'cat .[e]nv', 'cat .{e,}nv', 'cat .e*v', 'cat x | env']) assert.equal(sensitiveInput({ command }), true, command);
  for (const command of ['ls *.txt', '/usr/bin/env python3']) assert.equal(sensitiveInput({ command }), false, command);
});

test('round 7: every credential-printer pattern stays linear on its own prefix repeated, and the total scanned is bounded', () => {
  const N = 131000, rep = unit => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const inputs = [{ command: 'declare -' + 'x'.repeat(70000) + '1' }, { command: '; declare -' + 'x'.repeat(130000) + '1' },
    ...['docker exec ', 'gh auth status ', 'aws ssm get-parameter ', 'kubectl config view ', 'pulumi ', 'sops ', 'docker compose ', 'typeset -', 'sudo declare -', ';', '/proc/1/'].map(unit => ({ command: rep(unit) })),
    { files: Array.from({ length: 8 }, (_, i) => ({ path: 'f' + i, content: 'docker exec '.repeat(10900) })) }];
  for (const input of inputs) {
    const started = performance.now();
    sensitiveInput(input);
    assert.ok(performance.now() - started < 300 * SLOW, JSON.stringify(input).slice(0, 40) + ' took ' + Math.round(performance.now() - started) + ' ms');
  }
  for (const command of ['declare -px', '; typeset -x', 'docker exec web env', 'gh auth status -t']) assert.equal(sensitiveInput({ command }), true, command);
  assert.equal(sensitiveInput({ command: 'declare -A m' }), false);
});

test('round 7: a prompt over 1 MiB whose head scrubs down to little is still stored', () => {
  const prompt = 'What is in this screenshot? data:image/png;base64,' + 'A'.repeat(1600000);
  const entries = buildEntries({ client: 'claude-code', event: 'UserPromptSubmit', hook: { session_id: 's', prompt }, repo: 'r', ts: TS });
  assert.deepEqual(entries.map(e => e.text), ['What is in this screenshot? data:image/png;base64,[REDACTED MEDIA CONTENT]']);
});
