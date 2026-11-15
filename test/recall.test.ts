import { describe, expect, it } from "vitest";
import { MAX_RECALL_CANDIDATES, orderBySalience, packContext, type RecallTier, salienceScore } from "../src/recall";

const tiers: RecallTier[] = [
  { tier: "working", label: "Working", items: [{ ref: "core", title: "core", text: "AAAA" }] },
  {
    tier: "archival",
    label: "Archival",
    items: [
      {
        ref: "n1",
        title: "n1",
        text: "B".repeat(40),
        source_chars: 8_000,
        source_tokens: 2_000,
        preview_truncated: true,
        source_type: "note",
      },
      { ref: "n2", title: "n2", text: "C".repeat(40) },
    ],
  },
];

describe("packContext", () => {
  it("includes everything when the budget is large", () => {
    const pack = packContext("q", tiers, 10000);
    expect(pack.included).toHaveLength(3);
    expect(pack.truncated).toBe(0);
    expect(pack.text).toContain("[[core]]");
  });

  it("prioritizes earlier tiers (working memory) under a tight budget", () => {
    // budget admits the tiny working block + one archival note, not both notes
    const pack = packContext("q", tiers, 16);
    expect(pack.included[0].ref).toBe("core");
    expect(pack.truncated).toBeGreaterThanOrEqual(1);
    expect(pack.used).toBeLessThanOrEqual(16);
  });

  it("is deterministic", () => {
    const a = packContext("q", tiers, 20);
    const b = packContext("q", tiers, 20);
    expect(a.text).toBe(b.text);
    expect(a.used).toBe(b.used);
  });

  it("exposes a compact candidate index for both a budget omission and a partial preview", () => {
    const pack = packContext("q", tiers, 16);
    const core = pack.candidates.find((c) => c.ref === "core");
    const n1 = pack.candidates.find((c) => c.ref === "n1");
    expect(core).toMatchObject({ tier: "working", source_type: "note", state: "included", preview_truncated: false });
    expect(n1).toMatchObject({
      tier: "archival",
      source_type: "note",
      state: "omitted_budget",
      source_chars: 8_000,
      source_tokens: 2_000,
      preview_chars: 40,
      preview_truncated: true,
    });
  });

  it("bounds the metadata index separately and reports when candidates were not listed", () => {
    const many: RecallTier[] = [{
      tier: "working",
      label: "Working",
      items: Array.from({ length: MAX_RECALL_CANDIDATES + 1 }, (_, i) => ({ ref: `b-${i}`, title: `b-${i}`, text: "x", source_type: "memory_block" as const })),
    }];
    const pack = packContext("q", many, 10_000);
    expect(pack.candidates).toHaveLength(MAX_RECALL_CANDIDATES);
    expect(pack.candidate_index_truncated).toBe(1);
  });
});

describe("salienceScore", () => {
  it("collapses to relevance-only when importance and recency are uniform (backward compatible)", () => {
    // relMin==relMax guards relN to 1; zero views/stage, zero age → 0.6 + 0 + 0.15
    expect(salienceScore({ relevance: 5, views: 0, stage: 0, ageMs: 0 }, 5, 5)).toBeCloseTo(0.75, 6);
  });

  it("rewards usage frequency and curation maturity, and penalizes staleness", () => {
    const base = { relevance: 1, views: 0, stage: 0, ageMs: 0 };
    expect(salienceScore({ ...base, views: 1000 }, 0, 1)).toBeGreaterThan(salienceScore(base, 0, 1));
    expect(salienceScore({ ...base, stage: 2 }, 0, 1)).toBeGreaterThan(salienceScore(base, 0, 1));
    expect(salienceScore({ ...base, ageMs: 90 * 86_400_000 }, 0, 1)).toBeLessThan(salienceScore(base, 0, 1));
  });

  it("clamps out-of-range inputs (negative views/age, stage>2) without NaN", () => {
    const s = salienceScore({ relevance: 0.5, views: -5, stage: 9, ageMs: -1000 }, 0, 1);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("orderBySalience", () => {
  const cand = (ref: string, relevance: number, extra: Partial<{ views: number; stage: number; ageMs: number }> = {}) => ({ ref, relevance, views: 0, stage: 0, ageMs: 0, ...extra });

  it("returns a copy for 0- or 1-element pools (no throw, no mutation)", () => {
    expect(orderBySalience([])).toEqual([]);
    const one = [cand("solo", 0.5)];
    const out = orderBySalience(one);
    expect(out).toEqual(one);
    expect(out).not.toBe(one);
  });

  it("collapses to relevance order (desc) when views/stage/age are uniform", () => {
    const out = orderBySalience([cand("a", 0.3), cand("b", 0.9), cand("c", 0.6)]);
    expect(out.map((c) => c.ref)).toEqual(["b", "c", "a"]);
  });

  it("lets a heavily-used note overtake a marginally-more-relevant, unused one", () => {
    // a/d anchor the relevance min/max; b and c are a near-tie in relevance
    const out = orderBySalience([
      cand("a", 1.0),
      cand("b", 0.52), // slightly more relevant, unused
      cand("c", 0.5, { views: 100000 }), // slightly less relevant, heavily used
      cand("d", 0.0),
    ]);
    expect(out.map((c) => c.ref)).toEqual(["a", "c", "b", "d"]); // c overtakes b
  });

  it("breaks genuine relevance ties by recency, newest first", () => {
    const out = orderBySalience([
      cand("old", 0.5, { ageMs: 60 * 86_400_000 }),
      cand("new", 0.5, { ageMs: 0 }),
    ]);
    expect(out.map((c) => c.ref)).toEqual(["new", "old"]);
  });

  it("is deterministic and does not mutate its input", () => {
    const input = [cand("x", 0.2, { views: 10 }), cand("y", 0.8), cand("z", 0.5, { stage: 2 })];
    const snapshot = input.map((c) => c.ref);
    const a = orderBySalience(input).map((c) => c.ref);
    const b = orderBySalience(input).map((c) => c.ref);
    expect(a).toEqual(b);
    expect(input.map((c) => c.ref)).toEqual(snapshot); // input untouched
  });
});
