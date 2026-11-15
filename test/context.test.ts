import { describe, expect, it } from "vitest";
import { normalizeScope, normalizeScopes, scopeClause } from "../src/context";

// #117: the two git-remote forms of the SAME repo MUST collapse to one canonical
// scope string, or exact-match scope filtering splits (a note written from an
// https clone never matches a recall from an ssh clone). Normalize to
// `host/path` (lowercase host, no scheme, no `.git`, no trailing slash).
describe("normalizeScope (#117 context)", () => {
  it("collapses scp-like and https git remotes to the same canonical scope", () => {
    const canonical = "github.com/acme/cf-memory";
    expect(normalizeScope("git@github.com:acme/cf-memory.git")).toBe(canonical);
    expect(normalizeScope("https://github.com/acme/cf-memory")).toBe(canonical);
    expect(normalizeScope("https://github.com/acme/cf-memory.git")).toBe(canonical);
    expect(normalizeScope("ssh://git@github.com/acme/cf-memory.git")).toBe(canonical);
    expect(normalizeScope("git://github.com/acme/cf-memory.git")).toBe(canonical);
    expect(normalizeScope("https://github.com/acme/cf-memory/")).toBe(canonical);
  });

  it("lowercases the host but preserves path case", () => {
    expect(normalizeScope("https://GitHub.com/acme/CF-Memory.git")).toBe("github.com/acme/CF-Memory");
  });

  it("strips a token/user in an https remote", () => {
    expect(normalizeScope("https://x-access-token:abc123@github.com/acme/cf-memory.git")).toBe("github.com/acme/cf-memory");
  });

  it("handles a host:port url", () => {
    expect(normalizeScope("https://git.example.com:8443/team/repo.git")).toBe("git.example.com/team/repo");
  });

  it("collapses an scp remote on a DOT-LESS internal host to match its https form", () => {
    // a bare internal git host (no dot) — scp and https clones of the same repo
    // must produce the SAME scope (gated on the git@ user prefix, not a dotted host).
    expect(normalizeScope("git@githost:team/repo.git")).toBe("githost/team/repo");
    expect(normalizeScope("https://githost/team/repo.git")).toBe("githost/team/repo");
    expect(normalizeScope("ssh://git@githost/team/repo.git")).toBe("githost/team/repo");
  });

  it("does NOT treat a Windows drive path or a bare colon-label as an scp remote", () => {
    // scp と誤認しない(user@ も無く、ホストにドットも無い)。remote ではないので
    // 2026-08-20 以降は 'global' に落ちる。
    expect(normalizeScope("C:\\Users\\foo\\project")).toBe("global");
    expect(normalizeScope("robot:mini")).toBe("global");
  });

  it("empty / whitespace / explicit 'global' → 'global'", () => {
    expect(normalizeScope("")).toBe("global");
    expect(normalizeScope("   ")).toBe("global");
    expect(normalizeScope(null)).toBe("global");
    expect(normalizeScope(undefined)).toBe("global");
    expect(normalizeScope("global")).toBe("global");
    expect(normalizeScope("GLOBAL")).toBe("global");
  });

  it("remote でないものに scope を作らない — パスもラベルも 'global'", () => {
    // 2026-08-20: 以前はこれらをそのまま scope にしていた。その結果、本番で1つの
    // プロジェクトが3通りに割れ(`search` / `github.com/acme/search` /
    // `/Users/.../search`)、互いに見えなくなっていた。git 配下でない作業に
    // 固有の scope は無い、というのが今の規則。
    expect(normalizeScope("/Users/foo/project/")).toBe("global");
    expect(normalizeScope("/Users/foo/project")).toBe("global");
    expect(normalizeScope("  robot  ")).toBe("global");
    expect(normalizeScope("search")).toBe("global");
    expect(normalizeScope("shopapp-career-ai")).toBe("global");
  });

  it("社内ホスト(ドット無し)の remote は残す", () => {
    // `git@host:path` は scp 経路で `host/path` になる。ここを弾くと社内 GitLab の
    // scope が消えるので、ドットの有無ではなく「スラッシュを含み、絶対パスでない」
    // を条件にしている。
    expect(normalizeScope("git@internal:shopapp/rss")).toBe("internal/shopapp/rss");
    expect(normalizeScope("internal/shopapp/rss")).toBe("internal/shopapp/rss");
  });

  it("is idempotent (normalizing an already-canonical value is a no-op)", () => {
    const c = "github.com/acme/cf-memory";
    expect(normalizeScope(c)).toBe(c);
  });
});

describe("normalizeScopes — 複数プロジェクトを一度に指す", () => {
  it("親ディレクトリの子リポジトリをまとめて指せる", () => {
    // このリポジトリ群がまさにその形: ~/work/acme は git ではなく、
    // 子に auth / cf-memory / search / tasks がある。
    expect(
      normalizeScopes([
        "https://github.com/acme/auth.git",
        "git@github.com:acme/cf-memory.git",
        "github.com/acme/search",
      ]),
    ).toEqual(["github.com/acme/auth", "github.com/acme/cf-memory", "github.com/acme/search"]);
  });

  it("同じ remote の別チェックアウトは1つに畳まれる", () => {
    // shopapp-nextjs / nextjs2 / nextjs2-is-admin は同じ remote を指している。
    // パスを scope にしていたら3つに割れていた。
    expect(
      normalizeScopes([
        "https://github.com/acme-shop/shopapp.git",
        "git@github.com:acme-shop/shopapp.git",
        "github.com/acme-shop/shopapp",
      ]),
    ).toEqual(["github.com/acme-shop/shopapp"]);
  });

  it("remote でないものは落とす。'global' も混ぜない", () => {
    // 'global' は条件側が常に含むので、混ぜると「global を送れば全部出る」という
    // 誤解を生むだけで意味が無い。
    expect(normalizeScopes(["/Users/foo/project", "search", "global", ""])).toEqual([]);
    expect(normalizeScopes(["github.com/acme/auth", "global"])).toEqual(["github.com/acme/auth"]);
  });

  it("単数の文字列でも空でも受ける", () => {
    expect(normalizeScopes("github.com/acme/auth")).toEqual(["github.com/acme/auth"]);
    expect(normalizeScopes("github.com/acme/auth, github.com/acme/cf-memory")).toEqual([
      "github.com/acme/auth",
      "github.com/acme/cf-memory",
    ]);
    expect(normalizeScopes(null)).toEqual([]);
    expect(normalizeScopes(undefined)).toEqual([]);
  });
});

describe("scopeClause — 絞り込み条件", () => {
  it("scope が無ければ条件を足さない(すべて見える)", () => {
    expect(scopeClause("n", [])).toEqual({ sql: "", args: [] });
  });

  it("'global' を必ず含める", () => {
    // 外すと、どこにも属さない汎用知識がプロジェクト作業中に一切出なくなる。
    // `scope = ?` と書いた瞬間に踏む落とし穴。
    const c = scopeClause("n", ["github.com/acme/auth"]);
    expect(c.sql).toBe(" AND n.scope IN (?, 'global')");
    expect(c.args).toEqual(["github.com/acme/auth"]);
  });

  it("複数なら ? がその数だけ並ぶ", () => {
    const c = scopeClause("n", ["a/b", "c/d", "e/f"]);
    expect(c.sql).toBe(" AND n.scope IN (?,?,?, 'global')");
    expect(c.args).toEqual(["a/b", "c/d", "e/f"]);
  });

  it("別名なしのテーブルにも使える", () => {
    expect(scopeClause("", ["a/b"]).sql).toBe(" AND scope IN (?, 'global')");
  });
});
