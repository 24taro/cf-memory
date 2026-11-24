# cf-memory agent 0.3.3

A small hook program for Claude Code and Codex. It keeps the conversation itself
in cf-memory so agents can find it later by keyword.
No summarization, no model calls, no background workers.

## What each hook does

| Hook | Does |
|---|---|
| SessionStart | flushes; `session_context` → injects `core_memory` and `handoff` (the last reply of another session in the same repository) |
| UserPromptSubmit | queues `prompt`, flushes; injects keyword `recall` for the prompt without the core blocks (SessionStart already showed them), in at most about 9,600 characters (Claude Code shows only a preview of a hook text over 10,000; Codex's limit is raised with `additionalContextLimit`) and `CF_MEMORY_RECALL_BUDGET` tokens (600 for a bare acknowledgement such as "ok"). In a directory without a remote, recall uses the remotes of its child directories: that scan runs after the prompt is queued, spends at most 1.5 s in all, and the next prompt goes on where it stopped (cached 10 minutes) |
| PostToolUse / PostToolUseFailure | queues one `action` line, plus an `error` entry when the tool failed; no network call unless ≥40 entries are waiting or the oldest waiting entry is over 5 minutes old |
| Stop | queues `reply` (the last assistant message), flushes as much as its budget allows |

`session_context` answers `{ core_memory: string, handoff: { session_id, time, text } | null }`; only
those two fields are read.

Entries: `{ id, session_id, client, repo, ts, kind, text }`.

- `prompt` / `reply`: full text, cut at 65,536 chars with `…（以下省略）`.
- `action`: one line, at most 400 chars: `"<tool>: <command | file_path | path | url | query | pattern | description>"`,
  with ` → 失敗` when it failed. Grep/Glob show `pattern (path)`; Codex `apply_patch` shows the patched files.
- `error`: the action line, a newline, then the head of the failure output; 2,048 chars in all.
- Not kept: tool output, file contents, MCP results, agent-to-agent tools and wait/clock tools
  (`send_message`, `spawn_agent`, `wait_agent`, `sleep`, `curr_time`, Claude `SendMessage`/`Agent`/`Task`, …).
- `id` = sha256 over client, session id, ts, kind and text (the server ignores ids it already has).
- `repo` = the current Git origin as `//host/owner/name`, with a port for nondefault services. HTTPS
  and SSH clones of the same hosted repository share a handoff. Local and file-path origins use
  the directory name plus a hash of its full path. `session_context` uses the same `repo` and
  `session_id` as the entries. Logs recorded under the earlier keys remain available through
  `log_search` and `log_sessions`. Automatic handoff uses replies recorded with the current key.
- Everything passes `scrubText` and the free-text secret scrubber (`パスワードは xxxx`,
  `password is xxxx`, `pw: xxxx`, `暗証番号 1234`) before it is written anywhere.
- A tool call whose input names a credential file (`DEFAULT_DENY_PATHS`: `.env`, `.env.*`, `*.pem`,
  `*.key`, `credentials*`, `secrets*`, plus `*.env`, `.dev.vars`, `*.tfvars`, `.netrc`, `.pgpass`,
  `.npmrc`, `.git-credentials`, SSH private keys, gcloud/gh credential files, …; also through shell
  spellings such as `.e""nv`, `.en?`, `.[e]nv`) in any path or command field, or runs a credential
  printer (`security find-*-password`, `gh auth token`, `gcloud auth print-access-token`, `aws ssm
  get-parameter --with-decryption`, `kubectl config view --raw`, `heroku config`, `printenv`, `env`,
  `export -p`, `set`, `process.env`, …), keeps only its action line: no `error` entry, no output.
  That action line shows the command's first line without heredoc bodies, here-strings, quoted
  text, assignment values or echo/printf arguments (what would be written into the file); a patch
  shows only its file names.
- An action line cut at 400 chars ends with `…（以下省略）` (then ` → 失敗` when it failed). No cut
  lands inside a `[REDACTED…]` marker.
- `repo` and `session_id` never contain control characters (the server refuses them): in `repo` they
  become spaces; a `session_id` with one, or longer than 128 chars, is replaced by its sha256.
- A hook payload over 4 MB is not parsed whole: the tool input (or its `command`/`file_path`/…
  fields) and the exit code are recovered from complete JSON values near its start and end; the
  output becomes `（出力が大きすぎて省略）`, and an unrecoverable input `（入力が大きすぎて省略）`. An
  oversized prompt or reply keeps its head (scrubbed, cut to 65,536 chars with the marker).

Payload fields used — Claude Code: `session_id`, `cwd`, `hook_event_name`, `prompt`, `tool_name`,
`tool_input`, `error` (PostToolUseFailure; `tool_response` as fallback), `is_interrupt`,
`last_assistant_message`. Codex: the same names; Codex has no PostToolUseFailure, so a failure is read
from `tool_response` (`exit_code`/`exitCode` ≠ 0, `success: false`, `isError`/`is_error`, `error`, or
text starting `Exit code: N`).

## Spool and flush

Entries are appended to `~/.cf-memory/v3/spool/<client>.jsonl` (or `$CF_MEMORY_AGENT_HOME/spool`) and
sent with `log_append` in batches of ≤50 entries and ≤2,000,000 bytes of request JSON (the MCP
endpoint rejects bodies over 8 MB; an entry larger than that on its own goes alone), within the
hook's time budget (SessionStart 6 s, UserPromptSubmit 9 s, tool hooks 3 s, Stop 7 s; a watchdog
ends the process shortly after). A cursor file records what was delivered; anything unsent goes
with the next flush. With less than 1 s of the flush's share left (after a slow OAuth refresh, say) or
the deadline reached before the first send, the flush is skipped (`budget`: recorded as
`last_flush_skipped`, not as a failure; the entries go with the next flush). Files are never rewritten: a flush that has delivered the live file (or 8 MB
of it) renames it to a sealed segment (`<client>.<time>-<random>.seg`), which is deleted whole once
delivered; an append that raced the rename is written again to the new live file (the server
ignores the repeated id). One flush runs at a time per client: the lock file holds a random
token, is refreshed before every send, is taken over only when not refreshed for 30 s (one hook at
a time does the takeover), and a flush that finds its lock or file taken over stops without
writing anything. Tool hooks flush only at ≥40 waiting entries or when the oldest is over
5 minutes old, and after a failed flush they skip the network for a minute (other hooks still
retry). A write that failed halfway leaves a torn last line: the next write starts with a newline,
so the torn part never swallows the next entry (an entry joined to one by an older Agent is
recovered from its `{"id":"`). After a send times out with nothing delivered, the next batches
are half as large (down to 1 entry) and grow back after each success. A flush also deletes
leftover `*.tmp`, `*.old` and `*.takeover` files older than an hour. Hooks always exit 0; problems
are written to `~/.cf-memory/v3/health/<client>.json` (codes and timestamps only, never text or tokens).

Circuit breaker: after a request to the server times out at its normal cap, every call for the next
5 minutes (recall, `session_context`, the flush) gets at most 1.5 s, so a hung server cannot hold each
prompt for 8 s. Once half of that window has passed, one call (the first: recall, `session_context`,
else the flush) probes the server with its normal cap. A timeout at the normal cap re-arms the
breaker for another 5 minutes; a timeout at 1.5 s, or a deadline reached before anything was sent,
does not; any answer closes it. When `session_context` fails, SessionStart injects a one-line notice,
as recall does.

Accepted crash windows (each only repeats work; nothing is lost): a hook killed after a batch was
delivered but before the cursor write resends it (the server counts `duplicates`); an append that
raced a seal is written twice; a flush killed between setting a refused or held entry aside and the
cursor write lists it twice in `rejected.jsonl` / `held.jsonl` (a replay queues it once).

When the server refuses an entry as invalid (`entries[i].… ` errors, which fail the same way on
every retry), that entry moves to `spool/<client>.rejected.jsonl` (kept up to 4 MB, then dropped)
at once, its id is kept in the cursor so it is never resent (even when the deadline cuts the
batch), and the rest of the batch is resent, so one bad entry never blocks the spool. After 20
refusals in a row with nothing accepted the server is more likely at fault than the entries: the
rest stays in the spool, the flush fails with `rejecting` and every hook waits a minute before the
next try; `doctor` then says the server most likely refuses everything this Agent sends (check
that the server and Agent versions match). Refused entries make `doctor` warn (`warnings`,
`spool.rejected_entries`, `spool.rejected_dropped` once the file is full); `agent.mjs
replay-rejected` queues them again, marked as replayed: one the server still refuses is set aside
again on its own and never counts toward the 20 (which hold back only fresh entries). The server's
`dropped_over_cap` / `dropped_over_total_cap` (server daily caps, off unless the operator sets them) and `ts_clamped` (a fast clock) counts
are recorded in the health file's `last_flush`; they are not errors. Transport, auth,
HTTP 5xx and other server errors (logs not configured, write conflicts) keep the batch for the
next flush.

Destinations: an entry is delivered only to the server and account that queued it, and only when
that is known. Each queued line carries `to`: the origin of the server configured when the hook
queued it (`CF_MEMORY_MCP_URL`, else the `~/.claude.json` url, else the default) and what the hook knew
about the account without a request. The account that flushed last is never assumed.

- `{ origin, account }`: the token at hand (environment, Claude config, or macOS Keychain)
  is one the server's `whoami` already reported for that account.
- `{ origin, at, cred }`: account unknown. `cred` is a fingerprint of the token at hand (a keyed
  hash; the key is `~/.cf-memory/v3/accounts.key`), `at` the time it was queued.
- `{ origin, at }`: the server is known and a token was unavailable or ambiguous.
- `{}`: no usable server URL.

A flush first settles which account its token belongs to: the server's `whoami` `user_id`, asked
once per token and remembered in `~/.cf-memory/v3/accounts.json` (mode 0600) as hashes: per origin the
accounts seen (a hash of the user id), for each up to 4 tokens (each a hash with its own salt, plus
its fingerprint; forgotten after 90 days without use), and which account last flushed there.
Two live tokens of one account cost one verification request each. Only hashes are stored.
A missing or anonymous identity leaves the entries queued
(`no_account`; the entries stay queued). The flush then sends:

- entries labelled with its own account;
- entries whose fingerprint is its own token's, or one `whoami` reported for
  this account before. A fingerprint of a token no flush has identified waits, also on a machine
  with one account and goes on its own at that token's first verified flush.

The Keychain lookup at recording time is local and limited to 500 ms. If a
hook can read a credential later, it can send only entries already bound by
the rules above. Use one matching Keychain entry per server or set the token
explicitly in the client environment.

Every other entry (another server, another account, account not known, no destination) moves, with
its `to`, to `spool/<client>.held.jsonl` and the cursor passes it: it is not sent elsewhere and does
not block the entries behind it. The file is kept up to 16 MB; past that, entries that would be held
are dropped and counted (`spool.held_dropped`, a `doctor` problem). Held entries no longer count
toward the 64 MB limit below. Held entries known to be the flushing account's (labelled with it, or
queued by a token since identified as its own) are queued again on their own when that account
takes over from another one or its token is identified. The rest needs the operator:

- SessionStart injects one line with the number of held entries for the configured server and the
  `doctor` command.
- `doctor` lists them per destination (`spool.held`: origin, account or unknown, count, time range,
  up to 5 session ids) and prints the command for each group: a `problems` entry (and `ok: false`)
  for groups the configured account can act on, a warning for another server's or account's.
- `agent.mjs replay-held` queues held entries again as they are, and the next flush applies the
  rule above again. It takes a selection: `--origin ORIGIN|none`, `--account HASH` or `--unknown`,
  `--session ID`, `--since TIME`, `--until TIME` (ISO 8601 or epoch ms; all given must match; the
  others stay held).
- `agent.mjs replay-held <selection> --to-current` is the explicit decision to send the selected
  entries to the server and account configured now. It needs a selection, so one account's entries
  are never swept along with another's. `doctor` only suggests it per session, for entries of
  unknown account.

`replay-rejected` keeps each entry's destination.

Agent 0.3.3 holds old entries without an account or token fingerprint. If they
also lack a server, `doctor` groups them under `--origin none`. Review the
entries and use a specific `replay-held` selection with `--to-current` to
assign them to the configured server and account.

Credentials: `CF_MEMORY_ACCESS_TOKEN`, Claude's `mcpServers["cf-memory"].headers`, or the macOS
Keychain item `Claude Code-credentials` (its `cf-memory|…` MCP OAuth entry). Codex uses the same
sources. The Claude user configuration lives in `~/.claude.json`, or in
`$CLAUDE_CONFIG_DIR/.claude.json` for a separate profile. `CF_MEMORY_CLAUDE_CONFIG`
can explicitly select another file. A token is sent only to the server it was issued for (the Keychain entry's `serverUrl`,
else the `~/.claude.json` url, else the default): `CF_MEMORY_MCP_URL` may name another host only
together with `CF_MEMORY_ACCESS_TOKEN`. Only the Stop hook refreshes an
expiring token (`claude mcp get cf-memory`), and a refresh that did not take effect is not tried again
for 10 minutes (`doctor --refresh` always tries). A refresh ends 1 s before the hook's deadline so the
refreshed entry can be read back; past the deadline the hook reports `budget`, not `no_credentials`.

Over 64 MB of undelivered entries, new `action` entries are dropped (prompts, replies and errors are
kept); the hook counts them and `doctor` warns for a day after the last one (`spool.dropped_entries`,
`spool.last_dropped`).

## Settings

Environment first, then `~/.cf-memory/v3/config.json`:

| Setting | Default | |
|---|---|---|
| `CF_MEMORY_LOG_ENABLED` | `true` | queue and send log entries |
| `CF_MEMORY_RECALL_ENABLED` | `true` | inject recall (UserPromptSubmit) and session context (SessionStart) |
| `CF_MEMORY_RECALL_BUDGET` | `10000` | recall token budget (100–20000); the character limit above usually binds first |

## Commands

```bash
node cf-memory-agent/scripts/agent.mjs doctor            # JSON: versions, auth, spool, last flush/error, settings
node cf-memory-agent/scripts/agent.mjs flush             # send the spool now (30 s budget; recorded as the hooks record it)
node cf-memory-agent/scripts/agent.mjs install --dry-run # print what would be written for Claude Code and Codex
node cf-memory-agent/scripts/agent.mjs install [--client claude-code|codex] [--home DIR]
node cf-memory-agent/scripts/agent.mjs uninstall [--client claude-code|codex] [--dry-run] [--home DIR]
node cf-memory-agent/scripts/agent.mjs replay-rejected [--client claude-code|codex]   # queue refused entries again
node cf-memory-agent/scripts/agent.mjs replay-held [--client claude-code|codex] [--origin ORIGIN|none] [--account HASH|--unknown] [--session ID] [--since TIME] [--until TIME] [--to-current]
                                                     # queue held entries again, all or a selection (--to-current: the selected ones, for the server and account configured now)
```

- Claude Code: adds the marketplace when needed and verifies that its registered source is this
  checkout. Runs `claude plugin install cf-memory-agent@cf-memory` and `claude plugin update …`,
  then verifies the user-scope version, cache location and package file digests.
  Install and uninstall return a nonzero status if the requested state cannot be verified.
  Once the plugin is installed it removes the old `~/.claude/hooks/cf-memory-recall.sh` hook from
  `settings.json` (backup `settings.json.cf-memory-backup-<ms>`), so recall is not injected twice. Only
  the groups and events that removal empties go; every other key stays (an empty `"Notification": []`
  too). A symlinked `settings.json` (dotfile managers) is edited at its target, with the backup next
  to the target; a target that cannot be written is left as it is and the report says what to remove
  by hand.
- Codex: copies `hooks/`, `scripts/`, `plugin.json` to `$CODEX_HOME/cf-memory-agent/<version>-<hash>/` and
  replaces the cf-memory agent handlers in `$CODEX_HOME/hooks.json` (other hooks are kept; a backup is
  written; the handlers clear `NODE_OPTIONS`, as the Claude ones do). The 2 newest backups and
  package copies are kept. **Approve the new hooks once in Codex `/hooks`.** The installer never
  edits trust state. The old `CF_MEMORY_CODEX_CONFIG_DIR` / `CF_MEMORY_CODEX_HOOKS_FILE` are not read; set
  to other paths they make install and uninstall stop (use `CODEX_HOME` or `--home`).
- Uninstall removes only cf-memory's parts: `claude plugin uninstall cf-memory-agent@cf-memory`, the old
  recall hook, the cf-memory handlers in `hooks.json` (backed up), the package copies and the install
  record. The spool and health files stay.
- `--home DIR` installs everything under `DIR` (tests); an empty `--home=` is refused.

## Files

`scripts/agent.mjs` (Claude entry and commands), `scripts/codex-hook.mjs` (Codex entry),
`scripts/hook.mjs` (hook flow), `scripts/entries.mjs` (payload → entries), `scripts/spool.mjs`,
`scripts/repo.mjs`, `scripts/settings.mjs`, `scripts/health.mjs`, `scripts/doctor.mjs`,
`scripts/install.mjs`, `scripts/transport.mjs` (OAuth + MCP HTTP), `scripts/redact.mjs`.
`scope.mjs`, `time-zone.mjs`, `memory-echo.mjs` and `redact.mjs` are also imported by the Worker;
`portability.mjs` is the separate memory export/import tool. An import compares each restored note
with what the server stores for the archive's text (a body whose first non-blank line opens a
`--- key: value ---` block gets that fence rewritten to `***`; each run of control characters in a
title or tag becomes one space), so archives holding rows from before those rules restore
completely and a retry changes nothing. A note or core block whose body is over the server's
262,144-character limit is refused before anything is written, in the dry run too, with the
record's id in the message.

Tests: `npm run test:agent` (node:test, `cf-memory-agent/test`).
