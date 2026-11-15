import { describe, expect, it } from "vitest";
import { applyBlockOp, BlockFullError, DEFAULT_MEMORY_CHAR_LIMIT, resolveCharLimit } from "../src/memory";

describe("applyBlockOp", () => {
  it("set overwrites", () => {
    expect(applyBlockOp("old", { op: "set", value: "new" })).toBe("new");
  });
  it("append joins with a newline", () => {
    expect(applyBlockOp("a", { op: "append", value: "b" })).toBe("a\nb");
    expect(applyBlockOp("", { op: "append", value: "b" })).toBe("b");
  });
  it("replace with an EMPTY (non-null) find is a NO-OP, not a per-character interleave (finding #4 — no silent core-memory corruption)", () => {
    // String.split("") splits between every char, so join(value) would interleave
    // `value` into the block ('name: bob' → 'nXaXmX...') and destroy persistent
    // core-memory. The documented "no match = silent no-op" contract must hold for "".
    expect(applyBlockOp("name: bob", { op: "replace", value: "X", replaceTarget: "" })).toBe("name: bob");
    // null replaceTarget still means whole-block set (memory_set semantics) — unchanged
    expect(applyBlockOp("name: bob", { op: "replace", value: "whole" })).toBe("whole");
  });
  it("replace swaps a substring", () => {
    expect(applyBlockOp("name: bob", { op: "replace", value: "alice", replaceTarget: "bob" })).toBe("name: alice");
  });
  it("REJECTS (BlockFullError) instead of silently truncating when the result would exceed the char limit (P0 forcing-function)", () => {
    expect(() => applyBlockOp("", { op: "set", value: "x".repeat(50), charLimit: 10 })).toThrow(BlockFullError);
    // the error carries the sizes so the caller/agent can react
    try {
      applyBlockOp("a".repeat(8), { op: "append", value: "b".repeat(8), charLimit: 10 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BlockFullError);
      expect((e as BlockFullError).limit).toBe(10);
      expect((e as BlockFullError).length).toBe(17); // "a"*8 + "\n" + "b"*8
    }
  });
  it("does NOT throw when the result fits within the limit (or the limit is null/0)", () => {
    expect(applyBlockOp("", { op: "set", value: "x".repeat(10), charLimit: 10 })).toHaveLength(10);
    expect(applyBlockOp("hi", { op: "append", value: "there", charLimit: null })).toBe("hi\nthere");
  });
});

describe("resolveCharLimit (issue #31)", () => {
  it("an explicit charLimit always wins, even null (explicitly unlimited)", () => {
    expect(resolveCharLimit(10, { char_limit: 500 })).toBe(10);
    expect(resolveCharLimit(null, { char_limit: 500 })).toBeNull();
    expect(resolveCharLimit(10, null)).toBe(10);
  });
  it("a brand-new block (no existing row) falls back to the default when charLimit is omitted", () => {
    expect(resolveCharLimit(undefined, null)).toBe(DEFAULT_MEMORY_CHAR_LIMIT);
    expect(resolveCharLimit(undefined, undefined)).toBe(DEFAULT_MEMORY_CHAR_LIMIT);
  });
  it("an EXISTING block keeps its own established limit when charLimit is omitted, even if that limit is null (no retroactive tightening of an already-created block like 'profile')", () => {
    expect(resolveCharLimit(undefined, { char_limit: null })).toBeNull();
    expect(resolveCharLimit(undefined, { char_limit: 800 })).toBe(800);
  });
  it("a brand-new block whose omitted-limit default would be exceeded is REJECTED (not truncated to the default)", () => {
    const value = "x".repeat(DEFAULT_MEMORY_CHAR_LIMIT + 500);
    const limit = resolveCharLimit(undefined, null); // 3000 (DEFAULT_MEMORY_CHAR_LIMIT)
    expect(() => applyBlockOp("", { op: "set", value, charLimit: limit })).toThrow(BlockFullError);
  });
});
