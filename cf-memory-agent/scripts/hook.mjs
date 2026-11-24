// The hook program shared by Claude Code (agent.mjs) and Codex (codex-hook.mjs).
// It queues entries locally, flushes them with log_append, and injects
// session_context (SessionStart) or recall (UserPromptSubmit). It never throws
// and never outlives its time budget; problems go to the local health file.
// Each entry is queued for the configured server, and for the account when the
// token at hand is known to be its own; a flush sends only the entries known to
// be queued for the server and account it runs with (spool.mjs).
import { hookInput } from './bounded.mjs';
import { agentHome } from './client.mjs';
import { buildEntries, claudeHook, codexHook, cleanText, eventTime, repoKey, sessionKey, textOf } from './entries.mjs';
import { readHealth, updateHealth } from './health.mjs';
import { resolveRepo } from './repo.mjs';
import { loadSettings } from './settings.mjs';
import { appendEntries, flush, heldGroups, pendingStats, requeueOwn } from './spool.mjs';
import { claudeConfig, configuredOrigin, createDeadlineMcp, credentials, destination, failureCode, knownCreds, McpFailure, queuedFor } from './transport.mjs';
import { PLUGIN_VERSION } from './version.mjs';

// Work budget per event (ms). The hook manifests allow more (10/12/5/5/10 s);
// a watchdog ends the process shortly after the budget whatever happens.
export const BUDGET_MS = { SessionStart: 6000, UserPromptSubmit: 9000, PostToolUse: 3000, PostToolUseFailure: 3000, Stop: 7000 };
export const EVENTS = Object.keys(BUDGET_MS);
// Flushing a backlog must not hold the user's prompt or session start for the
// whole budget: the flush gets its own shorter share; leftovers go next time.
export const FLUSH_BUDGET_MS = { SessionStart: 3000, UserPromptSubmit: 2500, PostToolUse: 2500, PostToolUseFailure: 2500, Stop: 6500 };
// Tool hooks only append to the spool. They go to the network only when this
// many entries are waiting or the oldest waiting entry is this old; the
// prompt, session-start and stop hooks flush whatever is waiting.
export const TOOL_FLUSH_ENTRIES = 40, TOOL_FLUSH_AGE_MS = 5 * 60000;
const WATCHDOG_GRACE_MS = 800, FLUSH_BACKOFF_MS = 60000, RECALL_QUERY_MAX = 8000;
// Claude Code caps each hook's additionalContext at 10,000 characters: over it,
// Claude gets only a 2,000-character preview and a file path. Codex's cap is
// raised in codex-hooks.json (additionalContextLimit).
export const CONTEXT_MAX = 9800;
// Circuit breaker: after a call to the server timed out at its normal cap, every
// call for the next 5 minutes (recall, session_context, the flush) gets at most
// 1.5 s, so a hung server cannot hold each prompt for 8 s. Half-open: once half
// the window has passed, one call (the first) gets its normal cap as a probe. A
// timeout at the normal cap re-arms it (one at 1.5 s does not); any answer closes it.
export const BREAKER_MS = 5 * 60000, BREAKER_CAP_MS = 1500;
// Less time than this left for the flush (after an OAuth refresh, say): no flush (`budget`).
export const FLUSH_MIN_MS = 1000;
const ACK_BUDGET = 600;
const ACKS = new Set(['ok', 'okay', 'はい', 'うん', 'いいえ', '了解', '了解です', 'ありがとう', 'ありがとうございます', 'thanks', 'thank you', 'thx', 'おはよう', 'こんにちは', 'こんばんは', 'では', 'yes', 'no']);
export const RECALL_HEADER = 'cf-memory 自動想起(このメッセージに関連しうる過去の記憶。参考情報として扱い、鮮度が疑わしければ現物を確認すること):';
export const SESSION_HEADER = 'cf-memory セッション開始コンテキスト(参考情報。現在の指示と実際のコードが優先):';
export const LOG_HINT = '過去の会話と作業は log_search(短い語で、言い換えながら何度か)と log_read で探せる。結果は発言と最終回答が先に並ぶ。抜粋に答えが見えなくても、関係ありそうな結果は log_read で開いて確かめる。残すべき知識は notes_put で保存する。';
// The recall pack's own limit, so the server keeps whole notes instead of the hook cutting one.
export const RECALL_MAX_CHARS = CONTEXT_MAX - RECALL_HEADER.length - 2;

const bounded = (text, max = CONTEXT_MAX) => text.length <= max ? text : text.slice(0, max - 1) + '…';
export const failureLine = (what, code) => 'cf-memory ' + what + 'は今回失敗しました(' + code + ')。過去の記憶は不完全かもしれない。doctor で確認できる。作業はそのまま続けること。';
const contextOutput = (event, text) => text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null;

/** The health patch for a flush result (the hooks and `agent.mjs flush`). */
export function flushHealth(result, at, health = {}) {
  const code = !result.error ? undefined : typeof result.error === 'string' ? result.error : failureCode(result.error);
  // The deadline before the first send is no flush at all; after the server
  // answered something it is progress, not a failure.
  const progress = result.sent > 0 || result.rejected > 0;
  if (code === 'budget' && !progress) return { last_flush_skipped: { at, reason: 'budget' } };
  const partial = (code === 'timeout' || code === 'budget') && progress, ok = !code || partial;
  // dropped_over_cap / dropped_over_total_cap (server daily caps) and ts_clamped (a fast clock) are diagnostics, not failures.
  const patch = {
    last_flush_at: at,
    last_flush: {
      ok, sent: result.sent ?? 0, stored: result.stored ?? 0, duplicates: result.duplicates ?? 0, dropped_over_cap: result.dropped_over_cap ?? 0,
      dropped_over_total_cap: result.dropped_over_total_cap ?? 0, ts_clamped: result.ts_clamped ?? 0, invalid: result.invalid ?? 0, rejected: result.rejected ?? 0,
      rejected_dropped: result.rejected_dropped ?? 0, held: result.held ?? 0, held_dropped: result.held_dropped ?? 0, pending_bytes: result.pending_bytes ?? null, ...(partial ? { partial: true } : code ? { error: code } : {}),
    },
  };
  if (result.rejected_dropped > 0) patch.rejected_dropped_total = (health.rejected_dropped_total ?? 0) + result.rejected_dropped;
  if (result.held_dropped > 0) patch.held_dropped_total = (health.held_dropped_total ?? 0) + result.held_dropped;
  if (ok) patch.last_flush_ok_at = at;
  else { patch.last_flush_error_at = at; patch.last_error = { at, where: 'flush', code }; }
  return patch;
}

// session_context answers exactly { core_memory: string, handoff: { session_id, time, text } | null }.
export function sessionContextText(result, repo) {
  const parts = [];
  const core = typeof result?.core_memory === 'string' ? result.core_memory.trim() : '';
  if (core) parts.push('## core memory\n' + core);
  const handoff = result?.handoff;
  if (handoff && typeof handoff.text === 'string' && handoff.text.trim()) {
    const when = typeof handoff.time === 'string' && handoff.time ? ', ' + handoff.time : '';
    parts.push('## 前回の続き(同じリポジトリ' + (repo ? ' ' + repo : '') + ' の別セッションの最後の返答' + when + ')\n' + bounded(handoff.text.trim(), 4000));
  }
  parts.push(LOG_HINT);
  return bounded(SESSION_HEADER + '\n\n' + parts.join('\n\n'));
}

export function recallText(result) {
  const text = typeof result?.text === 'string' && result.text.trim() ? result.text.trim() : '(関連する記憶はまだありません)';
  return bounded(RECALL_HEADER + '\n\n' + text);
}

/**
 * Run one hook event. Returns { output, entries }: `output` is the JSON object
 * to print (or null). Never throws.
 */
export async function runHook({ client, event, payload, env = process.env, fetcher = fetch, now = Date.now, started = performance.now(), doctorCommand }) {
  const home = agentHome(env);
  const at = now();
  const patch = { version: PLUGIN_VERSION, last_hook: { event: String(event).slice(0, 40), at } };
  let output = null, entries = [];
  try {
    if (env.CF_MEMORY_AGENT_CHILD === '1' || env.CF_MEMORY_DISTILL_CHILD === '1' || !EVENTS.includes(event)) return { output: null, entries };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    const deadline = started + BUDGET_MS[event];
    const settings = loadSettings(env, home);
    const hook = client === 'codex' ? codexHook(payload) : claudeHook(payload);
    const inject = settings.recall_enabled && (event === 'SessionStart' || event === 'UserPromptSubmit');
    const queue = settings.log_enabled && event !== 'SessionStart';
    const recallQuery = event === 'UserPromptSubmit' ? cleanText(textOf(hook.prompt), RECALL_QUERY_MAX, '').trim() : '';
    const cwd = hook.cwd || process.cwd();
    const repo = queue || inject ? resolveRepo(cwd, { home, now: at }) : { repo: '', contexts: [] };

    let dropped = 0, config;
    if (queue) {
      entries = buildEntries({ client, event, hook, repo: repo.repo, ts: eventTime(payload, at) });
      if (entries.length) {
        // Record the credential available at queue time. A refresh or account
        // switch during the flush must never assign the entry to a new account.
        try {
          if (!env.CF_MEMORY_MCP_URL || !env.CF_MEMORY_ACCESS_TOKEN) config = await claudeConfig(env, deadline);
          dropped = (await appendEntries(home, client, entries, await queuedFor(env, home, config, at, deadline))).dropped;
        } catch (error) { patch.last_error = { at, where: 'spool', code: failureCode(error) }; }
      }
    }
    // Only once the prompt is queued: a parent of several checkouts recalls with
    // their remotes (a bounded scan; what it did not reach, the next prompt does).
    const contexts = inject && event === 'UserPromptSubmit' && recallQuery !== '' && !repo.remote ? resolveRepo(cwd, { home, now: at, children: true }).contexts : repo.contexts || [];

    const health = await readHealth(home, client);
    if (dropped) { patch.spool_dropped_at = at; patch.spool_dropped_total = (health.spool_dropped_total ?? 0) + dropped; }
    const toolEvent = event === 'PostToolUse' || event === 'PostToolUseFailure';
    // After a failed flush, tool hooks stay off the network for a minute so a
    // dead connection does not slow every tool call; other hooks still retry,
    // except after `rejecting` (the server refuses everything): then all wait.
    const backingOff = (toolEvent || health.last_flush?.error === 'rejecting') && health.last_flush_error_at > (health.last_flush_ok_at ?? 0) && at - health.last_flush_error_at < FLUSH_BACKOFF_MS;
    const breaker = Number.isFinite(health.slow_until) && at < health.slow_until && health.slow_until - at <= BREAKER_MS;
    const probing = breaker && at >= health.slow_until - BREAKER_MS / 2 && health.slow_probe !== health.slow_until;
    const pending = settings.log_enabled
      ? await pendingStats(home, client, toolEvent ? { count: true, countLimit: TOOL_FLUSH_ENTRIES, oldest: true } : {}).catch(() => ({ bytes: 0 }))
      : { bytes: 0 };
    const due = !toolEvent || pending.entries >= TOOL_FLUSH_ENTRIES || (Number.isFinite(pending.oldest_ts) && at - pending.oldest_ts > TOOL_FLUSH_AGE_MS);
    const wantsFlush = settings.log_enabled && !backingOff && pending.bytes > 0 && due;
    const wantsRecall = inject && event === 'UserPromptSubmit' && recallQuery !== '';
    const wantsContext = inject && event === 'SessionStart';

    let connection = null, authCode = null;
    if (wantsFlush || wantsRecall || wantsContext) {
      // Only the Stop hook may refresh an expiring OAuth token (it can take seconds).
      try { connection = await credentials(env, event === 'Stop', deadline, config); } catch (error) { authCode = failureCode(error); }
    }
    // The probe is the call the user waits for (recall, session_context), else the flush.
    const probe = probing && connection ? (wantsRecall ? 'recall' : wantsContext ? 'session_context' : 'log_append') : null;
    const reduced = name => breaker && name !== probe;
    const call = connection ? (name, args) => createDeadlineMcp(connection, deadline, fetcher, reduced(name) ? BREAKER_CAP_MS : undefined)(name, args) : null;
    const flushDeadline = Math.min(deadline, started + FLUSH_BUDGET_MS[event], reduced('log_append') ? started + BREAKER_CAP_MS : Infinity);
    const flushCall = connection ? createDeadlineMcp(connection, flushDeadline, fetcher) : null;
    const skipFlush = authCode === 'budget' || Boolean(connection) && flushDeadline - performance.now() < FLUSH_MIN_MS;
    // Claimed before the call, so concurrent hooks do not all probe.
    if (probe && !(probe === 'log_append' && skipFlush)) await updateHealth(home, client, { slow_probe: health.slow_until });

    // The flush's real room (a Stop hook after an OAuth refresh may have little left).
    const flushRoom = flushDeadline - performance.now();
    // The account behind the token (one whoami per new token) comes out of the flush's own share.
    const flushTask = wantsFlush && call && !skipFlush
      ? destination(connection, flushCall, home, at)
        // Back under this account, or its token just identified: what was held and is known to be its own goes too.
        .then(async to => { if (to.changed) await knownCreds(home).then(creds => requeueOwn(home, client, to, creds)).catch(() => {}); return to; })
        .then(to => flush(home, client, batch => flushCall('log_append', { entries: batch }), { deadline: flushDeadline, to }))
        .catch(error => ({ error }))
      : null;
    let budget = settings.recall_budget;
    if (ACKS.has(recallQuery.toLowerCase().replace(/[。.!！?？\s]+$/u, ''))) budget = Math.min(budget, ACK_BUDGET);
    const recallTask = wantsRecall && call
      // core: false — the core blocks came with SessionStart (again after a compaction).
      ? call('recall', { query: recallQuery, budget, core: false, max_chars: RECALL_MAX_CHARS, ...(contexts.length ? { context: contexts.length === 1 ? contexts[0] : contexts } : {}) })
      : null;
    // The same repo and session_id the entries carry, so the current session is excluded exactly.
    const contextTask = wantsContext && call ? call('session_context', { repo: repoKey(repo.repo), session_id: sessionKey(hook.session_id) }) : null;
    // Flush, recall and session_context run side by side; the hook prints only
    // after all three settle, so waiting entries are delivered before the
    // injection (recall does not read the logs, so the order changes nothing).
    const [flushed, recalled, context] = await Promise.allSettled([flushTask, recallTask, contextTask]);
    // Only a request that timed out at its normal cap arms the breaker; any answer closes it (and wins).
    let arm = false, answered = false;

    if (wantsFlush) {
      const result = flushed.status === 'fulfilled' ? flushed.value : { error: flushed.reason };
      if (skipFlush) patch.last_flush_skipped = { at, reason: 'budget' };
      else if (!call) {
        patch.last_flush_at = at; patch.last_flush_error_at = at; patch.last_flush = { ok: false, error: authCode };
        patch.last_error = { at, where: 'auth', code: authCode };
      } else if (result && !result.busy) {
        Object.assign(patch, flushHealth(result, at, health));
        const progress = result.sent > 0 || result.rejected > 0;
        answered ||= progress;
        // A prompt or tool hook's flush has only a 2.5 s share: a log_append slower than that says
        // nothing about recall, so only a flush that really had 5 s or more (a Stop flush) arms.
        const fullCap = flushRoom >= 5000;
        arm ||= !progress && fullCap && !reduced('log_append') && result.error instanceof McpFailure && result.error.kind === 'timeout';
      }
    }

    if (wantsRecall) {
      if (recalled.status === 'fulfilled' && recallTask) {
        output = contextOutput(event, recallText(recalled.value));
        patch.last_recall = { at, ok: true };
        answered = true;
      } else {
        const code = recallTask ? failureCode(recalled.reason) : authCode;
        patch.last_recall = { at, ok: false, code };
        patch.last_error = { at, where: 'recall', code };
        arm ||= code === 'timeout' && Boolean(recallTask) && !reduced('recall'); // a Keychain timeout says nothing about the server
        output = contextOutput(event, failureLine('自動想起', code));
      }
    }

    if (wantsContext) {
      const lines = [];
      if (context.status === 'fulfilled' && contextTask) {
        lines.push(sessionContextText(context.value, repo.repo));
        patch.last_session_context = { at, ok: true };
        answered = true;
      } else {
        const code = contextTask ? failureCode(context.reason) : authCode;
        patch.last_session_context = { at, ok: false, code };
        patch.last_error = { at, where: 'session_context', code };
        arm ||= code === 'timeout' && Boolean(contextTask) && !reduced('session_context');
        lines.push(failureLine('セッション開始コンテキスト', code));
      }
      const after = patch.last_flush ?? health.last_flush;
      const left = settings.log_enabled ? await pendingStats(home, client).catch(() => ({ bytes: 0 })) : { bytes: 0 };
      if (left.bytes > 0 && after && after.ok === false) {
        lines.push('cf-memory: 未送信のログが約 ' + Math.max(1, Math.round(left.bytes / 1024)) + ' KB ある(最後のエラー: ' + (after.error || 'unknown') + ')。' +
          (doctorCommand ? '確認: ' + doctorCommand : 'Agent の doctor で確認できる。') + ' 作業はそのまま続けること。');
      }
      // Held entries for this server (or for none) are not sent on their own: say so where it is read.
      if (settings.log_enabled) {
        const here = configuredOrigin(env, config ?? (env.CF_MEMORY_MCP_URL ? {} : await claudeConfig(env, deadline)));
        const held = (await heldGroups(home, client).catch(() => [])).filter(group => group.origin === null || group.origin === here).reduce((sum, group) => sum + group.entries, 0);
        if (held > 0) {
          lines.push('cf-memory: 保留中のログが ' + held + ' 件ある(このサーバー向けだが、今のアカウントのものと確定できないため未送信)。' +
            (doctorCommand ? '内訳と再送コマンド: ' + doctorCommand : 'Agent の doctor に内訳と再送コマンド(replay-held)が出る。') + ' 作業はそのまま続けること。');
        }
      }
      output = contextOutput(event, lines.join('\n\n'));
    }
    // Any answer in this hook wins over a timeout of another call.
    if (arm && !answered) Object.assign(patch, { slow_until: at + BREAKER_MS, slow_probe: undefined });
    else if (breaker && answered) Object.assign(patch, { slow_until: 0, slow_probe: undefined });
    patch.last_hook.ok = !patch.last_error || patch.last_error.at !== at;
  } catch (error) {
    patch.last_hook.ok = false;
    patch.last_error = { at, where: 'hook', code: failureCode(error) };
  }
  await updateHealth(home, client, patch).catch(() => {});
  return { output, entries };
}

/**
 * Process entry for a hook: read the payload from stdin, run, print, exit 0.
 * Claude Code prints nothing when there is nothing to inject; Codex always
 * prints a JSON object ({} when empty), which its Stop hook requires.
 */
export async function hookMain({ client, event: hint, env = process.env, stdin = process.stdin, doctorCommand }) {
  const started = performance.now();
  let done = false, watchdog;
  const finish = output => {
    if (done) return;
    done = true; clearTimeout(watchdog);
    const text = client === 'codex' ? JSON.stringify(output ?? {}) + '\n' : output ? JSON.stringify(output) + '\n' : '';
    if (!text) { process.exit(0); return; }
    process.stdout.write(text, () => process.exit(0));
  };
  // A closed stdout, a stray rejection or an exception still ends with exit 0.
  process.stdout.on('error', () => process.exit(0));
  process.on('uncaughtException', () => { if (!done) finish(null); else process.exit(0); });
  process.on('unhandledRejection', () => { if (!done) finish(null); });
  const arm = event => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(null), Math.max(0, started + (BUDGET_MS[event] ?? BUDGET_MS.UserPromptSubmit) + WATCHDOG_GRACE_MS - performance.now())); };
  arm(hint);
  try {
    let payload = {};
    try { payload = await hookInput(stdin); } catch { payload = {}; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
    const event = EVENTS.includes(payload.hook_event_name) ? payload.hook_event_name : hint;
    arm(event);
    const { output } = await runHook({ client, event, payload, env, started, doctorCommand });
    finish(output);
  } catch { finish(null); }
}
