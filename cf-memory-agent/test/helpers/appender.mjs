// Child process: a hook that appends for a duration or for a fixed count,
// then prints the ids it appended.
import { appendEntries } from '../../scripts/spool.mjs';
import { makeEntry } from '../../scripts/entries.mjs';
const [, , home, schedule, tag, pause = '0'] = process.argv;
const ids = [], pauseMs = Number(pause);
const count = schedule.startsWith('count=') ? Number(schedule.slice('count='.length)) : null;
const end = count === null ? Date.now() + Number(schedule) : 0;
const shouldAppend = count === null ? () => Date.now() < end : index => index < count;
for (let i = 0; shouldAppend(i); i++) {
  const entry = makeEntry({ client: 'codex', session_id: 's-' + tag, repo: 'x/y', ts: Date.now(), kind: 'action', text: 'Bash: echo ' + tag + ' ' + i });
  await appendEntries(home, 'codex', [entry]);
  ids.push(entry.id);
  if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
}
process.stdout.write(JSON.stringify(ids));
