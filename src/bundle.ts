// Skill bundle files (phase 2b): a skill's SKILL.md lives in D1, but optional
// bundle files (scripts/ references/ assets/) keep their bytes in R2. This module
// is PURE (no D1/R2) — the path validator, size caps, and content-type policy that
// keep the feature safe — so it is exhaustively unit-testable like slug.ts/db.ts.

/** Per-file byte cap (also the buffered-read bound; streaming deferred). */
export const MAX_BUNDLE_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Per-skill total byte cap, summed over all its bundle files. */
export const MAX_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MiB
/** Per-skill distinct-path cap. */
export const MAX_BUNDLE_FILE_COUNT = 100;
/** A bundle file at/under this size AND of an inline-text type is embedded as
 *  `content` by bundle()/skills_install; larger → a proxied URL. (skills_file_read
 *  has its own, larger 256 KiB returned-bytes cap.) */
export const INLINE_CONTENT_MAX_BYTES = 32 * 1024; // 32 KiB
/** The only top-level directories a bundle path may live under. SKILL.md is NOT
 *  here — it lives in D1 with its own route. */
export const BUNDLE_TOP_DIRS = new Set(["scripts", "references", "assets"]);

/** Upload content-types we store verbatim; anything else → application/octet-stream.
 *  (Serving still re-gates via resolveServeContentType — this is stored, not trusted.) */
const UPLOAD_ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown", "application/json"]);
/** Raster images we serve inline with their own type (not scriptable). */
const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Types small enough + safe to inline as UTF-8 `content` (never executed). */
const INLINE_TEXT = new Set(["text/plain", "text/markdown", "application/json"]);

/** Raised by SkillsRepo file methods / routes when the R2 BUNDLES binding is
 *  absent (phase-1 dev, or R2 not yet provisioned) — callers degrade, never 500. */
export class BundlesUnconfiguredError extends Error {
  constructor() {
    super("bundle files not enabled (R2 BUNDLES binding is not configured)");
    this.name = "BundlesUnconfiguredError";
  }
}

/** Raised when a put would exceed the per-skill count or total-size cap. */
export class BundleQuotaError extends Error {
  constructor(readonly reason: "count" | "total") {
    super(`bundle quota exceeded (${reason})`);
    this.name = "BundleQuotaError";
  }
}

/** Validate a client-supplied bundle-file path into a safe, normalized relative
 *  path, or null if it is unsafe. Operate on the ALREADY-DECODED value (Hono's
 *  c.req.param('*')) so `%2e%2e`/`%2f` are decoded then caught here. NEVER runs
 *  slugify (lossy — collapses dots/slashes). Rejects: empty / too long / control
 *  chars / backslash / leading slash / drive prefix / any '', '.', '..', or
 *  dot-leading segment (traversal, a//b, ./a, trailing slash, dotfiles); enforces
 *  the top-dir allowlist and depth/length caps. */
export function validateBundlePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x22 || c === 0x5c) return null; // control chars (<0x20), double-quote (keeps the Content-Disposition filename well-formed), or backslash (Windows sep / escape)
  }
  if (raw.startsWith("/")) return null; // absolute
  if (/^[a-zA-Z]:/.test(raw)) return null; // Windows drive prefix
  const normalized = raw.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.length < 2 || segments.length > 10) return null; // must be <topdir>/<...file>; depth cap
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return null; // traversal / empty / dotfile
    if (seg.length > 100) return null;
  }
  if (!BUNDLE_TOP_DIRS.has(segments[0])) return null; // allowlist (also rejects a bare SKILL.md)
  return normalized;
}

/** Store the client's content-type only if allowlisted, else octet-stream. */
export function sanitizeUploadContentType(ct: string | null | undefined): string {
  const base = (ct ?? "").split(";")[0].trim().toLowerCase();
  return UPLOAD_ALLOWED.has(base) ? base : "application/octet-stream";
}

/** Authoritative SERVE policy (never echoes a raw stored type for active content).
 *  Raster images serve inline with their type; text types serve as text/plain;
 *  everything else (html/js/svg/xml/octet-stream) → octet-stream. `inline` is true
 *  ONLY for the raster images (Content-Disposition: attachment for all else). */
export function resolveServeContentType(stored: string | null | undefined): { type: string; inline: boolean } {
  const base = (stored ?? "").split(";")[0].trim().toLowerCase();
  if (INLINE_IMAGE.has(base)) return { type: base, inline: true };
  if (INLINE_TEXT.has(base)) return { type: "text/plain; charset=utf-8", inline: false };
  return { type: "application/octet-stream", inline: false };
}

/** Whether a stored content-type may be inlined as UTF-8 `content`. */
export function isInlineTextType(ct: string | null | undefined): boolean {
  return INLINE_TEXT.has((ct ?? "").split(";")[0].trim().toLowerCase());
}

/** Standard base64 (NOT base64url) of raw bytes, for skills_file_read binary. */
export function base64FromBytes(b: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  return btoa(s);
}

/** basename of a validated bundle path, for the Content-Disposition filename. */
export function bundleBasename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || "file";
}

/** Percent-encode each path segment for a same-origin file URL, keeping the '/'
 * separators literal so Hono's `:path{.+}` decodes it back to the stored path.
 * validateBundlePath permits URL-reserved chars (%, ?, #), so URLs must encode. */
export function encodeBundlePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A safe `Content-Disposition: attachment` value for a bundle file. HTTP header
 * values are Latin1 (ByteString), so a raw non-ASCII (CJK/emoji) filename would
 * throw when building the Response. Emit an ASCII-sanitized `filename=` fallback
 * plus an RFC 6266 `filename*=UTF-8''<pct-encoded>` for modern clients. */
export function attachmentDisposition(path: string): string {
  const name = bundleBasename(path);
  let ascii = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    ascii += c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c ? name[i] : "_"; // printable-ASCII, no quote/backslash
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
