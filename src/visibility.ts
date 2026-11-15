// Single source of truth for read authorization on a note/skill row. Pure +
// unit-tested so the ownership predicate can never silently regress.
// The public/unlisted/private visibility axis was RETIRED 2026-07-17
// (DESIGN.md decision 9).
//
// 2026-08-20: a second readable set appeared — shared rows. A row is readable if
// it is YOURS (user_id = you) or if it is SHARED (shared = 1). cf-memory is
// invite-only and does not divide permissions among the invited, so "invited" is
// the whole membership test and it was already answered by the time a principal
// exists — which is why sharing needs no group, no membership table, and nothing
// to create when a new project or a new person appears.
//
// This file is the only place the shared OR is written. Every SQL read site
// calls readableSql() rather than spelling out `user_id = ?`, so widening
// visibility is one edit and one mutation target, not fifteen.

import type { Principal } from "./types";

export interface ReadableRow {
  user_id: string;
  shared?: number | boolean | null;
  deleted_at?: number | null;
}

/** An authenticated caller reads their own live rows, plus anything in a shared
 * space. Anonymous callers — including a signed-in person cf-memory has no row for
 * — read nothing. */
export function isReadable(row: ReadableRow, principal: Principal): boolean {
  if (row.deleted_at) return false;
  if (principal.anonymous) return false;
  if (row.shared) return true;
  return row.user_id === principal.userId;
}

/** The SQL form of isReadable, for filtering in the query rather than after it.
 *
 * `alias` is the table alias carrying the columns ("n", "src", or "" for an
 * unaliased table). Returns a parenthesised clause plus its bind args, so a
 * caller can AND it into any WHERE without worrying about precedence.
 *
 * Anonymous yields `1=0` rather than an error: the discovery doors return empty
 * and the web door has already redirected or refused. */
export function readableSql(alias: string, principal: Principal): { sql: string; args: unknown[] } {
  return readableSqlFor(alias, principal.anonymous ? "anonymous" : principal.userId);
}

/** readableSql for the call sites that carry a bare viewer id rather than a
 * Principal (the link/graph queries). "anonymous" is the sentinel those sites
 * already used for "no viewer". Produces exactly one bind arg when there is a
 * viewer and none when there is not — same shape the hand-written clauses had,
 * so an existing arg push keeps its position. */
export function readableSqlFor(alias: string, viewerId: string): { sql: string; args: unknown[] } {
  if (!viewerId || viewerId === "anonymous") return { sql: "1=0", args: [] };
  const c = alias ? `${alias}.` : "";
  return { sql: `(${c}shared = 1 OR ${c}user_id = ?)`, args: [viewerId] };
}
