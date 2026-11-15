import { execFileSync, spawnSync } from 'node:child_process';
// One build identity for dry-run and operator-authorized deployment. Arguments
// are passed directly, never through a shell. Do not infer production approval.
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
if (dirty && !dry) throw Error('Commit or clean the checkout before production deployment');
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', ...args,
  '--var', 'BUILD_GIT_SHA:' + sha + (dirty ? '-dirty' : ''), '--var', 'BUILD_DATE:' + new Date().toISOString()], { stdio: 'inherit' });
process.exit(result.status ?? 1);
