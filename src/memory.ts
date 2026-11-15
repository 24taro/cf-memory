// Core-memory blocks (MemGPT/Letta-style working memory) are just pinned,
// char-limited notes in the SAME store — one substrate. The mutation op is pure
// and unit-tested; persistence lives in services.ts.

export type BlockOp = "set" | "append" | "replace";

export interface BlockOpInput {
  op: BlockOp;
  value: string;
  charLimit?: number | null;
  replaceTarget?: string;
}

// mnemo's "memory" tier is a short, char-limited inbox — but cf-memory shipped with
// no default, so an omitted char_limit meant unlimited growth (issue #31). This
// only backstops BRAND-NEW blocks; an existing block (even one whose char_limit
// happens to be null) keeps its own established limit, so this never retroactively
// tightens an already-created block like a long-lived "profile" block.
// Raised 2000 -> 3000 (2026-07) once block overflow became a hard reject (the
// forcing-function below) rather than a silent truncation: a slightly roomier
// default lowers how often ordinary blocks hit block_full, while overflow is now
// a safe, actionable event instead of silent data loss.
export const DEFAULT_MEMORY_CHAR_LIMIT = 3000;

// Forcing-function on overflow (memory-compression research, P0): a block write
// whose result exceeds char_limit is REJECTED with this typed error instead of
// being silently `.slice()`-truncated. Surfaced to the agent as a machine-readable
// `block_full` so it self-corrects (condense via memory_replace, raise char_limit,
// or archive to a note) rather than losing the tail without knowing. `label` is
// filled in by the caller (applyBlockOp doesn't have it).
export class BlockFullError extends Error {
  constructor(
    readonly length: number,
    readonly limit: number,
    readonly label?: string,
  ) {
    super(`block full: ${length} chars exceeds the ${limit}-char limit${label ? ` for block '${label}'` : ""}`);
    this.name = "BlockFullError";
  }
}

export function resolveCharLimit(charLimit: number | null | undefined, existing: { char_limit: number | null } | null | undefined): number | null {
  if (charLimit !== undefined) return charLimit;
  if (existing) return existing.char_limit;
  return DEFAULT_MEMORY_CHAR_LIMIT;
}

export function applyBlockOp(current: string, input: BlockOpInput): string {
  const { op, value, charLimit, replaceTarget } = input;
  let next: string;
  switch (op) {
    case "set":
      next = value;
      break;
    case "append":
      next = current ? `${current}\n${value}` : value;
      break;
    case "replace":
      // replaceTarget == null → whole-block set (memory_set semantics). An EMPTY
      // (but non-null) find is degenerate: String.split("") splits between every
      // character, so join(value) would interleave `value` into the block and
      // silently corrupt persistent core-memory (or overflow the char limit).
      // Per the documented "no match = silent no-op" contract, treat "" as a no-op.
      next = replaceTarget == null ? value : replaceTarget === "" ? current : current.split(replaceTarget).join(value);
      break;
    default:
      next = current;
  }
  if (charLimit != null && charLimit > 0 && next.length > charLimit) {
    // Forcing-function (P0): reject instead of silently truncating, so the agent
    // distills/archives rather than losing the tail unknowingly.
    throw new BlockFullError(next.length, charLimit);
  }
  return next;
}
