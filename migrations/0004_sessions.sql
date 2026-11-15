-- cf-memory — Phase: Sessions.
-- A session is an append-only journal of entries with a rolling summary; it is
-- the "episodic" tier recall blends alongside working/archival/procedural.

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,                 -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id),
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary_md      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  visibility      TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('public','unlisted','private')),
  agent_ref       TEXT,
  embedding       BLOB,
  embedding_model TEXT,
  content_hash    TEXT NOT NULL DEFAULT '',
  entry_count     INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_entries (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role       TEXT NOT NULL DEFAULT 'note',          -- note|user|agent|observation
  content_md TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_entries ON session_entries(session_id, created_at);

-- keyword search over sessions (title + rolling summary + concatenated body)
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title, summary, body, tokenize='porter unicode61'
);
