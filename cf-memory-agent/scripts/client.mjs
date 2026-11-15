import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const CLIENTS = ['claude-code', 'codex'];
export function clientName(env = process.env) {
  if (!env.CF_MEMORY_CLIENT || env.CF_MEMORY_CLIENT === 'claude-code') return 'claude-code';
  if (env.CF_MEMORY_CLIENT === 'codex') return 'codex';
  throw Error('unsupported cf-memory client');
}
export function clientVersion(client, env = process.env) {
  return String(env.CF_MEMORY_CLIENT_VERSION || (client === 'codex' ? env.CODEX_CLI_VERSION : env.CLAUDE_CODE_VERSION) || 'unknown').slice(0, 100);
}
// All Agent state (spool, settings, health, caches): ~/.cf-memory/v3, or
// CF_MEMORY_AGENT_HOME (tests and alternative installs).
export function agentHome(env = process.env) {
  return env.CF_MEMORY_AGENT_HOME ? resolve(env.CF_MEMORY_AGENT_HOME) : join(homedir(), '.cf-memory', 'v3');
}
// True when the module at `url` is the script node was started with. Compared
// by real path: the installed path may go through a symlink (/var → /private/var).
export function isMain(url) {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}
