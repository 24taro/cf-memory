import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
