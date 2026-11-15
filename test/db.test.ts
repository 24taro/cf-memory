import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/db";

describe("estimateTokens", () => {
  it("keeps ASCII at len/4 (no regression)", () => {
    // "hello world" is 11 chars -> ceil(11/4) = 3
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("AAAA")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("counts CJK at ~1 token/char and beats the old len/4 estimate", () => {
    const ja = "記憶検索の設計"; // 7 CJK chars
    expect(estimateTokens(ja)).toBe(7);
    // the old heuristic would have undercounted at ceil(7/4) = 2
    expect(estimateTokens(ja)).toBeGreaterThan(Math.ceil(ja.length / 4));
    // kana + full-width punctuation also count as CJK
    expect(estimateTokens("こんにちは、世界")).toBe(8);
  });

  it("sums CJK and ASCII buckets for mixed JA+EN text", () => {
    // "記憶 recall" -> 2 CJK chars + " recall" (7 ASCII chars -> ceil(7/4) = 2)
    expect(estimateTokens("記憶 recall")).toBe(2 + Math.ceil(" recall".length / 4));
  });
});
