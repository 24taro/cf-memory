import { describe, expect, it } from "vitest";
import { atomFeed, buildPrompt, changesMd, networkMd, rankingMd } from "../src/serialize";

describe("buildPrompt", () => {
  it("wraps the recalled pack with handle + task framing", () => {
    const p = buildPrompt("owner", "fix the bug", "## Working memory\n- foo");
    expect(p).toContain("@owner");
    expect(p).toContain("## Task");
    expect(p).toContain("fix the bug");
    expect(p).toContain("## Working memory");
  });
  it("notes when no task is given", () => {
    expect(buildPrompt("o", "", "ctx")).toContain("(no task specified)");
  });
});

const change = { verb: "note.created", created_at: 0, title: "Hello", slug: "hello", op: "create", hash: "abc123" };

describe("changesMd", () => {
  it("renders a content-hashed commit-log line", () => {
    const md = changesMd("owner", [change]);
    expect(md).toContain("create");
    expect(md).toContain("Hello");
    expect(md).toContain("abc123");
  });
});

describe("atomFeed", () => {
  it("produces Atom with one entry per slugged change and escapes html", () => {
    const xml = atomFeed("owner", "https://x.test", [{ ...change, title: "<b>Hi</b>" }]);
    expect(xml).toContain("<feed");
    expect(xml).toContain("<entry>");
    expect(xml).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    expect(xml).toContain("https://x.test/@owner/n/hello");
  });
  it("omits entries with no slug", () => {
    const xml = atomFeed("owner", "https://x.test", [{ ...change, slug: null }]);
    expect(xml).not.toContain("<entry>");
  });
});

describe("rankingMd / networkMd", () => {
  it("renders a ranking table row and a stub-marked edge", () => {
    expect(rankingMd("o", [{ slug: "a", title: "A", inlinks: 2, views: 1, score: 7 }])).toContain("| 1 | 7 |");
    expect(networkMd("o", { nodes: [{ id: "a", label: "A", stub: false }, { id: "b", label: "b", stub: true }], edges: [{ source: "a", target: "b" }] })).toContain("[[a]] → [[b]] (stub)");
  });

  // issue #33: a node with zero in/out links (orphan) was silently dropped
  // from the edge-only listing, so the "nodes: N" header count and the
  // listing's actual entry count disagreed.
  it("lists a zero-degree (orphan) node so the header's node count matches the listing", () => {
    const md = networkMd("o", {
      nodes: [
        { id: "a", label: "A", stub: false },
        { id: "b", label: "B", stub: false },
        { id: "lonely", label: "Lonely", stub: false },
      ],
      edges: [{ source: "a", target: "b" }],
    });
    expect(md).toContain("nodes: 3, edges: 1");
    expect(md).toContain("[[lonely]] (no links)");
    // exactly 1 edge line + 1 orphan line = 2 listing entries, one per node not otherwise covered
    const listingLines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(listingLines).toHaveLength(2);
  });
});
