// The wikilink mesh: parse [[slug]] / [[slug|anchor]] / [[@handle/slug]] and
// ![[embed]] out of note bodies. Pure + unit-tested; DB resolution lives in notes.ts.

import { slugifyPath } from "./slug";

export interface WikilinkMatch {
  raw: string;
  targetHandle: string | null;
  targetSlug: string; // slugified
  rawTarget: string; // original target text, for display
  anchorText: string | null;
  kind: "wikilink" | "embed";
  position: number; // ordinal among accepted matches
}

// Blank out fenced code blocks and inline code so [[..]] inside code is ignored,
// while preserving offsets (so ordinal positions stay stable).
function maskCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function splitAnchor(inner: string): [string, string | null] {
  const i = inner.indexOf("|");
  if (i === -1) return [inner.trim(), null];
  return [inner.slice(0, i).trim(), inner.slice(i + 1).trim() || null];
}

function splitHandle(target: string): { handle: string | null; slugText: string } {
  const t = target.trim();
  if (t.startsWith("@")) {
    const slash = t.indexOf("/");
    if (slash !== -1) return { handle: t.slice(1, slash), slugText: t.slice(slash + 1) };
    return { handle: t.slice(1), slugText: "" };
  }
  return { handle: null, slugText: t };
}

export function parseWikilinks(body: string): WikilinkMatch[] {
  const masked = maskCode(body);
  const out: WikilinkMatch[] = [];
  let cursor = 0;
  while (cursor < masked.length) {
    const open = masked.indexOf("[[", cursor);
    if (open === -1) break;
    const isEmbed = open > cursor && masked[open - 1] === "!";
    const start = isEmbed ? open - 1 : open;
    const inner = open + 2;
    let close = inner;
    while (close < masked.length && masked[close] !== "]" && masked[close] !== "\n") close++;
    // No opener in this run of characters can cross the same closing character
    // or newline. Advance once without rescanning the run for every opener.
    if (close === masked.length) break;
    if (close === inner || masked[close] !== "]" || masked[close + 1] !== "]") {
      cursor = close + 1;
      continue;
    }
    cursor = close + 2;
    const [targetPart, anchorPart] = splitAnchor(masked.slice(inner, close).trim());
    const { handle, slugText } = splitHandle(targetPart);
    const targetSlug = slugifyPath(slugText);
    if (!slugText || targetSlug === "untitled") continue;
    out.push({
      raw: masked.slice(start, cursor),
      targetHandle: handle,
      targetSlug,
      rawTarget: slugText,
      anchorText: anchorPart,
      kind: isEmbed ? "embed" : "wikilink",
      position: out.length,
    });
  }
  return out;
}

/** Unique target slugs in first-seen order. */
export function uniqueTargets(matches: WikilinkMatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m.targetSlug)) {
      seen.add(m.targetSlug);
      out.push(m.targetSlug);
    }
  }
  return out;
}
