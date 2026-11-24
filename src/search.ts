// Keyword search across notes AND skills: several SQLite FTS5 (trigram) lanes
// — the OR-of-tokens query with synonyms, a literal phrase lane, and recall's
// question / Japanese-prose / identifier focus lanes — fused with Reciprocal
// Rank Fusion, plus a LIKE fallback for 1–2 character queries. rrfFuse +
// ftsQuery + snippet are pure/unit-tested. Every query carries a visibility
// predicate, and hydration re-checks it against the same snapshot.
//
// 2026-10-31 (design B): semantic search (embeddings, Vectorize, the D1 cosine
// scan) is removed. Keyword search over notes and kept conversations answered
// 19/20 of the owner's real questions against 13/20 for semantic+keyword, and
// the semantic lane added almost nothing. `mode` is still accepted for old
// clients; every mode runs the same keyword lanes.

import { normalizeScopes, scopeClause } from "./context";
import { clampLimit, estimateTokens, now } from "./db";
import type { Principal, SearchHit } from "./types";
import { readableSql } from "./visibility";
import { logSlowRead } from './read-timing';

/** Accepted for compatibility. All three behave as keyword search. */
export type SearchMode = "hybrid" | "keyword" | "semantic";
export type SearchScope = "notes" | "skills" | "all";
export const SEARCH_MODES: readonly SearchMode[] = ['hybrid', 'keyword', 'semantic'];
/** What every search door reports about retrieval now that the semantic lane
 * is gone. `requested_lanes_complete` stays true: keyword lanes cannot time out
 * into a partial fallback. It never means the bounded top-k is exhaustive.
 * `semantic_status` is "not_requested" (no semantic lane ran), not a new value:
 * installed 0.2.x Agents treat anything but "ready"/"not_requested" as an
 * incomplete search and stall auto-apply and canonical refresh. Keep it until
 * those Agents are gone (rollout phase 5). */
export const SEMANTIC_STATUS = 'not_requested' as const;
export function keywordRetrieval(requested: SearchMode = 'hybrid') {
  return { mode: 'keyword' as const, requested_mode: requested, semantic_status: SEMANTIC_STATUS,
    semantic_budget_ms: 0, requested_lanes_complete: true };
}
export async function standaloneSearch(search: SearchService, principal: Principal, q: string,
  opts: Parameters<SearchService['hybrid']>[2] = {}) {
  const mode = opts.mode ?? 'hybrid';
  if (!SEARCH_MODES.includes(mode)) throw new SearchInputError('invalid search mode');
  const hits = await search.hybrid(principal, q, { ...opts, mode });
  return { hits, retrieval: keywordRetrieval(mode) };
}
export interface SearchFilters {
  memory_type?: 'user' | 'feedback' | 'project' | 'reference';
  created_since?: number; created_until?: number;
  updated_since?: number; updated_until?: number;
  file_ref?: string;
  current_only?: boolean;
}
export interface GuidedMemoryRow {
  id: string; kind: 'note' | 'skill'; slug: string; title: string; scope: string;
  shared: number; content_hash: string; created_at: number; updated_at: number;
  char_count: number; body?: string; valid_from: number | null; valid_until: number | null;
}
export class SearchInputError extends Error {}
/** Front doors and direct service callers share strict filter validation. */
export function searchFilters(raw: Record<string, unknown>): SearchFilters {
  const out: SearchFilters = {};
  if (raw.memory_type != null) {
    if (typeof raw.memory_type !== 'string' || !['user', 'feedback', 'project', 'reference'].includes(raw.memory_type)) throw new SearchInputError('invalid memory_type');
    out.memory_type = raw.memory_type as SearchFilters['memory_type'];
  }
  for (const key of ['created_since', 'created_until', 'updated_since', 'updated_until'] as const) {
    if (raw[key] == null) continue;
    const value = raw[key];
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
    if (!Number.isSafeInteger(n) || n < 0 || n > 8640000000000000) throw new SearchInputError('invalid ' + key);
    out[key] = n;
  }
  for (const prefix of ['created', 'updated'] as const) {
    const lower = out[`${prefix}_since`], upper = out[`${prefix}_until`];
    if (lower != null && upper != null && lower >= upper) throw new SearchInputError('invalid ' + prefix + ' range');
  }
  if (raw.file_ref != null) {
    if (typeof raw.file_ref !== 'string' || !raw.file_ref.trim() || raw.file_ref.length > 500) throw new SearchInputError('invalid file_ref');
    out.file_ref = raw.file_ref.trim();
  }
  if (raw.current_only != null) {
    if (typeof raw.current_only !== 'boolean') throw new SearchInputError('invalid current_only');
    out.current_only = raw.current_only;
  }
  return out;
}
function filterClause(kind: Kind, filters: SearchFilters, principal: Principal): { sql: string; args: unknown[] } {
  const terms: string[] = [], args: unknown[] = [];
  if (filters.memory_type) {
    terms.push(kind === 'note' ? 'n.type = ?' : '1=0');
    if (kind === 'note') args.push(filters.memory_type);
  }
  for (const column of ['created', 'updated'] as const) {
    const lower = filters[`${column}_since`], upper = filters[`${column}_until`];
    if (lower != null) { terms.push(`n.${column}_at >= ?`); args.push(lower); }
    if (upper != null) { terms.push(`n.${column}_at < ?`); args.push(upper); }
  }
  if (filters.file_ref) {
    // Durable snapshots survive raw TTL. Match literal references, never bodies
    // or another user's capture, and bind both kind and reference. Same reader
    // rule as CaptureService.provenance (capture.ts provenanceReadable): a
    // personal source on a since-shared note matches for its actor only.
    terms.push("EXISTS (SELECT 1 FROM memory_provenance pv, json_each(pv.source_metadata_json,'$.file_refs') f WHERE pv.memory_kind=? AND pv.memory_id=n.id AND f.value=? AND (pv.actor_id=? OR (COALESCE(json_extract(pv.source_metadata_json,'$.imported'),0)!=1 AND json_extract(pv.source_metadata_json,'$.visibility')='project')))");
    args.push(kind, filters.file_ref, principal.anonymous ? '' : principal.userId);
  }
  return { sql: terms.length ? terms.join(' AND ') + ' AND ' : '', args };
}
type Kind = "note" | "skill";

/** Reciprocal Rank Fusion across any number of ranked key lists. */
export function rrfFuse(lists: string[][], k = 60, weights: number[] = [], rankConstants: number[] = []): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const [lane, list] of lists.entries()) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + (weights[lane] ?? 1) / ((rankConstants[lane] ?? k) + idx + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** decision 10: the recall-only "still-valid, not-superseded" predicate, shared by
 * every FTS lane and hydration so they filter candidates identically. Notes-only
 * (skills carry no validity columns) and gated on `excludeArchived` (the recall
 * flag) so plain notes_search keeps superseded/expired notes findable — exactly
 * like the archived cold tier. `.args(nowMs)` yields the two positional binds in
 * SQL order; both are `now`. Pure.
 *
 * 2026-08-21: supersede する側にも可視性の条件が要る。無いと、他人が自分の個人
 * ノートで共有ノートを supersede しただけで、その共有ノートが全員の recall から
 * 消える —— 誰にも見えないノートが、みんなに見えるノートを取り下げる形。
 * 取り下げてよいのは、そのノートの著者自身か、共有された supersede だけ。 */
export function validityClause(kind: Kind, excludeArchived: boolean): { sql: string; args: (nowMs: number) => number[] } {
  if (!(excludeArchived && kind === "note")) return { sql: "", args: () => [] };
  return {
    // Uncorrelated live-key sets are built once. Without a supersedes index,
    // the old correlated NOT EXISTS scans all notes for every candidate.
    // JSON arrays encode the author/id pair without delimiter collisions;
    // scalar IN avoids SQLite's repeated NULL-check scan for row-value NOT IN.
    // Filter NULL forward pointers so they cannot poison NOT IN. Preserve the
    // original result for a legacy NULL id; user_id is NOT NULL in the schema.
    sql: "(n.id IS NULL OR (n.id NOT IN (SELECT sup.supersedes FROM notes sup WHERE sup.deleted_at IS NULL AND sup.shared = 1 AND sup.supersedes IS NOT NULL) AND json_array(n.user_id,n.id) NOT IN (SELECT json_array(sup.user_id,sup.supersedes) FROM notes sup WHERE sup.deleted_at IS NULL AND sup.supersedes IS NOT NULL))) AND (n.valid_from IS NULL OR n.valid_from <= ?) AND (n.valid_until IS NULL OR n.valid_until > ?) AND ",
    args: (nowMs) => [nowMs, nowMs],
  };
}

/** Preserve the indexed Unicode terms and also recover Latin identifiers joined
 * to Japanese prose. The trigram index can match `Vectorize` and `ACK`, while
 * a query such as `VectorizeのACKが未処理` previously produced one unmatchable
 * token. Keep literals; never interpret user MATCH syntax or alter stored text. */
export function lexicalTokens(q: string): string[] {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.flatMap(token => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)
    ? [token, ...(token.match(/[a-z][a-z0-9]*/g) ?? [])]
    : [token]))];
}

/** Safe FTS5 MATCH string: OR of quoted tokens (recall-biased; RRF re-ranks). */
export function ftsQuery(q: string): string | null {
  const tokens = lexicalTokens(q);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** A literal multi-token phrase, never user-supplied MATCH syntax. A second
 * indexed lexical vote ranks an exact identifier/title above rows that merely
 * share one of its words. Single terms retain the existing one-lane weighting. */
export function ftsPhrase(q: string): string | null {
  const phrase = q.trim().toLowerCase();
  if ((phrase.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2) return null;
  return `"${phrase.replace(/"/g, '""')}"`;
}

/** A bounded supplementary query for Recall prompts that start with a question
 * followed by response instructions. Keep the complete query in every ordinary
 * lane: this heuristic does not parse intent or discard later questions. */
export function leadingQuestion(q: string): string | null {
  // Japanese questions commonly end in 「か。」 rather than a question mark.
  // Only admit that literal question ending, not arbitrary first statements.
  const match = q.trim().match(/^([^?？\n。!！]{12,600}(?:[?？]|か。))([\s\S]+)$/u);
  if (!match || match[2].trim().length < 40 || /\.\s/u.test(match[1]) || lexicalTokens(match[1]).length < 2) return null;
  return match[1];
}

/** Recall-only supplement for Japanese prose. An entire mixed-script token
 * (e.g. Agentで技術的な記憶を保存...) is usually absent from stored text. Keep
 * the full query in existing lanes, and recover at most eight literal Han runs
 * that meet the trigram index's three-character minimum. No short-term LIKE
 * scans, morphological model, synonym expansion or user MATCH operators. */
export function japaneseProseMatch(q: string): string | null {
  const bounded = q.slice(0, 2000);
  if (bounded.length < 12 || !/[\p{Script=Hiragana}]/u.test(bounded)) return null;
  const existing = new Set(lexicalTokens(bounded));
  const terms = [...new Set(bounded.match(/[\p{Script=Han}]{3,}/gu) ?? [])]
    .filter(t => t.length <= 24 && !existing.has(t)).slice(0, 8);
  return terms.length ? terms.map(t => `"${t}"`).join(' OR ') : null;
}

/** Recall-only companion to japaneseProseMatch. A Japanese question naming a
 * code identifier (camelCase, snake_case or containing digits, 4+ chars, e.g.
 * invoiceTotal) must not lose the English note that defines it to notes that
 * merely share a Han term. Plain words (cf-memory, pending) never form this lane. */
export function identifierMatch(q: string): string | null {
  const bounded = q.slice(0, 2000);
  if (!/[\p{Script=Hiragana}]/u.test(bounded)) return null;
  const terms = [...new Set(bounded.match(/\b[A-Za-z_][A-Za-z0-9_]{3,63}\b/g) ?? [])]
    .filter(t => /[a-z][A-Z]|_|\d/.test(t)).slice(0, 8);
  return terms.length ? terms.map(t => `"${t}"`).join(' OR ') : null;
}

/** Like ftsQuery but OR-expands each token with its synonyms (E5). Pure. */
export function expandedMatch(q: string, synonyms: Map<string, string[]>): string | null {
  const tokens = lexicalTokens(q);
  if (!tokens.length) return null;
  const terms: string[] = [];
  for (const t of tokens) {
    terms.push(`"${t.replace(/"/g, '""')}"`);
    for (const s of synonyms.get(t) ?? []) terms.push(`"${s.replace(/"/g, '""')}"`);
  }
  return terms.join(" OR ");
}

/** Body characters the snippet path examines. A 200-character preview needs
 * little more than 200; the slack covers wikilink targets and whitespace runs
 * that flatten away. The body is another member's stored text, so the cost of
 * a preview must not depend on its length or shape. */
const SNIPPET_SCAN_CHARS = 8192;

/** Replace `[[target|label]]` (aliased) or `[[target]]` with its visible text,
 * `!` embed marker included. Same matches as the patterns
 * /!?\[\[([^\]|]+)\|([^\]]+)\]\]/g and /!?\[\[([^\]]+)\]\]/g, in one forward
 * pass: `close` and `bar` only move right, so a run of '[' with no closer never
 * rescans the rest of the text from each start position. */
function flattenWikilinks(text: string, aliased: boolean): string {
  let out = "", copied = 0, close = -1, bar = -1;
  for (let open = text.indexOf("[["); open !== -1;) {
    const from = open + 2;
    if (close < from && (close = text.indexOf("]", from)) === -1) break; // no closer left: nothing else can match
    if (aliased && bar < from && (bar = text.indexOf("|", from)) === -1) break;
    const start = aliased ? bar + 1 : from; // first character of the visible text
    if ((aliased ? bar > from && bar < close : true) && close > start && text[close + 1] === "]") {
      const begin = open > copied && text[open - 1] === "!" ? open - 1 : open;
      out += text.slice(copied, begin) + text.slice(start, close);
      copied = close + 2;
      open = text.indexOf("[[", copied);
    } else {
      open = text.indexOf("[[", open + 1);
    }
  }
  return copied ? out + text.slice(copied) : text;
}

/** Flattened leading text of the body, and whether the body ran past the
 * examined prefix (in which case the text is necessarily a partial preview). */
function flattenForSnippet(body: string, max: number): { flat: string; cut: boolean } {
  const scan = Math.max(SNIPPET_SCAN_CHARS, max * 4);
  const flat = flattenWikilinks(flattenWikilinks(body.slice(0, scan), true), false) // [[target|label]] -> label, then [[target]] -> target
    .replace(/\s+/g, " ")
    .trim();
  return { flat, cut: body.length > scan };
}

export function snippet(body: string, max = 200): string {
  const { flat, cut } = flattenForSnippet(body, max);
  return flat.length > max || cut ? `${flat.slice(0, max)}…` : flat;
}

/** Whether `snippet(body, max)` is a partial leading preview. Kept alongside
 * snippet() so callers never infer truncation from a literal ellipsis. */
export function snippetWasTruncated(body: string, max = 200): boolean {
  const { flat, cut } = flattenForSnippet(body, max);
  return flat.length > max || cut;
}

const TABLE: Record<Kind, { table: string; fts: string; soft: boolean }> = {
  note: { table: "notes", fts: "notes_fts", soft: true },
  // issue #36 review r1 fix: skills now have deleted_at (soft-delete). false
  // here left a deleted skill fully discoverable via search, directly
  // contradicting softDelete()'s own "drops it from search" contract.
  skill: { table: "skills", fts: "skills_fts", soft: true },
};

/** A query made only of 1–2 character words ("認証 設定", "DB 移行"): the trigram
 * index cannot match any of them. Prose ("認証の設定を見直したい") is left to
 * recall's Japanese focus lane, so ordinary search stays as it was. At most four. */
export function shortTerms(q: string): string[] {
  const words = q.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.some((word) => [...word].length > 2)) return [];
  // At least one non-ASCII word, and ASCII words only as 2-character letters/digits (DB, db, D1, Go):
  // "do it", "ok go" or "is it ok" alone would match nearly every note.
  if (words.some((word) => /^[\x00-\x7f]+$/.test(word) && !/^[A-Za-z0-9]{2}$/.test(word)) || !words.some((word) => /[^\x00-\x7f]/.test(word))) return [];
  return [...new Set(words)].slice(0, 4);
}

export const MAX_SYNONYM_CHARS = 160;
export const MAX_SYNONYMS_PER_REQUEST = 50;
const MAX_SYNONYM_TERMS = 32;
const MAX_EXPANSIONS_PER_TERM = 8;

export class SearchService {
  constructor(private db: D1Database) {}

  /** 同義語は書いた人の設定。
   *
   * 2026-08-21: ここは述語なしで全員の行を読んでいた。synonyms は user_id を
   * 記録しているのに読み取りで無視していたので、他人が登録した同義語が自分の
   * 検索語を勝手に広げていた —— 結果が静かに変わるだけで、気づく手段が無い。
   * 共有ノートと違い、同義語に「共有」の概念は無い(誰の語彙かで意味が変わる)。 */
  private async synonymsFor(viewerId: string, terms: string[]): Promise<Map<string, string[]>> {
    const termsToExpand = terms.filter(term => term.length <= MAX_SYNONYM_CHARS).slice(0, MAX_SYNONYM_TERMS);
    if (!viewerId || !termsToExpand.length) return new Map();
    const started = Date.now();
    try {
      const res = await this.db
        .prepare(`SELECT word.value AS term, (
          SELECT json_group_array(synonym) FROM (
            SELECT substr(synonym,1,?) AS synonym FROM synonyms
            WHERE user_id=? AND term=word.value ORDER BY synonyms.synonym LIMIT ?
          )
        ) AS aliases FROM json_each(?) word`)
        .bind(MAX_SYNONYM_CHARS + 1, viewerId, MAX_EXPANSIONS_PER_TERM, JSON.stringify(termsToExpand))
        .all<{ term: string; aliases: string }>();
      return new Map(res.results.map(row => [
        row.term, (JSON.parse(row.aliases) as string[]).filter(alias => alias.length > 0 && alias.length <= MAX_SYNONYM_CHARS).map(alias => alias.toLowerCase()),
      ]));
    } finally { logSlowRead('search_synonyms', started); }
  }

  // Path A access predicate — readableSql が唯一の定義(自分の行 + 共有空間)。
  // ここに直接 user_id を書かない: 共有の OR が2箇所に散ると、片方だけ直して
  // 「検索には出るが id で開けない」のような食い違いが生まれる
  // (decision 9). Anonymous callers match nothing (`1=0`): the discovery doors
  // return empty rather than erroring, and the web door redirects to /access/login.
  // The #117 scope filter (`scope IN (context,'global')`) narrows the owner's
  // rows to the current project + globals. MUST stay `IN (context, 'global')`,
  // never a bare `scope = context` — that would zero out every 'global' row
  // (the mem0 null-scoping pitfall). Unset context → no scope filter.
  private accessClause(_kind: Kind, principal: Principal, contexts: string[]): { sql: string; args: unknown[] } {
    const vis = readableSql("n", principal);
    if (!vis.args.length) return vis; // anonymous: 1=0
    const sc = scopeClause("n", contexts);
    return { sql: `(${vis.sql}${sc.sql})`, args: [...vis.args, ...sc.args] };
  }

  // #117: the distinct non-'global' scopes the caller can actually read —
  // the pickable projects for the web スコープ filter. 'global' is excluded because
  // it is not a project to narrow TO (it is the universal tier every scope query
  // already ORs in via accessClause), and "すべて" (no context) already shows it.
  // Deleted rows are excluded so a scope that survives only on tombstones is not
  // offered. Anonymous callers get nothing (mirrors accessClause: no viewer, no rows).
  async listScopes(principal: Principal): Promise<string[]> {
    if (principal.anonymous) return [];
    const access = readableSql('n', principal);
    const res = await this.db
      .prepare(
        `SELECT scope FROM notes n WHERE ${access.sql} AND scope <> 'global' AND deleted_at IS NULL AND kind!='block'
         UNION
         SELECT scope FROM skills n WHERE ${access.sql} AND scope <> 'global' AND deleted_at IS NULL
         ORDER BY scope`,
      )
      .bind(...access.args, ...access.args)
      .all<{ scope: string }>();
    return (res.results ?? []).map((r) => r.scope);
  }

  async withOwnerHandles(principal: Principal, hits: SearchHit[]): Promise<Array<SearchHit & { ownerHandle: string }>> {
    if (!hits.length) return [];
    const access = readableSql('n', principal);
    const wanted = JSON.stringify(hits.map(({ type, id }) => [type, id]));
    const rows = await this.db.prepare(`WITH hits AS (
        SELECT json_extract(value, '$[0]') AS type, json_extract(value, '$[1]') AS id FROM json_each(?)
      )
      SELECT hits.type, hits.id, u.handle FROM hits
        JOIN notes n ON hits.type='note' AND n.id=hits.id JOIN users u ON u.id=n.user_id
        WHERE n.deleted_at IS NULL AND ${access.sql}
      UNION ALL
      SELECT hits.type, hits.id, u.handle FROM hits
        JOIN skills n ON hits.type='skill' AND n.id=hits.id JOIN users u ON u.id=n.user_id
        WHERE n.deleted_at IS NULL AND ${access.sql}`)
      .bind(wanted, ...access.args, ...access.args)
      .all<{ type: Kind; id: string; handle: string }>();
    const handles = new Map(rows.results.map(row => [`${row.type}/${row.id}`, row.handle]));
    return hits.flatMap(hit => {
      const ownerHandle = handles.get(`${hit.type}/${hit.id}`);
      return ownerHandle ? [{ ...hit, ownerHandle }] : [];
    });
  }

  async hybrid(
    principal: Principal,
    q: string,
    opts: { mode?: SearchMode; limit?: number; scope?: SearchScope; context?: string | string[] | null; excludeArchived?: boolean; focusFirstQuestion?: boolean; focusJapaneseProse?: boolean } & SearchFilters = {},
  ): Promise<SearchHit[]> {
    const started = Date.now();
    try {
      // opts.mode is accepted and ignored: every mode runs the same keyword lanes.
      const limit = clampLimit(opts.limit, 20);
      const scope = opts.scope ?? "notes";
      // #119: recall passes excludeArchived=true so archived notes drop out of recall
      // candidate generation. notes_search leaves it false → archived notes STAY
      // findable in search (the cold-tier requirement: out of recall, kept in search).
      const filters = searchFilters({ ...opts });
      const excludeArchived = opts.excludeArchived === true || filters.current_only === true;
      // Normalize the caller's context to the SAME canonical form the write path
      // stamped (so an https-clone read matches a git@-clone write). Guard the
      // unset case: a null/empty context means "no scope filter" (see every scope),
      // NOT scope='global' — normalizeScope(null) would wrongly return 'global'.
      const context = normalizeScopes(opts.context);
      // Cap query length so a single unauthenticated read can't drive FTS MATCH
      // with an unbounded input — oversized queries otherwise spend tens of
      // seconds of worker time and 500. ~2k chars covers any real query.
      if (q.length > 2000) q = q.slice(0, 2000);
      const kinds: Kind[] = scope === "all" ? ["note", "skill"] : scope === "skills" ? ["skill"] : ["note"];
      // decision 10: recall (excludeArchived) also drops superseded / out-of-window
      // notes. Stamp `now` once so every lane compares against the same instant.
      const nowMs = now();

      type Lane = { ids: string[]; weight?: number; rankConstant?: number };
      const focus = opts.focusFirstQuestion ? leadingQuestion(q) : null;
      const terms = [...new Set([...lexicalTokens(q), ...(focus ? lexicalTokens(focus) : [])])];
      const synonyms = await this.synonymsFor(principal.anonymous ? '' : principal.userId, terms);
      const lexicalLanes = new Map<Kind, Lane[]>();
      for (const kind of kinds) {
        const specs: Array<{ query: string; match?: string; weight?: number; rankConstant?: number }> = [];
        if (focus) specs.push({ query: focus, rankConstant: 5 });
        const japanese = opts.focusJapaneseProse ? japaneseProseMatch(q) : null;
        if (japanese) specs.push({ query: q, match: japanese, rankConstant: 5 });
        const identifiers = opts.focusJapaneseProse ? identifierMatch(q) : null;
        if (identifiers) specs.push({ query: q, match: identifiers, rankConstant: 5 });
        // Every mode runs the phrase lane: `mode` no longer selects lanes.
        const phrase = ftsPhrase(q);
        if (phrase) specs.push({ query: q, match: phrase, weight: 2 });
        specs.push({ query: q });
        // At most five independent FTS reads at a time, through unchanged
        // ACL/scope/lifecycle SQL. Promise.all observes every failure and retains
        // input order even when the exact/focused/OR lanes finish out of order.
        lexicalLanes.set(kind, await Promise.all(specs.map(async spec => ({
          ids: (await this.fts(kind, principal, spec.query, limit * 3, context, excludeArchived, nowMs, filters, synonyms, spec.match)).map(id => `${kind}:${id}`),
          weight: spec.weight, rankConstant: spec.rankConstant,
        }))));
      }
      const lists: string[][] = [], weights: number[] = [], rankConstants: number[] = [];
      // Preserve the kind/lane insertion order, votes and ties. Timing must
      // never affect RRF ranking or which current rows are hydrated.
      for (const kind of kinds) {
        for (const lane of lexicalLanes.get(kind) || []) {
          if (lane.weight !== undefined) weights[lists.length] = lane.weight;
          if (lane.rankConstant !== undefined) rankConstants[lists.length] = lane.rankConstant;
          lists.push(lane.ids);
        }
      }

      const fused = rrfFuse(lists, 60, weights, rankConstants).slice(0, limit);
      if (!fused.length) return [];
      return await this.hydrate(fused, principal, context, excludeArchived, nowMs, filters);
    } finally { logSlowRead('search', started); }
  }

  private async fts(kind: Kind, principal: Principal, q: string, k: number, context: string[], excludeArchived: boolean, nowMs: number, filters: SearchFilters, synonyms: Map<string, string[]>, matchOverride?: string): Promise<string[]> {
    const match = matchOverride ?? expandedMatch(q, synonyms);
    if (!match) return [];
    const t = TABLE[kind];
    const vis = this.accessClause(kind, principal, context);
    const extra = filterClause(kind, filters, principal);
    const softClause = t.soft ? "n.deleted_at IS NULL AND " : "";
    // Core-memory blocks are kind='block' notes; never surface them in note search.
    const blockClause = kind === "note" ? "n.kind != 'block' AND " : "";
    // #119: recall excludes archived notes; search keeps them. archived_at is a
    // notes-only column, so this is a no-op for skills.
    const archivedClause = excludeArchived && kind === "note" ? "n.archived_at IS NULL AND " : "";
    // decision 10: recall also drops superseded / out-of-validity-window notes.
    // Notes-only columns, gated on the SAME excludeArchived flag (no-op for skills
    // and for plain notes_search). Two `?` bound to nowMs, before vis.args.
    const validity = validityClause(kind, excludeArchived);
    // FTS5's rank cursor uses the SAME weighted BM25 score, but avoids sorting
    // every matching row through SQLite's outer temporary B-tree. Keep all
    // authorization/lifecycle predicates before LIMIT; rank is not authority.
    const sql = `SELECT n.id AS id FROM ${t.fts} f JOIN ${t.table} n ON n.rowid = f.rowid
      WHERE ${t.fts} MATCH ? AND f.rank MATCH 'bm25(5.0, 1.0, 1.0)' AND ${softClause}${blockClause}${archivedClause}${validity.sql}${extra.sql}${vis.sql}
      ORDER BY f.rank LIMIT ?`;
    const started = Date.now();
    const res = await this.db
      .prepare(sql)
      .bind(match, ...validity.args(nowMs), ...extra.args, ...vis.args, k)
      .all<{ id: string }>();
    logSlowRead(kind === 'note' ? 'fts_note' : 'fts_skill', started, res.meta);
    const ids = (res.results ?? []).map((r) => r.id);
    // notes_fts uses trigram tokenization (>=3-char tokens), so 1-2 char queries
    // (the most common JP query length, e.g. 記憶/検索/設計) match nothing in the
    // keyword lane. Fall back to a substring scan for those short queries only.
    if (ids.length === 0 && (q.trim().length === 1 || q.trim().length === 2)) {
      const titleCol = kind === "note" ? "n.title" : "n.name";
      const bodyCol = kind === "note" ? "n.body_md" : "n.description";
      const like = "%" + q.trim().replace(/[%_\\]/g, "\\$&") + "%";
      // No bm25 here, so order title matches first (mirrors the emu-it26 title
      // boost the >=3-char lane gets) then recency — without an ORDER BY the LIKE
      // scan returns arbitrary rowid order and RRF would rank an irrelevant note
      // above an obvious title match.
      const subSql = `SELECT n.id AS id FROM ${t.table} n
        WHERE (${titleCol} LIKE ? ESCAPE '\\' OR ${bodyCol} LIKE ? ESCAPE '\\') AND ${softClause}${blockClause}${archivedClause}${validity.sql}${extra.sql}${vis.sql}
        ORDER BY (CASE WHEN ${titleCol} LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), n.updated_at DESC
        LIMIT ?`;
      const shortStarted = Date.now();
      const subRes = await this.db
        .prepare(subSql)
        .bind(like, like, ...validity.args(nowMs), ...extra.args, ...vis.args, like, k)
        .all<{ id: string }>();
      logSlowRead(kind === 'note' ? 'short_note' : 'short_skill', shortStarted, subRes.meta);
      return (subRes.results ?? []).map((r) => r.id);
    }
    // Design B has no semantic lane, so a query made only of 1–2 character words
    // ("認証 設定", "DB 移行") would find nothing: the trigram MATCH drops them.
    // Match those words as substrings instead, at least two of them, most words first.
    // Once per kind: the phrase lane (matchOverride) would repeat the same scan.
    const terms = ids.length === 0 && !matchOverride ? shortTerms(q) : [];
    if (terms.length) {
      const titleCol = kind === "note" ? "n.title" : "n.name";
      const bodyCol = kind === "note" ? "n.body_md" : "n.description";
      const hit = terms.map(() => `(instr(lower(${titleCol}), lower(?)) > 0 OR instr(lower(${bodyCol}), lower(?)) > 0)`).join(" + ");
      const need = Math.min(2, terms.length);
      const subSql = `SELECT id FROM (SELECT n.id AS id, (${hit}) AS hits, n.updated_at AS u,
          (CASE WHEN ${terms.map(() => `instr(lower(${titleCol}), lower(?)) > 0`).join(" OR ")} THEN 0 ELSE 1 END) AS t
        FROM ${t.table} n WHERE ${softClause}${blockClause}${archivedClause}${validity.sql}${extra.sql}${vis.sql})
        WHERE hits >= ? ORDER BY hits DESC, t, u DESC LIMIT ?`;
      const shortStarted = Date.now();
      const subRes = await this.db
        .prepare(subSql)
        .bind(...terms.flatMap((w) => [w, w]), ...terms, ...validity.args(nowMs), ...extra.args, ...vis.args, need, k)
        .all<{ id: string }>();
      logSlowRead(kind === 'note' ? 'short_words_note' : 'short_words_skill', shortStarted, subRes.meta);
      return (subRes.results ?? []).map((r) => r.id);
    }
    return ids;
  }

  // D1 caps bound variables at 100 per statement; chunk the IN-clause so large
  // result sets (limit can be up to 200) never exceed that and trip a 500.
  private async loadRows(
    ids: string[],
    kind: Kind,
    rows: Map<string, { slug: string; title: string; body: string; user_id: string }>,
    principal: Principal,
    context: string[],
    excludeArchived: boolean,
    nowMs: number,
    filters: SearchFilters,
  ): Promise<void> {
    if (!ids.length) return;
    const cols =
      kind === "note"
        ? "id, slug, title, body_md AS body, user_id"
        : "id, slug, name AS title, description AS body, user_id";
    const table = kind === "note" ? "notes" : "skills";
    const vis = this.accessClause(kind, principal, context), validity = validityClause(kind, excludeArchived);
    const extra = filterClause(kind, filters, principal);
    const block = kind === 'note' ? "n.kind != 'block' AND " : '';
    const archived = kind === 'note' && excludeArchived ? 'n.archived_at IS NULL AND ' : '';
    const args = [...validity.args(nowMs), ...extra.args, ...vis.args], cap = Math.max(1, 90 - args.length);
    // Recheck against the SAME snapshot that reads the body. A candidate lookup
    // can precede a concurrent ownership/scope/expiry change; it is not
    // authority for a later full-source read.
    for (let i = 0; i < ids.length; i += cap) {
      const batch = ids.slice(i, i + cap);
      const ph = batch.map(() => "?").join(",");
      const res = await this.db
        .prepare(`SELECT ${cols} FROM ${table} n WHERE id IN (${ph}) AND n.deleted_at IS NULL AND ${block}${archived}${validity.sql}${extra.sql}${vis.sql}`)
        .bind(...batch, ...args)
        .all<{ id: string; slug: string; title: string; body: string; user_id: string }>();
      for (const r of res.results ?? []) rows.set(`${kind}:${r.id}`, r);
    }
  }

  /** Selected progressive reads apply ALL search predicates in the same SELECT
   * that hydrates current metadata/body. A cursor is a shortlist, not authority. */
  async guidedRows(principal: Principal, refs: Array<{ kind: 'note' | 'skill'; id: string }>, contexts: string[], filters: SearchFilters, details = false): Promise<GuidedMemoryRow[]> {
    if (refs.length > 20 || contexts.length > 20) throw new SearchInputError('guided selection exceeds limit');
    const rows: GuidedMemoryRow[] = [], nowMs = Date.now();
    for (const kind of ['note', 'skill'] as const) {
      const ids = refs.filter(r => r.kind === kind).map(r => r.id); if (!ids.length) continue;
      const vis = this.accessClause(kind, principal, contexts), validity = validityClause(kind, true), extra = filterClause(kind, filters, principal);
      const table = kind === 'note' ? 'notes' : 'skills', body = kind === 'note' ? 'body_md' : 'instructions_md';
      const cols = `n.id,n.slug,${kind === 'note' ? 'n.title' : 'n.name'} AS title,n.scope,n.shared,n.content_hash,n.created_at,n.updated_at,length(n.${body}) AS char_count,${kind === 'note' ? 'n.valid_from,n.valid_until' : 'NULL AS valid_from,NULL AS valid_until'}${details ? ',n.' + body + ' AS body' : ''}`;
      const result = await this.db.prepare(`SELECT ${cols} FROM ${table} n WHERE n.id IN (${ids.map(() => '?').join(',')}) AND n.deleted_at IS NULL AND ${kind === 'note' ? "n.kind!='block' AND n.archived_at IS NULL AND " : ''}${validity.sql}${extra.sql}${vis.sql}`)
        .bind(...ids, ...validity.args(nowMs), ...extra.args, ...vis.args).all<Omit<GuidedMemoryRow, 'kind'>>();
      rows.push(...result.results.map(row => ({ ...row, kind })));
    }
    return refs.flatMap(ref => rows.filter(row => row.kind === ref.kind && row.id === ref.id));
  }

  private async hydrate(
    fused: Array<{ id: string; score: number }>,
    principal: Principal,
    context: string[],
    excludeArchived: boolean,
    nowMs: number,
    filters: SearchFilters,
  ): Promise<SearchHit[]> {
    const started = Date.now();
    try {
      const byKind: Record<Kind, string[]> = { note: [], skill: [] };
      for (const f of fused) {
        const [kind, id] = f.id.split(/:(.+)/) as [Kind, string];
        byKind[kind].push(id);
      }
      const rows = new Map<string, { slug: string; title: string; body: string; user_id: string }>();
      await this.loadRows(byKind.note, "note", rows, principal, context, excludeArchived, nowMs, filters);
      await this.loadRows(byKind.skill, "skill", rows, principal, context, excludeArchived, nowMs, filters);

      const hits: SearchHit[] = [];
      for (const f of fused) {
        const r = rows.get(f.id);
        if (!r) continue;
        const [kind, id] = f.id.split(/:(.+)/) as [Kind, string];
        hits.push({
          type: kind,
          id,
          slug: r.slug,
          title: r.title,
          snippet: snippet(r.body),
          char_count: r.body.length,
          estimated_tokens: estimateTokens(r.body),
          preview_truncated: snippetWasTruncated(r.body),
          score: f.score,
          via: ["fts"],
        });
      }
      return hits;
    } finally { logSlowRead('search_hydration', started); }
  }
}
