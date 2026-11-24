import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { unstable_readConfig } from 'wrangler';

function wranglerJson(...args) {
  try {
    return JSON.parse(execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }));
  } catch {
    throw new Error(`could not read the result of wrangler ${args.join(' ')}`);
  }
}

function installTag(file) {
  try {
    writeFileSync(file, randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('could not save the local installation claim');
  }
  const claim = readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{32}$/.test(claim)) throw new Error('the local installation claim is invalid');
  return `cf-memory-install-${claim}`;
}

async function reserveWorker(claimFile) {
  const config = unstable_readConfig({ env: process.env.CLOUDFLARE_ENV }, { hideWarnings: true, useRedirectIfAvailable: true });
  const name = config.name;
  let account = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  if (!account) {
    const { accounts } = wranglerJson('whoami', '--json');
    if (accounts?.length !== 1) {
      throw new Error('set CLOUDFLARE_ACCOUNT_ID to the account to use for the first install');
    }
    account = accounts[0].id;
  }
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !/^[a-z0-9-]+$/.test(name ?? '')) {
    throw new Error('could not determine the Cloudflare account ID and Worker name');
  }

  const region = process.env.CLOUDFLARE_COMPLIANCE_REGION || config.compliance_region;
  const domain = `https://api${region === 'fedramp_high' ? '.fed' : ''}${process.env.WRANGLER_API_ENVIRONMENT === 'staging' ? '.staging' : ''}.cloudflare.com/client/v4`;
  const override = process.env.CLOUDFLARE_API_BASE_URL || process.env.CF_API_BASE_URL;
  if (override && override !== domain) throw new Error('the Cloudflare API URL does not match the Wrangler environment');

  const auth = wranglerJson('auth', 'token', '--json');
  const headers = auth.type === 'api_key'
    ? { 'X-Auth-Email': auth.email, 'X-Auth-Key': auth.key }
    : { Authorization: `Bearer ${auth.token}` };
  const workers = `${domain}/accounts/${account}/workers/workers`;

  async function request(path, options = {}) {
    try {
      const response = await fetch(workers + path, {
        ...options, headers: { ...headers, 'Content-Type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      return { ...await response.json(), status: response.status, ok: response.ok };
    } catch {
      throw new Error('could not confirm the Worker reservation with Cloudflare; retry from this checkout');
    }
  }

  // The create-only API arbitrates between machines; Wrangler deploy itself is an upsert.
  const tag = installTag(claimFile);
  const owns = result => result?.name === name && Array.isArray(result.tags) && result.tags.includes(tag);
  const created = await request('', { method: 'POST', body: JSON.stringify({ name, tags: [tag] }) });
  if (created.ok && created.success && owns(created.result)) return { account, name };
  if (created.status !== 409 || !created.errors?.some(error => error.code === 10040)) {
    throw new Error(`Cloudflare did not confirm the Worker reservation (HTTP ${created.status}); retry from this checkout`);
  }

  // An interrupted first install can resume only its own Worker, before any version exists.
  const existing = await request(`/${name}`);
  if (existing.ok && existing.success && owns(existing.result)) {
    const versions = await request(`/${name}/versions?page=1&per_page=1`);
    if (versions.ok && versions.success && Array.isArray(versions.result) && versions.result.length === 0) {
      return { account, name };
    }
  }
  throw new Error('the Worker name is already in use or reserved by another install. Retry from the original checkout');
}

try {
  const { account, name } = await reserveWorker(process.argv[2]);
  console.log(`${account} ${name}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
