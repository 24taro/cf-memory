import { sha256hex } from './db';
import { parseDeletionGuard } from './guards';
import type { SupersessionGuard } from './types';
import { scrubText } from '../cf-memory-agent/scripts/redact.mjs';

export interface RetractionProvenance {
  source_event_ids: string[];
  generated_by: string;
  confidence: number;
  rationale: string;
}
export function retractionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('invalid retraction_id');
  return value;
}
export function retractionTarget(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 80) throw Error('invalid retraction target');
  return value;
}
export function retractionProvenance(input: unknown): RetractionProvenance {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid retraction provenance');
  const p = input as Record<string, unknown>;
  if (Object.keys(p).some(k => !['source_event_ids','generated_by','confidence','rationale'].includes(k)) ||
      !Array.isArray(p.source_event_ids) || !p.source_event_ids.length || p.source_event_ids.length > 8 ||
      p.source_event_ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      typeof p.generated_by !== 'string' || !/^cf-memory-agent\/(subscription|anthropic-api|gemini|openrouter)(\/review-v[1-9][0-9]{0,2})?$/.test(p.generated_by) ||
      typeof p.confidence !== 'number' || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1 ||
      typeof p.rationale !== 'string' || !p.rationale.trim() || p.rationale.length > 500 ||
      scrubText(p.rationale) !== p.rationale || /\[REDACTED|\[DENIED PATH\]/.test(p.rationale))
    throw Error('invalid retraction provenance');
  return { source_event_ids: [...new Set(p.source_event_ids as string[])].sort(), generated_by: p.generated_by,
    confidence: p.confidence, rationale: p.rationale.trim() };
}
export function parseRetraction(args: Record<string, unknown>) {
  if (Object.keys(args).some(k => !['id','deletion_guard','provenance','retraction_id'].includes(k))) throw Error('invalid retraction request');
  const id = retractionTarget(args.id), operationId = retractionId(args.retraction_id);
  const guard = parseDeletionGuard(args.deletion_guard), provenance = retractionProvenance(args.provenance);
  if (guard.id !== id || args.slug !== undefined) throw Error('invalid retraction target');
  return { id, operationId, guard, provenance };
}
export const retractionEventId = (userId: string, operationId: string) => sha256hex(JSON.stringify(['note-retraction-v1',userId,operationId]));
export const retractionRequestHash = (id: string, guard: SupersessionGuard, provenance: RetractionProvenance) =>
  sha256hex(JSON.stringify({ id, deletion_guard: guard, provenance }));
