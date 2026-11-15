import { normalizeScope } from './context';
import type { SupersessionGuard } from './types';

export function parseSupersessionGuard(value: unknown): SupersessionGuard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid supersedes_guard');
  const g = value as Record<string, unknown>;
  if (Object.keys(g).some(k => !['id','content_hash','scope','shared','updated_at','provenance_count'].includes(k)) ||
      typeof g.id !== 'string' || !g.id.length || g.id.length > 80 ||
      typeof g.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(g.content_hash) ||
      typeof g.scope !== 'string' || g.scope.length > 500 || normalizeScope(g.scope) !== g.scope ||
      typeof g.shared !== 'boolean' || typeof g.updated_at !== 'number' || !Number.isSafeInteger(g.updated_at) || g.updated_at < 0 ||
      typeof g.provenance_count !== 'number' || !Number.isSafeInteger(g.provenance_count) || g.provenance_count < 0)
    throw new Error('invalid supersedes_guard');
  return { id: g.id, content_hash: g.content_hash, scope: g.scope, shared: g.shared, updated_at: g.updated_at, provenance_count: g.provenance_count };
}

export function parseDeletionGuard(value: unknown): SupersessionGuard {
  try { return parseSupersessionGuard(value); }
  catch { throw new Error('invalid deletion_guard'); }
}

export function parseUpdateGuard(value: unknown): SupersessionGuard {
  try { return parseSupersessionGuard(value); }
  catch { throw new Error('invalid update_guard'); }
}

