import { sha256hex } from './db';
import { parseUpdateGuard } from './guards';
import { retractionProvenance, type RetractionProvenance } from './retraction';
import { slugifyPath } from './slug';
import type { SupersessionGuard } from './types';
import { markedPrivate, scrub, scrubText } from '../cf-memory-agent/scripts/redact.mjs';

export type AppendProvenance = RetractionProvenance;
// Use the same bounded decoded-JSON/private/credential rules as Capture;
// never introduce a weaker or divergent interpretation for durable append.
export function appendContentUnsafe(value: unknown): boolean {
  return markedPrivate(value) || JSON.stringify(scrub(value)) !== JSON.stringify(value);
}
export function appendId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('invalid append_id');
  return value;
}
export function parseAppend(args: Record<string, unknown>) {
  if (Object.keys(args).some(k => !['slug','text','append_id','append_guard','provenance','expected_content_hash'].includes(k)) ||
      typeof args.slug !== 'string' || !args.slug.trim() || slugifyPath(args.slug) !== args.slug ||
      typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000 ||
      scrubText(args.text) !== args.text || appendContentUnsafe(args.text) || /\[REDACTED|\[DENIED|\[TRUNCATED/.test(args.text))
    throw Error('invalid guarded append');
  let guard: SupersessionGuard, provenance: AppendProvenance;
  try { guard = parseUpdateGuard(args.append_guard); } catch { throw Error('invalid append_guard'); }
  try { provenance = retractionProvenance(args.provenance); } catch { throw Error('invalid append provenance'); }
  if (appendContentUnsafe(provenance.rationale)) throw Error('invalid append provenance');
  if (args.expected_content_hash !== undefined && args.expected_content_hash !== guard.content_hash)
    throw Error('append hash does not match append_guard');
  return { slug: args.slug, text: args.text, operationId: appendId(args.append_id), guard, provenance };
}
export const appendEventId = (userId: string, operationId: string) => sha256hex(JSON.stringify(['note-append-v1',userId,operationId]));
export const appendRequestHash = (slug: string, text: string, guard: SupersessionGuard, provenance: AppendProvenance) =>
  sha256hex(JSON.stringify({slug,text,append_guard:guard,provenance}));
