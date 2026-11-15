-- cf-memory-logs (binding LOGS): the kept conversation, design B (2026-10-31).
-- A separate D1 database from `cf-memory`, so a full log database never blocks
-- notes, recall or login. Rows are written only by log_append and are never
-- updated; the daily scheduled() job deletes old `action`/`error` rows.

CREATE TABLE log_entries (
  rowid INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,              -- client id, 64 hex (sha256)
  session_id TEXT NOT NULL,
  client TEXT NOT NULL,          -- 'claude-code' | 'codex'
  repo TEXT NOT NULL DEFAULT '', -- normalized git remote ("acme/cf-memory") or cwd basename
  ts INTEGER NOT NULL,           -- event time, epoch ms
  kind TEXT NOT NULL CHECK (kind IN ('prompt','reply','action','error')),
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, id)
);
CREATE INDEX log_user_ts ON log_entries(user_id, ts);
CREATE INDEX log_user_session ON log_entries(user_id, session_id, ts);
CREATE INDEX log_user_repo_ts ON log_entries(user_id, repo, ts);
CREATE INDEX log_kind_ts ON log_entries(kind, ts);

-- External-content FTS5 index over log_entries.text (trigram, like notes_fts).
CREATE VIRTUAL TABLE log_fts USING fts5(text, content='log_entries', content_rowid='rowid', tokenize='trigram');

-- Keep log_fts in sync. Entries are append-only, so there is no UPDATE trigger.
CREATE TRIGGER log_entries_ai AFTER INSERT ON log_entries BEGIN
  INSERT INTO log_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER log_entries_ad AFTER DELETE ON log_entries BEGIN
  INSERT INTO log_fts(log_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

-- Per user per UTC day: stored `action` bytes (the daily cap) and how many
-- `action` entries were dropped over it.
CREATE TABLE log_daily (user_id TEXT NOT NULL, day TEXT NOT NULL, action_bytes INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
