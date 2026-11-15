import { describe, expect, it, vi } from 'vitest';
import { slowReadTiming } from '../src/read-timing';
import { LogService } from '../src/logs';
import { principalFixture } from './helpers';

describe('slow read telemetry privacy', () => {
  it('whitelists numeric fields and fixed names even when metadata contains private data', () => {
    const source = { duration: 123, rows_read: 4000, total_attempts: 2, query: 'private query',
      results: [{ token: 'private value' }], served_by_region: 'private region',
      timings: { sql_duration_ms: 121.123, sql: 'private SQL' } };
    expect(slowReadTiming('fts_note', 650.556, source)).toEqual({ event: 'cf_memory_slow_read',
      operation: 'fts_note', wall_ms: 650.56, sql_ms: 121.12, rows_read: 4000, total_attempts: 2 });
    expect(slowReadTiming('private operation', 1000, source)).toBeUndefined();
  });
  it('never serializes malformed numeric fields or arbitrary phase keys', () => {
    expect(slowReadTiming('recall', 900, { duration: 'token', rows_read: Infinity, total_attempts: -1 },
      { notes_ms: 600, working_ms: NaN, ...{ secret: 'private value' } }))
      .toEqual({ event: 'cf_memory_slow_read', operation: 'recall', wall_ms: 900, notes_ms: 600 });
  });
  it('omits fast reads and invalid elapsed times', () => {
    for (const elapsed of [0, 499, -1, NaN, Infinity]) expect(slowReadTiming('recall', elapsed)).toBeUndefined();
    expect(slowReadTiming('fts_skill', 500, null)).toEqual({ event: 'cf_memory_slow_read', operation: 'fts_skill', wall_ms: 500 });
  });
  it('records deferred view latency without accepting arbitrary context', () => {
    expect(slowReadTiming('recall_views', 4200, { principal: 'private actor', ids: ['private note'], duration: 4 }))
      .toEqual({ event: 'cf_memory_slow_read', operation: 'recall_views', wall_ms: 4200, sql_ms: 4 });
  });
  it('retains only fixed numeric diagnostics for each newly observed search stage', () => {
    for (const operation of ['search', 'search_synonyms', 'search_hydration', 'log_search', 'log_sessions']) {
      expect(slowReadTiming(operation, 800, { duration: 3, rows_read: 5, query: 'private', embedding: [1, 2], token: 'private' }))
        .toEqual({ event: 'cf_memory_slow_read', operation, wall_ms: 800, sql_ms: 3, rows_read: 5 });
    }
  });
  it('removed vector stages are no longer accepted operation names', () => {
    for (const operation of ['vector_scan_note', 'vector_query', 'vector_health']) expect(slowReadTiming(operation, 800, { duration: 3 })).toBeUndefined();
  });
  it('observes a rejected log search without logging its private error or hiding failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const failure = new Error('private SQL and bindings');
    const db = { prepare: () => ({ bind: () => ({ all: async () => { vi.setSystemTime(700); throw failure; } }) }) } as unknown as D1Database;
    try {
      await expect(new LogService(db).search(principalFixture({ userId: 'private actor' }), { query: 'private query' })).rejects.toBe(failure);
      expect(info.mock.calls).toEqual([[JSON.stringify({ event: 'cf_memory_slow_read', operation: 'log_search', wall_ms: 700 })]]);
    } finally { info.mockRestore(); vi.useRealTimers(); }
  });
});
