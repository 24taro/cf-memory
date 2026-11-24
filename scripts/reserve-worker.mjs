import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
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
  return { account: account.toLowerCase(), name, domain, region, ownerHandle: config.vars?.OWNER_HANDLE || 'owner', config };
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
  const base = `${domain}/accounts/${account}`;

  return async function request(path, options = {}) {
    try {
      const response = await fetch(base + path, {
        ...options, headers: { ...options.headers, ...headers, 'Content-Type': 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      return { ...await response.json(), status: response.status, ok: response.ok };
    } catch {
      throw new Error('could not confirm the Worker and account with Cloudflare; retry from this checkout');
    }
  };
}

async function ownsActiveToken(origin, token, ownerHandle, timeout = 15_000) {
  try {
    const response = await fetch(`${origin}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.token_status === 'active' && result.handle === ownerHandle && Array.isArray(result.scopes) && result.scopes.includes('admin');
  } catch {
    return false;
  }
}

function existingOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
        ['/', '/mcp', '/mcp/'].includes(url.pathname)) return url.origin;
  } catch { /* report the intended use without echoing the input */ }
  throw new Error('--existing-url must be the original HTTPS Worker URL or its /mcp endpoint');
}

async function workerTarget(bindingFile, existingUrl, requireReady = false) {
  const target = configuredTarget();
  const { account, name, domain, region } = target;
  const binding = readBinding(bindingFile);
  if (requireReady && binding?.phase !== 'ready') throw new Error('token rotation requires a verified deployment from this checkout');
  if (binding && (binding.account !== account || binding.name !== name || binding.domain !== domain)) {
    throw new Error('the selected Cloudflare account or Worker differs from this checkout’s saved deployment');
  }
  const accountRequest = cloudflareApi({ domain, account });
  const request = (path, options) => accountRequest(`/workers${path}`, options);
  const subdomain = await request('/subdomain');
  if (!subdomain.ok || !subdomain.success || !/^[a-z0-9-]+$/.test(subdomain.result?.subdomain ?? '')) {
    throw new Error('could not verify a workers.dev address for the selected account. Check Workers & Pages in Cloudflare');
  }
  const origin = `https://${name}.${subdomain.result.subdomain}${region === 'fedramp_high' ? '.fed' : ''}.workers.dev`;
  if (binding && binding.origin !== origin) throw new Error('the selected Worker URL differs from this checkout’s saved deployment');
  if (existingUrl && existingOrigin(existingUrl) !== origin) throw new Error('the selected Worker URL differs from --existing-url');
  const existing = await request(`/workers/${name}`);
  const validWorker = result => result?.name === name && /^[a-f0-9]{32}$/i.test(result.id ?? '');
  if (binding && existing.ok && existing.success && validWorker(existing.result) && binding.workerId !== existing.result.id) {
    throw new Error('Cloudflare reports a different Worker identity for the saved name');
  }
  return { ...target, binding, origin, request, accountRequest, existing, validWorker };
}

function readOwnerToken(secretsFile) {
  const saved = readLocalFile(secretsFile);
  const token = saved?.match(/^API_TOKEN=([^\r\n]*)/m)?.[1];
  if (saved !== null && (!token || token.length < 32)) {
    throw new Error(`${secretsFile} holds no API_TOKEN of 32 or more characters`);
  }
  return token ?? null;
}

const D1_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function namedEntry(rows, key, value) {
  const matches = Array.isArray(rows) ? rows.filter(row => row?.[key] === value) : [];
  return matches.length === 1 ? matches[0] : null;
}

async function verifyStorage(target) {
  const { name, config, binding, request, accountRequest } = target;
  const settings = await request(`/scripts/${name}/settings`);
  const deployed = settings.result?.bindings;
  if (!settings.ok || !settings.success || !Array.isArray(deployed)) {
    throw new Error('could not verify the active Worker storage bindings');
  }
  const [DB, LOGS] = await Promise.all(['DB', 'LOGS'].map(async name => {
    const wanted = namedEntry(config.d1_databases, 'binding', name);
    const live = namedEntry(deployed, 'name', name);
    if (!wanted || live?.type !== 'd1' || !D1_ID.test(live.id ?? '')) {
      throw new Error(`could not verify the ${name} D1 binding`);
    }
    const id = live.id.toLowerCase();
    if (wanted.database_id && wanted.database_id.toLowerCase() !== id) {
      throw new Error(`the configured ${name} D1 database ID differs from the running Worker`);
    }
    if (!wanted.database_id && !wanted.database_name) {
      throw new Error(`configure the original D1 database ID or name for ${name}`);
    }
    const database = await accountRequest(`/d1/database/${id}`);
    if (!database.ok || !database.success || typeof database.result?.uuid !== 'string' || database.result.uuid.toLowerCase() !== id ||
        (wanted.database_name && database.result.name !== wanted.database_name)) {
      throw new Error(`the configured ${name} D1 database name or identity differs from the running Worker`);
    }
    return id;
  }));
  if (DB === LOGS) throw new Error('DB and LOGS must use two separate D1 databases');
  const plannedBucket = namedEntry(config.r2_buckets, 'binding', 'BUNDLES');
  const liveBucket = namedEntry(deployed, 'name', 'BUNDLES');
  const jurisdiction = value => value && value !== 'default' ? value : '';
  if (liveBucket?.type !== 'r2_bucket' || !plannedBucket?.bucket_name || liveBucket.bucket_name !== plannedBucket.bucket_name ||
      jurisdiction(liveBucket.jurisdiction) !== jurisdiction(plannedBucket.jurisdiction)) {
    throw new Error('the configured BUNDLES R2 bucket differs from the running Worker');
  }
  const bucketName = liveBucket.bucket_name;
  const bucketJurisdiction = jurisdiction(liveBucket.jurisdiction);
  const bucket = await accountRequest(`/r2/buckets/${encodeURIComponent(bucketName)}`, {
    headers: bucketJurisdiction ? { 'cf-r2-jurisdiction': bucketJurisdiction } : {},
  });
  const createdAt = bucket.result?.creation_date;
  if (!bucket.ok || !bucket.success || bucket.result?.name !== bucketName ||
      (bucket.result?.jurisdiction && jurisdiction(bucket.result.jurisdiction) !== bucketJurisdiction) ||
      typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('could not verify the creation date of the BUNDLES R2 bucket');
  }
  const BUNDLES = { bucket_name: bucketName, jurisdiction: bucketJurisdiction, created_at: createdAt };
  const saved = binding?.storage;
  if (saved && (saved.DB !== DB || saved.LOGS !== LOGS || saved.BUNDLES?.bucket_name !== BUNDLES.bucket_name ||
      saved.BUNDLES?.jurisdiction !== BUNDLES.jurisdiction ||
      (saved.BUNDLES?.created_at !== undefined && saved.BUNDLES.created_at !== BUNDLES.created_at))) {
    throw new Error('the running Worker storage differs from this checkout’s saved deployment');
  }
  return { DB, LOGS, BUNDLES };
}

function recordStorage(file, binding, storage) {
  if (binding.storage?.BUNDLES?.created_at === undefined) writeBinding(file, { ...binding, storage }, true);
}

async function prepareWorker(claimFile, bindingFile, secretsFile, existingUrl) {
  const target = await workerTarget(bindingFile, existingUrl);
  const { account, name, domain, ownerHandle, binding, origin, request, existing, validWorker } = target;
  const token = readOwnerToken(secretsFile);
  const record = workerId => ({ version: 1, account, name, domain, origin, workerId, phase: 'pending' });
  const output = (mode, workerId) => ({ mode, account, name, domain, origin, workerId });

  if (existing.ok && existing.success && validWorker(existing.result)) {
    const worker = existing.result;
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
      if (binding && token) {
        const storage = await verifyStorage(target);
        recordStorage(bindingFile, binding, storage);
        return output('update', worker.id);
      }
    }
    if (!token) throw new Error(`the Worker already exists. Restore ${secretsFile} from its original checkout`);
    if (!binding && !existingUrl) {
      throw new Error('the saved token has no deployment identity. Use --existing-url with the original Worker URL from your prior setup');
    }
    if (!await ownsActiveToken(origin, token, ownerHandle)) {
      throw new Error('the selected Worker did not accept the saved owner token; check the deployment before retrying');
    }
    const storage = await verifyStorage(target);
    if (!binding) writeBinding(bindingFile, { ...record(worker.id), storage, phase: 'ready' });
    else recordStorage(bindingFile, binding, storage);
    return output('update', worker.id);
  }

  if (existing.status !== 404 || existing.success !== false) throw new Error('could not verify whether the Worker already exists');
  if (binding || token !== null || existingUrl) throw new Error('the original Worker could not be verified; the saved token cannot be used on a new Worker');

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

async function recordDeployedStorage(bindingFile, workerId) {
  const target = await workerTarget(bindingFile, '');
  const { binding, existing, validWorker } = target;
  if (!binding || binding.workerId !== workerId || !existing.ok || !existing.success || !validWorker(existing.result)) {
    throw new Error('the deployed Worker identity could not be verified before database migration');
  }
  const storage = await verifyStorage(target);
  recordStorage(bindingFile, binding, storage);
}

async function rotateToken(bindingFile, secretsFile) {
  const { account, name, domain, ownerHandle, binding, origin, existing, validWorker } = await workerTarget(bindingFile, '', true);
  if (!existing.ok || !existing.success || !validWorker(existing.result)) {
    throw new Error('the original Worker could not be verified; no token was uploaded');
  }
  const current = readOwnerToken(secretsFile);
  const pendingFile = `${secretsFile}.next`;
  const readPending = () => {
    const value = readLocalFile(pendingFile);
    if (value === null) return null;
    const token = value.match(/^API_TOKEN=([a-f0-9]{64})\n?$/)?.[1];
    if (!token) throw new Error(`${pendingFile} is not a valid staged rotation token`);
    return token;
  };
  let pending = readPending();
  if (!pending || !await ownsActiveToken(origin, pending, ownerHandle)) {
    if (!current || !await ownsActiveToken(origin, current, ownerHandle)) {
      throw new Error('the original Worker did not accept the saved token or a pending rotation token');
    }
    if (!pending) {
      try {
        writeFileSync(pendingFile, `API_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      pending = readPending();
      if (!pending) throw new Error('the staged token changed while rotating');
    }
    try {
      execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'API_TOKEN', '--name', name], {
        input: pending,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: { ...process.env, CI: 'true', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_BASE_URL: domain },
        timeout: 90_000,
      });
    } catch {
      throw new Error(`Cloudflare did not confirm the upload. Keep ${pendingFile} and rerun --rotate-token to resume`);
    }
    let verified = false;
    const deadline = Date.now() + 60_000;
    for (let remaining = deadline - Date.now(); remaining > 0 && !verified; remaining = deadline - Date.now()) {
      verified = await ownsActiveToken(origin, pending, ownerHandle, Math.min(5_000, remaining));
      const pause = Math.min(3_000, deadline - Date.now());
      if (!verified && pause > 0) await delay(pause);
    }
    if (!verified) throw new Error(`the Worker has not accepted the staged token. Keep ${pendingFile} and rerun --rotate-token to resume`);
  }
  if (readPending() !== pending || readBinding(bindingFile)?.workerId !== binding.workerId) {
    throw new Error('the local deployment or staged token changed while rotating');
  }
  renameSync(pendingFile, secretsFile);
  return { mode: 'rotated', account, name, domain, origin, workerId: binding.workerId };
}

try {
  const [command, first, second, third, fourth] = process.argv.slice(2);
  if (command === 'ready') {
    const binding = readBinding(first);
    if (!binding || binding.workerId !== second) throw new Error('the saved deployment identity changed before completion');
    if (binding.phase !== 'ready') writeBinding(first, { ...binding, phase: 'ready' }, true);
  } else if (command === 'record-storage') {
    await recordDeployedStorage(first, second);
  } else if (command === 'prepare' || command === 'rotate') {
    const { mode, account, name, domain, origin, workerId } = command === 'prepare'
      ? await prepareWorker(first, second, third, fourth) : await rotateToken(first, second);
    console.log(`${mode} ${account} ${name} ${domain} ${origin} ${workerId}`);
  } else {
    throw new Error('expected prepare, record-storage, ready or rotate');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
