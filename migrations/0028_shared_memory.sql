-- 共有の記憶 (2026-08-20)。
--
-- 個人の記憶は個人のまま。プロジェクトの記憶は、cf-memory に招待された人みんなの
-- 共有物にする。ShopApp の決定を誰か1人だけが覚えている状態をなくすのが目的。
--
-- 最初は spaces / space_members / space_scopes の3表で設計したが、捨てた。
-- 所属を「招待された人全員」にした時点で space_id はアクセス情報を何も運ばず、
-- 事実上の真偽値になっていた。にもかかわらず、新しいプロジェクトに触るたびに
-- 人が器を作って scope を紐づける必要があった —— 判定に寄与しないものの
-- ために、増えるたびに手作業が要る形。真偽値1つで同じことができる。
ALTER TABLE notes ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

-- 記憶の種類。共有するかどうかの既定をこれで決める。
--
-- 分類は ~/.claude/CLAUDE.md のファイル側メモリで既に使っているものと同じ。
-- 新しい判断基準を増やさず、毎回付けている判断を再利用するため:
--   project / reference … その仕事についての事実。他の人にも要る  → 共有
--   user    / feedback  … その人自身のこと。他の人には要らない    → 個人
--
-- これは**既定を決めるだけ**で、可視性そのものではない。保存時に shared へ
-- 解決して固定する。読むときに type から可視性を計算する形にすると、あとで
-- 分類の運用を変えた瞬間に過去のノートが一斉に公開されうる。
--
-- NULL = 未分類。既存の行はすべてこれになり、shared も 0 のまま —— この移行で
-- 共有される行は1つも無い。
ALTER TABLE notes ADD COLUMN type TEXT
  CHECK (type IS NULL OR type IN ('user','feedback','project','reference'));

-- skills にも同じ列が要る。読み取り条件(readableSql)は notes と skills の両方に
-- 使われるので、片方だけに足すと skills 側の検索が SQL エラーで黙って空を返す
-- (実際そうなり、対照テストが拾った)。
ALTER TABLE skills ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_notes_shared  ON notes(shared)  WHERE shared = 1;
CREATE INDEX idx_skills_shared ON skills(shared) WHERE shared = 1;
