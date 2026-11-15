// issue #69: recall() now returns a structured, server-side tiered grouping
// (`RecallPack.sections`, built in src/recall.ts's packContext() from the same
// `keep` set that drives `pack.text`) instead of us re-parsing the rendered
// `pack.text` markdown back into groups. The exact 4 tier labels recall() can
// emit, in fixed order (see src/services.ts's RecallService.recall()), are:
// "Working memory (core blocks)", `Relevant notes for "<q>"` / "Recent notes",
// "Relevant skills", "Ambient (evergreen)".
//
// This module maps that structured grouping into the /preview page's
// view-model (`RecallSection[]`), translating each raw English tier label to
// its Japanese display name. Unlike the old line-based `pack.text` re-parser
// (issue #56's MVP, now removed), this is robust to item bodies whose own text
// contains a line starting with "## " or "### " -- such text can no longer be
// mistaken for a tier heading, because grouping is carried by structure, not
// re-derived from markdown.

import type { RecallTier } from "../recall";

export interface RecallSectionItem {
  /** Item ref (slug or block/skill label). */
  ref: string;
  title: string;
  text: string;
  /** Handle of the member who owns it, when that is not the viewer. */
  sharedBy?: string;
  /** Handle of the member who last wrote its text, when that is not the owner
   * (for the viewer's own note: a teammate wrote into it). */
  editedBy?: string;
}

export interface RecallSection {
  /** The raw English tier label, straight from `RecallTier.label`. */
  rawLabel: string;
  /** The Japanese display label (or the raw label itself, for any
   * unrecognized/future tier -- mirrors web/pages.tsx's `X_LABEL[x] ?? x`
   * fallback convention used throughout this file). */
  label: string;
  items: RecallSectionItem[];
}

/** Maps a raw tier label (from src/services.ts's `tiers` array / a
 * `RecallTier.label`) to its Japanese display label. Falls back to the raw
 * label for any tier not in this fixed, currently-known set. */
export function tierLabelFor(rawLabel: string): string {
  if (rawLabel === "Working memory (core blocks)") return "作業メモリ";
  if (rawLabel.startsWith('Relevant notes for "') || rawLabel === "Recent notes") return "保存済み知識";
  if (rawLabel === "Relevant skills") return "手順";
  if (rawLabel === "Ambient (evergreen)") return "定着した周辺情報";
  return rawLabel;
}

/** Pure mapper: `RecallPack.sections` (the structured, server-side tiered
 * grouping from src/recall.ts's packContext()) -> the /preview page's
 * view-model. Preserves tier order and per-item order exactly, translating
 * each raw tier label to its Japanese display name. Robust by construction:
 * grouping is carried by structure, so an item body containing a "## "/"### "
 * line can never be misread as a tier heading (the failure mode of the removed
 * `pack.text` re-parser, issue #69). */
export function toRecallSections(sections: RecallTier[]): RecallSection[] {
  return sections.map((s) => ({
    rawLabel: s.label,
    label: tierLabelFor(s.label),
    items: s.items.map((i) => ({ ref: i.ref, title: i.title, text: i.text, ...(i.shared_by === undefined ? {} : { sharedBy: i.shared_by }), ...(i.edited_by === undefined ? {} : { editedBy: i.edited_by }) })),
  }));
}
