-- Expand curator suggestion kinds for the recall-side curator (archive / stage).
-- SQLite can't ALTER a CHECK; recreate the table (pending suggestions are transient).
DROP TABLE IF EXISTS curator_suggestions;
CREATE TABLE curator_suggestions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,                     -- title|tag|link|distill_skill|archive|stage (validated in app)
  target_kind   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  rationale     TEXT,
  confidence    REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','superseded')),
  reviewed_by   TEXT,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_user_status ON curator_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_target ON curator_suggestions(target_id);
