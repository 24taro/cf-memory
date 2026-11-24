// OAuth credentials and the MCP HTTP client. Tokens stay in process memory:
// never in the spool, health files, errors, logs or argv.
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { responseText } from './bounded.mjs';
import { agentHome, claudeUserConfigPath } from './client.mjs';
const exec = promisify(execFile);
// No built-in server: the url comes from CF_MEMORY_MCP_URL or the cf-memory entry
// in ~/.claude.json. An unconfigured Agent sends nothing anywhere.
export const DEFAULT_MCP_URL = '';
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export class McpFailure extends Error {
  constructor(kind, name, status, validation) {
    kind = ['http', 'timeout', 'budget', 'network', 'protocol', 'rejected', 'response', 'incomplete'].includes(kind) ? kind : 'network';
    const tool = typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : 'unknown';
    status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    super(kind === 'http' ? 'cf-memory HTTP ' + (status || 'unknown') : 'cf-memory MCP ' + kind + ': ' + tool);
    this.kind = kind; this.tool = tool;
    if (status) this.status = status;
    if (validation) this.validation = validation;
  }
}

// log_append validation errors fail the same way on every retry. The server
// answers them as an isError tool result starting with `entries[i].<field> …`
// (that entry is bad) or `log_append: …` / `entries must be …` (the request is
// bad). Everything else (logs not configured, write conflicts, auth) is worth
// retrying. Only the classification is kept, never the message text.
function appendValidation(result) {
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === 'text')?.text : undefined;
  if (typeof text !== 'string') return undefined;
  const entry = /^entries\[(\d{1,4})\]/.exec(text);
  if (entry) return { index: Number(entry[1]) };
  return /^(?:log_append:|entries must be)/.test(text) ? { batch: true } : undefined;
}

// One monotonic allowance across credential lookup and every MCP request.
// `budget`: the deadline came before anything was asked (not a server failure).
export const budgetError = () => Object.assign(Error('cf-memory deadline exceeded'), { code: 'budget' });
export function remaining(deadline, cap) {
  if (deadline === undefined) return cap;
  const left = Math.floor(deadline - performance.now());
  if (!Number.isFinite(left) || left < 1) throw new DOMException('cf-memory deadline exceeded', 'TimeoutError');
  return Math.min(cap, left);
}

export async function refreshOAuth(env = process.env, run = exec, timeout = 8000) {
  // The hook guard stops this child from running cf-memory hooks recursively.
  const childEnv = { ...env, CF_MEMORY_AGENT_CHILD: '1', CF_MEMORY_DISTILL_CHILD: '1' };
  delete childEnv.CLAUDECODE;
  // This official inspection command refreshes an EXISTING MCP connection. Never
  // invoke login, mint credentials, or implement our own refresh-token handling.
  await run(env.CF_MEMORY_CLAUDE_BIN || 'claude', ['mcp', 'get', 'cf-memory'], {
    env: childEnv, timeout, maxBuffer: 64000, encoding: 'utf8',
  }); // stdout/stderr stay private; only the refreshed Keychain entry is consumed
}

// A refresh that did not take effect is not retried for 10 minutes (every Stop
// hook would spend seconds on it). Only the time of the attempt is stored. It
// ends REFRESH_RESERVE_MS before the deadline, so the refreshed entry can be read back.
export const REFRESH_PAUSE_MS = 10 * 60000, REFRESH_RESERVE_MS = 1000;
const refreshFile = env => join(agentHome(env), 'health', 'oauth-refresh.json');
async function refreshPaused(env) {
  try {
    const { at } = JSON.parse(await readFile(refreshFile(env), 'utf8'));
    return Number.isFinite(at) && at <= Date.now() && Date.now() - at < REFRESH_PAUSE_MS;
  } catch { return false; }
}
async function noteRefresh(env) {
  try {
    const path = refreshFile(env), temporary = path + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    await rename(temporary, path);
  } catch {}
}

const origin = value => { try { return new URL(value).origin; } catch { return null; } };
// Follow the active Claude user profile. An explicit cf-memory override wins.
export async function claudeConfig(env = process.env, deadline) {
  try {
    return JSON.parse(await readFile(env.CF_MEMORY_CLAUDE_CONFIG || claudeUserConfigPath(env), {
      encoding: 'utf8', ...(deadline === undefined ? {} : { signal: AbortSignal.timeout(remaining(deadline, 1500)) }),
    }));
  } catch { return {}; }
}
// Sources, in order: CF_MEMORY_ACCESS_TOKEN, ~/.claude.json mcpServers["cf-memory"]
// headers, then the macOS Keychain item "Claude Code-credentials" (mcpOAuth
// entry whose key starts with "cf-memory|"). Codex has no separate cf-memory token:
// its hooks use the same sources (the previous Codex adapter did the same).
// A token goes only to the server it was issued for (the Keychain entry's
// serverUrl, else the ~/.claude.json url, else the default): CF_MEMORY_MCP_URL
// may point elsewhere only together with CF_MEMORY_ACCESS_TOKEN.
// allowRefresh: true (refresh an expiring Keychain token, at most once per
// 10 minutes), 'force' (doctor --refresh) or false.
export async function credentials(env = process.env, allowRefresh = true, deadline, config) {
  config ??= await claudeConfig(env, deadline);
  const server = config?.mcpServers?.['cf-memory'], override = env.CF_MEMORY_MCP_URL || '';
  const issuedTo = issued => !override || origin(override) === origin(issued);
  const configUrl = server?.url || DEFAULT_MCP_URL;
  let url = override || configUrl, token, source = null, elsewhere = false, ambiguous = false;
  if (env.CF_MEMORY_ACCESS_TOKEN) { token = env.CF_MEMORY_ACCESS_TOKEN; source = 'env'; }
  else if (typeof server?.headers?.Authorization === 'string') {
    if (issuedTo(configUrl)) { token = server.headers.Authorization.replace(/^Bearer\s+/i, ''); source = 'claude_config'; } else elsewhere = true;
  }
  if (!token && process.platform === 'darwin' && env.CF_MEMORY_KEYCHAIN !== 'off') {
    let wait;
    try { wait = remaining(deadline, 1500); } catch { throw budgetError(); } // out of time, not out of credentials
    try {
      const stored = JSON.parse(execFileSync('security', ['find-generic-password', '-s', env.CF_MEMORY_KEYCHAIN_SERVICE || KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8', timeout: wait, stdio: ['ignore', 'pipe', 'ignore'],
      }));
      const entries = Object.entries(stored.mcpOAuth || {}).filter(([key, value]) =>
        key.startsWith('cf-memory|') && typeof value?.accessToken === 'string' && value.accessToken);
      const matching = entries.filter(([, value]) => (!value.serverUrl || override || value.serverUrl === configUrl) && issuedTo(value.serverUrl || configUrl));
      // More than one usable credential leaves the active account ambiguous.
      const entry = matching.length === 1 ? matching[0] : undefined;
      ambiguous = matching.length > 1;
      if (!matching.length && entries.length && override) elsewhere = true;
      if (entry) {
        if (allowRefresh && entry[1].refreshToken && Number.isFinite(entry[1].expiresAt) && entry[1].expiresAt < Date.now() + 60000) {
          let timeout = 0;
          try { timeout = remaining(deadline, 8000 + REFRESH_RESERVE_MS) - REFRESH_RESERVE_MS; } catch {}
          if (timeout >= 1000 && (allowRefresh === 'force' || !await refreshPaused(env))) {
            await noteRefresh(env);
            await refreshOAuth(env, exec, timeout).catch(() => {});
            return credentials(env, false, deadline, config);
          }
        }
        token = entry[1].accessToken; url = override || entry[1].serverUrl || configUrl;
        source = token ? 'keychain' : null;
      }
    } catch (error) {
      if (error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM') throw new DOMException('Keychain read timed out', 'TimeoutError');
    }
  }
  if (ambiguous) throw Object.assign(Error('multiple cf-memory OAuth credentials match this server'), { code: 'ambiguous_credentials' });
  const parsed = new URL(url);
  // `elsewhere`: the only token found was issued for another server.
  if (!token && elsewhere || parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw Error('unsafe MCP URL');
  if (!token) throw Object.assign(Error('cf-memory OAuth unavailable; run claude mcp login cf-memory'), { code: 'no_credentials' });
  return { url, token, source };
}

export function createMcp({ url, token }, timeout = 8000, fetcher = fetch, responseLimit = 2000000) {
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 16 * 1048576) throw Error('invalid MCP response limit');
  return async (name, args = {}) => {
    try {
      const response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(typeof timeout === 'function' ? timeout() : timeout),
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new McpFailure('http', name, response.status);
      }
      let raw = await responseText(response, responseLimit), parsed, result;
      try {
        // Stateless cf-memory answers application/json; tolerate an SSE-framed body.
        if (/^\s*(?:event|data):/.test(raw)) raw = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).at(-1) || '';
        parsed = JSON.parse(raw);
        if (parsed.error) throw new McpFailure('rejected', name);
        if (parsed.result?.isError) throw new McpFailure('rejected', name, undefined, name === 'log_append' ? appendValidation(parsed.result) : undefined);
        result = JSON.parse(parsed.result.content.find(x => x.type === 'text').text);
        if (!result || typeof result !== 'object') throw new McpFailure('protocol', name);
      } catch (error) { throw error instanceof McpFailure ? error : new McpFailure('protocol', name); }
      if (result.ok === false) throw new McpFailure('rejected', name);
      return result;
    } catch (error) {
      if (error instanceof McpFailure) throw error;
      const kind = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : error?.message === 'response exceeds limit' ? 'response' : 'network';
      throw new McpFailure(kind, name);
    }
  };
}

// Hook calls: no interactive refresh, and every request fits in the hook's
// remaining time (at most `cap` ms each). Past the deadline nothing is sent (`budget`).
export function createDeadlineMcp(connection, deadline, fetcher = fetch, cap = 8000) {
  return (name, args) => {
    let timeout;
    try { timeout = remaining(deadline, cap); } catch { return Promise.reject(new McpFailure('budget', name)); }
    return createMcp(connection, timeout, fetcher)(name, args);
  };
}

// Destinations. Every queued entry records where it was queued for, and a flush
// sends an entry only to that server and account (spool.mjs). The destination
// is { origin, account }: the server's origin and a hash of the user id the
// server's whoami reports for the token. Tokens rotate, so the account is not
// derived from the token: <agent home>/accounts.json remembers, per origin, the
// accounts seen there and, for each, a few salted hashes of the tokens whoami
// reported it for; whoami is asked again only for a token not among them.
// No token or user id is stored.
//
// accounts.json: { v: 2, origins: { <origin>: record | { evicted } }, forgot? }
//   record = { at, run: { account, since }, accounts: { <account>: { at, tokens: [{ salt, hash, cred?, at }] } } }
// `run` is the account the flushes on that origin are being made for and since
// when no other account has flushed there (0: since before anything was queued,
// for the first account ever seen on the origin). An origin dropped for space
// leaves `{ evicted }` (and, past EVICTED_MAX of those, `forgot`): accounts were
// seen there, which ones is no longer known.
//
// What a queued line says (`to`), by what the hook knows without a request:
//   { origin, account }    the token at hand is one whoami reported for that account
//   { origin, at, cred }   account unknown; `cred` identifies the token at hand
//                          (a keyed hash, key in <agent home>/accounts.key)
//   { origin, at }         no credential could identify an account as the entry was queued
//   {}                     no usable server url: never sent on its own
// `at` is the time it was queued. spool.mjs has the delivery rule.
const ACCOUNTS_MAX = 8, EVICTED_MAX = 64, ORIGIN_ACCOUNTS_MAX = 4, TOKENS_MAX = 4;
// A remembered token not used for this long is forgotten; a record is rewritten
// at most this often when nothing but the time of use changed.
const TOKEN_AGE_MS = 90 * 86400000, TOUCH_MS = 10 * 60000;
const HASH = /^[0-9a-f]{64}$/, ACCOUNT = /^[0-9a-f]{16}$/;
const accountsFile = home => join(home, 'accounts.json'), keyFile = home => join(home, 'accounts.key');
const digest = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex');
const time = value => Number.isFinite(value) && value >= 0 ? value : 0;

function originRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.accounts || typeof value.accounts !== 'object') return null;
  const accounts = {};
  for (const [account, entry] of Object.entries(value.accounts)) {
    if (!ACCOUNT.test(account) || !entry || typeof entry !== 'object') return null;
    accounts[account] = {
      at: time(entry.at),
      tokens: (Array.isArray(entry.tokens) ? entry.tokens : []).filter(token => HASH.test(token?.salt) && HASH.test(token?.hash))
        .map(token => ({ salt: token.salt, hash: token.hash, ...(ACCOUNT.test(token.cred) ? { cred: token.cred } : {}), at: time(token.at) })),
    };
  }
  const run = ACCOUNT.test(value.run?.account) && Object.hasOwn(accounts, value.run.account) && Number.isFinite(value.run.since) && value.run.since >= 0 ? { account: value.run.account, since: value.run.since } : null;
  return { at: time(value.at), run, accounts };
}

// { state: 'missing' | 'ok' | 'unreadable', origins, forgot }. A file that is
// not there is a home no account was seen from; one that cannot be read or
// parsed says nothing, and nothing is concluded from it (unknown entries wait).
async function readAccounts(home) {
  let text;
  try { text = await readFile(accountsFile(home), 'utf8'); } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'unreadable', origins: {}, forgot: false };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('shape');
    const origins = {};
    if (value.v === 2) {
      if (!value.origins || typeof value.origins !== 'object' || Array.isArray(value.origins)) throw Error('shape');
      // A record that does not read is an origin whose accounts are not known any more.
      for (const [at, entry] of Object.entries(value.origins)) origins[at] = originRecord(entry) ?? { evicted: time(entry?.evicted ?? entry?.at) };
    } else {
      // The first format: one { account, salt, token, at } per origin.
      for (const [at, entry] of Object.entries(value)) {
        const known = ACCOUNT.test(entry?.account) && HASH.test(entry.salt) && HASH.test(entry.token);
        origins[at] = known
          ? { at: time(entry.at), run: { account: entry.account, since: time(entry.at) }, accounts: { [entry.account]: { at: time(entry.at), tokens: [{ salt: entry.salt, hash: entry.token, at: time(entry.at) }] } } }
          : { evicted: time(entry?.at) };
      }
    }
    return { state: 'ok', origins, forgot: value.forgot === true };
  } catch { return { state: 'unreadable', origins: {}, forgot: false }; }
}

async function writeAccounts(home, book, at, record) {
  const others = Object.entries(book.origins).filter(([key]) => key !== at);
  const full = others.filter(([, value]) => value.accounts).sort((a, b) => b[1].at - a[1].at);
  // An origin dropped for space stays known as one where accounts were seen.
  const evicted = [...full.slice(ACCOUNTS_MAX - 1).map(([key, value]) => [key, { evicted: value.at }]), ...others.filter(([, value]) => !value.accounts)].sort((a, b) => b[1].evicted - a[1].evicted);
  const next = {
    v: 2, origins: Object.fromEntries([[at, record], ...full.slice(0, ACCOUNTS_MAX - 1), ...evicted.slice(0, EVICTED_MAX)]),
    ...(book.forgot || evicted.length > EVICTED_MAX ? { forgot: true } : {}),
  };
  const path = accountsFile(home), temporary = path + '.' + randomUUID() + '.tmp';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await rename(temporary, path);
}

// What is known about an origin: 'new' (no account was ever seen there),
// 'known' (its record), 'forgotten' (accounts were seen, the record is gone)
// or 'unreadable'.
function seenAt(book, at) {
  if (book.state === 'unreadable') return { state: 'unreadable' };
  const record = Object.hasOwn(book.origins, at) ? book.origins[at] : null;
  if (record?.accounts) return { state: 'known', record };
  return { state: record || book.forgot ? 'forgotten' : 'new' };
}
const accountOf = (record, token) => Object.entries(record.accounts).find(([, entry]) => entry.tokens.some(known => known.hash === digest(known.salt, token)))?.[0] ?? null;

// A token's fingerprint for spool lines: the same token gives the same value
// on this machine and nothing else can be told from it. null: no key (it could
// not be read, or made when `create`), so the line carries none.
async function credOf(home, at, token, create) {
  const path = keyFile(home);
  const read = async () => { const key = (await readFile(path, 'utf8')).trim(); return HASH.test(key) ? key : null; };
  let key = null;
  try { key = await read(); } catch (error) {
    if (error?.code !== 'ENOENT' || !create) return null;
    // Made once: the first writer's key stays (link fails for the others).
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, digest(randomUUID(), randomUUID()), { mode: 0o600 });
      await link(temporary, path).catch(failure => { if (failure?.code !== 'EEXIST') throw failure; });
      key = await read();
    } catch { return null; } finally { await unlink(temporary).catch(() => {}); }
  }
  return key ? digest('cf-memory-agent-cred', key, at, token).slice(0, 16) : null;
}

const configuredUrl = (env, config) => env.CF_MEMORY_MCP_URL || config?.mcpServers?.['cf-memory']?.url || DEFAULT_MCP_URL;
/** The origin of the server configured now (the same url credentials() resolves), or null. */
export const configuredOrigin = (env, config = {}) => origin(configuredUrl(env, config));
// The token a hook has at hand without the Keychain: the first two sources of
// credentials(), under the same rule about which server a token may go to.
function tokenAtHand(env, config) {
  if (env.CF_MEMORY_ACCESS_TOKEN) return env.CF_MEMORY_ACCESS_TOKEN;
  const server = config?.mcpServers?.['cf-memory'], override = env.CF_MEMORY_MCP_URL || '';
  if (typeof server?.headers?.Authorization !== 'string') return null;
  if (override && origin(override) !== origin(server.url || DEFAULT_MCP_URL)) return null;
  return server.headers.Authorization.replace(/^Bearer\s+/i, '') || null;
}

/** The account hash for a user id on an origin (what `to.account` holds). */
export const accountKey = (at, user) => digest('cf-memory-agent-account', at, user).slice(0, 16);

/**
 * What a line queued now says about where it goes (see the table above): the
 * configured server and, only when the token at hand is known to belong to it,
 * the account. The fallback Keychain read is local, bounded and refresh-free.
 * An entry without a credential stays held until the operator assigns it.
 */
export async function queuedFor(env, home, config = {}, now = Date.now(), deadline = Infinity) {
  let at = configuredOrigin(env, config), token = tokenAtHand(env, config);
  if (!token && process.platform === 'darwin' && env.CF_MEMORY_KEYCHAIN !== 'off') {
    try {
      const connection = await credentials(env, false, Math.min(deadline, performance.now() + 500), config);
      token = connection.token;
      at = origin(connection.url);
    } catch { /* An unbound entry is kept for explicit recovery. */ }
  }
  if (!at) return {};
  const unknown = { origin: at, at: now };
  if (!token) return unknown;
  const seen = seenAt(await readAccounts(home), at);
  const account = seen.state === 'known' ? accountOf(seen.record, token) : null;
  if (account) return { origin: at, account };
  const cred = await credOf(home, at, token, true);
  return cred ? { ...unknown, cred } : unknown;
}

/** Recorded token fingerprints: Map(origin -> Map(cred -> account)). Reads only. */
export async function knownCreds(home) {
  const result = new Map();
  for (const [at, record] of Object.entries((await readAccounts(home)).origins)) {
    if (!record.accounts) continue;
    result.set(at, new Map(Object.entries(record.accounts).flatMap(([account, entry]) => entry.tokens.filter(token => token.cred).map(token => [token.cred, account]))));
  }
  return result;
}

/**
 * The destination a connection delivers to. `call` is the MCP client of that
 * same connection (whoami is asked once per token not remembered).
 * Returns { origin, account, creds, others, changed }:
 *   creds   fingerprints of the tokens known to be this account's (this one included)
 *   others  { cred: account } for the other accounts recorded on the origin
 *   changed true when this flush learned something: a token newly identified,
 *           or the account taking over from another one (held entries known to
 *           be this account's can go now; see requeueOwn in spool.mjs).
 * Throws `no_account` when the server does not name an authenticated user.
 */
export async function destination(connection, call, home, now = Date.now()) {
  const at = origin(connection.url), book = await readAccounts(home), seen = seenAt(book, at);
  const cred = await credOf(home, at, connection.token, true);
  let account = seen.state === 'known' ? accountOf(seen.record, connection.token) : null;
  const remembered = Boolean(account);
  if (!account) {
    const identity = await call('whoami', {});
    const user = identity?.user_id;
    if (typeof user !== 'string' || !user || user.length > 200 || identity.anonymous === true || ['none', 'invalid'].includes(identity.token_status)) {
      throw Object.assign(Error('cf-memory account unavailable'), { code: 'no_account' });
    }
    account = accountKey(at, user);
  }
  const before = seen.state === 'known' ? seen.record : { at: 0, run: null, accounts: {} };
  // Retain the existing on-disk shape for account change detection. The
  // timestamp carries no delivery authority.
  const run = before.run?.account === account ? before.run : { account, since: now };
  const mine = before.accounts[account] ?? { at: 0, tokens: [] };
  const current = mine.tokens.find(token => token.hash === digest(token.salt, connection.token));
  const salt = current?.salt ?? digest(randomUUID(), randomUUID());
  const token = { salt, hash: current?.hash ?? digest(salt, connection.token), ...(cred ?? current?.cred ? { cred: cred ?? current.cred } : {}), at: now };
  // The record changes with a new token, a new fingerprint or another account's
  // run ending; otherwise only the times of use move, and those are written rarely.
  const changed = !remembered || !current || current.cred !== token.cred || before.run?.account !== account || book.state !== 'ok';
  if (changed || now - (current?.at ?? 0) > TOUCH_MS) {
    const tokens = [token, ...mine.tokens.filter(other => other !== current && now - other.at < TOKEN_AGE_MS).sort((a, b) => b.at - a.at)].slice(0, TOKENS_MAX);
    const rest = Object.entries(before.accounts).filter(([key]) => key !== account).sort((a, b) => b[1].at - a[1].at).slice(0, ORIGIN_ACCOUNTS_MAX - 1);
    // If recording fails, a later flush verifies the credential again.
    await writeAccounts(home, book, at, { at: now, run, accounts: Object.fromEntries([[account, { at: now, tokens }], ...rest]) }).catch(() => {});
  }
  const creds = [...new Set([cred, ...mine.tokens.map(known => known.cred)].filter(Boolean))];
  const others = Object.fromEntries(Object.entries(before.accounts).filter(([key]) => key !== account).flatMap(([key, entry]) => entry.tokens.filter(known => known.cred).map(known => [known.cred, key])));
  return { origin: at, account, creds, others, changed };
}

// Safe diagnostic code for health files: never an exception message.
export function failureCode(error) {
  if (error instanceof McpFailure) {
    if (error.kind === 'http') return 'http_' + (error.status || 'unknown');
    if (error.validation) return error.validation.batch ? 'invalid_batch' : 'invalid_entry';
    return error.kind;
  }
  if (['no_credentials', 'ambiguous_credentials', 'no_account', 'budget'].includes(error?.code)) return error.code;
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'timeout';
  if (error?.message === 'unsafe MCP URL') return 'unsafe_url';
  if (['ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'EMFILE'].includes(error?.code)) return error.code;
  return 'runtime';
}
