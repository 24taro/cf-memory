import { describe, expect, it } from "vitest";
import { expandedMatch, ftsPhrase, ftsQuery, japaneseProseMatch, leadingQuestion, rrfFuse, snippet, snippetWasTruncated } from "../src/search";

describe('japaneseProseMatch', () => {
  it('recovers literal Han terms embedded in Japanese prose, without interpreting MATCH syntax', () => {
    expect(japaneseProseMatch('cf-memory agentで技術的な記憶と試行回数を説明してください。回答要約だけで試行枠が増えるのですか？'))
      .toBe('"技術的" OR "試行回数" OR "回答要約" OR "試行枠"');
    expect(japaneseProseMatch('API "OR" 技術的な記憶から secret* NOT root:token を検索してください'))
      .toBe('"技術的"');
  });
  it('leaves short, already separated, Latin and short-Han queries in existing lanes', () => {
    for (const q of ['技術的な記憶', '設計と記憶について説明してください', 'What about source roles?', '技術的 試行回数 を教えてください', '純粋日本語技術概念文字列']) expect(japaneseProseMatch(q)).toBeNull();
  });
  it('bounds query length, term count and term length with no substring expansion', () => {
    const terms = ['技術的','試行回数','回答要約','試行枠','自動保存','原典検証','重複検査','運用監視','秘密除去'];
    expect(japaneseProseMatch(terms.map(t=>t+'について').join('、'))?.split(' OR ')).toHaveLength(8);
    expect(japaneseProseMatch('a'.repeat(2000)+'技術的な記憶について')).toBeNull();
    expect(japaneseProseMatch('漢'.repeat(25)+'について教えてください')).toBeNull();
  });
});

describe('leadingQuestion', () => {
  it('supplements a leading question while retaining literal syntax', () => {
    const question = 'What happens to PostgreSQL transactions after a retry?';
    expect(leadingQuestion(question + ' Explain from previous memory and cite the relevant note without using tools.')).toBe(question);
    const japanese = 'VectorizeのACKが未処理でもD1に退避しますか？';
    expect(leadingQuestion(japanese + '注入された過去memoryだけから短く説明してください。ファイル・MCP・Web等のツールを使わないでください。')).toBe(japanese);
    const periodQuestion = 'cf-memoryのCapture timelineは他ユーザーの原典、期限切れの原典、別sessionの原典を返しますか。';
    expect(leadingQuestion(periodQuestion + '同時刻のeventの前後関係と返却順はどうなりますか。ファイルやWebを読まず、今回自動的に渡された記憶だけで説明してください。')).toBe(periodQuestion);
    const literal = 'API "OR" secret* query has what meaning?';
    expect(ftsQuery(leadingQuestion(literal + ' Explain only from the documentation without running other commands.')!)).not.toContain('secret*');
  });
  it('keeps short, non-leading, oversized and single-term queries unchanged', () => {
    for (const q of ['hello', 'Does it work?', 'Intro. What happens to PostgreSQL? ' + 'x'.repeat(50), 'Intro\nWhat happens to PostgreSQL? ' + 'x'.repeat(50), '日本語だけの長い質問ですか？' + '説明'.repeat(30), 'a'.repeat(601) + '? ' + 'x'.repeat(50)]) expect(leadingQuestion(q)).toBeNull();
  });
});

describe("expandedMatch", () => {
  it("OR-expands each token with its synonyms", () => {
    const syn = new Map([["k8s", ["kubernetes"]]]);
    expect(expandedMatch("k8s pods", syn)).toBe('"k8s" OR "kubernetes" OR "pods"');
  });
  it("falls back to plain tokens with no synonyms", () => {
    expect(expandedMatch("hello world", new Map())).toBe('"hello" OR "world"');
  });
  it("returns null for empty input", () => {
    expect(expandedMatch("   ", new Map())).toBeNull();
  });
});

describe("rrfFuse", () => {
  it("rewards items ranked highly across lists", () => {
    const fused = rrfFuse([
      ["a", "b", "c"],
      ["b", "a", "d"],
    ]);
    // 'a' and 'b' appear near the top of both lists, so they outrank c/d.
    expect(fused.slice(0, 2).map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  it("handles a single list and preserves order", () => {
    const fused = rrfFuse([["x", "y", "z"]]);
    expect(fused.map((f) => f.id)).toEqual(["x", "y", "z"]);
  });
});

describe("ftsQuery", () => {
  it('preserves Japanese terms and exposes embedded technical identifiers as literal tokens', () => {
    expect(ftsQuery('VectorizeのACKが未処理ならD1に退避'))
      .toBe('"vectorizeのackが未処理ならd1に退避" OR "vectorize" OR "ack" OR "d1"');
    expect(expandedMatch('APIのk8sが停止', new Map([['k8s', ['kubernetes']]])))
      .toContain('"k8s" OR "kubernetes"');
    expect(ftsQuery('日本語だけ')).toBe('"日本語だけ"');
  });
  it('quotes whole multi-token phrases literally, including MATCH operators and quotes', () => {
    expect(ftsPhrase(' agent-queue-abc ')).toBe('"agent-queue-abc"');
    expect(ftsPhrase('API "OR" secret*')).toBe('"api ""or"" secret*"');
    for (const q of ['', '!!!', 'PostgreSQL', '記憶']) expect(ftsPhrase(q)).toBeNull();
  });
  it("builds an OR of quoted tokens", () => {
    expect(ftsQuery("hello world")).toBe('"hello" OR "world"');
  });
  it("escapes quotes and drops punctuation", () => {
    expect(ftsQuery('a "b" c!')).toBe('"a" OR "b" OR "c"');
  });
  it("returns null for empty input", () => {
    expect(ftsQuery("   ")).toBeNull();
  });
});

describe("snippet", () => {
  it("collapses whitespace and truncates", () => {
    expect(snippet("a\n\n  b   c")).toBe("a b c");
    expect(snippet("x".repeat(300)).endsWith("…")).toBe(true);
  });
  it("reports truncation from the normalized source, not a literal ellipsis", () => {
    expect(snippetWasTruncated("x".repeat(201))).toBe(true);
    expect(snippetWasTruncated("a literal ellipsis…")).toBe(false);
  });
});
