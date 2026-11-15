// Child process: a hook that appends one small entry at a time for `ms`
// (pausing `pauseMs` between appends), then prints the ids it appended.
import { appendEntries } from '../../scripts/spool.mjs';
import { makeEntry } from '../../scripts/entries.mjs';
const [home, ms, tag, pauseMs] = [process.argv[2], Number(process.argv[3]), process.argv[4], Number(process.argv[5] || 0)];
const ids = [], end = Date.now() + ms;
for (let i = 0; Date.now() < end; i++) {
  const entry = makeEntry({ client: 'codex', session_id: 's-' + tag, repo: 'x/y', ts: Date.now(), kind: 'action', text: 'Bash: echo ' + tag + ' ' + i });
  await appendEntries(home, 'codex', [entry]);
  ids.push(entry.id);
  if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
}
process.stdout.write(JSON.stringify(ids));
