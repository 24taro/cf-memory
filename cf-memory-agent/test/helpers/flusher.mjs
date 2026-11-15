// Child process: a hook that waits until `startAt`, then flushes. Every batch
// it sends takes `holdMs`; its ids go to `log` and its time span (with this
// pid) to `log`.spans.
import { appendFileSync } from 'node:fs';
import { flush } from '../../scripts/spool.mjs';
const [home, startAt, log, holdMs] = [process.argv[2], Number(process.argv[3]), process.argv[4], Number(process.argv[5] || 5)];
while (Date.now() < startAt) { /* spin: every flusher starts in the same millisecond */ }
const result = await flush(home, 'codex', async batch => {
  const start = performance.timeOrigin + performance.now();
  await new Promise(resolve => setTimeout(resolve, holdMs));
  appendFileSync(log, batch.map(entry => entry.id).join('\n') + '\n');
  appendFileSync(log + '.spans', JSON.stringify({ pid: process.pid, start, end: performance.timeOrigin + performance.now() }) + '\n');
  return { stored: batch.length };
});
process.stdout.write(JSON.stringify({ busy: Boolean(result.busy), sent: result.sent, error: result.error ? String(result.error.message ?? result.error) : undefined }));
