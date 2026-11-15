-- E5: CJK-capable keyword search (FTS5 `trigram` tokenizer = substring/partial-token
-- matching, works for Japanese) + a synonyms table for OR-expansion at query time.
-- Recreating the FTS tables empties them; run POST /api/v1/admin/reindex once to
-- repopulate existing rows (new writes index normally).

DROP TABLE IF EXISTS notes_fts;
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tags, tokenize='trigram');

DROP TABLE IF EXISTS skills_fts;
CREATE VIRTUAL TABLE skills_fts USING fts5(name, description, instructions, tokenize='trigram');

DROP TABLE IF EXISTS sessions_fts;
CREATE VIRTUAL TABLE sessions_fts USING fts5(title, summary, body, tokenize='trigram');

CREATE TABLE IF NOT EXISTS synonyms (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  term    TEXT NOT NULL,
  synonym TEXT NOT NULL,
  UNIQUE(user_id, term, synonym)
);
CREATE INDEX IF NOT EXISTS idx_synonyms_user_term ON synonyms(user_id, term);
