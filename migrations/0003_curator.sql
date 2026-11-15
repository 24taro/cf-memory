-- cf-memory — Phase 4: the AI curator as a NON-DESTRUCTIVE suggestion layer.
-- Every machine proposal (title / tags / [[links]] / distilled skill) lands here
-- as a diff + rationale + confidence that a human or scoped agent approves. The
-- garden self-organizes but never silently rewrites itself.

CREATE TABLE IF NOT EXISTS curator_suggestions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('title','tag','link','distill_skill')),
  target_kind   TEXT NOT NULL,                     -- 'note' | 'cluster'
  target_id     TEXT NOT NULL,
  proposal_json TEXT NOT NULL,                      -- the diff (new title / tags / target_slug / skill_md)
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
