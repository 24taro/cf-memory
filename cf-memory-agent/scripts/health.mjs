// A small local health file per client (<agent home>/health/<client>.json).
// It holds timestamps, counters and fixed diagnostic codes only: never prompt
// text, tool output, tokens or exception messages.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const healthPath = (home, client) => join(home, 'health', client + '.json');

export async function readHealth(home, client) {
  try {
    const value = JSON.parse(await readFile(healthPath(home, client), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Read-modify-write. Concurrent hooks may overwrite each other's fields; the
// file is diagnostic, so the latest observation winning is acceptable.
export async function updateHealth(home, client, patch) {
  try {
    await mkdir(join(home, 'health'), { recursive: true, mode: 0o700 });
    const next = { ...await readHealth(home, client), ...patch };
    const path = healthPath(home, client), temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(next, null, 1), { mode: 0o600 });
    await rename(temporary, path);
    return next;
  } catch { return null; }
}
