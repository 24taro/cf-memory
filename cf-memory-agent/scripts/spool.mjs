// Local spool: hooks append entries to <agent home>/spool/<client>.jsonl and a
// flush sends them with log_append in batches. A cursor ({ ino, offset, skip })
// records how far one file has been delivered. No file is ever rewritten: once
// a flush has delivered the live file (or 8 MB of it) it renames it to a sealed
// segment (<client>.<time>-<random>.seg), and a segment is deleted whole once
// delivered. An append that raced the rename lands in the segment, so every
// appender checks, before closing, that the path still names the file it wrote
// to and appends again if not; the repeat, like a resend after a crash, is
// harmless (the server ignores ids it already has). Entries the server rejects
// as invalid move to <client>.rejected.jsonl and their ids stay in the cursor's
// `skip` until it passes them, so they are never resent; after 20 rejections in
// a row with nothing accepted, entries stay in the spool and the flush fails
// (`rejecting`) instead. `agent.mjs replay-rejected` queues them again, marked
// `replayed`: refused again, each is set aside again without counting toward
// that streak (which only holds fresh entries back).
// The cursor also keeps that streak and the batch size: after a send times out
// with nothing delivered the next batches are half as large (down to 1), and
// grow back after each success.
// Destinations: a queued line also carries `to` (what the hook knew when it
// queued it; the forms are listed in transport.mjs). A flush names the
// destination it delivers to and sends only the entries that are known to be
// that server's and that account's (`mine` in flush() is the whole rule). Every
// other entry moves, with its `to`, to <client>.held.jsonl before the cursor
// passes it: never sent elsewhere. That file is kept up to 16 MB; past it held
// entries are dropped and counted. `agent.mjs replay-held` queues held entries
// again as they are, all of them or a selection (destination, account unknown,
// session, time); only its `--to-current` gives the selected ones the current
// destination. A line without `to` was queued by an Agent from before
// destinations: the first flush that reaches it adopts it, once, as an
// "account unknown" entry of that flush's server.
import { appendFile, link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validEntry } from './entries.mjs';
import { failureCode, remaining } from './transport.mjs';

export const BATCH_ENTRIES = 50;
// Whole log_append request body, JSON-RPC envelope included (the MCP endpoint
// rejects bodies over 8 MB). An entry larger than this on its own goes alone.
export const BATCH_BYTES = 2000000;
export const SPOOL_ACTION_CAP_BYTES = 64 * 1048576;
export const REJECTED_CAP_BYTES = 4 * 1048576;
export const HELD_CAP_BYTES = 16 * 1048576;
export const LOCK_STALE_MS = 30000, SEAL_BYTES = 8 * 1048576, REJECT_STREAK = 20, STALE_FILE_MS = 3600000;
// After a `rejecting` stop the streak holds this long, then up to REJECT_STREAK more are set aside,
// so a run of refused entries is drained in steps and never wedges the entries behind it.
export const STREAK_HOLD_MS = 10 * 60000;
// One write() per group of whole lines: concurrent O_APPEND writes never split a line.
const WRITE_BYTES = 262144, READ_CHUNK = 4 * 1048576, SCAN_CHUNK = 262144;
const REQUEST_OVERHEAD = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_append', arguments: { entries: [] } } }));
const COUNTERS = ['stored', 'duplicates', 'dropped_over_cap', 'dropped_over_total_cap', 'ts_clamped'];
const SEALED = /^\d{15}-[0-9a-f]{8}\.seg$/, EMPTY = { ino: 0, offset: 0, skip: [] };

export const spoolDir = home => join(home, 'spool');
export const spoolFile = (home, client) => join(spoolDir(home), client + '.jsonl');
const cursorFile = (home, client) => join(spoolDir(home), client + '.cursor.json');
const lockFile = (home, client) => join(spoolDir(home), client + '.lock');
const sealedFile = (home, client) => join(spoolDir(home), client + '.' + String(Date.now()).padStart(15, '0') + '-' + randomUUID().slice(0, 8) + '.seg');
export const rejectedFile = (home, client) => join(spoolDir(home), client + '.rejected.jsonl');
export const heldFile = (home, client) => join(spoolDir(home), client + '.held.jsonl');

const statOrNull = path => stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const stale = info => Math.abs(Date.now() - info.mtimeMs) >= LOCK_STALE_MS;

/** Sealed segments (oldest first), then the live file: [{ path, ino, size, sealed }]. */
async function spoolFiles(home, client) {
  let names = [];
  try { names = await readdir(spoolDir(home)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  for (const name of [...names.filter(name => name.startsWith(client + '.') && SEALED.test(name.slice(client.length + 1))).sort(), client + '.jsonl']) {
    const path = join(spoolDir(home), name), info = await statOrNull(path);
    if (info) files.push({ path, ino: info.ino, size: info.size, sealed: name.endsWith('.seg') });
  }
  return files;
}

async function readCursor(home, client) {
  try {
    const value = JSON.parse(await readFile(cursorFile(home, client), 'utf8'));
    if (!Number.isSafeInteger(value?.offset) || value.offset < 0 || !Number.isSafeInteger(value?.ino)) return EMPTY;
    return {
      ino: value.ino, offset: value.offset, skip: Array.isArray(value.skip) ? value.skip.filter(id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)).slice(0, 1000) : [],
      ...(Number.isSafeInteger(value.streak) && value.streak > 0 ? { streak: value.streak } : {}),
      ...(Number.isSafeInteger(value.streak_at) && value.streak_at > 0 ? { streak_at: value.streak_at } : {}),
      ...(Number.isSafeInteger(value.batch) && value.batch >= 1 && value.batch <= BATCH_ENTRIES ? { batch: value.batch } : {}),
    };
  } catch { return EMPTY; }
}
async function writeCursor(home, client, cursor) {
  const path = cursorFile(home, client), temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(cursor), { mode: 0o600 });
  await rename(temporary, path);
}
const startOf = (cursor, file) => cursor.ino === file.ino && cursor.offset <= file.size ? cursor.offset : 0;

// A file whose last byte is not a newline ends in a torn line (a write that
// failed halfway): the next write starts with one, so it never joins that line.
async function appendLines(path, lines) {
  const writes = [];
  for (const line of lines) {
    const last = writes.at(-1);
    if (last && last.bytes + line.length <= WRITE_BYTES) { last.parts.push(line); last.bytes += line.length; } else writes.push({ parts: [line], bytes: line.length });
  }
  const buffers = writes.map(write => Buffer.concat(write.parts));
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = await open(path, 'a+', 0o600);
    try {
      const { size } = await handle.stat();
      const torn = size > 0 && (await readAt(handle, size - 1, 1))[0] !== 10;
      for (const buffer of torn ? [Buffer.from('\n'), ...buffers] : buffers) {
        for (let done = 0; done < buffer.length;) {
          const { bytesWritten } = await handle.write(buffer, done);
          if (!bytesWritten) throw Object.assign(Error('short write'), { code: 'EIO' });
          done += bytesWritten;
        }
      }
      // Compared while the handle is open, so the inode number cannot be reused yet.
      if ((await statOrNull(path))?.ino === (await handle.stat()).ino) return;
    } finally { await handle.close(); }
  }
}

const ACCOUNT = /^[0-9a-f]{16}$/;
// A destination as written on a line: { origin, account } (the account is
// known), { origin, at, cred? } (account unknown: queued at `at`, by the token
// with fingerprint `cred` when one was at hand), or undefined (none readable).
function destinationOf(to) {
  if (typeof to?.origin !== 'string' || !to.origin || to.origin.length > 300) return undefined;
  if (to.account !== undefined) return typeof to.account === 'string' && ACCOUNT.test(to.account) ? { origin: to.origin, account: to.account } : undefined;
  return { origin: to.origin, at: Number.isFinite(to.at) && to.at >= 0 ? to.at : 0, ...(typeof to.cred === 'string' && ACCOUNT.test(to.cred) ? { cred: to.cred } : {}) };
}
// The destination a line has for the flush that reaches it. A line without
// `to` (an Agent from before destinations) is adopted as an "account unknown"
// entry of this flush's server, queued when its entry is dated.
const boundTo = (line, here) => line.to === undefined
  ? (here?.origin ? { origin: here.origin, at: Number.isFinite(line.ts) && line.ts >= 0 ? line.ts : 0 } : undefined)
  : destinationOf(line.to);
// The destination of a flush as transport.mjs destination() gives it; {} (nothing is delivered) when it names no account.
function flushTo(to) {
  const at = destinationOf(to);
  if (!at?.account) return {};
  return {
    ...at, since: Number.isFinite(to.since) && to.since >= 0 ? to.since : null,
    creds: new Set(Array.isArray(to.creds) ? to.creds.filter(cred => typeof cred === 'string' && ACCOUNT.test(cred)) : []),
    others: new Map(Object.entries(to.others && typeof to.others === 'object' ? to.others : {}).filter(([cred, account]) => ACCOUNT.test(cred) && typeof account === 'string' && ACCOUNT.test(account))),
  };
}
// The one delivery rule: an entry goes only to the server and account that
// queued it, and only when that is known.
// - Another origin, or no readable destination: never.
// - { origin, account }: to that account.
// - Account unknown with a token fingerprint: to the account that token is
//   known to belong to (it is this flush's token, or whoami reported it for
//   this account before). A fingerprint not known for this account waits.
// - Account unknown without one: only when this account is the first ever seen
//   on the origin, or it has been the only one flushing there since before the
//   entry was queued (`since`). Where another account flushed last, or nothing
//   reliable is recorded, the entry waits: it is not given to whoever comes next.
// A flush that names no destination (no hook or command does) sends only lines without one.
function queuedHere(line, at) {
  if (at === undefined) return line.to === undefined;
  const to = boundTo(line, at);
  if (!to || !at.origin || to.origin !== at.origin) return false;
  if (to.account) return to.account === at.account;
  if (to.cred) return at.creds.has(to.cred);
  return at.since !== null && to.at >= at.since;
}
// The line as it is held: an adopted line keeps the origin it was adopted for,
// and a fingerprint known to be another account's becomes that account.
function heldLine(line, at) {
  const to = boundTo(line, at);
  if (!to) return line;
  if (!to.account && to.cred && at?.origin === to.origin && at.others?.has(to.cred)) return { ...line, to: { origin: to.origin, account: at.others.get(to.cred) } };
  return line.to === undefined ? { ...line, to } : line;
}
// The spool line of an entry: the log_append fields, then its destination and flags.
const spoolLine = (entry, to, replayed) => Buffer.from(JSON.stringify({ ...wireEntry(entry), ...(to === undefined ? {} : { to }), ...(replayed ? { replayed: true } : {}) }) + '\n');

/**
 * Append validated entries, queued for `to` (see transport.mjs queuedFor; a `to`
 * that names no server is written as {}: such an entry is never sent on its own).
 * Over the size cap, `action` entries are dropped (prompt/reply/error are kept).
 */
export async function appendEntries(home, client, entries, to) {
  const valid = entries.filter(validEntry);
  if (!valid.length) return { appended: 0, dropped: entries.length };
  await mkdir(spoolDir(home), { recursive: true, mode: 0o700 });
  const size = (await spoolFiles(home, client)).reduce((sum, file) => sum + file.size, 0);
  const kept = size > SPOOL_ACTION_CAP_BYTES ? valid.filter(entry => entry.kind !== 'action') : valid;
  if (kept.length) await appendLines(spoolFile(home, client), kept.map(entry => spoolLine(entry, to === undefined ? undefined : destinationOf(to) ?? {})));
  return { appended: kept.length, dropped: entries.length - kept.length };
}

// Remove `path` only if it is still the file `ino`: it is moved aside under a
// unique name first, and a different file found there is put back.
async function removeIf(path, ino) {
  const aside = path + '.' + randomUUID() + '.old';
  try { await rename(path, aside); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if ((await statOrNull(aside))?.ino !== ino) await link(aside, path).catch(() => {});
  await unlink(aside).catch(() => {});
}

// Remove a stale lock. One hook at a time does this (under <lock>.takeover),
// so two hooks that both found the lock stale cannot both win it.
async function takeOver(path) {
  const guard = path + '.takeover';
  let handle;
  try { handle = await open(guard, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await statOrNull(guard); // left behind by a crash mid-takeover
    if (info && stale(info)) await removeIf(guard, info.ino);
    return false;
  }
  try {
    const info = await statOrNull(path);
    if (info && stale(info)) await removeIf(path, info.ino);
    return true;
  } finally { await handle.close(); await unlink(guard).catch(() => {}); }
}

// The lock file holds a random token. A lock not refreshed for 30 s is stale
// and may be taken over; the holder refreshes it before every send and checks
// its token before every cursor write, seal or delete.
async function acquire(home, client) {
  const path = lockFile(home, client), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await statOrNull(path);
      if (info && !stale(info)) return null; // another hook is flushing
      if (info && !await takeOver(path)) return null;
      continue;
    }
    const { ino } = await handle.stat();
    const held = async () => (await readFile(path, 'utf8').catch(() => '')) === token;
    try { await handle.writeFile(token); } catch (error) { await removeIf(path, ino).finally(() => handle.close()); throw error; }
    return {
      held,
      refresh: async () => { const now = new Date(); await handle.utimes(now, now); return held(); },
      // Removes only this flush's own lock (the open handle keeps its inode number).
      release: async () => { try { if (await held()) await removeIf(path, ino); } finally { await handle.close(); } },
    };
  }
  return null;
}

async function readAt(handle, start, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}
async function readRange(path, start, length) {
  const handle = await open(path, 'r');
  try { return await readAt(handle, start, length); } finally { await handle.close(); }
}

// The `ts` of the first complete line in [start, size) that carries one.
async function firstTs(path, start, size) {
  let carry = Buffer.alloc(0);
  for (let position = start; position < size && position - start < READ_CHUNK;) {
    const chunk = await readRange(path, position, Math.min(SCAN_CHUNK, size - position));
    if (!chunk.length) break;
    position += chunk.length;
    let data = Buffer.concat([carry, chunk]), stop;
    while ((stop = data.indexOf(10)) >= 0) {
      let entry = null;
      try { entry = JSON.parse(data.subarray(0, stop).toString('utf8')); } catch {}
      if (Number.isFinite(entry?.ts)) return entry.ts;
      data = data.subarray(stop + 1);
    }
    carry = data;
  }
  return null;
}

/**
 * Undelivered bytes; with `count`, undelivered entries (stops counting at
 * `countLimit`); with `oldest`, the `ts` of the oldest undelivered entry.
 */
export async function pendingStats(home, client, { count = false, countLimit = Infinity, oldest = false } = {}) {
  const files = await spoolFiles(home, client).catch(() => []);
  const cursor = await readCursor(home, client);
  const ranges = files.map(file => [file.path, startOf(cursor, file), file.size]);
  const result = { bytes: ranges.reduce((sum, [, start, size]) => sum + size - start, 0) };
  if (count) {
    let entries = 0;
    scan: for (const [path, start, size] of ranges) {
      for (let position = start; position < size;) {
        const chunk = await readRange(path, position, Math.min(Number.isFinite(countLimit) ? SCAN_CHUNK : READ_CHUNK, size - position)).catch(() => Buffer.alloc(0));
        if (!chunk.length) break; // a segment a flush just deleted
        position += chunk.length;
        for (const byte of chunk) if (byte === 10 && ++entries >= countLimit) break scan;
      }
    }
    result.entries = entries;
  }
  if (oldest) {
    result.oldest_ts = null;
    for (const [path, start, size] of ranges) {
      if (start >= size) continue;
      result.oldest_ts = await firstTs(path, start, size).catch(() => null);
      if (result.oldest_ts !== null) break;
    }
  }
  return result;
}

async function lineStats(path) {
  const info = await statOrNull(path).catch(() => null);
  if (!info) return { bytes: 0, entries: 0 };
  let entries = 0;
  for (let position = 0; position < info.size; position += READ_CHUNK) {
    const chunk = await readRange(path, position, Math.min(READ_CHUNK, info.size - position));
    for (const byte of chunk) if (byte === 10) entries++;
  }
  return { bytes: info.size, entries };
}
/** Entries the server rejected as invalid (kept locally, never resent). */
export const rejectedStats = (home, client) => lineStats(rejectedFile(home, client));
/** Entries not known to be the flushing server's and account's (kept locally, never sent on their own). */
export const heldStats = (home, client) => lineStats(heldFile(home, client));

const sameAccount = (to, account, creds) => to.account === account || Boolean(!to.account && to.cred && creds?.get(to.origin)?.get(to.cred) === account);
/**
 * The held entries, grouped by where they were queued for:
 * [{ origin, account, state, entries, oldest, newest, sessions }], where `state` is
 * 'account' (known: `account`), 'unknown' (queued for `origin`, account unknown)
 * or 'none' (no readable destination). `creds` (transport.mjs knownCreds) lets a
 * token fingerprint recorded since count as its account. `sessions`: up to 5 ids.
 */
export async function heldGroups(home, client, creds) {
  const [entries] = await setAside(heldFile(home, client));
  const groups = new Map();
  for (const entry of entries.values()) {
    const to = destinationOf(entry.to);
    const account = !to ? null : to.account ?? (to.cred ? creds?.get(to.origin)?.get(to.cred) ?? null : null);
    const key = JSON.stringify([to?.origin ?? null, account]);
    const group = groups.get(key) ?? { origin: to?.origin ?? null, account, state: !to ? 'none' : account ? 'account' : 'unknown', entries: 0, oldest: entry.ts, newest: entry.ts, sessions: [] };
    group.entries++; group.oldest = Math.min(group.oldest, entry.ts); group.newest = Math.max(group.newest, entry.ts);
    if (group.sessions.length < 5 && !group.sessions.includes(entry.session_id)) group.sessions.push(entry.session_id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// Keep rejected entries for inspection, up to a cap; past it they are dropped
// (false; counted as rejected_dropped).
async function quarantine(home, client, entries) {
  const size = (await statOrNull(rejectedFile(home, client)))?.size ?? 0;
  if (size >= REJECTED_CAP_BYTES) return false;
  await appendFile(rejectedFile(home, client), entries.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600, flag: 'a' });
  return true;
}

// One spool line: [entry or null, torn]. A line that does not parse may be a
// torn write joined to the next entry (spools from before torn tails were
// closed): the entry is recovered from its last '{"id":"'.
function lineEntry(text) {
  let entry = null, torn = false;
  try { entry = JSON.parse(text); } catch {
    const start = text.lastIndexOf('{"id":"');
    if (start > 0) { try { entry = JSON.parse(text.slice(start)); torn = true; } catch {} }
  }
  return validEntry(entry) ? [entry, torn] : [null, false];
}

// Leftovers of crashed writers (temporary cursors and health files, moved-aside
// locks, takeover guards) older than an hour.
async function sweep(home) {
  for (const dir of [spoolDir(home), join(home, 'health'), home]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter(name => /\.(?:tmp|old|takeover)$/.test(name))) {
      const info = await statOrNull(join(dir, name)).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs > STALE_FILE_MS) await unlink(join(dir, name)).catch(() => {});
    }
  }
}

// Exactly the fields log_append accepts (the server rejects unknown keys).
const wireEntry = ({ id, session_id, client, repo, ts, kind, text }) => ({ id, session_id, client, repo, ts, kind, text });

// The entries of a set-aside file, by id (a crash can list one twice): [Map, invalid lines, any text].
async function setAside(path) {
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const entries = new Map();
  let invalid = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    const [entry] = lineEntry(line);
    if (entry) entries.set(entry.id, entry); else invalid++;
  }
  return [entries, invalid, text !== ''];
}

/** Queue the entries in <client>.rejected.jsonl again, each for the destination it had, marked `replayed` (and forget their set-aside ids). */
export async function replayRejected(home, client) {
  await mkdir(spoolDir(home), { recursive: true, mode: 0o700 });
  const lock = await acquire(home, client);
  if (!lock) return { busy: true, replayed: 0, invalid: 0 };
  try {
    const path = rejectedFile(home, client);
    const [entries, invalid, any] = await setAside(path);
    if (entries.size) await appendLines(spoolFile(home, client), [...entries.values()].map(entry => spoolLine(entry, entry.to, true)));
    const cursor = await readCursor(home, client);
    const { streak, streak_at, ...rest } = cursor;
    await writeCursor(home, client, { ...rest, skip: cursor.skip.filter(id => !entries.has(id)) });
    if (any) await unlink(path).catch(() => {});
    return { replayed: entries.size, invalid };
  } finally { await lock.release().catch(() => {}); }
}

/**
 * Queue entries in <client>.held.jsonl again; the others stay held. `only`
 * selects them (every given condition must hold; none given: all):
 *   origin   queued for that origin ('none': no readable destination)
 *   account  known to be that account's (as labelled, or by a token fingerprint in `creds`)
 *   unknown  true: no account is known for it
 *   session  that session_id
 *   since / until  entry time (ms), inclusive
 * Without `to` each keeps the destination it had, and the next flush applies
 * its rule again. With `to` (the operator's explicit choice, `replay-held
 * --to-current`) the selected ones are queued for that destination instead.
 */
export async function replayHeld(home, client, to, only = {}, creds) {
  await mkdir(spoolDir(home), { recursive: true, mode: 0o700 });
  const lock = await acquire(home, client);
  if (!lock) return { busy: true, replayed: 0, invalid: 0 };
  try {
    const path = heldFile(home, client);
    const [entries, invalid, any] = await setAside(path);
    const selected = entry => {
      const at = destinationOf(entry.to);
      if (only.origin !== undefined && (at?.origin ?? 'none') !== only.origin) return false;
      if (only.account !== undefined && !(at && sameAccount(at, only.account, creds))) return false;
      if (only.unknown && at && (at.account || at.cred && creds?.get(at.origin)?.has(at.cred))) return false;
      if (only.session !== undefined && entry.session_id !== only.session) return false;
      return !(only.since !== undefined && entry.ts < only.since) && !(only.until !== undefined && entry.ts > only.until);
    };
    const chosen = [...entries.values()].filter(selected), kept = [...entries.values()].filter(entry => !selected(entry));
    const there = to === undefined ? undefined : destinationOf({ origin: to.origin, account: to.account });
    if (to !== undefined && !there?.account) throw Error('replay-held: the current destination names no account');
    if (!chosen.length && kept.length) return { replayed: 0, invalid, kept: kept.length }; // nothing to move: the file stays as it is
    if (chosen.length) await appendLines(spoolFile(home, client), chosen.map(entry => spoolLine(entry, there ?? entry.to, entry.replayed === true)));
    // Rewritten whole under the flush lock (only a flush, which holds it, appends here).
    if (kept.length) {
      const temporary = path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, kept.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
      await rename(temporary, path);
    } else if (any) await unlink(path).catch(() => {});
    return { replayed: chosen.length, invalid, ...(kept.length ? { kept: kept.length } : {}) };
  } finally { await lock.release().catch(() => {}); }
}

/**
 * Held entries that are known to be `to`'s own (labelled with its account, or
 * queued by a token since identified as that account's: `creds`) are queued
 * again as they are. The callers do this when destination() reports `changed`:
 * the account is back, or the token that queued them has just been identified.
 */
export const requeueOwn = (home, client, to, creds) => replayHeld(home, client, undefined, { origin: to.origin, account: to.account }, creds);

/**
 * Send undelivered entries with `send(entries)` (one log_append call) in
 * batches of ≤50 entries and ≤2,000,000 request bytes until done, a failure,
 * or the deadline. When the server names an invalid entry (`error.validation.index`),
 * that entry is set aside at once and the rest of the batch is resent; any
 * other failure stops the flush and leaves the batch for the next hook. A
 * flush that finds its lock or file taken over stops without writing anything
 * and reports `busy`.
 * `to` is the destination `send` delivers to (transport.mjs destination()): only
 * entries known to be queued for it are sent, the others are held (queuedHere).
 * `own`: ids this hook queued itself; on the same origin they go with this flush
 * (the account that queues an entry is the one whose credential the hook then
 * finds, even when another account was the last one seen there).
 * Returns { sent, stored, duplicates, dropped_over_cap, dropped_over_total_cap, ts_clamped, invalid, rejected, rejected_dropped, held, held_dropped, pending_bytes, busy?, error? }
 * (`invalid`: unreadable local lines skipped; `rejected`: entries the server refused;
 * `held`: entries not known to be this destination's, moved to held.jsonl;
 * `held_dropped`: such entries not kept because held.jsonl is full;
 * `rejected_dropped`: refused entries not kept because rejected.jsonl is full;
 * error 'rejecting': the server refused 20 entries in a row, the rest stays queued;
 * 'budget': the deadline came before the first send; 'timeout': it came after the server answered).
 */
export async function flush(home, client, send, { deadline, batchEntries = BATCH_ENTRIES, batchBytes = BATCH_BYTES, to, own } = {}) {
  const result = { sent: 0, stored: 0, duplicates: 0, dropped_over_cap: 0, dropped_over_total_cap: 0, ts_clamped: 0, invalid: 0, rejected: 0, rejected_dropped: 0, held: 0, held_dropped: 0, batches: 0 };
  const here = to === undefined ? undefined : flushTo(to);
  const mine = parsed => queuedHere(parsed, here) || Boolean(here?.origin && own?.has(parsed.id) && destinationOf(parsed.to)?.origin === here.origin);
  await mkdir(spoolDir(home), { recursive: true, mode: 0o700 });
  const lock = await acquire(home, client);
  if (!lock) return { ...result, busy: true, pending_bytes: (await pendingStats(home, client)).bytes };
  await sweep(home).catch(() => {});
  let cursor = await readCursor(home, client);
  // Batch size for this flush (halved after a send timed out with nothing delivered).
  let size = Math.min(batchEntries, cursor.batch ?? batchEntries);
  const tune = next => { size = Math.max(1, Math.min(batchEntries, next)); cursor = { ...cursor, batch: size }; };
  const late = () => { try { remaining(deadline, 1); return false; } catch { return true; } };
  const ended = () => { result.error = result.batches || result.rejected ? 'timeout' : 'budget'; return 'stop'; };
  // Before any cursor write, seal or delete: this flush still holds the lock and the file is still where it was.
  const owns = async file => await lock.held() && (await statOrNull(file.path))?.ino === file.ino;
  const save = async next => { cursor = next; await writeCursor(home, client, cursor); };

  // Deliver the complete lines of one file from the cursor: 'done' (nothing
  // complete left), 'stop' (deadline or send failure) or 'lost' (taken over).
  const deliver = async file => {
    const handle = await open(file.path, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!handle) return 'lost';
    try {
      if ((await handle.stat()).ino !== file.ino) return 'lost';
      let offset = startOf(cursor, file);
      const skip = new Set(cursor.ino === file.ino ? cursor.skip : []);
      const commit = async next => {
        if (!await owns(file)) return false;
        offset = next; await save({ ...cursor, ino: file.ino, offset, skip: [...skip] }); return true;
      };
      for (;;) {
        const fileSize = (await handle.stat()).size;
        if (offset >= fileSize) return 'done';
        if (late()) return ended();
        const chunk = await readAt(handle, offset, Math.min(READ_CHUNK, fileSize - offset));
        const last = chunk.lastIndexOf(10);
        if (last < 0) {
          if (chunk.length < READ_CHUNK) return 'done'; // a partial line: an append in progress (or torn, in a segment)
          result.invalid++; // 4 MiB without a newline is no entry; the rest of that line fails to parse
          if (!await commit(offset + chunk.length)) return 'lost';
          continue;
        }
        const items = [];
        for (let start = 0; start <= last;) {
          const stop = chunk.indexOf(10, start);
          // An empty line (written after a torn tail) is no entry and not invalid.
          const [parsed, torn] = stop > start ? lineEntry(chunk.subarray(start, stop).toString('utf8')) : [null, false];
          const entry = parsed && wireEntry(parsed);
          if (torn) result.invalid++; // the torn part before it
          items.push({ entry, line: parsed, foreign: Boolean(parsed) && !mine(parsed), replayed: parsed?.replayed === true, blank: stop === start, end: offset + stop + 1, bytes: entry ? Buffer.byteLength(JSON.stringify(entry)) : 0 });
          start = stop + 1;
        }
        for (let index = 0; index < items.length;) {
          // Entries queued for another destination are never part of a batch: a
          // run of them is held first (with its `to`), then the cursor passes it.
          const elsewhere = item => item.foreign && !skip.has(item.entry.id);
          if (elsewhere(items[index])) {
            let stop = index + 1;
            while (stop < items.length && elsewhere(items[stop])) stop++;
            if (!await lock.refresh()) return 'lost';
            // Kept up to a cap, like refused entries; past it they are dropped and counted.
            if (((await statOrNull(heldFile(home, client)))?.size ?? 0) >= HELD_CAP_BYTES) result.held_dropped += stop - index;
            else {
              await appendFile(heldFile(home, client), items.slice(index, stop).map(item => JSON.stringify(heldLine(item.line, here)) + '\n').join(''), { mode: 0o600, flag: 'a' });
              result.held += stop - index;
            }
            if (!await commit(items[stop - 1].end)) return 'lost';
            index = stop;
            continue;
          }
          // Unreadable lines and set-aside ids ride along with the batch;
          // `settled` is where the lines before its first entry end.
          let next = index, bytes = REQUEST_OVERHEAD, settled = offset, batch = [], lead = index;
          const range = new Set(), replayed = new Set(), queued = new Map(), byteCap = Math.max(1, Math.floor(batchBytes * size / batchEntries));
          while (next < items.length && batch.length < size) {
            const { entry, end, bytes: length, blank } = items[next];
            if (elsewhere(items[next])) break;
            if (!entry || skip.has(entry.id)) {
              if (entry) range.add(entry.id); else if (!blank) result.invalid++;
              next++; if (!batch.length) settled = end;
              continue;
            }
            if (batch.length && bytes + length + 1 > byteCap) break;
            bytes += length + (batch.length ? 1 : 0); batch.push(entry); range.add(entry.id);
            queued.set(entry.id, items[next].line.to);
            if (items[next++].replayed) replayed.add(entry.id);
          }
          while (batch.length) {
            if (late()) return ended();
            if (!await lock.refresh()) return 'lost';
            let response;
            try { response = await send(batch); } catch (error) {
              const bad = error?.validation?.index;
              if (!(Number.isInteger(bad) && bad >= 0 && bad < batch.length)) {
                if (failureCode(error) === 'timeout' && !result.sent && size > 1) { tune(Math.floor(size / 2)); await commit(settled); }
                result.error = error; return 'stop';
              }
              // Twenty refusals in a row and nothing accepted: more likely the
              // server than the entries. Keep them queued and fail visibly.
              // A replayed entry was refused before: it goes back aside on its own.
              const again = replayed.has(batch[bad].id);
              if (!again && (cursor.streak ?? 0) >= REJECT_STREAK) {
                // Hold, and never drain past a full rejected file: then the entries stay queued.
                const full = await stat(rejectedFile(home, client)).then(info => info.size >= REJECTED_CAP_BYTES, () => false);
                if (full || Date.now() - (cursor.streak_at ?? 0) < STREAK_HOLD_MS) { result.error = 'rejecting'; return 'stop'; }
                cursor = { ...cursor, streak: 0 };
              }
              // Set aside and remembered before the next send, so a deadline
              // or crash never brings it back.
              if (!await quarantine(home, client, [{ ...batch[bad], ...(queued.get(batch[bad].id) === undefined ? {} : { to: queued.get(batch[bad].id) }) }])) result.rejected_dropped++;
              result.rejected++;
              skip.add(batch[bad].id);
              if (!again) cursor = { ...cursor, streak: (cursor.streak ?? 0) + 1, streak_at: Date.now() };
              // The cursor moves past leading set-aside entries (their ids are then behind it).
              for (; lead < next; lead++) {
                const { entry, end } = items[lead];
                if (entry && !skip.has(entry.id)) break;
                if (entry) skip.delete(entry.id);
                settled = end;
              }
              if (!await commit(settled)) return 'lost';
              batch = batch.filter((_, i) => i !== bad);
              continue;
            }
            result.batches++; result.sent += batch.length;
            for (const key of COUNTERS) if (Number.isFinite(response?.[key])) result[key] += response[key];
            const { streak, streak_at, ...rest } = cursor;
            cursor = rest;
            if (size < batchEntries) tune(size * 2);
            break;
          }
          for (const id of range) skip.delete(id); // `skip` holds only ids past the cursor
          if (!await commit(items[next - 1].end)) return 'lost';
          index = next;
        }
      }
    } finally { await handle.close(); }
  };

  try {
    // A seal adds a pass: the new segment is finished (and deleted) next.
    passes: for (let pass = 0; pass < 3; pass++) {
      let sealed = false;
      for (const file of await spoolFiles(home, client)) {
        const outcome = await deliver(file);
        if (outcome === 'lost') { result.busy = true; break passes; }
        if (file.sealed) {
          if (outcome !== 'done') break passes;
          if (!await owns(file)) { result.busy = true; break passes; }
          if (cursor.ino === file.ino) await save({ ...cursor, ...EMPTY });
          await unlink(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
          continue;
        }
        const info = await statOrNull(file.path), offset = cursor.ino === file.ino ? cursor.offset : 0;
        if (info && offset > 0 && (outcome === 'done' && offset >= info.size || offset >= SEAL_BYTES)) {
          if (!await owns(file)) { result.busy = true; break passes; }
          await rename(file.path, sealedFile(home, client)); sealed = true;
        }
        if (outcome !== 'done') break passes;
      }
      if (!sealed) break;
    }
    return { ...result, pending_bytes: (await pendingStats(home, client)).bytes };
  } finally { await lock.release().catch(() => {}); }
}
