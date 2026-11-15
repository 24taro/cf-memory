-- Multi-user auth: an is_admin flag (decision 8, NEVER derived from scope) and a
-- password hash (decision 7's web-session foundation).
-- SQLite's ALTER cannot add a NOT NULL column without a default that satisfies
-- existing rows (same constraint 0005_stage.sql/0008_workspace.sql worked
-- around), so password_hash stays NULL-able: NULL means "not yet set up".
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_hash TEXT; -- 'pbkdf2-sha256$<iter>$<saltB64>$<hashB64>'. NULL = unset.

-- Backing store for the eg_session cookie (web login). The token itself is
-- never stored — only its sha256 hash (mirrors api_keys.key_hash). scope is
-- NOT stored here: decision 7 hardcodes eg_session's scope to
-- {notes:read, notes:write} at resolve-time, so there is nothing scope-shaped
-- to leak from this table even if it is fully dumped.
CREATE TABLE IF NOT EXISTS web_sessions (
  id           TEXT PRIMARY KEY,               -- ULID
  user_id      TEXT NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL UNIQUE,            -- sha256(opaque random token), hex
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                -- created_at + 30d (mirrors the old eg_key cookie's Max-Age)
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_web_sessions_token ON web_sessions(token_hash);
