import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushCommand } from '../scripts/agent.mjs';
import { doctor } from '../scripts/doctor.mjs';
import { makeEntry } from '../scripts/entries.mjs';
import { appendEntries, pendingStats } from '../scripts/spool.mjs';
import { queuedFor } from '../scripts/transport.mjs';
import { PLUGIN_VERSION } from '../scripts/version.mjs';
import { CODEX_APPROVAL, parseInstallArgs } from '../scripts/install.mjs';
import { fakeServer, tempDir, testEnv, TEST_TOKEN } from './helpers/fake-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agent = join(root, 'scripts', 'agent.mjs'), codexHook = join(root, 'scripts', 'codex-hook.mjs');

function run(script, args, env, input = '') {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

test('Claude hook processes: prompt prints the recall JSON, tool hooks print nothing', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const env = testEnv(dir.path, server.url);
    const prompt = await run(agent, ['user-prompt-submit'], env, JSON.stringify({ session_id: 's1', cwd: dir.path, hook_event_name: 'UserPromptSubmit', prompt: 'What changed in the spool?' }));
    assert.equal(prompt.code, 0);
    const output = JSON.parse(prompt.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /remembered: the fixture project uses vitest/);
    const tool = await run(agent, ['post-tool-use'], env, JSON.stringify({ session_id: 's1', cwd: dir.path, hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'flush', path: 'scripts' }, tool_response: { numFiles: 2 } }));
    assert.deepEqual([tool.code, tool.stdout], [0, '']);
    const failure = await run(agent, ['post-tool-use-failure'], env, JSON.stringify({ session_id: 's1', cwd: dir.path, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'Exit code 2' }));
    assert.deepEqual([failure.code, failure.stdout], [0, '']);
    const stop = await run(agent, ['stop'], env, JSON.stringify({ session_id: 's1', cwd: dir.path, hook_event_name: 'Stop', last_assistant_message: 'Finished.' }));
    assert.deepEqual([stop.code, stop.stdout], [0, '']);
    const start = await run(agent, ['session-start'], env, JSON.stringify({ session_id: 's2', cwd: dir.path, hook_event_name: 'SessionStart', source: 'startup' }));
    assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    const kinds = server.named('log_append').flatMap(c => c.args.entries).map(e => e.kind);
    assert.deepEqual(kinds, ['prompt', 'action', 'action', 'error', 'reply']);
  } finally { await server.close(); dir.cleanup(); }
});

test('Codex hook process always prints one JSON object', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const env = testEnv(dir.path, server.url);
    const base = { session_id: 'c1', turn_id: 't1', cwd: dir.path };
    const prompt = await run(codexHook, [], env, JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Add a flag' }));
    assert.equal(prompt.code, 0);
    assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    for (const payload of [
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { exit_code: 0, stdout: '' } },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'wait_agent', tool_input: {}, tool_response: {} },
      { ...base, hook_event_name: 'Stop', last_assistant_message: 'Done.', stop_hook_active: false },
      { ...base, hook_event_name: 'PreCompact' },
    ]) {
      const result = await run(codexHook, [], env, JSON.stringify(payload));
      assert.deepEqual([result.code, result.stdout.trim()], [0, '{}'], payload.hook_event_name);
    }
    const start = await run(codexHook, [], env, JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }));
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /core memory/);
    assert.deepEqual(server.named('log_append').flatMap(c => c.args.entries).map(e => [e.client, e.kind]), [['codex', 'prompt'], ['codex', 'action'], ['codex', 'reply']]);
  } finally { await server.close(); dir.cleanup(); }
});

test('hooks exit 0 on malformed input and on an unusable home', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const env = testEnv(dir.path, server.url);
    for (const input of ['', 'not json', '[1,2]', '{"hook_event_name":']) {
      const claude = await run(agent, ['post-tool-use'], env, input);
      assert.deepEqual([claude.code, claude.stdout], [0, ''], JSON.stringify(input));
      const codex = await run(codexHook, [], env, input);
      assert.deepEqual([codex.code, codex.stdout.trim()], [0, '{}'], JSON.stringify(input));
    }
    const file = join(dir.path, 'plain-file');
    writeFileSync(file, 'x');
    const broken = await run(agent, ['user-prompt-submit'], { ...env, CF_MEMORY_AGENT_HOME: file }, JSON.stringify({ session_id: 's', cwd: dir.path, hook_event_name: 'UserPromptSubmit', prompt: 'hi there' }));
    assert.equal(broken.code, 0);
    assert.equal(broken.stderr, '');
  } finally { await server.close(); dir.cleanup(); }
});

test('a hanging server cannot hold a hook past its budget; the entry stays queued', async () => {
  const dir = tempDir(), server = await fakeServer({ hang: name => name === 'log_append' });
  try {
    const env = testEnv(dir.path, server.url);
    const result = await run(agent, ['post-tool-use'], env, JSON.stringify({ session_id: 's', cwd: dir.path, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.equal(result.code, 0);
    assert.ok(result.ms < 4800, 'finished in ' + result.ms + ' ms');
    assert.ok((await pendingStats(env.CF_MEMORY_AGENT_HOME, 'claude-code')).bytes > 0);
  } finally { await server.close(); dir.cleanup(); }
});

test('doctor reports versions, settings, auth, spool and last flush without printing the token', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const env = testEnv(dir.path, server.url, { CF_MEMORY_RECALL_BUDGET: '1800' });
    await run(agent, ['stop'], env, JSON.stringify({ session_id: 's', cwd: dir.path, hook_event_name: 'Stop', last_assistant_message: 'ok' }));
    const result = await run(agent, ['doctor'], env);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!result.stdout.includes(TEST_TOKEN));
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.agent.version, PLUGIN_VERSION);
    assert.equal(report.agent.node, process.version);
    assert.deepEqual(report.auth, { configured: true, reachable: true, source: 'env', server: server.url, latency_ms: report.auth.latency_ms });
    assert.deepEqual(report.settings.CF_MEMORY_RECALL_BUDGET, { value: 1800, source: 'env' });
    assert.deepEqual(report.settings.CF_MEMORY_LOG_ENABLED, { value: true, source: 'default' });
    const claude = report.clients['claude-code'];
    assert.equal(claude.spool.pending_entries, 0);
    assert.ok(claude.last_successful_flush);
    assert.equal(claude.last_flush.sent, 1);
    assert.deepEqual([claude.last_flush.dropped_over_total_cap, claude.last_flush.ts_clamped], [0, 0], 'server drop and clamp counters are reported');
    assert.equal(claude.last_error, null);
    assert.ok('codex' in report.clients);
    const codex = await run(codexHook, ['doctor'], env);
    assert.equal(JSON.parse(codex.stdout).agent.version, PLUGIN_VERSION);
  } finally { await server.close(); dir.cleanup(); }
});

test('doctor without credentials says so and exits 1', async () => {
  const dir = tempDir();
  try {
    const env = testEnv(dir.path, null, { CF_MEMORY_MCP_URL: 'http://127.0.0.1:9/mcp' });
    const result = await run(agent, ['doctor', '--no-versions'], env);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.auth, { configured: false, reachable: false, error: 'no_credentials' });
  } finally { dir.cleanup(); }
});

test('install --dry-run prints the files for both clients and writes nothing', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home');
    const result = await run(agent, ['install', '--dry-run', '--home', home], testEnv(dir.path, null));
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dry_run, true);
    const claude = report.clients['claude-code'], codex = report.clients.codex;
    assert.deepEqual(claude.commands.map(c => c.args.slice(0, 2)), [['plugin', 'marketplace'], ['plugin', 'install'], ['plugin', 'update']]);
    assert.ok(claude.files.some(f => f.path === join(home, '.claude', 'plugins', 'cache', 'cf-memory', 'cf-memory-agent', PLUGIN_VERSION, 'hooks', 'hooks.json')));
    assert.ok(claude.files.some(f => f.path.endsWith(join('scripts', 'agent.mjs'))));
    assert.ok(codex.files.some(f => f.path === join(home, '.codex', 'hooks.json')));
    assert.ok(codex.files.some(f => f.path.startsWith(codex.package_dir) && f.path.endsWith(join('scripts', 'codex-hook.mjs'))));
    assert.equal(codex.approval, CODEX_APPROVAL);
    assert.match(codex.approval, /\/hooks/);
    assert.deepEqual(Object.keys(codex.hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.ok(report.next.includes(CODEX_APPROVAL));
    assert.equal(existsSync(home), false, 'nothing written');
  } finally { dir.cleanup(); }
});

test('install --home writes the Codex package and hooks, keeps other hooks, replaces old cf-memory handlers', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const userHook = { type: 'command', command: 'echo mine', statusMessage: 'Mine' };
    const oldServer = { type: 'command', command: "'/usr/bin/node' '/x/.codex/cf-memory-agent/0.2.159-0123456789abcdef/scripts/codex-hook.mjs'", timeout: 5, statusMessage: 'cf-memory agent (PostToolUse)' };
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [userHook, oldServer] }], PreCompact: [{ hooks: [{ ...oldServer, statusMessage: 'cf-memory agent (PreCompact)' }] }] } }));
    const result = await run(agent, ['install', '--client', 'codex', '--home', home], testEnv(dir.path, null));
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout).clients.codex;
    const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const post = hooks.PostToolUse.flatMap(g => g.hooks);
    assert.deepEqual(post.map(h => h.statusMessage), ['Mine', 'cf-memory agent (PostToolUse)']);
    assert.ok(post[1].command.includes(join(report.package_dir, 'scripts', 'codex-hook.mjs')));
    assert.ok(existsSync(join(report.package_dir, 'scripts', 'codex-hook.mjs')));
    assert.ok(existsSync(join(report.package_dir, 'hooks', 'codex-hooks.json')));
    assert.equal(readdirSync(codexHome).filter(n => n.startsWith('hooks.json.cf-memory-backup-')).length, 1);
    assert.equal(JSON.parse(readFileSync(join(home, '.cf-memory', 'v3', 'install-codex.json'), 'utf8')).version, PLUGIN_VERSION);
    assert.ok(!readdirSync(codexHome).some(n => /trust|config\.toml/.test(n)), 'no trust or config state written');
    // The installed hook runs through the shell as Codex runs it, with the user's NODE_OPTIONS cleared, and answers with JSON.
    const command = post[1].command;
    assert.match(command, /^NODE_OPTIONS= '.+' '.+codex-hook\.mjs'$/);
    const hookRun = await new Promise(resolve => {
      const child = spawn('/bin/sh', ['-c', command], { env: { ...testEnv(dir.path, null), NODE_OPTIONS: '--require /nonexistent/preload.js' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', d => { stdout += d; });
      child.on('close', code => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ session_id: 'c', hook_event_name: 'Stop', last_assistant_message: 'x' }));
    });
    assert.deepEqual([hookRun.code, hookRun.stdout.trim()], [0, '{}']);
    // Second install: nothing changes.
    const again = JSON.parse((await run(agent, ['install', '--client', 'codex', '--home', home], testEnv(dir.path, null))).stdout).clients.codex;
    assert.equal(again.hooks_changed, false);
    assert.equal(again.package_exists, true);
  } finally { dir.cleanup(); }
});

test('install --home for Claude Code verifies the marketplace, version and files in that home', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), log = join(dir.path, 'claude-calls.log');
    const fake = fakeClaude(dir, log, { includeHome: true });
    const result = await run(agent, ['install', '--client', 'claude-code', '--home', home], testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fake }));
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout).clients['claude-code'];
    assert.equal(report.verified, true);
    assert.ok(report.results.every(r => r.ok));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 3);
    assert.ok(calls.every(line => line.startsWith(home + '|' + join(home, '.claude') + '|plugin ')));
    assert.match(calls[0], /plugin marketplace add .+/);
    assert.match(calls[1], /plugin install cf-memory-agent@cf-memory --scope user$/);
  } finally { dir.cleanup(); }
});

test('Claude Code install fails if every plugin command fails, even with an old matching registry entry', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: '/usr/bin/false' });
    for (const records of [[], [{ scope: 'user', version: PLUGIN_VERSION }]]) {
      writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'cf-memory-agent@cf-memory': records } }));
      const result = await run(agent, ['install', '--client', 'claude-code', '--home', home], env);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Could not verify the cf-memory Claude marketplace/);
      const report = JSON.parse(result.stdout).clients['claude-code'];
      assert.equal(report.verified, false);
      assert.ok(report.results.every(item => !item.ok));
    }
  } finally { dir.cleanup(); }
});

test('Claude Code uninstall distinguishes a remaining plugin, an unreadable registry and an already absent plugin', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const file = join(plugins, 'installed_plugins.json');
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: '/usr/bin/false' });
    const cases = [
      [JSON.stringify({ plugins: { 'cf-memory-agent@cf-memory': [{ scope: 'user', version: PLUGIN_VERSION }] } }), 1, /still installed/],
      ['{', 1, /Could not verify/],
      [JSON.stringify({ plugins: { 'cf-memory-agent@cf-memory': [{ scope: 'project', version: PLUGIN_VERSION }] } }), 0, /^$/],
    ];
    for (const [contents, status, message] of cases) {
      writeFileSync(file, contents);
      const result = await run(agent, ['uninstall', '--client', 'claude-code', '--home', home], env);
      assert.equal(result.code, status);
      assert.match(result.stderr.trim(), message);
      assert.equal(JSON.parse(result.stdout).clients['claude-code'].verified, status === 0);
      assert.equal(readFileSync(file, 'utf8'), contents);
    }
  } finally { dir.cleanup(); }
});

// ---- Round 2: uninstall, pruning, the legacy recall hook, old variables ----

function fakeClaude(dir, log, { includeHome = false, corruptCache = false } = {}) {
  const fake = join(dir.path, 'fake-claude.cjs');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const config = process.env.CLAUDE_CONFIG_DIR;
const prefix = ${includeHome} ? process.env.HOME + '|' + config + '|' : '';
fs.appendFileSync(${JSON.stringify(log)}, prefix + args.join(' ') + '\\n');
const plugins = join(config, 'plugins');
const markets = join(plugins, 'known_marketplaces.json');
const installed = join(plugins, 'installed_plugins.json');
if (args[1] === 'marketplace' && args[2] === 'add') {
  const path = args[3];
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(markets, JSON.stringify({ 'cf-memory': { source: { source: 'directory', path }, installLocation: path } }));
}
if (args[1] === 'update') {
  const registry = JSON.parse(fs.readFileSync(markets, 'utf8'));
  const version = ${JSON.stringify(PLUGIN_VERSION)};
  const installPath = join(plugins, 'cache', 'cf-memory', 'cf-memory-agent', version);
  fs.cpSync(join(registry['cf-memory'].installLocation, 'cf-memory-agent'), installPath, { recursive: true });
  if (${corruptCache}) fs.appendFileSync(join(installPath, 'README.md'), '\\nDifferent cached bytes.\\n');
  fs.writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'cf-memory-agent@cf-memory': [{ scope: 'user', version, installPath }] } }));
}
if (args[1] === 'uninstall') fs.rmSync(installed, { force: true });
`);
  chmodSync(fake, 0o755);
  return fake;
}
const legacySettings = { env: { KEEP: '1' }, hooks: {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: '$HOME/.claude/hooks/cf-memory-recall.sh' }, { type: 'command', command: 'other-recall' }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/cf-memory-recall.sh --start' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }],
} };

test('a different registered Claude marketplace is preserved and blocks installation', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), plugins = join(home, '.claude', 'plugins'), log = join(dir.path, 'calls.log');
    const other = join(dir.path, 'another-checkout');
    mkdirSync(other);
    mkdirSync(plugins, { recursive: true });
    const marketplace = join(plugins, 'known_marketplaces.json');
    const existing = JSON.stringify({ 'cf-memory': { source: { source: 'directory', path: other }, installLocation: other } });
    writeFileSync(marketplace, existing);
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fakeClaude(dir, log) });
    const result = await run(agent, ['install', '--client', 'claude-code', '--home', home], env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /verify the cf-memory Claude marketplace/);
    assert.equal(existsSync(log), false);
    assert.equal(readFileSync(marketplace, 'utf8'), existing);
  } finally { dir.cleanup(); }
});

test('Claude setup leaves the legacy hook when installed package bytes do not match', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), settings = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify(legacySettings));
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fakeClaude(dir, join(dir.path, 'calls.log'), { corruptCache: true }) });
    const result = await run(agent, ['install', '--client', 'claude-code', '--home', home], env);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).clients['claude-code'].verified, false);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), legacySettings);
  } finally { dir.cleanup(); }
});

test('Codex setup refuses a modified cache without changing its hooks', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), env = testEnv(dir.path, null);
    const args = ['install', '--client', 'codex', '--home', home];
    const first = await run(agent, args, env);
    assert.equal(first.code, 0, first.stderr);
    const report = JSON.parse(first.stdout).clients.codex;
    const hooks = readFileSync(report.hooks_file, 'utf8');
    writeFileSync(join(report.package_dir, 'README.md'), 'Outdated copy');
    const second = await run(agent, args, env);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /refusing an existing Codex Agent package/);
    assert.equal(readFileSync(report.hooks_file, 'utf8'), hooks);
  } finally { dir.cleanup(); }
});

test('install removes the old cf-memory-recall.sh hook once the plugin is in place (backed up); dry-run only reports it', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), settings = join(home, '.claude', 'settings.json'), log = join(dir.path, 'calls.log');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify(legacySettings));
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fakeClaude(dir, log) });
    const dry = JSON.parse((await run(agent, ['install', '--client', 'claude-code', '--dry-run', '--home', home], env)).stdout).clients['claude-code'];
    assert.equal(dry.legacy.legacy_recall_hooks, 2);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), legacySettings, 'dry-run writes nothing');
    const report = JSON.parse((await run(agent, ['install', '--client', 'claude-code', '--home', home], env)).stdout).clients['claude-code'];
    assert.equal(report.verified, true);
    assert.equal(report.legacy.legacy_recall_hooks, 2);
    assert.deepEqual(JSON.parse(readFileSync(report.legacy.backup, 'utf8')), legacySettings);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { env: { KEEP: '1' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-recall' }] }], Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }] } });
  } finally { dir.cleanup(); }
});

test('install keeps the 2 newest hooks.json backups and Codex package copies', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), codexHome = join(home, '.codex'), env = testEnv(dir.path, null);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    for (const at of [1000, 2000, 3000]) writeFileSync(join(codexHome, 'hooks.json.cf-memory-backup-' + at), '{}');
    const old = ['0.2.1-0000000000000001', '0.2.2-0000000000000002', '0.2.3-0000000000000003'].map((name, i) => {
      const path = join(codexHome, 'cf-memory-agent', name);
      mkdirSync(path, { recursive: true });
      utimesSync(path, new Date(Date.now() - (5 - i) * 86400000), new Date(Date.now() - (5 - i) * 86400000));
      return path;
    });
    const report = JSON.parse((await run(agent, ['install', '--client', 'codex', '--home', home], env)).stdout).clients.codex;
    const backups = readdirSync(codexHome).filter(name => name.startsWith('hooks.json.cf-memory-backup-')).sort();
    assert.equal(backups.length, 2);
    assert.ok(backups.includes('hooks.json.cf-memory-backup-3000'), backups.join());
    assert.deepEqual(readdirSync(join(codexHome, 'cf-memory-agent')).sort(), [basename(old[2]), basename(report.package_dir)].sort());
  } finally { dir.cleanup(); }
});

test('uninstall removes only cf-memory: the Codex handlers, package copies and record, the plugin, the old recall hook', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), codexHome = join(home, '.codex'), log = join(dir.path, 'calls.log');
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fakeClaude(dir, log) });
    mkdirSync(codexHome, { recursive: true });
    const mine = { type: 'command', command: 'echo mine', statusMessage: 'Mine' };
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [mine] }] } }));
    assert.equal((await run(agent, ['install', '--home', home], env)).code, 0);
    mkdirSync(join(home, '.cf-memory', 'v3', 'spool'), { recursive: true });
    writeFileSync(join(home, '.cf-memory', 'v3', 'spool', 'codex.jsonl'), '');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(legacySettings));
    const before = readFileSync(join(codexHome, 'hooks.json'), 'utf8');
    const dry = JSON.parse((await run(agent, ['uninstall', '--dry-run', '--home', home], env)).stdout);
    assert.equal(dry.clients.codex.hooks_changed, true);
    assert.equal(readFileSync(join(codexHome, 'hooks.json'), 'utf8'), before, 'dry-run writes nothing');
    const result = await run(agent, ['uninstall', '--home', home], env);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')), { hooks: { PostToolUse: [{ matcher: '.*', hooks: [mine] }] } });
    assert.equal(readFileSync(report.clients.codex.backup, 'utf8'), before);
    assert.equal(existsSync(join(codexHome, 'cf-memory-agent')), false);
    assert.equal(existsSync(join(home, '.cf-memory', 'v3', 'install-codex.json')), false);
    assert.ok(existsSync(join(home, '.cf-memory', 'v3', 'spool', 'codex.jsonl')), 'the Agent data stays');
    assert.match(readFileSync(log, 'utf8'), /plugin uninstall cf-memory-agent@cf-memory --scope user/);
    assert.equal(report.clients['claude-code'].installed_version, null);
    assert.equal(report.clients['claude-code'].legacy.legacy_recall_hooks, 2);
    assert.ok(!readFileSync(join(home, '.claude', 'settings.json'), 'utf8').includes('cf-memory-recall.sh'));
  } finally { dir.cleanup(); }
});

test('the old CF_MEMORY_CODEX_HOOKS_FILE / CF_MEMORY_CODEX_CONFIG_DIR are refused unless they name the real Codex paths', async () => {
  const dir = tempDir();
  try {
    const env = testEnv(dir.path, null);
    for (const extra of [{ CF_MEMORY_CODEX_HOOKS_FILE: join(dir.path, 'other.json') }, { CF_MEMORY_CODEX_CONFIG_DIR: join(dir.path, 'other') }]) {
      const result = await run(agent, ['install', '--client', 'codex', '--dry-run'], { ...env, ...extra });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /CF_MEMORY_CODEX_CONFIG_DIR and CF_MEMORY_CODEX_HOOKS_FILE are no longer read/);
    }
    const same = await run(agent, ['install', '--client', 'codex', '--dry-run'], { ...env, CF_MEMORY_CODEX_HOOKS_FILE: join(dir.path, '.codex', 'hooks.json') });
    assert.equal(same.code, 0, same.stderr);
  } finally { dir.cleanup(); }
});

// ---- Round 3 ----

test('UserPromptSubmit in a parent of many checkouts queues the prompt before a bounded child scan (slow git, review r7)', async () => {
  const dir = tempDir(), server = await fakeServer();
  try {
    const parent = join(dir.path, 'Develop'), bin = join(dir.path, 'bin');
    for (let i = 0; i < 40; i++) mkdirSync(join(parent, 'repo' + i), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 0.4\nexit 1\n'); // a slow git (network mount, cold xcrun shim)
    chmodSync(join(bin, 'git'), 0o755);
    const env = { ...testEnv(dir.path, server.url), PATH: bin + ':' + process.env.PATH };
    const live = join(env.CF_MEMORY_AGENT_HOME, 'spool', 'claude-code.jsonl'), started = Date.now();
    let queuedAt = null;
    const poll = setInterval(() => { try { if (queuedAt === null && readFileSync(live, 'utf8').includes('remember this decision')) queuedAt = Date.now() - started; } catch {} }, 10);
    const result = await run(agent, ['user-prompt-submit'], env, JSON.stringify({ session_id: 's', cwd: parent, hook_event_name: 'UserPromptSubmit', prompt: 'remember this decision' }));
    clearInterval(poll);
    assert.equal(result.code, 0);
    assert.ok(result.ms < 5000, 'finished in ' + result.ms + ' ms');
    assert.ok(queuedAt !== null && result.ms - queuedAt > 1000, 'queued before the scan: at ' + queuedAt + ' of ' + result.ms + ' ms');
    assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.startsWith('cf-memory 自動想起'), 'recall still answers');
    // Delivered, or (the scan used up the prompt's flush share) waiting for the next hook; never lost.
    const delivered = server.named('log_append').flatMap(c => c.args.entries).some(e => e.text === 'remember this decision');
    assert.ok(delivered || (await pendingStats(env.CF_MEMORY_AGENT_HOME, 'claude-code', { count: true })).entries === 1);
    const cached = JSON.parse(readFileSync(join(env.CF_MEMORY_AGENT_HOME, 'repo-cache.json'), 'utf8')).entries[parent];
    assert.equal(typeof cached.scan_after, 'string', 'the next prompt goes on with the scan');
  } finally { await server.close(); dir.cleanup(); }
});

test('install edits a symlinked settings.json at its target (backup next to it) and keeps every other key, empty arrays too', async () => {
  const dir = tempDir();
  try {
    const home = join(dir.path, 'home'), dotfiles = join(dir.path, 'dotfiles'), target = join(dotfiles, 'claude-settings.json'), link = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(dotfiles);
    const original = { ...legacySettings, hooks: { ...legacySettings.hooks, Notification: [] }, permissions: { allow: [], deny: [] } };
    writeFileSync(target, JSON.stringify(original));
    symlinkSync(target, link);
    const env = testEnv(dir.path, null, { CF_MEMORY_CLAUDE_BIN: fakeClaude(dir, join(dir.path, 'calls.log')) }), doctorEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
    const warning = (await doctor({ env: doctorEnv, versions: false })).warnings.find(w => w.includes('cf-memory-recall.sh'));
    assert.ok(warning?.startsWith(link + ' (a symlink to ' + realpathSync(target) + ') still runs the old cf-memory-recall.sh hook (2)'), warning);
    // A target that cannot be written: install says what to remove by hand and changes nothing.
    chmodSync(dotfiles, 0o555);
    let report;
    try { report = JSON.parse((await run(agent, ['install', '--client', 'claude-code', '--home', home], env)).stdout).clients['claude-code']; } finally { chmodSync(dotfiles, 0o755); }
    assert.match(report.legacy.error, /^could not write .+claude-settings\.json \(EACCES\): remove the hooks running ~\/\.claude\/hooks\/cf-memory-recall\.sh from it by hand$/);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), original);
    report = JSON.parse((await run(agent, ['install', '--client', 'claude-code', '--home', home], env)).stdout).clients['claude-code'];
    assert.deepEqual([report.legacy.legacy_recall_hooks, report.legacy.target, report.legacy.error], [2, realpathSync(target), undefined]);
    assert.ok(lstatSync(link).isSymbolicLink(), 'the link stays');
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { env: { KEEP: '1' }, permissions: { allow: [], deny: [] }, hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other-recall' }] }], Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }], Notification: [],
    } });
    assert.equal(dirname(report.legacy.backup), realpathSync(dotfiles));
    assert.deepEqual(JSON.parse(readFileSync(report.legacy.backup, 'utf8')), original);
    assert.equal((await doctor({ env: doctorEnv, versions: false })).warnings.some(w => w.includes('cf-memory-recall.sh')), false);
  } finally { dir.cleanup(); }
});

test('install refuses an empty --home= as it refuses --home ""', async () => {
  assert.throws(() => parseInstallArgs(['--home=']), /--home needs a directory/);
  assert.throws(() => parseInstallArgs(['--home', '']), /--home needs a directory/);
  assert.equal(parseInstallArgs(['--home=/somewhere']).home, '/somewhere');
  const dir = tempDir();
  try {
    const result = await run(agent, ['install', '--dry-run', '--home='], testEnv(dir.path, null));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--home needs a directory/);
    assert.equal(result.stdout, '');
  } finally { dir.cleanup(); }
});

test('agent.mjs flush records a timeout after partial delivery as progress, as the hooks do', async () => {
  const dir = tempDir(), server = await fakeServer({ delay: name => name === 'log_append' ? 400 : 0 });
  try {
    const env = testEnv(dir.path, server.url), home = env.CF_MEMORY_AGENT_HOME;
    await appendEntries(home, 'codex', Array.from({ length: 200 }, (_, i) => makeEntry({ client: 'codex', session_id: 's', ts: 1790000000000 + i, kind: 'action', text: 'Bash: echo ' + i })), await queuedFor(env, home));
    const report = await flushCommand(['--client', 'codex'], env, 1000);
    assert.equal(report.codex.error, 'timeout');
    assert.ok(report.codex.sent >= 50 && report.codex.sent < 200, 'sent ' + report.codex.sent);
    const health = JSON.parse(readFileSync(join(home, 'health', 'codex.json'), 'utf8'));
    assert.deepEqual([health.last_flush.ok, health.last_flush.partial, health.last_flush.sent, health.last_flush_error_at, health.last_error], [true, true, report.codex.sent, undefined, undefined]);
    assert.equal((await doctor({ env: { ...env, CLAUDE_CONFIG_DIR: join(dir.path, '.claude'), CODEX_HOME: join(dir.path, '.codex') }, versions: false })).clients.codex.flush_failing, false);
  } finally { await server.close(); dir.cleanup(); }
});
