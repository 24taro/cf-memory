// Ids, time, hashing and small numeric helpers. No D1 access here so this
// module is import-free and unit-testable.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time prefix (lexicographically sortable) + 80 bits randomness. */
export function ulid(seedTime: number = Date.now()): string {
  let time = seedTime;
  let timeChars = "";
  for (let i = 0; i < 10; i++) {
    timeChars = CROCKFORD[time % 32] + timeChars;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return timeChars + rand;
}

export function now(): number {
  return Date.now();
}

/** decision 10: parse a bi-temporal validity value into a ms epoch. Accepts a
 * ms-epoch number (or all-digit string) or an ISO/date string (via Date.parse).
 * Returns undefined for absent/unparseable input so the write path PRESERVES the
 * existing value on an edit rather than silently zeroing a validity window. */
export function parseValidTs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v.trim());
    if (Number.isFinite(t) && !Number.isNaN(t)) return t;
  }
  return undefined;
}

export async function sha256hex(input: string): Promise<string> {
  return sha256hexBytes(new TextEncoder().encode(input));
}

/** SHA-256 hex of raw bytes (skill_files integrity digest; sha256hex is the string form). */
export async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Rough token estimate — deterministic, used by recall budgeting. CJK-aware:
 * counts CJK codepoints (kana, kanji, CJK punctuation, full/half-width) at
 * ~1 token/char and the rest at ~4 chars/token, then sums the two buckets.
 * English text stays exactly at len/4 (no regression vs the old heuristic). */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Clamp a caller-supplied list/search limit: non-positive or non-finite -> default,
 * otherwise floored and capped at `max`. Protects every door (REST + MCP). */
export function clampLimit(n: number | undefined, def: number, max = 200): number {
  const x = Math.floor(Number(n));
  return Number.isFinite(x) && x > 0 ? Math.min(x, max) : def;
}
