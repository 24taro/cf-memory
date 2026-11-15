// Context-scoped memory (issue #117): a memory's `scope` is a per-PROJECT
// relevance axis — the client-resolved `repo ?? workdir ?? 'global'`. It is NOT
// access control (that's owner/visibility; #115 removed the old team `workspace`).
// recall/search pre-filter to `scope IN (<current>, 'global')`.
//
// `normalizeScope` collapses the many spellings of one git remote to a single
// canonical `host/path` so exact-match filtering doesn't split (an https clone
// and an ssh clone of the same repo MUST produce the same scope), and refuses to
// invent a scope for anything that is not a remote — a workdir path or a bare
// label becomes 'global'.
//
// Using the REMOTE rather than the path also collapses copies for free: three
// checkouts of the same repo, or the same project cloned under two parent
// directories, are one scope instead of three.

import { normalizeScope } from '../cf-memory-agent/scripts/scope.mjs';
export { normalizeScope };
const GLOBAL = 'global';

/** 複数の scope を受け取って正規化する。
 *
 * 親ディレクトリで作業しているとき(このリポジトリ群がまさにそう: ~/work/acme は
 * git ではなく、子に auth / cf-memory / search / tasks がある)、クライアントは子の
 * remote をまとめて送る。いるディレクトリが、欲しい広さをそのまま表す —— 深く入れば
 * 狭く、上がれば広く。別名表を持たずに複数リポジトリのプロダクトを扱えるのは、
 * この形にしたおかげ。
 *
 * 'global' に落ちた値は捨てる。混ぜても `IN (…, 'global')` が常に含むので意味が無く、
 * 「global を送ったら全部出る」という誤解の元になる。
 */
export function normalizeScopes(raw: string | string[] | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(/[\s,]+/) : [];
  const out = new Set<string>();
  for (const r of list) {
    const s = normalizeScope(r);
    if (s && s !== GLOBAL) out.add(s);
  }
  return [...out];
}

/** 絞り込み条件。scope が空なら条件を足さない(= 全部見る)。
 *
 * `IN (…, 'global')` の 'global' は必ず含める。外すと、どこにも属さない汎用知識が
 * プロジェクト作業中に一切出なくなる —— mem0 で知られた null-scoping の落とし穴で、
 * `scope = ?` と書いた瞬間に踏む。 */
export function scopeClause(alias: string, scopes: string[]): { sql: string; args: unknown[] } {
  if (!scopes.length) return { sql: "", args: [] };
  const c = alias ? `${alias}.` : "";
  return { sql: ` AND ${c}scope IN (${scopes.map(() => "?").join(",")}, '${GLOBAL}')`, args: [...scopes] };
}
