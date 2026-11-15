// Regression: src/search.ts:flattenForSnippet:quadratic-wikilink-regex
//
// Building a search snippet must cost time linear in a bounded prefix of the
// body, whatever the body contains, and must keep the exact text the previous
// (regex) flattening produced for bodies that fit in that prefix.
import { describe, it, expect } from "vitest";
import { snippet, snippetWasTruncated } from "../../src/search";

/** The flattening as it was before the fix; the output contract. */
function legacyFlatten(body: string): string {
  return body
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
function legacySnippet(body: string, max = 200): string {
  const flat = legacyFlatten(body);
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
const legacyTruncated = (body: string, max = 200): boolean => legacyFlatten(body).length > max;

const ms = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t; };

describe("snippet cost is bounded and linear", () => {
  const hostile: Array<[string, string]> = [
    ["200k of '['", "[".repeat(200_000)],
    ["200k of '![['", "![[".repeat(66_667)],
    ["200k of '[[a|'", "[[a|".repeat(50_000)],
    ["200k of '[' then one ']'", "[".repeat(200_000) + "]"],
    ["200k of '[[a]'", "[[a]".repeat(50_000)],
    ["200k of '[[|]]'", "[[|]]".repeat(40_000)],
    ["lines of 30 '[['", ("[[".repeat(30) + "\n").repeat(3_300)],
    ["2M of '['", "[".repeat(2_000_000)],
    ["200k of whitespace", " \n\t".repeat(66_667)],
  ];
  snippet("[".repeat(500)); snippetWasTruncated("x".repeat(500)); // warm-up

  for (const [name, body] of hostile) {
    it(`${name}: snippet + truncation flag finish in well under 100 ms`, () => {
      let out = "";
      const elapsed = ms(() => { out = snippet(body); snippetWasTruncated(body); });
      expect(elapsed).toBeLessThan(100);
      expect(out.length).toBeLessThanOrEqual(201);
    });
  }

  it("cost does not grow with the body beyond the examined prefix", () => {
    const at = (n: number) => Math.min(...[0, 1, 2].map(() => ms(() => { snippet("[".repeat(n)); })));
    const small = at(100_000), large = at(1_600_000);
    // Quadratic growth would be 256x; a bounded prefix is flat. Allow wide noise.
    expect(large).toBeLessThan(Math.max(small * 8, 20));
  });

  it("a hostile body still yields its leading text and reports truncation", () => {
    const body = "[".repeat(200_000);
    expect(snippet(body)).toBe("[".repeat(200) + "…");
    expect(snippetWasTruncated(body)).toBe(true);
    expect(snippet("intro [[target|label]] " + "[".repeat(200_000))).toBe(("intro label " + "[".repeat(200)).slice(0, 200) + "…");
  });
});

describe("snippet text is unchanged for ordinary and edge-case bodies", () => {
  const bodies: string[] = [
    "",
    "   \n\t ",
    "a\n\n  b   c",
    "plain text with no links at all",
    "x".repeat(200),
    "x".repeat(201),
    "x".repeat(300),
    "a literal ellipsis…",
    "see [[target]] for more",
    "see [[target|label]] for more",
    "embed ![[image.png]] here",
    "embed ![[image.png|alt text]] here",
    "[[a]][[b|c]]![[d]]![[e|f]]",
    "[[folder/note name#heading|shown]] and [[other note^block]]",
    "two aliases [[a|b|c]] and [[a|b]]|c]]",
    "empty [[]] and [[|]] and [[|x]] and [[x|]]",
    "unclosed [[target",
    "unclosed alias [[target|label",
    "half closed [[target] tail",
    "half closed alias [[target|label] tail",
    "stray ]] closers ]] and | pipes | here",
    "nested [[[inner]]] and [[[a|b]]]",
    "nested [[outer [[inner]] rest]]",
    "[[[[a]]",
    "[[a|[[b]]",
    "[[a|[[b|c]]]]",
    "[[a]]]]",
    "bang !![[x]] and ![ [[y]] and !\n[[z]]",
    "![[[x]] ![[[a|b]]",
    "[[multi\nline target]] and [[multi\nline|ali\nas]]",
    "[[a|b]]\n\n[[c]]\n",
    "markdown [text](http://example.com) and [ref][1] and - [ ] task and - [x] done",
    "code `arr[[0]]` and arr[i][[j]] and x[[1|2]]",
    "日本語の本文です。[[設計メモ]] と [[認証/設定|認証の設定]] を参照。",
    "全角　空白　と NBSP と﻿BOM と 行区切り",
    "絵文字 😀 [[ノート|😀ラベル]] ![[画像.png]]",
    "日本語。".repeat(80),
    "# 見出し\n\n- [[リンク]] の箇条書き\n- 二つ目 [[別名あり|別名]]\n\n本文が続きます。".repeat(12),
    "lorem ipsum ".repeat(500),
    ("word [[link|alias]] ![[embed]] [[plain]] ").repeat(40),
    "\n\n\n   leading whitespace then [[a|b]] text",
    "[[" + "t".repeat(300) + "|short]] after a long target",
    "[[" + "t".repeat(300) + "]] long plain target",
    "x".repeat(190) + " [[target|label that crosses the cut]] tail",
    "x".repeat(198) + "[[ab]]",
    "x".repeat(199) + "[[a|b]]",
    "x".repeat(199) + " [[a",
    "[".repeat(50) + "]]",
    "[".repeat(50) + "|" + "]".repeat(50),
    "[[a|b]".repeat(20) + "]",
    "a|b]] [[c".repeat(20),
  ];

  for (const body of bodies) {
    it(`matches the previous output: ${JSON.stringify(body.length > 48 ? `${body.slice(0, 48)}…(${body.length})` : body)}`, () => {
      expect(snippet(body)).toBe(legacySnippet(body));
      expect(snippetWasTruncated(body)).toBe(legacyTruncated(body));
      for (const max of [0, 1, 10, 50]) {
        expect(snippet(body, max)).toBe(legacySnippet(body, max));
        expect(snippetWasTruncated(body, max)).toBe(legacyTruncated(body, max));
      }
    });
  }

  it("matches the previous output on generated bracket soup", () => {
    // Deterministic generator: every combination of the characters the
    // wikilink patterns react to, short enough to stay inside the scan window.
    let seed = 0x2f6e2b1;
    const rand = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const alphabet = ["[", "[", "[[", "]", "]", "]]", "|", "!", "a", "b", " ", "\n", "語"];
    for (let i = 0; i < 20_000; i++) {
      let body = "";
      for (let n = 1 + rand(24); n > 0; n--) body += alphabet[rand(alphabet.length)];
      const max = [200, 3, 8][i % 3];
      if (snippet(body, max) !== legacySnippet(body, max) || snippetWasTruncated(body, max) !== legacyTruncated(body, max)) {
        expect({ body, max, snippet: snippet(body, max), truncated: snippetWasTruncated(body, max) })
          .toEqual({ body, max, snippet: legacySnippet(body, max), truncated: legacyTruncated(body, max) });
      }
    }
  });

  it("a body longer than the examined prefix is a truncated preview of its leading text", () => {
    const body = "lead [[note|label]] " + "tail ".repeat(100_000);
    expect(snippet(body)).toBe(legacySnippet(body));
    expect(snippetWasTruncated(body)).toBe(true);
  });
});
