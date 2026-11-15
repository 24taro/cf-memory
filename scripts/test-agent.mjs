import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// cf-memory agent tests (cf-memory-agent/test, node:test). Fixtures create their own
// temporary homes; one private parent keeps them out of the system temp dir.
const files = readdirSync('cf-memory-agent/test').filter(name => name.endsWith('.test.mjs')).sort().map(name => 'cf-memory-agent/test/' + name);
const testTemp = mkdtempSync(join(tmpdir(), 'cf-memory-agent-tests-'));
const keepTestTemp = process.env.CF_MEMORY_KEEP_TEST_TMP === '1';
let status = 0;
try {
  chmodSync(testTemp, 0o700);
  // Run inside a Claude Code session, the parent inherits the operator's live
  // CF_MEMORY_* settings; fixtures must see only the settings they set themselves.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CF_MEMORY_') || key === 'CF_MEMORY_KEEP_TEST_TMP' || key === 'CF_MEMORY_TEST_TIME_SCALE'));
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...inherited, TMPDIR: testTemp, TMP: testTemp, TEMP: testTemp } });
  status = result.status ?? 1;
} finally {
  if (keepTestTemp) console.error(`Agent test fixtures retained: ${testTemp}`);
  else rmSync(testTemp, { recursive: true, force: true });
}
process.exitCode = status;
