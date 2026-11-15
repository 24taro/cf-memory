#!/usr/bin/env node
// cf-memory agent for Codex. Codex runs this one script for every hook event
// (SessionStart, UserPromptSubmit, PostToolUse, Stop) and passes the event in
// the payload's hook_event_name. The Codex payload mapping (prompt, tool_name,
// tool_input, tool_response failures, last_assistant_message) is codexHook()
// in entries.mjs. Output is always one JSON object ({} when there is nothing).
//   codex-hook.mjs            (hook; payload on stdin)
//   codex-hook.mjs doctor     (same report as agent.mjs doctor)
import { fileURLToPath } from 'node:url';
import { isMain } from './client.mjs';
import { doctor } from './doctor.mjs';
import { hookMain } from './hook.mjs';

const script = fileURLToPath(import.meta.url);
if (isMain(import.meta.url)) {
  if (process.argv[2] === 'doctor') {
    try {
      const report = await doctor({ refresh: process.argv.includes('--refresh'), versions: !process.argv.includes('--no-versions') });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } catch { console.error('cf-memory agent doctor failed'); process.exitCode = 1; }
  } else {
    await hookMain({ client: 'codex', doctorCommand: 'node "' + script + '" doctor' });
  }
}
