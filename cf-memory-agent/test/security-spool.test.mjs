// Regression tests for
// cf-memory-agent/scripts/spool.mjs:flush:backlog-not-bound-to-server-or-account:
// an entry queued for one server/account is never delivered to another one.
// Loopback fake servers and dummy tokens only; HOME / CF_MEMORY_AGENT_HOME / TMPDIR
// are fresh temp dirs, inherited CF_MEMORY_* removed, Keychain lookup off (testEnv).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cf-memory-security-spool-')));
process.env.TMPDIR = ROOT; // everything below (tempDir(), child git) lands under ROOT
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { runHook } = await import('../scripts/hook.mjs');
const { flushCommand, replayHeldCommand } = await import('../scripts/agent.mjs');
const { doctor } = await import('../scripts/doctor.mjs');
const { makeEntry } = await import('../scripts/entries.mjs');
const { appendEntries, flush, HELD_CAP_BYTES, heldFile, heldGroups, heldStats, pendingStats, rejectedFile, replayHeld, replayRejected, SPOOL_ACTION_CAP_BYTES, spoolDir, spoolFile } = await import('../scripts/spool.mjs');
const { destination, queuedFor } = await import('../scripts/transport.mjs');
const { tempDir, testEnv } = await import('./helpers/fake-server.mjs');

const CLIENT = 'claude-code';
const TOKEN_X = 'fixture-token-account-X-not-a-secret', TOKEN_Y = 'fixture-token-account-Y-not-a-secret';
// A second token of account X (a rotated OAuth access token): the same account.
const TOKEN_X2 = 'fixture-token-account-X-rotated-not-a-secret';

// A stand-in cf-memory with accounts: whoami answers the caller's user_id (as
// src/mcp.ts does) and log_append stores each entry under the caller's account.
async function accountServer(accounts = { [TOKEN_X]: 'u_x', [TOKEN_X2]: 'u_x', [TOKEN_Y]: 'u_y' }, behavior = {}) {
  const calls = [], stored = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => { chunks.push(chunk); });
    request.on('end', () => {
      let message = {};
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const name = message.params?.name, args = message.params?.arguments ?? {};
      const user = accounts[String(request.headers.authorization).replace(/^Bearer /, '')];
      calls.push({ name, args, user });
      const reply = (status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
      const ok = result => reply(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      if (behavior.down?.()) return reply(503, { error: 'unavailable' });
      if (!user) return reply(401, { error: 'unauthorized' });
      if (name === 'whoami') return ok(behavior.whoami?.(user) ?? { handle: user, user_id: user, anonymous: false, token_status: 'active' });
      if (name === 'log_append') {
        if (behavior.failAppend?.()) return reply(503, { error: 'unavailable' });
        const bad = (args.entries ?? []).findIndex(entry => Object.keys(entry).some(key => !['id', 'session_id', 'client', 'repo', 'ts', 'kind', 'text'].includes(key)) || behavior.rejectEntry?.(entry));
        if (bad >= 0) return reply(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'entries[' + bad + '].text is not accepted' }], isError: true } });
        for (const entry of args.entries ?? []) stored.push({ user, text: entry.text, kind: entry.kind });
        return ok({ stored: (args.entries ?? []).length, duplicates: 0, dropped_over_cap: 0, dropped_over_total_cap: 0, ts_clamped: 0 });
      }
      if (name === 'recall') return ok({ text: 'fixture recall', used: 1, budget: args.budget });
      if (name === 'session_context') return ok({ core_memory: '', handoff: null });
      return reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool' } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  return {
    url, origin: new URL(url).origin, calls, stored,
    named: name => calls.filter(call => call.name === name),
    texts: user => stored.filter(entry => user === undefined || entry.user === user).map(entry => entry.text),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function setup(url, token = TOKEN_X) {
  const dir = tempDir('security-spool-');
  assert.ok(dir.path.startsWith(ROOT), 'temp home is under the test TMPDIR');
  const cwd = join(dir.path, 'work');
  mkdirSync(cwd, { recursive: true });
  const env = testEnv(dir.path, url, { TMPDIR: ROOT, CF_MEMORY_ACCESS_TOKEN: token });
  assert.equal(env.CF_MEMORY_KEYCHAIN, 'off');
  const loggedOut = { ...env }; delete loggedOut.CF_MEMORY_ACCESS_TOKEN;
  const hook = (event, payload, e = env) => runHook({ client: CLIENT, event, payload: { session_id: 'security-session', cwd, hook_event_name: event, ...payload }, env: e });
  const health = () => JSON.parse(readFileSync(join(env.CF_MEMORY_AGENT_HOME, 'health', CLIENT + '.json'), 'utf8'));
  const report = (e = env) => doctor({ env: e, versions: false });
  return { dir, env, loggedOut, home: env.CF_MEMORY_AGENT_HOME, hook, health, report };
}
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const entry = (text, extra = {}) => makeEntry({ client: CLIENT, session_id: 'security-session', repo: '', ts: Date.now(), kind: 'prompt', text, ...extra });

test('queued while logged out with server A configured, then pointed at server B: B never receives it; it is held, reported, and goes to A later', async () => {
  const A = await accountServer(), B = await accountServer();
  const s = setup(A.url);
  try {
    await s.hook('UserPromptSubmit', { prompt: 'queued-for-A' }, s.loggedOut);
    assert.equal(A.calls.length, 0);
    assert.equal(s.health().last_flush.error, 'no_credentials');

    const onB = { ...s.env, CF_MEMORY_MCP_URL: B.url };
    await s.hook('Stop', { last_assistant_message: 'reply-under-B' }, onB);
    assert.deepEqual(B.texts(), ['reply-under-B'], 'B stores only what was queued for B');
    assert.equal(A.named('log_append').length, 0);
    // Not delivered elsewhere and not dropped: set aside with its destination.
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => [line.text, line.to.origin]), [['queued-for-A', A.origin]]);
    assert.equal((await pendingStats(s.home, CLIENT)).bytes, 0);
    assert.equal(s.health().last_flush.ok, true);
    assert.equal(s.health().last_flush.held, 1);
    const report = await s.report(onB);
    assert.equal(report.clients[CLIENT].spool.held_entries, 1);
    assert.equal(report.clients[CLIENT].spool.held_file, heldFile(s.home, CLIENT));
    assert.ok(report.warnings.some(warning => warning.includes(CLIENT) && warning.includes('replay-held')), JSON.stringify(report.warnings));

    // Queued again while B is configured: still not B's.
    assert.deepEqual(await replayHeld(s.home, CLIENT), { replayed: 1, invalid: 0 });
    await s.hook('Stop', { last_assistant_message: 'second-under-B' }, onB);
    assert.deepEqual(B.texts(), ['reply-under-B', 'second-under-B']);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 1);

    // Back on A and logged in: now it is delivered, to A.
    assert.deepEqual(await replayHeld(s.home, CLIENT), { replayed: 1, invalid: 0 });
    await s.hook('Stop', { last_assistant_message: 'reply-under-A' });
    assert.deepEqual(A.texts('u_x'), ['queued-for-A', 'reply-under-A']);
    assert.equal(B.texts().includes('queued-for-A'), false);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
  } finally { await A.close(); await B.close(); s.dir.cleanup(); }
});

test('queued while server A is down (logged in), then pointed at server B: B receives only its own entry', async () => {
  const A = await accountServer(), B = await accountServer();
  const s = setup(A.url);
  try {
    await A.close();
    await s.hook('UserPromptSubmit', { prompt: 'queued-while-A-down' });
    assert.ok((await pendingStats(s.home, CLIENT)).bytes > 0);
    assert.equal(s.health().last_flush.ok, false);

    await s.hook('Stop', { last_assistant_message: 'done' }, { ...s.env, CF_MEMORY_MCP_URL: B.url });
    assert.deepEqual(B.texts(), ['done']);
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => line.text), ['queued-while-A-down']);
  } finally { await B.close(); s.dir.cleanup(); }
});

test('same server, account switched from X to Y: what was queued under X is not sent with Y\'s token; back under X it is delivered', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  const asY = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
  try {
    await s.hook('Stop', { last_assistant_message: 'first-under-X' }); // X is now the account seen on this server
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo queued-under-X' } }); // waits for the tool-flush threshold
    await s.hook('UserPromptSubmit', { prompt: 'queued-logged-out-after-X' }, s.loggedOut);
    assert.deepEqual(S.texts(), ['first-under-X']);

    await s.hook('Stop', { last_assistant_message: 'reply-under-Y' }, asY);
    // The entry this hook queued itself belongs to the account it runs under.
    assert.deepEqual(S.texts('u_y'), ['reply-under-Y']);
    assert.deepEqual(S.texts('u_x'), ['first-under-X']);
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => line.text), ['Bash: echo queued-under-X', 'queued-logged-out-after-X']);

    await s.hook('UserPromptSubmit', { prompt: 'next-under-Y' }, asY);
    assert.deepEqual(S.texts('u_y'), ['reply-under-Y', 'next-under-Y']);

    // The tool entry was queued with X's own token (labelled X); the logged-out one names no account.
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => [typeof line.to.account, typeof line.to.at]), [['string', 'undefined'], ['undefined', 'number']]);
    assert.deepEqual(await replayHeld(s.home, CLIENT), { replayed: 2, invalid: 0 });
    await s.hook('Stop', { last_assistant_message: 'back-under-X' });
    // Back under X: what is known to be X's goes; the entry of no known account
    // is not handed to whoever flushes next (Y flushed in between), it waits.
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'Bash: echo queued-under-X', 'back-under-X']);
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => line.text), ['queued-logged-out-after-X']);
    // The operator names it (by session here) and sends it to the account now configured.
    assert.deepEqual(await replayHeldCommand(['--client', CLIENT, '--origin', S.origin, '--unknown', '--session', 'security-session', '--to-current'], s.env), { [CLIENT]: { replayed: 1, invalid: 0 } });
    await s.hook('Stop', { last_assistant_message: 'last-under-X' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'Bash: echo queued-under-X', 'back-under-X', 'queued-logged-out-after-X', 'last-under-X']);
    assert.deepEqual(S.texts('u_y'), ['reply-under-Y', 'next-under-Y']);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('a rotated token of the same account still delivers its backlog, and the account is asked for once per token', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  try {
    await s.hook('Stop', { last_assistant_message: 'one' });
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo waiting' } });
    await s.hook('Stop', { last_assistant_message: 'two' });
    assert.equal(S.named('whoami').length, 1, 'a known token costs no extra request');

    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo before-rotation' } });
    await s.hook('Stop', { last_assistant_message: 'three' }, { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_X2 });
    assert.equal(S.named('whoami').length, 2);
    assert.deepEqual(S.texts('u_x'), ['one', 'Bash: echo waiting', 'two', 'Bash: echo before-rotation', 'three']);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('queued while logged out on a server no account was seen on: goes to the first account that logs in on that server', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_Y);
  try {
    await s.hook('UserPromptSubmit', { prompt: 'before-first-login' }, s.loggedOut);
    assert.deepEqual(Object.keys(lines(spoolFile(s.home, CLIENT))[0].to), ['origin', 'at'], 'account unknown, no account assumed');
    await s.hook('Stop', { last_assistant_message: 'after-login' });
    assert.deepEqual(S.texts('u_y'), ['before-first-login', 'after-login']);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('the destination stays local: the server gets the seven log_append fields, and no file holds the token', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  try {
    await s.hook('Stop', { last_assistant_message: 'shape' });
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo local' } });
    const [sent] = S.named('log_append')[0].args.entries;
    assert.deepEqual(Object.keys(sent).sort(), ['client', 'id', 'kind', 'repo', 'session_id', 'text', 'ts']);
    const [queued] = lines(spoolFile(s.home, CLIENT));
    assert.equal(queued.to.origin, S.origin);
    assert.match(queued.to.account, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(queued).includes('u_x'), false, 'the account is a hash, not the id');
    for (const dir of [s.home, spoolDir(s.home), join(s.home, 'health')]) {
      for (const name of readdirSync(dir)) {
        const info = statSync(join(dir, name));
        if (!info.isFile()) continue;
        assert.equal(info.mode & 0o777, 0o600, name);
        assert.equal(readFileSync(join(dir, name), 'utf8').includes(TOKEN_X), false, name);
      }
    }
    assert.equal(statSync(spoolDir(s.home)).mode & 0o777, 0o700);
  } finally { await S.close(); s.dir.cleanup(); }
});

const legacySpool = (home, texts, ts = Date.now() - 3600000) => {
  mkdirSync(spoolDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(spoolFile(home, CLIENT), texts.map(text => JSON.stringify(entry(text, { ts })) + '\n').join(''), { mode: 0o600, flag: 'a' });
};

test('upgrade: a backlog queued by an Agent without destinations keeps being delivered on a machine with one account, with no manual step', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  try {
    legacySpool(s.home, ['legacy-one', 'legacy-two']);
    const { output } = await s.hook('UserPromptSubmit', { prompt: 'new-prompt' });
    assert.ok(output?.hookSpecificOutput?.additionalContext.includes('fixture recall'));
    assert.equal(s.health().last_hook.ok, true);
    assert.deepEqual(S.texts('u_x'), ['legacy-one', 'legacy-two', 'new-prompt']);
    assert.equal(s.health().last_flush.held, 0);
    // The backlog a later flush reaches (a large one takes several) still goes: the account is still the only one.
    legacySpool(s.home, ['legacy-three']);
    await s.hook('Stop', { last_assistant_message: 'done' });
    assert.deepEqual(S.texts('u_x'), ['legacy-one', 'legacy-two', 'new-prompt', 'legacy-three', 'done']);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
    const report = await s.report();
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('upgrade: where another account flushed last, the old backlog is adopted once for that server as "account unknown", held, and shown at SessionStart and by doctor with the command', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  const asY = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
  try {
    await s.hook('Stop', { last_assistant_message: 'under-X' });
    await s.hook('Stop', { last_assistant_message: 'under-Y' }, asY);
    legacySpool(s.home, ['legacy-one', 'legacy-two']);
    await s.hook('Stop', { last_assistant_message: 'back-under-X' });
    assert.deepEqual(S.texts('u_x'), ['under-X', 'back-under-X']);
    assert.deepEqual(S.texts('u_y'), ['under-Y']);
    const held = lines(heldFile(s.home, CLIENT));
    assert.deepEqual(held.map(line => [line.text, line.to.origin, line.to.account, line.to.at === line.ts]), [['legacy-one', S.origin, undefined, true], ['legacy-two', S.origin, undefined, true]]);
    assert.equal(statSync(heldFile(s.home, CLIENT)).mode & 0o777, 0o600);
    assert.equal(s.health().last_flush.held, 2);

    // Seen where the user looks: the session start, and doctor as a problem.
    const started = await runHook({ client: CLIENT, event: 'SessionStart', payload: { session_id: 'next', cwd: s.dir.path, hook_event_name: 'SessionStart' }, env: s.env, doctorCommand: 'node "/x/agent.mjs" doctor' });
    const text = started.output.hookSpecificOutput.additionalContext;
    assert.ok(text.includes('保留中のログが 2 件') && text.includes('node "/x/agent.mjs" doctor'), text);
    const report = await s.report();
    assert.equal(report.ok, false);
    assert.equal(report.clients[CLIENT].spool.held_entries, 2);
    assert.deepEqual(report.clients[CLIENT].spool.held.map(group => [group.origin, group.state, group.entries, group.sessions]), [[S.origin, 'unknown', 2, ['security-session']]]);
    const [problem] = report.problems;
    assert.ok(problem.includes('agent.mjs replay-held --client ' + CLIENT + ' --origin ' + S.origin + ' --unknown --session <session id> --to-current'), problem);
    assert.equal(report.problems.concat(report.warnings).some(line => / --to-current(?! needs)/.test(line.replace('--session <session id> --to-current', ''))), false, 'no advice sends a whole group to the current account');

    // Queued again as they are, they are held again; the selected ones go to the account the operator sends them to.
    await replayHeld(s.home, CLIENT);
    await s.hook('Stop', { last_assistant_message: 'still-held' });
    assert.equal((await heldStats(s.home, CLIENT)).entries, 2);
    await assert.rejects(replayHeldCommand(['--client', CLIENT, '--to-current'], s.env), /needs a selection/);
    assert.deepEqual(await replayHeldCommand(['--client', CLIENT, '--origin', S.origin, '--unknown', '--session', 'security-session', '--to-current'], s.env), { [CLIENT]: { replayed: 2, invalid: 0 } });
    await s.hook('Stop', { last_assistant_message: 'adopted' });
    assert.deepEqual(S.texts('u_x'), ['under-X', 'back-under-X', 'still-held', 'legacy-one', 'legacy-two', 'adopted']);
    assert.deepEqual(S.texts('u_y'), ['under-Y']);
    assert.equal((await s.report()).ok, true);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('replay-rejected keeps the destination: an entry refused on A is not sent to B after a replay', async () => {
  const A = await accountServer(undefined, { rejectEntry: e => e.text === 'refused-on-A' }), B = await accountServer();
  const s = setup(A.url);
  try {
    await s.hook('UserPromptSubmit', { prompt: 'refused-on-A' });
    assert.deepEqual(lines(rejectedFile(s.home, CLIENT)).map(line => [line.text, line.to.origin]), [['refused-on-A', A.origin]]);
    assert.equal((await replayRejected(s.home, CLIENT)).replayed, 1);
    await s.hook('Stop', { last_assistant_message: 'on-B' }, { ...s.env, CF_MEMORY_MCP_URL: B.url });
    assert.deepEqual(B.texts(), ['on-B']);
    assert.deepEqual(lines(heldFile(s.home, CLIENT)).map(line => [line.text, line.replayed]), [['refused-on-A', true]]);
  } finally { await A.close(); await B.close(); s.dir.cleanup(); }
});

test('agent.mjs flush sends only what was queued for the current server and account', async () => {
  const A = await accountServer(), B = await accountServer();
  const s = setup(A.url);
  try {
    await s.hook('Stop', { last_assistant_message: 'seen-on-A' });
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo for-A' } });
    const onB = { ...s.env, CF_MEMORY_MCP_URL: B.url, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo for-B' } }, onB);
    const report = await flushCommand(['--client', CLIENT], onB);
    assert.equal(report[CLIENT].sent, 1);
    assert.equal(report[CLIENT].held, 1);
    assert.deepEqual(B.texts(), ['Bash: echo for-B']);
    assert.deepEqual(A.texts(), ['seen-on-A']);
    assert.equal(s.health().last_flush.held, 1);
  } finally { await A.close(); await B.close(); s.dir.cleanup(); }
});

test('no flush when the server does not say which account the token belongs to', async () => {
  const S = await accountServer(undefined, { whoami: () => ({ handle: 'anonymous', user_id: 'anon', anonymous: true, token_status: 'none' }) });
  const s = setup(S.url);
  try {
    await s.hook('Stop', { last_assistant_message: 'waits' });
    assert.equal(S.named('log_append').length, 0);
    assert.equal(s.health().last_flush.ok, false);
    assert.equal(s.health().last_flush.error, 'no_account');
    assert.equal((await pendingStats(s.home, CLIENT, { count: true })).entries, 1);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('flush(): the destination of an entry and of the flush must agree', async () => {
  const dir = tempDir('security-spool-');
  try {
    const mine = 'c'.repeat(16), theirs = 'd'.repeat(16), nobodys = 'e'.repeat(16);
    // As destination() names it: this account since 1000, its token fingerprints, the other account's.
    const here = { origin: 'https://one.example', account: 'a'.repeat(16), since: 1000, creds: [mine], others: { [theirs]: 'b'.repeat(16) } };
    const queued = [
      [entry('mine'), { origin: here.origin, account: here.account }],
      [entry('my-token'), { origin: here.origin, at: 5, cred: mine }],
      [entry('since-my-run'), { origin: here.origin, at: 1000 }],
      [entry('before-my-run'), { origin: here.origin, at: 999 }],
      [entry('no-time'), { origin: here.origin }],
      [entry('other-account'), { origin: here.origin, account: 'b'.repeat(16) }],
      [entry('other-accounts-token'), { origin: here.origin, at: 2000, cred: theirs }],
      [entry('unidentified-token'), { origin: here.origin, at: 2000, cred: nobodys }],
      [entry('other-server'), { origin: 'https://two.example', account: here.account }],
      [entry('other-server-unknown'), { origin: 'https://two.example', at: 2000 }],
      [entry('no-server'), {}],
    ];
    for (const [e, to] of queued) await appendEntries(dir.path, CLIENT, [e], to);
    // A destination that is not one never matches.
    writeFileSync(spoolFile(dir.path, CLIENT), JSON.stringify({ ...entry('broken-destination'), to: 'https://one.example' }) + '\n' + JSON.stringify({ ...entry('broken-account'), to: { origin: here.origin, account: 7 } }) + '\n', { flag: 'a' });
    const sent = [];
    const result = await flush(dir.path, CLIENT, async batch => { sent.push(...batch.map(e => e.text)); return { stored: batch.length }; }, { to: here });
    assert.deepEqual(sent, ['mine', 'my-token', 'since-my-run']);
    assert.equal(result.sent, 3); assert.equal(result.held, 10); assert.equal(result.pending_bytes, 0);
    const held = lines(heldFile(dir.path, CLIENT));
    assert.deepEqual(held.map(line => line.text), ['before-my-run', 'no-time', 'other-account', 'other-accounts-token', 'unidentified-token', 'other-server', 'other-server-unknown', 'no-server', 'broken-destination', 'broken-account']);
    // A fingerprint known to be the other account's is held as that account's; nothing else is relabelled.
    assert.deepEqual(held.find(line => line.text === 'other-accounts-token').to, { origin: here.origin, account: 'b'.repeat(16) });
    assert.deepEqual(held.find(line => line.text === 'unidentified-token').to, { origin: here.origin, at: 2000, cred: nobodys });
    assert.deepEqual(held.find(line => line.text === 'no-server').to, {});

    // Without a record to go by (`since` null), no "account unknown" entry is taken; a flush that names no account takes nothing.
    await replayHeld(dir.path, CLIENT, undefined, { origin: here.origin, unknown: true });
    for (const to of [{ ...here, since: null }, { origin: here.origin, account: here.account }, { origin: here.origin }]) {
      const taken = [];
      await flush(dir.path, CLIENT, async batch => { taken.push(...batch.map(e => e.text)); return {}; }, { to: { ...to, creds: [], others: {} } });
      assert.deepEqual(taken, []);
      await replayHeld(dir.path, CLIENT, undefined, { origin: here.origin, unknown: true });
    }
    // The first account ever seen on the origin (`since` 0) takes them, whenever they were queued; never a token known to be someone else's.
    const first = [];
    await flush(dir.path, CLIENT, async batch => { first.push(...batch.map(e => e.text)); return {}; }, { to: { ...here, since: 0, creds: [] } });
    assert.deepEqual(first.sort(), ['before-my-run', 'no-time']);

    // A flush that names no destination sends nothing that has one.
    await appendEntries(dir.path, CLIENT, [entry('bound')], here);
    const unbound = [];
    const second = await flush(dir.path, CLIENT, async batch => { unbound.push(...batch.map(e => e.text)); return {}; });
    assert.deepEqual(unbound, []);
    assert.ok(second.held >= 1);

    // A failed send holds nothing twice and loses nothing.
    await replayHeld(dir.path, CLIENT, undefined, { account: here.account });
    await appendEntries(dir.path, CLIENT, [entry('mine-again')], here);
    const failed = await flush(dir.path, CLIENT, async () => { throw Error('down'); }, { to: here });
    assert.ok(failed.error);
    const after = [];
    await flush(dir.path, CLIENT, async batch => { after.push(...batch.map(e => e.text)); return {}; }, { to: here });
    assert.deepEqual(after, ['bound', 'mine-again']);
    assert.deepEqual(lines(heldFile(dir.path, CLIENT)).map(line => line.text).sort(), ['broken-account', 'broken-destination', 'no-server', 'other-account', 'other-accounts-token', 'other-server', 'other-server-unknown', 'unidentified-token']);
    assert.equal((await pendingStats(dir.path, CLIENT)).bytes, 0);
  } finally { dir.cleanup(); }
});

// The account that queued an entry is told from what the hook knows when it
// queues it, never assumed to be the one that flushed last.
const heldTexts = home => lines(heldFile(home, CLIENT)).map(line => line.text);
// The replay-held command a doctor line prints, as argv.
const printedReplay = line => /agent\.mjs replay-held (.*)$/.exec(line)[1].split(' ');

test('X seen, server down, Y queues a prompt and a reply, server up, X flushes: X never receives Y\'s text; Y replays exactly its own with the command doctor prints', async () => {
  let down = false;
  const S = await accountServer(undefined, { down: () => down });
  const s = setup(S.url, TOKEN_X);
  const asY = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
  try {
    await s.hook('Stop', { last_assistant_message: 'first-under-X' });
    down = true;
    await s.hook('UserPromptSubmit', { prompt: 'Y-private-prompt' }, asY);
    await s.hook('Stop', { last_assistant_message: 'Y-private-reply' }, asY);
    assert.equal(s.health().last_flush.ok, false);
    // Not labelled with the account that flushed last: account unknown, with Y's token fingerprint.
    for (const line of lines(spoolFile(s.home, CLIENT)).filter(line => line.text.startsWith('Y-'))) {
      assert.deepEqual(Object.keys(line.to), ['origin', 'at', 'cred']);
    }
    down = false;
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo X-own-tool' } }); // X's token is known: labelled X
    await s.hook('Stop', { last_assistant_message: 'back-under-X' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'Bash: echo X-own-tool', 'back-under-X']);
    assert.deepEqual(S.texts('u_y'), []);
    assert.deepEqual(heldTexts(s.home), ['Y-private-prompt', 'Y-private-reply']);
    // Under X, doctor does not offer them to X as X's own.
    const underX = await s.report();
    assert.equal(underX.ok, false);
    assert.equal(underX.problems.length, 1);
    assert.ok(underX.problems[0].includes('--unknown --session <session id> --to-current'), underX.problems[0]);

    // Y is back: its first flush identifies the token that queued them, so they are known to be Y's and go, with no command.
    await s.hook('Stop', { last_assistant_message: 'Y-online' }, asY);
    assert.deepEqual(S.texts('u_y'), ['Y-online', 'Y-private-prompt', 'Y-private-reply']);
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'Bash: echo X-own-tool', 'back-under-X']);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
    assert.equal((await s.report(asY)).ok, true);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('X seen, server down, Y queues a prompt and a reply, server up, Y flushes: Y\'s own entries are delivered, nothing is held', async () => {
  let down = false;
  const S = await accountServer(undefined, { down: () => down });
  const s = setup(S.url, TOKEN_X);
  const asY = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
  try {
    await s.hook('Stop', { last_assistant_message: 'first-under-X' });
    down = true;
    await s.hook('UserPromptSubmit', { prompt: 'Y-offline-prompt' }, asY);
    await s.hook('Stop', { last_assistant_message: 'Y-offline-reply' }, asY);
    down = false;
    await s.hook('UserPromptSubmit', { prompt: 'Y-online-prompt' }, asY);
    assert.deepEqual(S.texts('u_y'), ['Y-offline-prompt', 'Y-offline-reply', 'Y-online-prompt']);
    assert.deepEqual(S.texts('u_x'), ['first-under-X']);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
    assert.equal(s.health().last_flush.held, 0);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('a hook that queues without flushing right after a switch (a tool hook under Y): X\'s next flush does not send it, Y\'s does', async () => {
  const S = await accountServer();
  const asY = env => ({ ...env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y });
  const first = setup(S.url, TOKEN_X), second = setup(S.url, TOKEN_X);
  try {
    // X flushes next: held, never under u_x.
    await first.hook('Stop', { last_assistant_message: 'first-under-X' });
    await first.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo Y-private-tool' } }, asY(first.env));
    assert.equal(S.named('whoami').length, 1, 'the tool hook asked nothing');
    await first.hook('Stop', { last_assistant_message: 'back-under-X' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'back-under-X']);
    assert.deepEqual(heldTexts(first.home), ['Bash: echo Y-private-tool']);

    // Y flushes next: its own.
    S.stored.length = 0;
    await second.hook('Stop', { last_assistant_message: 'first-under-X' });
    await second.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo Y-private-tool' } }, asY(second.env));
    await second.hook('Stop', { last_assistant_message: 'reply-under-Y' }, asY(second.env));
    assert.deepEqual(S.texts('u_y'), ['Bash: echo Y-private-tool', 'reply-under-Y']);
    assert.deepEqual(S.texts('u_x'), ['first-under-X']);
    assert.equal((await heldStats(second.home, CLIENT)).entries, 0);
  } finally { await S.close(); first.dir.cleanup(); second.dir.cleanup(); }
});

test('accounts.json unreadable: nothing is concluded from it; entries queued meanwhile are not sent to another account', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  const file = join(s.home, 'accounts.json');
  try {
    await s.hook('Stop', { last_assistant_message: 'first-under-X' });
    writeFileSync(file, '{"trunc');
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo X-action' } });
    await s.hook('UserPromptSubmit', { prompt: 'X-logged-out' }, s.loggedOut);
    const queued = lines(spoolFile(s.home, CLIENT));
    assert.deepEqual(queued.map(line => Object.keys(line.to)), [['origin', 'at', 'cred'], ['origin', 'at']], 'account unknown, not "first account on this server"');
    assert.equal(readFileSync(file, 'utf8'), '{"trunc', 'queueing does not paper over it');

    await s.hook('Stop', { last_assistant_message: 'under-Y' }, { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y });
    assert.deepEqual(S.texts('u_y'), ['under-Y']);
    assert.deepEqual(heldTexts(s.home), ['Bash: echo X-action', 'X-logged-out']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 2, 'the flush that identified its account records it again');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // X again: its token's entry is X's by evidence once queued again; the one of no known account stays held.
    await s.hook('Stop', { last_assistant_message: 'back-under-X' });
    await replayHeld(s.home, CLIENT);
    await s.hook('Stop', { last_assistant_message: 'last-under-X' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'back-under-X', 'Bash: echo X-action', 'last-under-X']);
    assert.deepEqual(heldTexts(s.home), ['X-logged-out']);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('accounts.json deleted, or the server\'s record evicted: an entry is still not sent to another account', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  const asY = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_Y };
  try {
    // Deleted: the entry carries X's token fingerprint, which is not Y's.
    await s.hook('Stop', { last_assistant_message: 'first-under-X' });
    rmSync(join(s.home, 'accounts.json'));
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo X-after-delete' } });
    await s.hook('Stop', { last_assistant_message: 'under-Y' }, asY);
    assert.deepEqual(S.texts('u_y'), ['under-Y']);
    assert.deepEqual(heldTexts(s.home), ['Bash: echo X-after-delete']);

    // Evicted: eight other servers flush, so this one's record makes room, but it stays known as a server accounts were seen on.
    // X again: its token is identified anew, and the held entry that token queued goes to X.
    await s.hook('Stop', { last_assistant_message: 'X-again' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'X-again', 'Bash: echo X-after-delete']);
    for (let i = 0; i < 8; i++) await destination({ url: 'https://other-' + i + '.example/mcp', token: 'fixture-other-' + i }, async () => ({ user_id: 'u_other', anonymous: false }), s.home, Date.now() + 1000 + i);
    const book = JSON.parse(readFileSync(join(s.home, 'accounts.json'), 'utf8'));
    assert.equal(Object.values(book.origins).filter(record => record.accounts).length, 8);
    assert.deepEqual(Object.keys(book.origins[S.origin]), ['evicted']);
    await s.hook('UserPromptSubmit', { prompt: 'X-logged-out-after-eviction' }, s.loggedOut);
    assert.deepEqual(Object.keys(lines(spoolFile(s.home, CLIENT)).at(-1).to), ['origin', 'at']);
    await s.hook('Stop', { last_assistant_message: 'Y-after-eviction' }, asY);
    assert.deepEqual(S.texts('u_y'), ['under-Y', 'Y-after-eviction']);
    assert.deepEqual(heldTexts(s.home), ['X-logged-out-after-eviction']);
    assert.equal(S.texts('u_y').some(text => text.startsWith('X-') || text.includes('X-after')), false);
  } finally { await S.close(); s.dir.cleanup(); }
});

test('two live tokens of one account used in turn cost one whoami each, not one per alternation; old tokens are pruned', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  const rotated = { ...s.env, CF_MEMORY_ACCESS_TOKEN: TOKEN_X2 };
  try {
    // A tool entry of a token no flush has identified yet waits for that token's own flush (it could be another account's).
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo early' } }, rotated);
    await s.hook('Stop', { last_assistant_message: 'zero' });
    assert.deepEqual([S.texts('u_x'), heldTexts(s.home)], [['zero'], ['Bash: echo early']]);
    await s.hook('Stop', { last_assistant_message: 'zero-rotated' }, rotated);
    assert.deepEqual([S.texts('u_x'), heldTexts(s.home)], [['zero', 'zero-rotated', 'Bash: echo early'], []]);
    S.stored.length = 0;
    for (let i = 0; i < 4; i++) {
      await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo a' + i } }, rotated);
      await s.hook('Stop', { last_assistant_message: 'one-' + i });
      await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo b' + i } });
      await s.hook('Stop', { last_assistant_message: 'two-' + i }, rotated);
    }
    assert.equal(S.named('whoami').length, 2);
    assert.equal(S.texts('u_x').length, 16);
    assert.equal((await heldStats(s.home, CLIENT)).entries, 0);
    // A small set, each token with its own salt; a token unused for long is forgotten.
    const call = async () => ({ user_id: 'u_x', anonymous: false });
    const far = Date.now() + 200 * 86400000;
    for (let i = 0; i < 6; i++) await destination({ url: S.url, token: 'fixture-later-token-' + i }, call, s.home, far + i);
    const [account] = Object.values(JSON.parse(readFileSync(join(s.home, 'accounts.json'), 'utf8')).origins[S.origin].accounts);
    assert.equal(account.tokens.length, 4);
    assert.equal(new Set(account.tokens.map(token => token.salt)).size, 4);
    assert.equal(JSON.stringify(account).includes('fixture-'), false);
    let asked = 0;
    await destination({ url: S.url, token: TOKEN_X }, async () => { asked++; return { user_id: 'u_x', anonymous: false }; }, s.home, far + 10);
    assert.equal(asked, 1, 'the pruned token is asked for again');
  } finally { await S.close(); s.dir.cleanup(); }
});

test('queuedFor names an account only for a token known to be its own, and destination() tells what unknown entries a flush may take', async () => {
  const dir = tempDir('security-spool-');
  const env = { CF_MEMORY_MCP_URL: 'https://one.example/mcp' }, at = 'https://one.example';
  const whoami = user => async () => ({ user_id: user, anonymous: false });
  const as = token => ({ url: env.CF_MEMORY_MCP_URL, token });
  try {
    assert.deepEqual(await queuedFor({}, dir.path, { mcpServers: { 'cf-memory': { url: 'not a url' } } }), {}, 'no usable server: no destination');
    assert.deepEqual(await queuedFor(env, dir.path, {}, 5), { origin: at, at: 5 });
    const first = await destination(as('token-x'), whoami('u_x'), dir.path, 100);
    assert.equal(first.since, 0, 'the first account ever seen takes what was queued before it logged in');
    assert.deepEqual(await queuedFor({ ...env, CF_MEMORY_ACCESS_TOKEN: 'token-x' }, dir.path, {}, 150), { origin: at, account: first.account });
    // The same token from ~/.claude.json; a token for another server is not at hand for this one.
    assert.deepEqual(await queuedFor({}, dir.path, { mcpServers: { 'cf-memory': { url: env.CF_MEMORY_MCP_URL, headers: { Authorization: 'Bearer token-x' } } } }, 150), { origin: at, account: first.account });
    assert.deepEqual(await queuedFor(env, dir.path, { mcpServers: { 'cf-memory': { url: 'https://two.example/mcp', headers: { Authorization: 'Bearer token-x' } } } }, 150), { origin: at, at: 150 });
    const unknown = await queuedFor({ ...env, CF_MEMORY_ACCESS_TOKEN: 'token-y' }, dir.path, {}, 160);
    assert.deepEqual(Object.keys(unknown), ['origin', 'at', 'cred']);
    assert.equal((await destination(as('token-x'), whoami('u_x'), dir.path, 200)).since, 0);

    const y = await destination(as('token-y'), whoami('u_y'), dir.path, 300);
    assert.equal(y.since, null, 'X flushed last: nothing of unknown account is Y\'s');
    assert.deepEqual(y.creds, [unknown.cred]);
    assert.deepEqual(Object.values(y.others), [first.account]);
    assert.equal((await destination(as('token-y'), whoami('u_y'), dir.path, 400)).since, 300, 'from its first flush on');
    const back = await destination(as('token-x'), async () => { throw Error('not asked'); }, dir.path, 500);
    assert.deepEqual([back.account, back.since], [first.account, null], 'a remembered token still ends the other account\'s run');
    assert.equal((await destination(as('token-x'), whoami('u_x'), dir.path, 600)).since, 500);
    for (const name of ['accounts.json', 'accounts.key']) {
      assert.equal(statSync(join(dir.path, name)).mode & 0o777, 0o600, name);
      assert.equal(/token-[xy]|u_[xy]/.test(readFileSync(join(dir.path, name), 'utf8')), false, name);
    }
  } finally { dir.cleanup(); }
});

test('replay-held selects by destination, unknown account, session and time; the rest stays held', async () => {
  const dir = tempDir('security-spool-');
  try {
    const one = 'https://one.example', account = 'a'.repeat(16);
    const queued = [
      [entry('x-known', { ts: 1000 }), { origin: one, account }],
      [entry('unknown-s1-early', { ts: 1000, session_id: 's1' }), { origin: one, at: 1000 }],
      [entry('unknown-s1-late', { ts: 5000, session_id: 's1' }), { origin: one, at: 5000 }],
      [entry('unknown-s2', { ts: 5000, session_id: 's2' }), { origin: one, at: 5000 }],
      [entry('elsewhere', { ts: 5000, session_id: 's1' }), { origin: 'https://two.example', at: 5000 }],
      [entry('nowhere', { ts: 5000, session_id: 's1' }), {}],
    ];
    for (const [e, to] of queued) await appendEntries(dir.path, CLIENT, [e], to);
    await flush(dir.path, CLIENT, async () => ({}), { to: { origin: 'https://three.example', account, since: 0 } });
    assert.equal((await heldStats(dir.path, CLIENT)).entries, 6);
    assert.deepEqual((await heldGroups(dir.path, CLIENT)).map(group => [group.origin, group.state, group.entries]), [[one, 'account', 1], [one, 'unknown', 3], ['https://two.example', 'unknown', 1], [null, 'none', 1]]);

    const sent = [];
    const here = { origin: one, account: 'f'.repeat(16) };
    const deliver = () => flush(dir.path, CLIENT, async batch => { sent.push(...batch.map(e => e.text)); return {}; }, { to: { ...here, since: null } });
    // One session, from a time on, sent to the account the operator names: exactly that entry.
    assert.deepEqual(await replayHeld(dir.path, CLIENT, here, { origin: one, unknown: true, session: 's1', since: 2000 }), { replayed: 1, invalid: 0, kept: 5 });
    await deliver();
    assert.deepEqual(sent, ['unknown-s1-late']);
    assert.equal(statSync(heldFile(dir.path, CLIENT)).mode & 0o777, 0o600);
    assert.deepEqual(await replayHeld(dir.path, CLIENT, here, { origin: one, unknown: true, until: 1000 }), { replayed: 1, invalid: 0, kept: 4 });
    assert.deepEqual(await replayHeld(dir.path, CLIENT, here, { origin: 'none' }), { replayed: 1, invalid: 0, kept: 3 });
    await deliver();
    assert.deepEqual(sent, ['unknown-s1-late', 'unknown-s1-early', 'nowhere']);
    // By account, as it is: still the other account's, so held again by this flush.
    assert.deepEqual(await replayHeld(dir.path, CLIENT, undefined, { account }), { replayed: 1, invalid: 0, kept: 2 });
    await deliver();
    assert.deepEqual(heldTexts(dir.path).sort(), ['elsewhere', 'unknown-s2', 'x-known']);
    assert.deepEqual(sent, ['unknown-s1-late', 'unknown-s1-early', 'nowhere']);
    await assert.rejects(replayHeld(dir.path, CLIENT, { origin: one }, { unknown: true }), /names no account/);
    assert.equal((await heldStats(dir.path, CLIENT)).entries, 3, 'a refused replay moves nothing');
  } finally { dir.cleanup(); }
});

test('held.jsonl is capped: past 16 MB held entries are dropped and counted, doctor reports it, and held bytes no longer stop new action entries', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  try {
    await s.hook('Stop', { last_assistant_message: 'first' });
    writeFileSync(heldFile(s.home, CLIENT), '', { mode: 0o600 });
    truncateSync(heldFile(s.home, CLIENT), SPOOL_ACTION_CAP_BYTES + 1); // sparse: no entries, only size
    assert.ok(HELD_CAP_BYTES < SPOOL_ACTION_CAP_BYTES);
    const action = makeEntry({ client: CLIENT, session_id: 'security-session', repo: '', ts: Date.now(), kind: 'action', text: 'Bash: echo kept' });
    assert.deepEqual(await appendEntries(s.home, CLIENT, [action], { origin: S.origin, account: 'b'.repeat(16) }), { appended: 1, dropped: 0 });
    await s.hook('Stop', { last_assistant_message: 'mine' });
    assert.deepEqual(S.texts('u_x'), ['first', 'mine']);
    assert.deepEqual([s.health().last_flush.held, s.health().last_flush.held_dropped, s.health().held_dropped_total], [0, 1, 1]);
    assert.equal(statSync(heldFile(s.home, CLIENT)).size, SPOOL_ACTION_CAP_BYTES + 1, 'nothing was added to the full file');
    const report = await s.report();
    assert.equal(report.clients[CLIENT].spool.held_dropped, 1);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some(problem => problem.includes('dropped') && problem.includes('16 MB')), JSON.stringify(report.problems));
  } finally { await S.close(); s.dir.cleanup(); }
});

test('entries held although they are the configured account\'s: doctor prints the command that queues exactly those, as they are', async () => {
  const S = await accountServer();
  const s = setup(S.url, TOKEN_X);
  try {
    await s.hook('Stop', { last_assistant_message: 'first-under-X' });
    const mine = await queuedFor(s.env, s.home), other = { origin: S.origin, account: 'b'.repeat(16) };
    assert.match(mine.account, /^[0-9a-f]{16}$/);
    await appendEntries(s.home, CLIENT, [entry('X-held')], mine);
    await appendEntries(s.home, CLIENT, [entry('other-held')], other);
    await flush(s.home, CLIENT, async () => ({}), { to: { origin: 'https://elsewhere.example', account: 'c'.repeat(16) } });
    assert.deepEqual(heldTexts(s.home), ['X-held', 'other-held']);
    const report = await s.report();
    assert.equal(report.ok, false);
    assert.equal(report.problems.length, 1);
    assert.ok(report.problems[0].includes('queued by the account now configured'), report.problems[0]);
    // The other account's entries are a warning, with a command that keeps them that account's.
    const warning = report.warnings.find(line => line.includes(other.account));
    assert.ok(warning.endsWith('replay-held --client ' + CLIENT + ' --origin ' + S.origin + ' --account ' + other.account), warning);
    const argv = printedReplay(report.problems[0]);
    assert.equal(argv.includes('--to-current'), false);
    assert.deepEqual(await replayHeldCommand(argv, s.env), { [CLIENT]: { replayed: 1, invalid: 0, kept: 1 } });
    await s.hook('Stop', { last_assistant_message: 'done' });
    assert.deepEqual(S.texts('u_x'), ['first-under-X', 'X-held', 'done']);
    assert.deepEqual(heldTexts(s.home), ['other-held']);
    assert.equal((await s.report()).ok, true);
  } finally { await S.close(); s.dir.cleanup(); }
});
