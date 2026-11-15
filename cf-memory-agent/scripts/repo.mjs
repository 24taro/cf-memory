// Repository identity for log entries ("owner/name", or "<dir>#<hash>" without
// a remote) and Recall context (the raw git remote, which the server
// normalizes itself). Cached per cwd.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { scrubEntryText } from './redact.mjs';

// The child-directory scan spends at most CHILD_SCAN_MS in all (git runs
// synchronously, so no watchdog can stop it); the next call goes on from where it stopped.
export const CHILD_SCAN_MAX = 40, CHILD_SCAN_MS = 1500;
const CACHE_TTL_MS = 10 * 60 * 1000, CACHE_MAX = 200, GIT_TIMEOUT_MS = 1500;

// Remove any userinfo (user:password@) from URL-form remotes. scp-like remotes
// ("git@host:owner/name") keep their user: it is not a credential.
export function stripUserinfo(remote) {
  const s = String(remote ?? '').trim();
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

// "owner/name" for hosted remotes (full path for nested groups), the last path
// segment for local or file remotes, '' when nothing usable.
export function normalizeRemote(remote) {
  const s = stripUserinfo(remote);
  if (!s) return '';
  let path;
  const url = s.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i);
  if (url) {
    path = url[1].toLowerCase() === 'file' || !url[2] ? basename((url[3] || '').replace(/\/+$/, '')) : (url[3] || '');
  } else {
    const scp = s.match(/^(?:[^/@\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/);
    path = scp && !/^[A-Za-z]$/.test(scp[1]) ? scp[2] : basename(s.replace(/[\\/]+$/, ''));
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/^~/, '');
  return path.slice(0, 200);
}

// The remote, null without one, undefined when git ran out of time.
function gitRemote(dir, git, timeout = GIT_TIMEOUT_MS) {
  try {
    const out = git('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const remote = stripUserinfo(String(out).trim());
    return remote ? remote.slice(0, 1000) : null;
  } catch (error) { return error?.code === 'ETIMEDOUT' ? undefined : null; }
}

function readCache(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && value.entries && typeof value.entries === 'object' ? value : { entries: {} };
  } catch { return { entries: {} }; }
}

function writeCache(path, cache) {
  try {
    const entries = Object.entries(cache.entries).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
    const temporary = path + '.' + randomUUID() + '.tmp';
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ entries: Object.fromEntries(entries) }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* the cache is an optimization only */ }
}

// Without a usable remote: the directory name and a short hash of its full
// path, so unrelated directories with the same name (app, tmp) never share a
// session_context handoff.
export const localRepo = dir => basename(dir).slice(0, 190).replace(/[\uD800-\uDBFF]$/, '') + '#' + createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8);

/**
 * { repo, remote, contexts } for a cwd. `contexts` (Recall) is the cwd's own
 * remote, or — when the cwd is a parent directory of several checkouts — the
 * remotes of its child directories, as the previous Recall hook did. A scan cut
 * by CHILD_SCAN_MS keeps what it found and the last directory it finished
 * (`scan_after`) in the cache.
 */
export function resolveRepo(cwd, { home, now = Date.now(), git = execFileSync, children = false } = {}) {
  const dir = String(cwd || process.cwd());
  const cachePath = home ? join(home, 'repo-cache.json') : null;
  const cache = cachePath ? readCache(cachePath) : { entries: {} };
  let entry = cache.entries[dir];
  let dirty = false;
  if (!entry || !(now - entry.at < CACHE_TTL_MS) || entry.at > now) { entry = { remote: gitRemote(dir, git) ?? null, at: now }; dirty = true; }
  if (children && !entry.remote && (!Array.isArray(entry.children) || typeof entry.scan_after === 'string')) {
    const found = new Set(Array.isArray(entry.children) ? entry.children : []), stop = performance.now() + CHILD_SCAN_MS;
    let after = typeof entry.scan_after === 'string' ? entry.scan_after : null, cut = false, cutAt = null;
    try {
      const names = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort().slice(0, CHILD_SCAN_MAX);
      for (const name of after === null ? names : names.filter(name => name > after)) {
        const left = Math.floor(stop - performance.now()), timeout = Math.min(GIT_TIMEOUT_MS, left);
        if (left < 50) { cut = true; break; }
        const remote = gitRemote(join(dir, name), git, timeout);
        // A call the scan's end cut short is asked again next time; one given the full timeout is not,
        // and neither is a child cut short twice in a row (a hung mount would stop every scan there).
        if (remote === undefined && timeout < GIT_TIMEOUT_MS && entry.cut_at !== name) { cut = true; cutAt = name; break; }
        if (remote) found.add(remote);
        after = name;
      }
    } catch {}
    const { scan_after, cut_at, ...rest } = entry;
    entry = { ...rest, children: [...found].sort(), ...(cut ? { scan_after: after ?? '', cut_at: cutAt } : {}) };
    dirty = true;
  }
  if (dirty && cachePath) { cache.entries[dir] = entry; writeCache(cachePath, cache); }
  const repo = scrubEntryText(entry.remote && normalizeRemote(entry.remote) || localRepo(dir)).slice(0, 200);
  return { repo, remote: entry.remote, contexts: entry.remote ? [entry.remote] : entry.children || [] };
}
