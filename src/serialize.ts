// Pure serializers for the dual-surface convention: every human view has a `.md`
// twin (and the changes view doubles as a content-hashed commit log) plus an Atom
// feed. Pure + unit-tested; the routes are thin wrappers over these.

export interface ChangeRow {
  verb: string;
  created_at: number;
  title: string;
  slug: string | null;
  op: string;
  hash: string;
}
export interface RankRow {
  slug: string;
  title: string;
  inlinks: number;
  views: number;
  score: number;
}
export interface GraphNode {
  id: string;
  label: string;
  stub: boolean;
  href?: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string }>;
  partial?: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** changes.md = a content-hashed create/replace commit log. */
export function changesMd(handle: string, changes: ChangeRow[]): string {
  const lines = [`# changes — @${handle}`, ""];
  for (const c of changes) {
    lines.push(`${iso(c.created_at)} | ${c.op.padEnd(7)} | ${c.title}${c.hash ? ` | ${c.hash}` : ""}${c.slug ? `  (/@${handle}/n/${c.slug})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function rankingMd(handle: string, rows: RankRow[]): string {
  const lines = [`# ranking — @${handle}`, "", "| # | score | backlinks | views | note |", "|--|--|--|--|--|"];
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.score} | ${r.inlinks} | ${r.views} | [${r.title}](/@${handle}/n/${r.slug}) |`));
  return `${lines.join("\n")}\n`;
}

export function networkMd(handle: string, g: GraphData): string {
  const stubs = new Set(g.nodes.filter((n) => n.stub).map((n) => n.id));
  const lines = [`# network — @${handle}`, "", `nodes: ${g.nodes.length}, edges: ${g.edges.length}`, ""];
  for (const e of g.edges) lines.push(`- [[${e.source}]] → [[${e.target}]]${stubs.has(e.target) ? " (stub)" : ""}`);
  // issue #33: the edge list alone never mentions a node with zero in/out
  // links, so the "nodes: N" header count and the listing's actual entry
  // count silently disagreed. List orphans too (a stub is always the target
  // of at least one edge by construction, so this never double-lists one).
  const linked = new Set<string>();
  for (const e of g.edges) {
    linked.add(e.source);
    linked.add(e.target);
  }
  for (const n of g.nodes) if (!linked.has(n.id)) lines.push(`- [[${n.id}]] (no links)`);
  return `${lines.join("\n")}\n`;
}

// Characters a line-oriented reader may treat as a line break or cannot show:
// C0, DEL, C1 (U+0085 NEL among them) and U+2028/U+2029.
const FM_CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** One frontmatter scalar. A value every reader gets back unchanged is written
 * plain, so ordinary titles stay readable; anything else — a line break,
 * surrounding space, a quote character at either end, a leading `[`, text that
 * would parse as a boolean or a number, the empty string — is written quoted on
 * one line.
 *
 * The readers are the parser (frontmatter.ts) and the CLI's lenient read
 * (cli/cf-memory.ts `push`), which drops the quotes at the ends and unescapes
 * nothing. So the quoted form is chosen for what the value holds:
 *   - no `"` and no backslash: a JSON double-quoted scalar, the form
 *     composeSkillMd uses. It needs no escapes, so dropping the quotes is exact.
 *   - a `"` or a backslash: single quotes around the value as it is. The parser
 *     and the CLI both take the text between them literally.
 *   - a control character or line break: a JSON scalar with escapes, so the
 *     value stays on its line. Only the parser reads this form back exactly.
 * JSON.stringify leaves DEL, C1 and U+2028/U+2029 as they are, so those are
 * escaped here as well. */
function fmScalar(value: string): string {
  const control = FM_CONTROL.test(value);
  const plain = value !== "" && value === value.trim() && !control && !/^["'\[]|["']$/.test(value)
    && value !== "true" && value !== "false" && !/^-?\d+(\.\d+)?$/.test(value);
  if (plain) return value;
  if (!control && /["\\]/.test(value)) return `'${value}'`;
  return JSON.stringify(value).replace(/[\x7f-\x9f\u2028\u2029]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

export interface NoteMdInput {
  title: string;
  slug: string;
  tags?: string[];
  stage: string;
  createdAt: number;
  validFrom?: number | null;
  validUntil?: number | null;
  /** Slug of the superseded note, when the reader may be shown it. */
  supersedes?: string | null;
  body: string;
}

/** The `.md` twin of a note: a complete, re-parseable frontmatter (B1: `pull .md
 * -> edit -> push` round-trips slug/tags/date, not just title/stage) plus the
 * body. Titles and tags are someone's stored text and a shared note's twin is
 * read by other members, so no stored value may add a `key: value` line or
 * close the block: the reader who pushes the twin back would send those lines
 * as their own metadata. Titles and tags are single-lined when written now
 * (notes.ts); this is the second layer, for rows stored before that. */
export function noteMd(n: NoteMdInput): string {
  const lines = [`title: ${fmScalar(n.title)}`, `slug: ${fmScalar(n.slug)}`];
  // Tags as a YAML block list (not inline `[a, b]`) so a tag that itself
  // contains a comma or bracket still round-trips — the inline form is
  // comma-delimited and would re-parse such a tag as several tags.
  if (n.tags?.length) {
    lines.push("tags:");
    for (const t of n.tags) lines.push(`  - ${fmScalar(t)}`);
  }
  // date = created_at as a full ISO string so it re-parses to the same instant.
  lines.push(`stage: ${fmScalar(n.stage)}`, `date: ${new Date(n.createdAt).toISOString()}`);
  if (n.validFrom != null) lines.push(`valid_from: ${new Date(n.validFrom).toISOString()}`);
  if (n.validUntil != null) lines.push(`valid_until: ${new Date(n.validUntil).toISOString()}`);
  if (n.supersedes) lines.push(`supersedes: ${fmScalar(n.supersedes)}`);
  // Normalize trailing newlines to exactly one so pull -> push -> pull is
  // idempotent (parseFrontmatter strips one leading newline after the block, so
  // an un-normalized `${body}\n` would otherwise accumulate a newline each cycle).
  // Walked back from the end, not /\n+$/: the regex rescans a newline run from
  // each of its newlines when the run is not at the end, which is quadratic.
  let end = n.body.length;
  while (end > 0 && n.body.charCodeAt(end - 1) === 10) end--;
  return `---\n${lines.join("\n")}\n---\n\n${n.body.slice(0, end)}\n`;
}

/** Prompt-builder: wrap a recalled context pack into a ready-to-use system prompt. */
export function buildPrompt(handle: string, query: string, packText: string): string {
  return `# Context for @${handle}
You are an agent operating over @${handle}'s cf-memory knowledge base (notes, skills, core memory). Ground your answer in the recalled context below; cite notes as [[slug]], and prefer evergreen knowledge over seedlings.

${packText}

---
## Task
${query.trim() || "(no task specified)"}
`;
}

export function profileMd(handle: string, notes: Array<{ slug: string; title: string }>, skills: Array<{ slug: string; name: string; version: string }>): string {
  const lines = [`# @${handle}`, "", "## Notes", ""];
  for (const n of notes) lines.push(`- [${n.title}](/@${handle}/n/${n.slug})`);
  if (skills.length) {
    lines.push("", "## Skills", "");
    for (const s of skills) lines.push(`- [${s.name}](/@${handle}/skills/${s.slug}) v${s.version}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Atom 1.0 feed over recent public changes. */
export function atomFeed(handle: string, baseUrl: string, changes: ChangeRow[]): string {
  const updated = changes.length ? iso(changes[0].created_at) : iso(0);
  const entries = changes
    .filter((c) => c.slug)
    .map((c) => {
      const url = `${baseUrl}/@${handle}/n/${c.slug}`;
      return `  <entry>
    <title>${xmlEscape(c.title)}</title>
    <link href="${xmlEscape(url)}"/>
    <id>tag:cf-memory,${c.slug}:${c.hash || c.created_at}</id>
    <updated>${iso(c.created_at)}</updated>
    <summary>${xmlEscape(c.op)}</summary>
  </entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>@${xmlEscape(handle)} · cf-memory</title>
  <link href="${xmlEscape(baseUrl)}/@${handle}"/>
  <link rel="self" href="${xmlEscape(baseUrl)}/@${handle}/feed.xml"/>
  <id>tag:cf-memory,@${xmlEscape(handle)}</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}
