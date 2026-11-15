#!/usr/bin/env node
// cf-memory agent for Claude Code (hooks) and the operator commands.
//   agent.mjs session-start | user-prompt-submit | post-tool-use | post-tool-use-failure | stop
//   agent.mjs doctor [--refresh] [--no-versions]
//   agent.mjs install [--client claude-code|codex|all] [--dry-run] [--home DIR]
//   agent.mjs uninstall [--client claude-code|codex|all] [--dry-run] [--home DIR]
//   agent.mjs flush [--client claude-code|codex]
//   agent.mjs replay-rejected [--client claude-code|codex]   (queue refused entries again)
//   agent.mjs replay-held [--client claude-code|codex] [selection] [--to-current]
//     queue held entries again as they are; selection (all given must match; none: all):
//       --origin ORIGIN|none   --account HASH | --unknown   --session ID   --since TIME   --until TIME
//     --to-current: queue the selected ones for the current server and account instead (needs a selection)
import { fileURLToPath } from 'node:url';
import { agentHome, CLIENTS, isMain } from './client.mjs';
import { doctor } from './doctor.mjs';
import { flushHealth, hookMain } from './hook.mjs';
import { readHealth, updateHealth } from './health.mjs';
import { install, parseInstallArgs, uninstall } from './install.mjs';
import { loadSettings } from './settings.mjs';
import { flush, replayHeld, replayRejected, requeueOwn } from './spool.mjs';
import { createDeadlineMcp, credentials, destination, failureCode, knownCreds } from './transport.mjs';

const script = fileURLToPath(import.meta.url);
export const HOOK_COMMANDS = {
  'session-start': 'SessionStart', 'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse', 'post-tool-use-failure': 'PostToolUseFailure', stop: 'Stop',
};

function clientsOf(argv) {
  const position = argv.indexOf('--client');
  const clients = position >= 0 ? [argv[position + 1]] : CLIENTS;
  if (clients.some(client => !CLIENTS.includes(client))) throw Error('--client must be claude-code or codex');
  return clients;
}

export async function flushCommand(argv, env, budget = 30000) {
  const clients = clientsOf(argv), home = agentHome(env), report = {};
  if (!loadSettings(env, home).log_enabled) return { skipped: 'CF_MEMORY_LOG_ENABLED is false' };
  const deadline = performance.now() + budget;
  const connection = await credentials(env, true, deadline);
  // Only what was queued for this server and account is sent; the rest is held (doctor lists it).
  const to = await destination(connection, createDeadlineMcp(connection, deadline), home);
  const creds = to.changed ? await knownCreds(home) : null;
  for (const client of clients) {
    if (creds) await requeueOwn(home, client, to, creds).catch(() => {});
    const result = await flush(home, client, batch => createDeadlineMcp(connection, deadline)('log_append', { entries: batch }), { deadline, to });
    const at = Date.now(), code = result.error ? (typeof result.error === 'string' ? result.error : failureCode(result.error)) : undefined;
    // Recorded as the hooks record it (a timeout after delivering something is partial progress).
    if (!result.busy) await updateHealth(home, client, flushHealth(result, at, await readHealth(home, client)));
    report[client] = { ...result, ...(code ? { error: code } : {}) };
  }
  return report;
}

const HELD_OPTIONS = ['--origin', '--account', '--session', '--since', '--until'];
// The selection of `replay-held` (spool.mjs replayHeld `only`). Times: ISO 8601 or epoch ms.
export function heldSelection(argv) {
  const only = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--client') { i++; continue; }
    if (flag === '--to-current') continue;
    if (flag === '--unknown') { only.unknown = true; continue; }
    if (!HELD_OPTIONS.includes(flag)) throw Error('--client, --to-current and the selection flags (--origin, --account, --unknown, --session, --since, --until) are the replay-held options');
    const value = argv[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw Error(flag + ' needs a value');
    if (flag === '--origin') {
      let origin = value;
      if (value !== 'none') { try { origin = new URL(value).origin; } catch { throw Error('--origin must be a server URL or none'); } }
      only.origin = origin;
    } else if (flag === '--account') {
      if (!/^[0-9a-f]{16}$/.test(value)) throw Error('--account must be the 16-character account hash doctor prints');
      only.account = value;
    } else if (flag === '--session') only.session = value;
    else {
      const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
      if (!Number.isFinite(time)) throw Error(flag + ' must be an ISO 8601 time or epoch milliseconds');
      only[flag.slice(2)] = time;
    }
  }
  if (only.account !== undefined && only.unknown) throw Error('--account and --unknown exclude each other');
  return only;
}

// Held entries are not known to be the configured server's and account's.
// Plain, the selected ones are queued again as they were (the next flush applies
// its rule again). `--to-current` is the operator's decision to send the
// selected ones to the server and account configured now instead; it never
// applies to everything at once, so one account's entries are not swept along
// with another's.
export async function replayHeldCommand(argv, env, budget = 30000) {
  const clients = clientsOf(argv), home = agentHome(env), report = {}, only = heldSelection(argv);
  let to;
  if (argv.includes('--to-current')) {
    if (!Object.keys(only).length) throw Error('--to-current needs a selection (--origin, --account, --unknown, --session, --since, --until): doctor prints the command for each group of held entries');
    const deadline = performance.now() + budget, connection = await credentials(env, true, deadline);
    to = await destination(connection, createDeadlineMcp(connection, deadline), home);
  }
  const creds = await knownCreds(home);
  for (const client of clients) report[client] = await replayHeld(home, client, to, only, creds);
  return report;
}

async function main() {
  const [command = 'doctor', ...argv] = process.argv.slice(2);
  if (Object.hasOwn(HOOK_COMMANDS, command)) {
    return hookMain({ client: 'claude-code', event: HOOK_COMMANDS[command], doctorCommand: 'node "' + script + '" doctor' });
  }
  try {
    if (command === 'doctor') {
      const report = await doctor({ refresh: argv.includes('--refresh'), versions: !argv.includes('--no-versions') });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } else if (command === 'install') {
      console.log(JSON.stringify(await install(parseInstallArgs(argv)), null, 2));
    } else if (command === 'uninstall') {
      console.log(JSON.stringify(await uninstall(parseInstallArgs(argv)), null, 2));
    } else if (command === 'flush') {
      console.log(JSON.stringify(await flushCommand(argv, process.env), null, 2));
    } else if (command === 'replay-rejected') {
      const report = {};
      for (const client of clientsOf(argv)) report[client] = await replayRejected(agentHome(process.env), client);
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'replay-held') {
      console.log(JSON.stringify(await replayHeldCommand(argv, process.env), null, 2));
    } else {
      console.error('usage: agent.mjs <session-start|user-prompt-submit|post-tool-use|post-tool-use-failure|stop|doctor|install|uninstall|flush|replay-rejected|replay-held>');
      process.exitCode = 2;
    }
  } catch (error) {
    // Never print exception details that could carry payload or credential text.
    console.error('cf-memory agent ' + command + ' failed: ' + failureCode(error) + (error?.message && /^(?:--|unknown install option|marketplace manifest|refusing|invalid existing|the Codex installer|symlink in Agent package|CF_MEMORY_CODEX_)/.test(error.message) ? ' (' + error.message + ')' : ''));
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
