import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
// Keep npm test -- <Vitest options> compatible while also checking plugin code.
// Each server suite starts D1/Miniflare. Unbounded CPU-based parallelism can
// exhaust local loopback sockets; match CI's finite default unless overridden.
const options = process.argv.slice(2);
if (!options.some(option => /^--maxWorkers(?:=|$)/.test(option))) options.push('--maxWorkers=2');
const server = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...options], { stdio: 'inherit' });
if (server.status !== 0) process.exit(server.status || 1);
const agent = spawnSync(process.execPath, ['scripts/test-agent.mjs'], { stdio: 'inherit' });
if (agent.status !== 0) process.exit(agent.status ?? 1);
const operatorTests = existsSync('scripts/test') ? readdirSync('scripts/test').filter(n => n.endsWith('.test.mjs')).map(n => 'scripts/test/' + n) : [];
if (!operatorTests.length) process.exit(0);
const operator = spawnSync(process.execPath, ['--test', ...operatorTests], { stdio: 'inherit' });
process.exit(operator.status ?? 1);
