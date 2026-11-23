import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { claudeUserConfigPath } from '../cf-memory-agent/scripts/client.mjs';

const name = 'cf-memory';
const registeredPath = claudeUserConfigPath();

function register(config) {
  const path = lstatSync(registeredPath, { throwIfNoEntry: false }) ? realpathSync(registeredPath) : null;
  const before = path ? readFileSync(path, 'utf8') : null;
  const settings = before === null ? {} : JSON.parse(before);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid Claude Code settings');
  const servers = settings.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid Claude Code MCP settings');
  if (!Object.hasOwn(servers, name)) {
    execFileSync('claude', ['mcp', 'add-json', '--scope', 'user', name, '-'], {
      input: JSON.stringify(config), stdio: ['pipe', 'ignore', 'ignore'],
    });
    const installed = JSON.parse(readFileSync(registeredPath, 'utf8')).mcpServers?.[name];
    if (installed?.url !== config.url || installed?.headers?.Authorization !== config.headers.Authorization) {
      throw new Error('Could not verify the new Claude Code registration');
    }
    return;
  }
  if (isDeepStrictEqual(servers[name], config)) return;

  // Replace just our user-scope entry. There is no point at which the previous
  // registration is missing, and a failed write leaves it readable.
  servers[name] = config;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (realpathSync(registeredPath) !== path || readFileSync(path, 'utf8') !== before) {
      throw new Error('Claude Code settings changed during registration');
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const override = process.env.CF_MEMORY_CLAUDE_CONFIG;
if (override && resolve(override) !== resolve(registeredPath)) {
  console.error('CF_MEMORY_CLAUDE_CONFIG points to a different file from the active Claude Code profile. Unset it before registering this client.');
  process.exit(1);
}

try {
  const token = readFileSync(0, 'utf8');
  register({ type: 'http', url: process.argv[2], headers: { Authorization: 'Bearer ' + token } });
} catch {
  console.error('Could not update the cf-memory registration in Claude Code user settings.');
  process.exitCode = 1;
}
