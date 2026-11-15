// 共有するかどうかの解決 (2026-08-20)。
//
// 「どこに保存されるか」は保存の瞬間に1度だけ決まり、行に固定される。読むときに
// 種類から計算し直さないのは、あとで分類の運用を変えたときに過去のノートが一斉に
// 公開されうるため。判断の結果を保存する、判断の材料を保存しない。

import type { NoteType } from "./types";

/** 共有してよい種類。その仕事についての事実と参照先は、関わる人みんなに要る。
 * user(その人自身のこと) と feedback(その人の進め方の好み) は要らない。 */
const SHARED_TYPES: ReadonlySet<string> = new Set(["project", "reference"]);

/** この保存は共有されるか。
 *
 * DB を引かない。器を作る操作が無いので、引くものが無い —— これが
 * spaces を捨てて得たものそのもの。新しいプロジェクトに触っても、
 * 新しい人が入っても、事前に用意するものは何も無い。
 */
export function resolveShared(type: NoteType | null | undefined): boolean {
  return !!type && SHARED_TYPES.has(type);
}

/** 受け取った値が記憶の種類として妥当か。
 *
 * 2026-08-22: `type` はどこでも検証されておらず、唯一の検査が migration 0028 の
 * CHECK 制約だった。upsert は制約違反を「同時書き込みの衝突」と区別できず12回
 * 再試行し、そのたびに埋め込みを計算し直してから失敗する。入口で断る。 */
export function isNoteType(v: unknown): v is NoteType {
  return v === "user" || v === "feedback" || v === "project" || v === "reference";
}

/** 受け取った値がノートの種類(kind)として妥当か。公開している値だけを通す。
 *
 * 2026-11-14: `kind` はどの入口でも検証されておらず、'block'(core-memory の印)が
 * notes の扉から通っていた。'block' は固定されて外れず、一覧と検索から消える。
 * 'block' に届くのは memory サービスだけ —— 入口はこの3つ以外を断る。 */
export function isNoteKind(v: unknown): v is "note" | "journal" | "observation" {
  return v === "note" || v === "journal" || v === "observation";
}
