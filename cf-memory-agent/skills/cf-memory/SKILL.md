---
name: cf-memory-memory
description: Find past conversations and work in cf-memory by keyword (log_search, log_read), use injected recall and session context, save lasting knowledge with notes_put, and check the Agent with doctor.
---

cf-memory keeps the conversation itself: each prompt, final reply, one-line tool
action and failed-tool error, scrubbed of secrets. It does not summarize.

- Recall (each prompt) and session context (core memory + the last reply of
  another session in the same repository) are injected automatically. Treat
  them as fallible context; current instructions and checked code win.
- To find earlier work, call `log_search` with short words, several times,
  rephrasing (names, file names, error words, Japanese and English). Narrow with
  `repo`, `kind`, `since`. Prompts and replies come first; a reply hit's `question`
  says what it answered. A snippet is only part of an entry: open a promising hit
  with `log_read` even when its snippet does not show the answer.
- `log_sessions` lists recent sessions with their first prompt and last reply.
- Save knowledge that should last with `notes_put` (search first to avoid
  duplicates). Never save credentials or private content.
- Health: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agent.mjs" doctor` (Claude Code)
  or `node <installed package>/scripts/codex-hook.mjs doctor` (Codex). It shows
  auth, the local spool, the last flush and the last error.
