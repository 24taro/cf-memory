// `doctor`: a JSON report of versions, settings, auth reachability, spool size
// and the last flush/error for each client. It never prints tokens and writes
// nothing (no refresh unless --refresh is given).
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { agentHome, CLIENTS } from './client.mjs';
import { readHealth } from './health.mjs';
import { claudeInstalledVersion, installPaths, ownedCodexHandler, withoutLegacyRecall } from './install.mjs';
import { configPath, loadSettings } from './settings.mjs';
import { HELD_CAP_BYTES, heldFile, heldGroups, heldStats, pendingStats, REJECT_STREAK, rejectedFile, rejectedStats, SPOOL_ACTION_CAP_BYTES, spoolFile } from './spool.mjs';
import { accountKey, claudeConfig, configuredOrigin, createMcp, credentials, failureCode, knownCreds } from './transport.mjs';
import { PLUGIN_VERSION } from './version.mjs';

const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const DROPPED_RECENT_MS = 24 * 3600000;

function cliVersion(executable) {
  try {
    return execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].slice(0, 100) || null;
  } catch { return null; }
}

async function codexInstalled(paths) {
  try {
    const hooks = JSON.parse(await readFile(paths.hooksFile, 'utf8'));
    const commands = Object.values(hooks.hooks || {}).flat().flatMap(group => group?.hooks || []).filter(ownedCodexHandler).map(handler => handler.command);
    const versions = [...new Set(commands.map(command => command.match(/cf-memory-agent\/([0-9][^/'"]*?)-[0-9a-f]{16}\//)?.[1]).filter(Boolean))];
    return { hooks_file: paths.hooksFile, cf_memory_handlers: commands.length, versions };
  } catch (error) { return { hooks_file: paths.hooksFile, cf_memory_handlers: 0, versions: [], ...(error.code === 'ENOENT' ? {} : { error: 'unreadable' }) }; }
}

// The old ~/.claude/hooks/cf-memory-recall.sh hook next to the plugin injects recall twice.
async function legacyRecallHooks(claudeDir) {
  const file = join(claudeDir, 'settings.json');
  try {
    const removed = withoutLegacyRecall(JSON.parse(await readFile(file, 'utf8'))).removed;
    const target = (await lstat(file)).isSymbolicLink() ? await realpath(file) : null;
    return { removed, file: target ? file + ' (a symlink to ' + target + ')' : file };
  } catch { return { removed: 0, file }; }
}

export async function doctor({ env = process.env, fetcher = fetch, refresh = false, versions = true } = {}) {
  const home = agentHome(env);
  const settings = loadSettings(env, home);
  const report = {
    ok: false,
    agent: { version: PLUGIN_VERSION, node: process.version, platform: process.platform, home },
    settings: {
      config_file: configPath(home), ...(settings.config_error ? { config_error: settings.config_error } : {}),
      CF_MEMORY_LOG_ENABLED: { value: settings.log_enabled, source: settings.source.CF_MEMORY_LOG_ENABLED },
      CF_MEMORY_RECALL_ENABLED: { value: settings.recall_enabled, source: settings.source.CF_MEMORY_RECALL_ENABLED },
      CF_MEMORY_RECALL_BUDGET: { value: settings.recall_budget, source: settings.source.CF_MEMORY_RECALL_BUDGET },
    },
    auth: { configured: false, reachable: false },
    clients: {},
    // `problems` need the operator (and make `ok` false); `warnings` do not.
    problems: [],
    warnings: [],
  };
  const paths = installPaths({ env });
  if (versions) {
    report.agent.claude_cli = cliVersion(env.CF_MEMORY_CLAUDE_BIN || 'claude');
    report.agent.codex_cli = cliVersion(env.CF_MEMORY_CODEX_BIN || 'codex');
  }
  // The server and (once whoami answered) the account configured now, as queued lines name them.
  const current = { origin: configuredOrigin(env, env.CF_MEMORY_MCP_URL ? {} : await claudeConfig(env)), account: null };
  try {
    const connection = await credentials(env, refresh ? 'force' : false);
    const url = new URL(connection.url);
    Object.assign(report.auth, { configured: true, source: connection.source, server: url.origin + url.pathname });
    const probe = createMcp({ ...connection, refresh: undefined }, 8000, fetcher);
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      try {
        const identity = await probe('whoami', {});
        Object.assign(report.auth, { reachable: true, latency_ms: Math.round(performance.now() - started) });
        current.origin = url.origin;
        if (typeof identity?.user_id === 'string' && identity.user_id && identity.anonymous !== true) current.account = accountKey(url.origin, identity.user_id);
        delete report.auth.error;
        break;
      } catch (error) {
        report.auth.error = failureCode(error);
        if (report.auth.error !== 'network') break; // one retry for a transient connection error
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  } catch (error) { report.auth.error = failureCode(error); }
  const creds = await knownCreds(home).catch(() => new Map());
  for (const client of CLIENTS) {
    const health = await readHealth(home, client);
    const pending = await pendingStats(home, client, { count: true }).catch(() => ({ bytes: null, entries: null }));
    const rejected = await rejectedStats(home, client).catch(() => ({ bytes: null, entries: null }));
    const held = await heldStats(home, client).catch(() => ({ bytes: null, entries: null }));
    const groups = await heldGroups(home, client, creds).catch(() => []);
    const failing = Number.isFinite(health.last_flush_error_at) && !(health.last_flush_ok_at >= health.last_flush_error_at);
    report.clients[client] = {
      spool: {
        file: spoolFile(home, client), pending_entries: pending.entries, pending_bytes: pending.bytes, rejected_file: rejectedFile(home, client), rejected_entries: rejected.entries,
        rejected_dropped: health.rejected_dropped_total ?? 0, held_file: heldFile(home, client), held_entries: held.entries,
        held: groups.map(group => ({ ...group, oldest: iso(group.oldest), newest: iso(group.newest) })), held_dropped: health.held_dropped_total ?? 0, dropped_entries: health.spool_dropped_total ?? 0, last_dropped: iso(health.spool_dropped_at),
      },
      last_hook: health.last_hook ? { ...health.last_hook, at: iso(health.last_hook.at) } : null,
      last_successful_flush: iso(health.last_flush_ok_at),
      last_flush: health.last_flush ? { ...health.last_flush, at: iso(health.last_flush_at) } : null,
      ...(health.last_flush_skipped ? { last_flush_skipped: { ...health.last_flush_skipped, at: iso(health.last_flush_skipped.at) } } : {}),
      last_error: health.last_error ? { ...health.last_error, at: iso(health.last_error.at) } : null,
      last_recall: health.last_recall ? { ...health.last_recall, at: iso(health.last_recall.at) } : null,
      last_session_context: health.last_session_context ? { ...health.last_session_context, at: iso(health.last_session_context.at) } : null,
      flush_failing: failing,
      ...(Number.isFinite(health.slow_until) && health.slow_until > Date.now() ? { server_slow_until: iso(health.slow_until) } : {}),
      runtime_version: health.version ?? null,
    };
    // `rejecting`: the server refused 20 entries in a row, so it most likely refuses
    // everything this Agent sends; replaying would only be refused again.
    const rejecting = failing && health.last_flush?.error === 'rejecting';
    if (rejecting) {
      report.warnings.push(client + ': the flush stopped (rejecting): the server refused ' + REJECT_STREAK + ' entries in a row, so it most likely refuses everything this Agent (' + PLUGIN_VERSION +
        ') sends. Check that the server and the Agent versions match (update the one that is behind). The waiting entries stay queued: every 10 minutes up to ' + REJECT_STREAK + ' more refused ones are set aside, so the ones the server accepts still go.');
    }
    // Refused entries are kept, not delivered: a warning, not a failure (20 in a row fail the flush).
    if (rejected.entries > 0 || health.rejected_dropped_total > 0) {
      report.warnings.push(client + ': the server refused ' + (rejected.entries ?? 0) + ' entries (kept in ' + rejectedFile(home, client) + ')' +
        (health.rejected_dropped_total > 0 ? ' and ' + health.rejected_dropped_total + ' more were dropped (file full)' : '') + '; to send them again' +
        (rejecting ? ', once the server accepts entries again' : '') + ': agent.mjs replay-rejected --client ' + client);
    }
    // Held entries are kept and never sent on their own. Each group gets the
    // command that fits it; none of them sends entries to an account that is
    // not known to have queued them without the operator selecting them.
    for (const group of groups) {
      const replay = 'agent.mjs replay-held --client ' + client + ' --origin ' + (group.origin ?? 'none');
      const what = client + ': ' + group.entries + ' held entries (in ' + heldFile(home, client) + ', ' + iso(group.oldest) + ' to ' + iso(group.newest) + ') ';
      if (group.state === 'account' && group.origin === current.origin && group.account === current.account) {
        report.problems.push(what + 'were queued by the account now configured and are not sent until they are queued again: ' + replay + ' --account ' + group.account);
      } else if (group.state === 'account') {
        report.warnings.push(what + 'were queued for account ' + group.account + ' on ' + group.origin + ', which is not the server and account now configured' + (current.account ? '' : ' (or the account could not be checked)') +
          ': they are not sent here. Once that server and account are configured again: ' + replay + ' --account ' + group.account);
      } else if (group.origin === null || group.origin === current.origin) {
        report.problems.push(what + (group.origin === null ? 'have no readable destination' : 'were queued for ' + group.origin + ' but the account that queued them is not known (no token was at hand, or one no flush has identified, and another account flushed there last or the record in accounts.json was lost)') +
          ': they are not sent on their own, and may be another account\'s. Sessions' + (group.sessions.length < 5 ? '' : ' (first 5)') + ': ' + group.sessions.join(', ') +
          '. To send the ones that are the account\'s now configured, name its sessions (or a time range with --since/--until): ' + replay + ' --unknown --session <session id> --to-current');
      } else {
        report.warnings.push(what + 'were queued for ' + group.origin + ', which is not the server now configured, and the account that queued them is not known: they are not sent here. Once that server is configured again, queue them again (the flush sends the ones it can tell are that account\'s and holds the rest, which doctor then lists): ' + replay + ' --unknown');
      }
    }
    if (health.held_dropped_total > 0) {
      report.problems.push(client + ': ' + health.held_dropped_total + ' entries that had to be held were dropped because ' + heldFile(home, client) + ' is full (' + Math.round(HELD_CAP_BYTES / 1048576) + ' MB): queue or remove what it holds (the commands above).');
    }
    // Over SPOOL_ACTION_CAP_BYTES waiting, new `action` entries are not queued.
    if (Number.isFinite(health.spool_dropped_at) && Date.now() - health.spool_dropped_at < DROPPED_RECENT_MS) {
      report.warnings.push(client + ': the spool passed ' + Math.round(SPOOL_ACTION_CAP_BYTES / 1048576) + ' MB of undelivered entries, so ' + (health.spool_dropped_total ?? 'some') +
        ' action entries were dropped (last at ' + iso(health.spool_dropped_at) + '; prompts, replies and errors are kept); see last_flush and last_error for why it is not delivered, then: agent.mjs flush --client ' + client);
    }
  }
  report.clients['claude-code'].installed = { plugin: 'cf-memory-agent@cf-memory', version: await claudeInstalledVersion(paths.claudeDir) };
  report.clients.codex.installed = await codexInstalled(paths);
  if (paths.error) report.warnings.push(paths.error);
  const legacy = await legacyRecallHooks(paths.claudeDir);
  if (legacy.removed) report.warnings.push(legacy.file + ' still runs the old cf-memory-recall.sh hook (' + legacy.removed + '): recall is injected twice; agent.mjs install --client claude-code removes it');
  report.ok = report.auth.reachable && !Object.values(report.clients).some(client => client.flush_failing) && !settings.config_error && !report.problems.length;
  return report;
}
