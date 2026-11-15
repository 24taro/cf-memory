// Slow-read diagnostics contain only fixed operation names and numeric timings.
// Never pass SQL, bindings, queries, principals, scopes, rows or exception text.
const operations = new Set(['fts_note', 'fts_skill', 'short_note', 'short_skill', 'recall', 'recall_views',
  'search', 'search_synonyms', 'search_hydration', 'log_search', 'log_sessions']);
const stages = ['working_ms', 'notes_ms', 'skills_hydration_ms', 'pack_views_ms'] as const;
export type RecallTimings = Partial<Record<typeof stages[number], number>>;
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value * 100) / 100 : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Whitelist each field; even unexpected backend metadata cannot reach logs. */
export function slowReadTiming(operation: string, elapsed: number, meta?: unknown, timings?: RecallTimings): Record<string, string | number> | undefined {
  const wall = numeric(elapsed);
  if (!operations.has(operation) || wall === undefined || wall < 500) return;
  const out: Record<string, string | number> = { event: 'cf_memory_slow_read', operation, wall_ms: wall };
  const source = object(meta), sql = numeric(object(source.timings).sql_duration_ms) ?? numeric(source.duration);
  if (sql !== undefined) out.sql_ms = sql;
  for (const key of ['rows_read', 'total_attempts'] as const) {
    const value = numeric(source[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of stages) {
    const value = numeric(timings?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
export function logSlowRead(operation: string, started: number, meta?: unknown, timings?: RecallTimings): void {
  const metric = slowReadTiming(operation, Date.now() - started, meta, timings);
  if (metric) console.info(JSON.stringify(metric));
}
