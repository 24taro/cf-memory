// Minimal YAML-ish frontmatter parser (a `---` fenced block at the top of a
// document). Pure + unit-tested. Handles `key: value`, quoted scalars, inline
// `[a, b]` lists, and `- item` block lists — enough for note + SKILL.md headers.

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    // The composer emits JSON double-quoted scalars, a subset of YAML. Decode
    // escapes on reimport while keeping the legacy YAML-ish parser tolerant of
    // quoted input outside that subset (for example YAML's \\e escape).
    try {
      const decoded: unknown = JSON.parse(t);
      if (typeof decoded === "string") return decoded;
    } catch { /* Preserve the historical quote-stripping fallback. */ }
    return t.slice(1, -1);
  }
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1);
  }
  return t;
}

function scalar(v: string): string | number | boolean {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return stripQuotes(t);
}

function parseBlock(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const mk = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!mk) {
      i++;
      continue;
    }
    const key = mk[1];
    const rest = mk[2];
    if (rest.trim() === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]*-[ \t]+/.test(lines[j])) {
        items.push(stripQuotes(lines[j].replace(/^[ \t]*-[ \t]+/, "")));
        j++;
      }
      if (items.length) {
        data[key] = items;
        i = j;
        continue;
      }
      data[key] = "";
      i++;
      continue;
    }
    const trimmed = rest.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      data[key] = trimmed
        .slice(1, -1)
        .split(",")
        .map((x) => stripQuotes(x))
        .filter((x) => x !== "");
      i++;
      continue;
    }
    data[key] = scalar(rest);
    i++;
  }
  return data;
}

export function parseFrontmatter(md: string): ParsedFrontmatter {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  // drop one separator newline (the blank line between the closing --- and body)
  return { data: parseBlock(m[1]), body: md.slice(m[0].length).replace(/^\r?\n/, "") };
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

export function composeSkillMd(name: string, description: string, instructions: string): string {
  // Always quote string metadata: plain YAML can interpret `: `, ` #`, numbers,
  // booleans and newlines as syntax or other types. Keep the body unchanged.
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions.trim()}\n`;
}
