// Slugification. Keeps letters/digits from any script (a-z0-9, kana/CJK, plus
// Korean/Cyrillic/Arabic/etc.) so titles stay human-readable in the URL space;
// everything else collapses to hyphens.

const ALLOWED = /[^\p{L}\p{N}]+/gu;

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKC")
    .replace(ALLOWED, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return s || "untitled";
}

// Route-colliding leaf words (a note `<ns>/edit` would be shadowed by /n/:slug/edit).
const RESERVED_LEAF = new Set(["edit"]);

/** Slugify each `/`-separated segment and rejoin — for namespaced note slugs like
 * `mnemo/about`. Enforces ONE namespace level (deeper paths collapse into the
 * leaf), drops empty segments, and remaps route-reserved leaf words. */
export function slugifyPath(input: string): string {
  let segs = input
    .split("/")
    .map((seg) => slugify(seg))
    .filter((s) => s && s !== "untitled");
  if (!segs.length) return "untitled";
  if (segs.length > 2) segs = [segs[0], segs.slice(1).join("-")]; // one level only
  if (segs.length === 2 && RESERVED_LEAF.has(segs[1])) segs[1] = `${segs[1]}-note`;
  return segs.join("/");
}
