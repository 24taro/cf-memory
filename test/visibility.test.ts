import { describe, expect, it } from "vitest";
import { isReadable, readableSql, readableSqlFor } from "../src/visibility";
import { principalFixture } from "./helpers";

const owner = principalFixture({ userId: "U_OWNER", handle: "owner", scopes: new Set(["admin"]) });
const anon = principalFixture({ userId: "anonymous", handle: "owner", scopes: new Set(), anonymous: true });
const other = principalFixture({ userId: "U_OTHER", handle: "x", scopes: new Set() });

const row = (extra: Record<string, unknown> = {}) => ({ user_id: "U_OWNER", ...extra });

describe("isReadable (owner-only, decision 9)", () => {
  it("the authenticated owner reads their own rows", () => {
    expect(isReadable(row(), owner)).toBe(true);
  });

  it("anonymous NEVER reads anything (fail-closed even below the gate)", () => {
    expect(isReadable(row(), anon)).toBe(false);
  });

  it("a different authed user cannot read another user's rows", () => {
    expect(isReadable(row(), other)).toBe(false);
  });

  it("deleted rows are never readable, even by the owner", () => {
    expect(isReadable(row({ deleted_at: 123 }), owner)).toBe(false);
  });
});

// ── 共有空間 (2026-08-19) ────────────────────────────────────────────────────
describe("共有された記憶", () => {
  const shared = (extra: Record<string, unknown> = {}) => ({ user_id: "U_OWNER", shared: 1, ...extra });

  it("共有された行は書いた人以外にも読める", () => {
    // 招待された人の中で権限を分けないので、招待済み = 読める。
    expect(isReadable(shared(), other)).toBe(true);
    expect(isReadable(shared(), owner)).toBe(true);
  });

  it("個人の行は共有が入っても他人に見えない", () => {
    // ここが崩れると共有機能が個人領域の漏れ口になる。
    expect(isReadable(row(), other)).toBe(false);
    expect(isReadable({ user_id: "U_OWNER", shared: 0 }, other)).toBe(false);
  });

  it("匿名は共有された行も読めない", () => {
    // 共有行は shared = 1 だけで真になる形なので、匿名判定が無いと
    // 「誰でも共有ノートを読める」になる。ゲートが先に 401 を返すため
    // アプリ経由のテストでは踏めない — 実際、匿名判定を壊す変異は素通りした。
    expect(isReadable(shared(), anon)).toBe(false);
  });

  it("削除された共有行は読めない", () => {
    expect(isReadable(shared({ deleted_at: 1 }), anon)).toBe(false);
    expect(isReadable(shared({ deleted_at: 1 }), other)).toBe(false);
  });
});

describe("readableSql — SQL 側も同じ規則", () => {
  it("匿名は何にも一致しない条件を返す", () => {
    expect(readableSql("n", anon)).toEqual({ sql: "1=0", args: [] });
    expect(readableSqlFor("n", "anonymous")).toEqual({ sql: "1=0", args: [] });
    expect(readableSqlFor("n", "")).toEqual({ sql: "1=0", args: [] });
  });

  it("閲覧者には「自分の行 または 共有」を返し、束縛は1つだけ", () => {
    const v = readableSql("n", owner);
    expect(v.sql).toBe("(n.shared = 1 OR n.user_id = ?)");
    // 引数が1つであることは重要: 呼び出し側は既存の並びの中にこれを差し込んでいる。
    expect(v.args).toEqual(["U_OWNER"]);
  });

  it("別名なしのテーブルにも使える", () => {
    expect(readableSqlFor("", "U_OWNER").sql).toBe("(shared = 1 OR user_id = ?)");
  });
});
