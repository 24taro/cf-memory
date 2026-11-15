// Read-only reuse of the shipped Agent helper, without modifying its immutable package.
declare module '*memory-echo.mjs' {
  export function isMemoryEcho(event: unknown): boolean;
}
declare module '*time-zone.mjs' {
  export function provenanceTimeFormatter(value?: unknown): Intl.DateTimeFormat;
}
declare module '*novelty-target.mjs' {
  export function noveltyTarget(row: unknown, identity: { user_id: string }, candidateShared?: boolean): {
    memory_kind: 'note' | 'skill'; id: string; user_id: string; title: string;
    body_md: string; content_hash: string; scope: string; shared: boolean;
  } | null;
}
