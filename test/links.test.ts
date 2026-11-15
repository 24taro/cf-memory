import { describe, expect, it } from "vitest";
import { parseWikilinks, uniqueTargets } from "../src/links";

describe("parseWikilinks", () => {
  it("extracts a basic [[slug]]", () => {
    const m = parseWikilinks("see [[other note]] here");
    expect(m).toHaveLength(1);
    expect(m[0].targetSlug).toBe("other-note");
    expect(m[0].kind).toBe("wikilink");
    expect(m[0].anchorText).toBeNull();
  });

  it("supports [[slug|anchor]]", () => {
    const m = parseWikilinks("[[deep-work|Deep Work]]");
    expect(m[0].targetSlug).toBe("deep-work");
    expect(m[0].anchorText).toBe("Deep Work");
  });

  it("supports cross-user [[@handle/slug]]", () => {
    const m = parseWikilinks("[[@alice/recipes]]");
    expect(m[0].targetHandle).toBe("alice");
    expect(m[0].targetSlug).toBe("recipes");
  });

  it("detects ![[embed]]", () => {
    const m = parseWikilinks("![[diagram]]");
    expect(m[0].kind).toBe("embed");
    expect(m[0].targetSlug).toBe("diagram");
  });

  it("ignores wikilinks inside code spans and fences", () => {
    const body = "real [[a]]\n`inline [[b]]`\n```\nfenced [[c]]\n```\ntail [[d]]";
    const slugs = parseWikilinks(body).map((m) => m.targetSlug);
    expect(slugs).toEqual(["a", "d"]);
  });

  it("assigns increasing positions and dedupes targets in order", () => {
    const m = parseWikilinks("[[a]] [[b]] [[a]]");
    expect(m.map((x) => x.position)).toEqual([0, 1, 2]);
    expect(uniqueTargets(m)).toEqual(["a", "b"]);
  });
});
