import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Stop the real installer at npm ci so the test cannot reach Cloudflare.
function preflight(version: string | null, args: string[] = [], versionExit = 0) {
  const root = mkdtempSync(join(tmpdir(), 'cf-memory-install-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    copyFileSync('install.sh', join(root, 'install.sh'));
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/usr/bin/dirname', join(bin, 'dirname'));
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$CALLS"\n${body}\n`, { mode: 0o700 });
    };
    stub('openssl', 'exit 90');
    stub('curl', 'exit 90');
    stub('npm', 'exit 42');
    stub('codex', 'exit 90');
    if (version !== null) {
      stub('claude', '[ "$1" = --version ] || exit 90\nprintf "%s\\n" "$CLAUDE_VERSION"\nexit "$CLAUDE_VERSION_EXIT"');
    }
    const calls = join(root, 'calls');
    writeFileSync(calls, '');
    const result = spawnSync('/bin/bash', ['install.sh', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { HOME: root, PATH: bin, CALLS: calls, CLAUDE_VERSION: version ?? '', CLAUDE_VERSION_EXIT: String(versionExit) },
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stderr: result.stderr, calls: readFileSync(calls, 'utf8').trim().split('\n') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('stops before dependency installation or client changes if Claude Code is too old', () => {
  const result = preflight('2.1.326 (Claude Code)');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('found Claude Code 2.1.326. Claude Code 2.1.327 or later is required');
  expect(result.stderr).toContain('./install.sh --no-client');
  expect(result.calls).toEqual(['claude --version']);
});

it.each([['unexpected output', 0], ['2.1.327 (Claude Code)', 1]])('stops when the installed Claude version cannot be verified (%s, exit %s)', (version, exitCode) => {
  const result = preflight(version, [], exitCode);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('could not determine the Claude Code version');
  expect(result.calls).toEqual(['claude --version']);
});

it.each(['2.1.327', '2.2.0', '3.0.0'])('continues for a supported Claude Code version (%s)', version => {
  const result = preflight(`${version} (Claude Code)`);
  expect(result.status).toBe(42);
  expect(result.calls).toEqual(['claude --version', 'npm ci --no-audit --no-fund']);
});

it('continues with Codex alone or when client setup is disabled', () => {
  for (const result of [preflight(null), preflight('2.1.326 (Claude Code)', ['--no-client'])]) {
    expect(result.status).toBe(42);
    expect(result.calls).toEqual(['npm ci --no-audit --no-fund']);
  }
});

function installFixture({ worker = 'present', savedToken = true, clients = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-memory-install-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    copyFileSync('install.sh', join(root, 'install.sh'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync('scripts/register-claude-mcp.mjs', join(root, 'scripts/register-claude-mcp.mjs'));
    symlinkSync(resolve('cf-memory-agent'), join(root, 'cf-memory-agent'), 'dir');
    symlinkSync(process.execPath, join(bin, 'node'));
    const tokenFile = join(root, '.cf-memory.secrets');
    if (savedToken) writeFileSync(tokenFile, `API_TOKEN=${'x'.repeat(32)}\n`, { mode: 0o600 });
    const trace = join(root, 'wrangler-args');
    writeFileSync(trace, '');
    const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
    mkdirSync(dirname(wrangler), { recursive: true });
    writeFileSync(wrangler, `
      const args = process.argv.slice(2);
      require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
      if (args[0] === 'secret') {
        if (process.env.WORKER === 'present') console.log('[{"name":"API_TOKEN","type":"secret_text"}]');
        else { console.error(process.env.WORKER === 'missing' ? 'Worker "cf-memory" not found.' : 'Could not reach Cloudflare.'); process.exitCode = 1; }
      }
      if (args[0] === 'deploy') console.log('https://test.example.workers.dev');
    `);
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    stub('npm', 'exit 0');
    stub('curl', `cat >/dev/null\nprintf '%s\\n' '{"token_status":"active"}'`);
    stub('codex', 'exit 0');
    stub('claude', `case "$1 $2" in\n  "--version ") echo '2.1.327 (Claude Code)' ;;\n  'mcp add-json') node -e 'require("node:fs").writeFileSync(process.env.HOME + "/.claude.json", JSON.stringify({mcpServers:{"cf-memory":JSON.parse(require("node:fs").readFileSync(0,"utf8"))}}))' ;;\n  *) exit 1 ;;\nesac`);
    const result = spawnSync('/bin/bash', ['install.sh', ...(clients ? [] : ['--no-client'])], {
      cwd: root,
      encoding: 'utf8',
      env: { HOME: root, CODEX_HOME: join(root, '.codex'), PATH: `${bin}:/usr/bin:/bin`, WORKER: worker, TRACE: trace },
    });
    const deploy = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(args => args[0] === 'deploy');
    const hooks = join(root, '.codex', 'hooks.json');
    return { result, deploy, tokenExists: existsSync(tokenFile), codex: existsSync(hooks) ? readFileSync(hooks, 'utf8') : '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('reports Claude hook failure separately and still sets up Codex', () => {
  const { result, codex } = installFixture({ clients: true });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Claude Code MCP server registered');
  expect(result.stderr).toContain('Claude Code hook setup failed');
  expect(result.stdout).toContain('Codex hooks installed');
  expect(result.stdout).toMatch(/^  Connected +codex$/m);
  expect(codex).toContain('cf-memory agent');
});

it('deploys a new Worker with a token and preserves the existing secret on update', () => {
  const created = installFixture({ worker: 'missing', savedToken: false });
  expect(created.result.status).toBe(0);
  expect(created.tokenExists).toBe(true);
  expect(created.deploy?.slice(1, 3)).toEqual(['--secrets-file', '.cf-memory.secrets']);
  const update = installFixture();
  expect(update.result.status).toBe(0);
  expect(update.deploy).toBeDefined();
  expect(update.deploy).not.toContain('--secrets-file');
});

it.each(['present', 'unknown'])('does not deploy when the local token is absent and Worker state is %s', worker => {
  const { result, deploy, tokenExists } = installFixture({ worker, savedToken: false });
  expect(result.status).toBe(1);
  expect(deploy).toBeUndefined();
  expect(tokenExists).toBe(false);
});

it('replaces only the existing Claude registration and preserves it when atomic writing fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-memory-claude-registration-'));
  try {
    const profile = join(root, 'claude-profile');
    mkdirSync(profile);
    const file = join(profile, '.claude.json');
    const previous = { mcpServers: { 'cf-memory': { url: 'https://old.example.test/mcp' }, another: { command: 'example' } }, projects: {} };
    const update = () => spawnSync(process.execPath, ['scripts/register-claude-mcp.mjs', 'https://new.example.test/mcp'], {
      input: 'x'.repeat(32), encoding: 'utf8', env: { HOME: root, CLAUDE_CONFIG_DIR: profile },
    });
    writeFileSync(file, JSON.stringify(previous));
    expect(update().status).toBe(0);
    const updated = JSON.parse(readFileSync(file, 'utf8'));
    expect(updated.mcpServers['cf-memory'].url).toBe('https://new.example.test/mcp');
    expect(updated.mcpServers.another).toEqual(previous.mcpServers.another);
    expect(updated.projects).toEqual(previous.projects);

    rmSync(file);
    // A valid target name whose temporary filename would exceed NAME_MAX.
    const longTarget = join(root, 'a'.repeat(250));
    writeFileSync(longTarget, JSON.stringify(previous));
    symlinkSync(longTarget, file);
    expect(update().status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(previous));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
