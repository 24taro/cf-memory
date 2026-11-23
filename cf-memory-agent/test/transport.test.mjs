import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentials, failureCode } from '../scripts/transport.mjs';
import { tempDir, testEnv } from './helpers/fake-server.mjs';

const CONFIG_TOKEN = 'fixture-config-token-not-a-secret';

function withConfig(dir, url) {
  const file = join(dir.path, 'claude.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { 'cf-memory': { url, headers: { Authorization: 'Bearer ' + CONFIG_TOKEN } } } }));
  return { ...testEnv(dir.path, null), CF_MEMORY_CLAUDE_CONFIG: file };
}
const failure = promise => promise.then(() => 'resolved', error => failureCode(error));

test('uses the active Claude user profile for MCP credentials', async () => {
  const dir = tempDir();
  try {
    const env = testEnv(dir.path, null, { CLAUDE_CONFIG_DIR: join(dir.path, 'claude-profile') });
    delete env.CF_MEMORY_CLAUDE_CONFIG;
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    const url = 'https://profile.example.test/mcp';
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
      mcpServers: { 'cf-memory': { url, headers: { Authorization: 'Bearer ' + CONFIG_TOKEN } } },
    }));
    const connection = await credentials(env, false);
    assert.deepEqual([connection.url, connection.token], [url, CONFIG_TOKEN]);
  } finally { dir.cleanup(); }
});

test('a token from ~/.claude.json goes only to the server it was issued for', async () => {
  const dir = tempDir();
  try {
    const env = withConfig(dir, 'https://memory.example.test/mcp');
    assert.deepEqual(await credentials(env, false).then(c => [c.url, c.token, c.source]), ['https://memory.example.test/mcp', CONFIG_TOKEN, 'claude_config']);
    assert.equal(await failure(credentials({ ...env, CF_MEMORY_MCP_URL: 'https://elsewhere.example.test/mcp' }, false)), 'unsafe_url', 'another host: refused');
    assert.equal((await credentials({ ...env, CF_MEMORY_MCP_URL: 'https://memory.example.test/other' }, false)).url, 'https://memory.example.test/other', 'same server, another path');
    assert.equal(await failure(credentials({ ...env, CF_MEMORY_MCP_URL: 'http://127.0.0.1:9/mcp' }, false)), 'unsafe_url', 'loopback needs its own credential');
    // CF_MEMORY_ACCESS_TOKEN in the same environment may go to an override host.
    const own = await credentials({ ...env, CF_MEMORY_MCP_URL: 'https://elsewhere.example.test/mcp', CF_MEMORY_ACCESS_TOKEN: 'fixture-env-token' }, false);
    assert.deepEqual([own.url, own.token, own.source], ['https://elsewhere.example.test/mcp', 'fixture-env-token', 'env']);
    assert.equal(await failure(credentials({ ...env, CF_MEMORY_MCP_URL: 'http://elsewhere.example.test/mcp', CF_MEMORY_ACCESS_TOKEN: 'fixture-env-token' }, false)), 'unsafe_url', 'plain http only to loopback');
  } finally { dir.cleanup(); }
});

// Fake macOS Keychain (an cf-memory entry that has already expired) and a
// `claude mcp get` that takes 1 s and refreshes nothing.
function keychainFixture(dir) {
  const security = join(dir.path, 'security'), claude = join(dir.path, 'claude'), calls = join(dir.path, 'claude-calls');
  writeFileSync(security, `#!/bin/sh\nnow=$(($(date +%s)*1000))\nprintf '{"mcpOAuth":{"cf-memory|x":{"serverUrl":"http://127.0.0.1:9/mcp","accessToken":"fixture-access-token-not-a-secret","refreshToken":"r","expiresAt":%s}}}' $((now-1000))\n`);
  writeFileSync(claude, `#!/bin/sh\necho call >> '${calls}'\nsleep 1\necho ok\n`);
  chmodSync(security, 0o755); chmodSync(claude, 0o755);
  const env = { ...testEnv(dir.path, null), CF_MEMORY_KEYCHAIN: 'on', CF_MEMORY_CLAUDE_BIN: claude, CF_MEMORY_MCP_URL: 'http://127.0.0.1:9/mcp' };
  return { env, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}

test('a refresh that does not take effect is not tried again for 10 minutes', { skip: process.platform !== 'darwin' && 'the Keychain path runs on macOS only' }, async () => {
  const dir = tempDir(), path = process.env.PATH;
  try {
    const fixture = keychainFixture(dir);
    process.env.PATH = dir.path + ':' + path; // `security` is looked up on PATH
    let started = performance.now();
    assert.equal((await credentials(fixture.env, true)).source, 'keychain');
    assert.ok(performance.now() - started >= 900 && fixture.calls() === 1, 'the first expiring token is refreshed');
    started = performance.now();
    assert.equal((await credentials(fixture.env, true)).token, 'fixture-access-token-not-a-secret');
    assert.ok(performance.now() - started < 800 && fixture.calls() === 1, 'the next hook within 10 minutes does not wait for another refresh');
    const recorded = readFileSync(join(fixture.env.CF_MEMORY_AGENT_HOME, 'health', 'oauth-refresh.json'), 'utf8');
    assert.match(recorded, /^\{"at":\d+\}$/, 'only the time of the attempt is stored');
    await credentials(fixture.env, 'force');
    assert.equal(fixture.calls(), 2, 'doctor --refresh still refreshes');
  } finally { process.env.PATH = path; dir.cleanup(); }
});
