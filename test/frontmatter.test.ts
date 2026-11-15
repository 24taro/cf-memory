import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { asStringArray, composeSkillMd, parseFrontmatter } from "../src/frontmatter";

describe("parseFrontmatter", () => {
  it("returns empty data + original body when there is no frontmatter", () => {
    const r = parseFrontmatter("just a body\nwith lines");
    expect(r.data).toEqual({});
    expect(r.body).toBe("just a body\nwith lines");
  });

  it("parses scalars and strips the block from the body", () => {
    const r = parseFrontmatter("---\ntitle: Hello World\nvisibility: public\n---\n\nbody here");
    expect(r.data.title).toBe("Hello World");
    expect(r.data.visibility).toBe("public");
    expect(r.body).toBe("body here");
  });

  it("parses inline and block lists", () => {
    expect(parseFrontmatter("---\ntags: [a, b, c]\n---\nx").data.tags).toEqual(["a", "b", "c"]);
    expect(parseFrontmatter("---\ntags:\n  - one\n  - two\n---\nx").data.tags).toEqual(["one", "two"]);
  });

  it("strips quotes and parses numbers/booleans", () => {
    const r = parseFrontmatter('---\nname: "Quoted"\ndraft: true\nn: 42\n---\nx');
    expect(r.data.name).toBe("Quoted");
    expect(r.data.draft).toBe(true);
    expect(r.data.n).toBe(42);
  });

  it("keeps legacy non-JSON quoted scalars and single-quoted values readable", () => {
    const r = parseFrontmatter('---\nname: "legacy\\e escape"\ndescription: \'legacy description\'\n---\nbody');
    expect(r.data.name).toBe("legacy\\e escape");
    expect(r.data.description).toBe("legacy description");
  });
});

describe("asStringArray", () => {
  it("normalizes arrays and comma/space strings", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(asStringArray("a, b c")).toEqual(["a", "b", "c"]);
    expect(asStringArray(undefined)).toEqual([]);
  });
});

describe("composeSkillMd", () => {
  it("round-trips through parseFrontmatter", () => {
    const md = composeSkillMd("my-skill", "does a thing", "Step 1. Step 2.");
    const r = parseFrontmatter(md);
    expect(r.data.name).toBe("my-skill");
    expect(r.data.description).toBe("does a thing");
    expect(r.body.trim()).toBe("Step 1. Step 2.");
  });

  // Parse the generated header with an independent YAML implementation. The
  // permissive local parser alone used to accept invalid `name: Agent: ...`.
  it.each([
    ["cf-memory agent: 導入手順", "出典: docs/CF_MEMORY-AGENT.md。"],
    ["procedure #1", "keep # this text"],
    ['say "hello"', 'path C:\\work\\file and "quotes"'],
    ["false", "true"],
    ["42", "3.14"],
    ["null", ""],
    ["[a, b]", "{key: value}"],
    ["*alias", "!tag &anchor"],
    ["line one\n---\ninjected: true", "tab\tand\r\nnewlines"],
    ["日本語 🚀", "  spaces remain  "],
  ])("exports string metadata intact for %j", (name, description) => {
    const md = composeSkillMd(name, description, "Step 1.\nStep 2.");
    const header = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1];
    expect(header).toBeDefined();
    const independent = parseDocument(header!);
    expect(independent.errors).toEqual([]);
    expect(independent.toJSON()).toEqual({ name, description });
    const local = parseFrontmatter(md);
    expect(local.data).toEqual({ name, description });
    expect(local.body).toBe("Step 1.\nStep 2.\n");
  });
});
