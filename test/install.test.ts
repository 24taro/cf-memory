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

function installFixture({ worker = 'present', reservation = 'created', savedToken = true, clients = false, dotEnv = '', bindingPhase = '', tokenAccepted = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cf-memory-install-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    copyFileSync('install.sh', join(root, 'install.sh'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync('scripts/register-claude-mcp.mjs', join(root, 'scripts/register-claude-mcp.mjs'));
    copyFileSync('scripts/reserve-worker.mjs', join(root, 'scripts/reserve-worker.mjs'));
    symlinkSync(resolve('cf-memory-agent'), join(root, 'cf-memory-agent'), 'dir');
    symlinkSync(process.execPath, join(bin, 'node'));
    const tokenFile = join(root, '.cf-memory.secrets');
    const claimFile = join(root, '.cf-memory.install-claim');
    const bindingFile = join(root, '.cf-memory.deployment.json');
    if (dotEnv) writeFileSync(join(root, '.env'), dotEnv);
    if (savedToken) writeFileSync(tokenFile, `API_TOKEN=${'x'.repeat(32)}\n`, { mode: 0o600 });
    if (reservation === 'resume' || reservation === 'deployed') writeFileSync(claimFile, 'a'.repeat(32), { mode: 0o600 });
    if (bindingPhase) writeFileSync(bindingFile, JSON.stringify({
      version: 1, phase: bindingPhase, account: 'a'.repeat(32), name: 'cf-memory', workerId: 'c'.repeat(32),
      domain: 'https://api.cloudflare.com/client/v4', origin: 'https://cf-memory.test.workers.dev',
    }), { mode: 0o600 });
    const trace = join(root, 'wrangler-args');
    writeFileSync(trace, '');
    const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
    mkdirSync(dirname(wrangler), { recursive: true });
    writeFileSync(join(root, 'node_modules/wrangler/index.js'), `
      exports.unstable_readConfig = () => ({ name: 'cf-memory' });
      exports.unstable_getVarsForDev = require(${JSON.stringify(resolve('node_modules/wrangler/wrangler-dist/cli.js'))}).unstable_getVarsForDev;
    `);
    writeFileSync(wrangler, `
      const args = process.argv.slice(2);
      require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify(args) + '\\n');
      if (args[0] === 'auth') console.log(JSON.stringify({ type: 'oauth', token: 'fixture' }));
      if (args[0] === 'whoami' && args.includes('--json')) {
        console.log(JSON.stringify({ accounts: [{ id: 'a'.repeat(32) }] }));
      }
      if (args[0] === 'deploy') console.log('https://test.example.workers.dev');
      if (args[0] === 'deploy' && process.env.CLOUDFLARE_ACCOUNT_ID) {
        require('node:fs').appendFileSync(process.env.TRACE, JSON.stringify([
          'deployment-target', process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_BASE_URL,
        ]) + '\\n');
      }
    `);
    const fetchMock = join(root, 'mock-cloudflare.mjs');
    writeFileSync(fetchMock, `
      import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (url, options) => {
        const method = options.method ?? 'GET';
        const path = new URL(url).pathname;
        appendFileSync(process.env.TRACE, JSON.stringify(['api', method, path]) + '\\n');
        const state = process.env.RESERVATION;
        const worker = { id: 'c'.repeat(32), name: 'cf-memory' };
        if (path === '/api/v1/whoami') {
          return process.env.TOKEN_ACCEPTED === 'true'
            ? Response.json({ token_status: 'active', handle: 'owner', scopes: ['admin'] })
            : Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        if (path.endsWith('/subdomain')) return Response.json({ success: true, result: { subdomain: 'test' } });
        if (method === 'POST') {
          const submitted = JSON.parse(options.body);
          if (state === 'created') return Response.json({ success: true, result: { ...worker, tags: submitted.tags } });
          if (state === 'unconfirmed') return Response.json({ success: false }, { status: 503 });
          return Response.json({ success: false, errors: [{ code: 10040 }] }, { status: 409 });
        }
        if (url.includes('/versions?')) {
          return Response.json({ success: true, result: state === 'deployed' ? [{ id: 'existing' }] : [] });
        }
        if (process.env.WORKER === 'unknown') return Response.json({ success: false }, { status: 503 });
        if (process.env.WORKER === 'present' || state === 'resume' || state === 'deployed') {
          return Response.json({ success: true, result: { ...worker, tags: ['cf-memory-install-' + 'a'.repeat(32)] } });
        }
        return Response.json({ success: false }, { status: 404 });
      };
    `);
    const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    stub('npm', 'exit 0');
    stub('curl', `cat >/dev/null\nprintf '%s\\n' '{"token_status":"active"}'`);
    stub('codex', 'exit 0');
    stub('claude', `case "$1 $2" in\n  "--version ") echo '2.1.327 (Claude Code)' ;;\n  'mcp add-json') node -e 'require("node:fs").writeFileSync(process.env.HOME + "/.claude.json", JSON.stringify({mcpServers:{"cf-memory":JSON.parse(require("node:fs").readFileSync(0,"utf8"))}}))' ;;\n  *) exit 1 ;;\nesac`);
    const result = spawnSync('/bin/bash', ['install.sh', ...(clients ? [] : ['--no-client'])], {
      cwd: root,
      encoding: 'utf8',
      env: {
        HOME: root, CODEX_HOME: join(root, '.codex'), PATH: `${bin}:/usr/bin:/bin`,
        WORKER: worker, TRACE: trace, RESERVATION: reservation, NODE_OPTIONS: `--import=${fetchMock}`, TOKEN_ACCEPTED: String(tokenAccepted),
      },
    });
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    const deploy = calls.find(args => args[0] === 'deploy');
    const hooks = join(root, '.codex', 'hooks.json');
    return {
      result, calls, deploy, tokenExists: existsSync(tokenFile), claimExists: existsSync(claimFile),
      binding: existsSync(bindingFile) ? JSON.parse(readFileSync(bindingFile, 'utf8')) : null,
      codex: existsSync(hooks) ? readFileSync(hooks, 'utf8') : '',
    };
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
  expect(created.claimExists).toBe(false);
  expect(created.deploy?.slice(1, 5)).toEqual(['--secrets-file', '.cf-memory.secrets', '--name', 'cf-memory']);
  expect(created.calls.findIndex(args => args[0] === 'api' && args[1] === 'POST'))
    .toBeLessThan(created.calls.findIndex(args => args[0] === 'deploy'));
  const update = installFixture();
  expect(update.result.status).toBe(0);
  expect(update.deploy).toBeDefined();
  expect(update.deploy).not.toContain('--secrets-file');
  expect(update.calls.findIndex(args => args[2] === '/api/v1/whoami'))
    .toBeLessThan(update.calls.findIndex(args => args[0] === 'deploy'));
  expect(update.binding.phase).toBe('ready');
});

it('resumes its own reserved Worker before any version exists', () => {
  const { result, calls, claimExists, deploy } = installFixture({ worker: 'missing', reservation: 'resume' });
  expect(result.status).toBe(0);
  expect(calls).toContainEqual(['api', 'GET', `/client/v4/accounts/${'a'.repeat(32)}/workers/workers/cf-memory/versions`]);
  expect(deploy).toContain('--secrets-file');
  expect(claimExists).toBe(false);
});

it('reserves and deploys to the account selected in Wrangler dotenv', () => {
  const account = 'b'.repeat(32);
  const { result, calls } = installFixture({
    worker: 'missing', savedToken: false, dotEnv: `TARGET_ACCOUNT=${account}\nCLOUDFLARE_ACCOUNT_ID=\${TARGET_ACCOUNT}\n`,
  });
  expect(result.status).toBe(0);
  expect(calls).toContainEqual(['api', 'POST', `/client/v4/accounts/${account}/workers/workers`]);
  expect(calls).toContainEqual(['deployment-target', account, 'https://api.cloudflare.com/client/v4']);
});

it.each(['competing', 'unconfirmed'])('uploads no credentials if the first-install reservation is %s', reservation => {
  const { result, calls, deploy, tokenExists, claimExists } = installFixture({ worker: 'missing', reservation, savedToken: false });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('no token was uploaded');
  expect(calls.some(args => args[0] === 'api' && args[1] === 'POST')).toBe(true);
  expect(deploy).toBeUndefined();
  expect(tokenExists).toBe(false);
  expect(claimExists).toBe(true);
});

it('does not treat a Worker with versions as a new deployment', () => {
  const { result, deploy, tokenExists, calls } = installFixture({ worker: 'missing', reservation: 'deployed', savedToken: false });
  expect(result.status).toBe(1);
  expect(deploy).toBeUndefined();
  expect(tokenExists).toBe(false);
  expect(calls.some(args => args[0] === 'api' && args[1] === 'POST')).toBe(false);
});

it('finishes provisioning its original Worker after the first deployment was interrupted', () => {
  const { result, deploy, binding, calls } = installFixture({ bindingPhase: 'pending', reservation: 'deployed', tokenAccepted: false });
  expect(result.status).toBe(0);
  expect(deploy).toBeDefined();
  expect(deploy).not.toContain('--secrets-file');
  expect(binding.phase).toBe('ready');
  expect(calls.some(args => args[2] === '/api/v1/whoami')).toBe(false);
});

it('requires the original destination and an accepted token before a routine update', () => {
  const changedAccount = installFixture({ bindingPhase: 'ready', dotEnv: `CLOUDFLARE_ACCOUNT_ID=${'b'.repeat(32)}\n` });
  expect(changedAccount.result.status).toBe(1);
  expect(changedAccount.result.stderr).toContain('differs from this checkout');
  expect(changedAccount.calls.some(args => args[0] === 'api' || args[0] === 'deploy')).toBe(false);

  const rejectedToken = installFixture({ tokenAccepted: false });
  expect(rejectedToken.result.status).toBe(1);
  expect(rejectedToken.calls).toContainEqual(['api', 'GET', '/api/v1/whoami']);
  expect(rejectedToken.deploy).toBeUndefined();
  expect(rejectedToken.binding).toBeNull();
});

it('keeps an unbound saved token out of a first deployment', () => {
  const { result, deploy, tokenExists, calls } = installFixture({ worker: 'missing' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('saved token cannot be used on a new Worker');
  expect(tokenExists).toBe(true);
  expect(deploy).toBeUndefined();
  expect(calls.some(args => args[0] === 'api' && args[1] === 'POST')).toBe(false);
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
