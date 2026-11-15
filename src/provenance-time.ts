// Read-only presentation of already-authorized provenance. Numeric metadata and
// source snapshots remain unchanged; no file/stat/query or observation inference.
import {provenanceTimeFormatter} from '../cf-memory-agent/scripts/time-zone.mjs';
export interface ProvenanceClockRow {
  event_id: string; source_session_id: string; actor_id: string; relation: string;
  created_at: unknown; source: unknown;
}
const LAST_MS = 253402300799999; // Last four-digit ISO year, inclusive.
function date(value: unknown): Date | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= LAST_MS
    ? new Date(value) : null;
}
export function createProvenanceTimePresentation(value: unknown = 'UTC') {
  const formatter = provenanceTimeFormatter(value);
  const timeZone = formatter.resolvedOptions().timeZone;
  const render = (epoch: unknown) => {
    const d = date(epoch);
    if (!d) return {utc_iso:null,local:null};
    const parts = Object.fromEntries(formatter.formatToParts(d).map(p=>[p.type,p.value]));
    // Offset seconds matter for historical IANA rules (e.g. Monrovia1970).
    // Local civil time is structured, never mislabeled as RFC3339 with a
    // silently rounded offset or an ambiguous bare repeated DST hour.
    const offset = /^(?:GMT|UTC)(?:([+-])(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(parts.timeZoneName);
    const offsetSeconds = offset ? (offset[1]==='-'?-1:1)*
      (Number(offset[2]||0)*3600+Number(offset[3]||0)*60+Number(offset[4]||0)) : null;
    const local = offsetSeconds!==null && /^\d{4}$/.test(parts.year) &&
      ['month','day','hour','minute','second'].every(k=>/^\d{2}$/.test(parts[k]))
      ? {date_time:`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(d.getUTCMilliseconds()).padStart(3,'0')}`,
          time_zone:timeZone,utc_offset_seconds:offsetSeconds} : null;
    return {utc_iso:d.toISOString(),local};
  };
  return {
    time_zone:timeZone,
    project(rows: readonly ProvenanceClockRow[]) {
      return {time_zone:timeZone,for_returned_provenance_only:true,entries:rows.map(row=>{
        const source = row.source && typeof row.source==='object' && !Array.isArray(row.source)
          ? row.source as Record<string,unknown> : {};
        const sourceTime = render(source.occurred_at);
        return {event_id:row.event_id,source_session_id:row.source_session_id,actor_id:row.actor_id,relation:row.relation,
          source_time:{...sourceTime,basis:source.imported===true||source.imported===1?'imported_claim'
            :sourceTime.utc_iso===null?'unknown':'recorded_source_event'},
          provenance_created_at:render(row.created_at)};
      })};
    },
  };
}
export type ProvenanceTimePresentation = ReturnType<typeof createProvenanceTimePresentation>;
export const PROVENANCE_TIME_DESCRIPTION = ' Optional time_zone (IANA name, default UTC) formats provenance_time_display for each returned event. Source time is recorded Capture-event metadata, not file mtime, proof of execution or when a fact became true; provenance_created_at is a separate record time. Imported times remain unverified claims. Null means unknown. Copy the rendered date/time and its zone/offset; do not guess a local date from an epoch. Original provenance, numeric times, hashes and guards are unchanged.';
