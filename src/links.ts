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

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

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
  let m: RegExpExecArray | null;
  let pos = 0;
  WIKILINK.lastIndex = 0;
  while ((m = WIKILINK.exec(masked)) !== null) {
    const isEmbed = m[1] === "!";
    const [targetPart, anchorPart] = splitAnchor(m[2].trim());
    const { handle, slugText } = splitHandle(targetPart);
    const targetSlug = slugifyPath(slugText);
    if (!slugText || targetSlug === "untitled") continue;
    out.push({
      raw: m[0],
      targetHandle: handle,
      targetSlug,
      rawTarget: slugText,
      anchorText: anchorPart,
      kind: isEmbed ? "embed" : "wikilink",
      position: pos++,
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
