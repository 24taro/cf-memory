import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { unstable_getVarsForDev, unstable_readConfig } from 'wrangler';

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

function configuredTarget() {
  const keys = [
    'CLOUDFLARE_ENV', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'CLOUDFLARE_COMPLIANCE_REGION',
    'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL',
  ];
  // Read the same dotenv files as the Wrangler commands, without printing their contents.
  const vars = unstable_getVarsForDev(undefined, ['.env', '.env.local'], {}, undefined, true, { required: keys });
  const setting = key => process.env[key] ?? vars[key]?.value;
  const config = unstable_readConfig({ env: setting('CLOUDFLARE_ENV') }, { hideWarnings: true, useRedirectIfAvailable: true });
  const name = config.name;
  let account = config.account_id || setting('CLOUDFLARE_ACCOUNT_ID') || setting('CF_ACCOUNT_ID');
  if (!account) {
    const { accounts } = wranglerJson('whoami', '--json');
    if (accounts?.length !== 1) {
      throw new Error('set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account to use');
    }
    account = accounts[0].id;
  }
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !/^[a-z0-9-]+$/.test(name ?? '')) {
    throw new Error('could not determine the Cloudflare account ID and Worker name');
  }

  const region = setting('CLOUDFLARE_COMPLIANCE_REGION') || config.compliance_region;
  const domain = `https://api${region === 'fedramp_high' ? '.fed' : ''}${setting('WRANGLER_API_ENVIRONMENT') === 'staging' ? '.staging' : ''}.cloudflare.com/client/v4`;
  const override = setting('CLOUDFLARE_API_BASE_URL') || setting('CF_API_BASE_URL');
  if (override && override !== domain) throw new Error('the Cloudflare API URL does not match the Wrangler environment');
  return { account: account.toLowerCase(), name, domain, region, ownerHandle: config.vars?.OWNER_HANDLE || 'owner' };
}

function readLocalFile(file) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > 8192) throw new Error(`expected a small regular file at ${file}`);
  return readFileSync(file, 'utf8');
}

function readBinding(file) {
  const content = readLocalFile(file);
  if (content === null) return null;
  let binding;
  try { binding = JSON.parse(content); } catch { throw new Error('the local deployment identity is invalid'); }
  if (binding?.version !== 1 || !['pending', 'ready'].includes(binding.phase) ||
      !/^[a-f0-9]{32}$/i.test(binding.workerId ?? '')) {
    throw new Error('the local deployment identity is invalid');
  }
  return binding;
}

function writeBinding(file, binding, replace = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    if (replace) renameSync(temporary, file);
    else linkSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function cloudflareApi({ domain, account }) {
  const auth = wranglerJson('auth', 'token', '--json');
  const headers = auth.type === 'api_key'
    ? { 'X-Auth-Email': auth.email, 'X-Auth-Key': auth.key }
    : { Authorization: `Bearer ${auth.token}` };
  const workers = `${domain}/accounts/${account}/workers`;

  return async function request(path, options = {}) {
    try {
      const response = await fetch(workers + path, {
        ...options, headers: { ...headers, 'Content-Type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      return { ...await response.json(), status: response.status, ok: response.ok };
    } catch {
      throw new Error('could not confirm the Worker and account with Cloudflare; retry from this checkout');
    }
  };
}

async function ownsActiveToken(origin, token, ownerHandle) {
  try {
    const response = await fetch(`${origin}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.token_status === 'active' && result.handle === ownerHandle && Array.isArray(result.scopes) && result.scopes.includes('admin');
  } catch {
    return false;
  }
}

async function prepareWorker(claimFile, bindingFile, secretsFile) {
  const { account, name, domain, region, ownerHandle } = configuredTarget();
  const binding = readBinding(bindingFile);
  if (binding && (binding.account !== account || binding.name !== name || binding.domain !== domain)) {
    throw new Error('the selected Cloudflare account or Worker differs from this checkout’s saved deployment');
  }
  const request = cloudflareApi({ domain, account });
  const subdomain = await request('/subdomain');
  if (!subdomain.ok || !subdomain.success || !/^[a-z0-9-]+$/.test(subdomain.result?.subdomain ?? '')) {
    throw new Error('could not verify a workers.dev address for the selected account. Check Workers & Pages in Cloudflare');
  }
  const origin = `https://${name}.${subdomain.result.subdomain}${region === 'fedramp_high' ? '.fed' : ''}.workers.dev`;
  if (binding && binding.origin !== origin) throw new Error('the selected Worker URL differs from this checkout’s saved deployment');

  const saved = readLocalFile(secretsFile);
  const token = saved?.match(/^API_TOKEN=([^\r\n]*)/m)?.[1];
  if (saved !== null && (!token || token.length < 32)) {
    throw new Error(`${secretsFile} holds no API_TOKEN of 32 or more characters`);
  }
  const record = workerId => ({ version: 1, account, name, domain, origin, workerId, phase: 'pending' });
  const validWorker = result => result?.name === name && /^[a-f0-9]{32}$/i.test(result.id ?? '');
  const output = (mode, workerId) => ({ mode, account, name, domain, origin, workerId });
  const existing = await request(`/workers/${name}`);

  if (existing.ok && existing.success && validWorker(existing.result)) {
    const worker = existing.result;
    if (binding && binding.workerId !== worker.id) {
      throw new Error('Cloudflare reports a different Worker identity for the saved name');
    }
    const claim = readLocalFile(claimFile);
    const ownsClaim = /^[a-f0-9]{32}$/.test(claim ?? '') && Array.isArray(worker.tags) && worker.tags.includes(`cf-memory-install-${claim}`);
    if (binding?.phase === 'pending' || (!binding && ownsClaim)) {
      const versions = await request(`/workers/${name}/versions?page=1&per_page=1`);
      if (!versions.ok || !versions.success || !Array.isArray(versions.result)) {
        throw new Error('could not verify the version state of the reserved Worker');
      }
      if (!versions.result.length) {
        if (!binding) writeBinding(bindingFile, record(worker.id));
        return output('first', worker.id);
      }
      // The previous run deployed the original Worker but may have stopped
      // before publishing its route or applying the database migrations.
      if (binding && token) return output('update', worker.id);
    }
    if (!token) throw new Error(`the Worker already exists. Restore ${secretsFile} from its original checkout`);
    if (!await ownsActiveToken(origin, token, ownerHandle)) {
      throw new Error('the selected Worker did not accept the saved owner token; check the deployment before retrying');
    }
    if (!binding) writeBinding(bindingFile, { ...record(worker.id), phase: 'ready' });
    return output('update', worker.id);
  }

  if (existing.status !== 404 || existing.success !== false) throw new Error('could not verify whether the Worker already exists');
  if (binding || saved !== null) throw new Error('the original Worker could not be verified; the saved token cannot be used on a new Worker');

  // Cloudflare's create-only request arbitrates across checkouts. Never fall
  // back to an upsert when another checkout claims the name first.
  const tag = installTag(claimFile);
  const created = await request('/workers', { method: 'POST', body: JSON.stringify({ name, tags: [tag] }) });
  if (!created.ok || !created.success || !validWorker(created.result) ||
      !Array.isArray(created.result.tags) || !created.result.tags.includes(tag)) {
    if (created.status === 409) throw new Error('the Worker name is already in use or reserved by another install');
    throw new Error(`Cloudflare did not confirm the Worker reservation (HTTP ${created.status}); retry from this checkout`);
  }
  writeBinding(bindingFile, record(created.result.id));
  return output('first', created.result.id);
}

try {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'ready') {
    const binding = readBinding(first);
    if (!binding || binding.workerId !== second) throw new Error('the saved deployment identity changed before completion');
    if (binding.phase !== 'ready') writeBinding(first, { ...binding, phase: 'ready' }, true);
  } else if (command === 'prepare') {
    const { mode, account, name, domain, origin, workerId } = await prepareWorker(first, second, third);
    console.log(`${mode} ${account} ${name} ${domain} ${origin} ${workerId}`);
  } else {
    throw new Error('expected prepare or ready');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
