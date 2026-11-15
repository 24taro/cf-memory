import { describe, expect, it } from "vitest";
import { slugify, slugifyPath } from "../src/slug";

describe("slugifyPath", () => {
  it("preserves one-level namespaces, slugifying each segment", () => {
    expect(slugifyPath("Mnemo/About Page")).toBe("mnemo/about-page");
  });
  it("drops empty/garbage segments", () => {
    expect(slugifyPath("a//b/")).toBe("a/b");
    expect(slugifyPath("!!!")).toBe("untitled");
  });
  it("matches slugify for a single segment", () => {
    expect(slugifyPath("Hello World")).toBe("hello-world");
  });
  it("clamps deeper paths to one namespace level", () => {
    expect(slugifyPath("a/b/c/d")).toBe("a/b-c-d");
  });
  it("remaps the route-reserved 'edit' leaf", () => {
    expect(slugifyPath("ns/edit")).toBe("ns/edit-note");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
  it("collapses and trims separators", () => {
    expect(slugify("  a -- b  ")).toBe("a-b");
  });
  it("keeps Japanese characters", () => {
    expect(slugify("メモの設計")).toBe("メモの設計");
  });
  it("falls back to 'untitled' when empty", () => {
    expect(slugify("!!!")).toBe("untitled");
  });
});
