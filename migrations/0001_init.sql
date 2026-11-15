-- cf-memory — Phase 1 schema.
-- One substrate: notes, the wikilink mesh, core-memory blocks, identity, provenance.
-- Multi-tenant columns are present from day one; phase 1 seeds ONE owner user.

-- identity ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- ULID
  handle        TEXT NOT NULL UNIQUE,              -- the @name
  display_name  TEXT NOT NULL DEFAULT '',
  email         TEXT,
  bio_md        TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,                  -- epoch ms
  updated_at    INTEGER NOT NULL
);

-- one scope model drives web session, REST, MCP, and CLI auth
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,                      -- visible, e.g. eg_live_AB12
  key_hash     TEXT NOT NULL,                      -- sha256(full key), hex
  scopes       TEXT NOT NULL DEFAULT 'notes:read', -- csv: notes:read|notes:write|admin
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- notes ---------------------------------------------------------------------
-- A note with a non-null pinned_block_label acts as a MemGPT-style core-memory
-- block (char-limited working memory) — same row, same mesh, one substrate.
CREATE TABLE IF NOT EXISTS notes (
  id                 TEXT PRIMARY KEY,             -- ULID
  user_id            TEXT NOT NULL REFERENCES users(id),
  slug               TEXT NOT NULL,                -- unique per user
  title              TEXT NOT NULL,
  body_md            TEXT NOT NULL,                -- markdown sans frontmatter
  frontmatter_json   TEXT NOT NULL DEFAULT '{}',
  visibility         TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('public','unlisted','private')),
  kind               TEXT NOT NULL DEFAULT 'note'
                       CHECK (kind IN ('note','journal','observation','block')),
  pinned_block_label TEXT,                         -- non-null => core-memory block
  char_limit         INTEGER,                      -- enforced when block label set
  embedding          BLOB,                         -- Float32 vector (phase-1 brute force)
  embedding_model    TEXT,
  content_hash       TEXT NOT NULL,                -- skip re-embed when unchanged
  word_count         INTEGER NOT NULL DEFAULT 0,
  view_count         INTEGER NOT NULL DEFAULT 0,
  score              REAL NOT NULL DEFAULT 0,       -- denormalized ranking
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  published_at       INTEGER,
  deleted_at         INTEGER,                       -- soft delete
  UNIQUE(user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_visibility ON notes(visibility);
CREATE INDEX IF NOT EXISTS idx_notes_block ON notes(user_id, pinned_block_label);

-- full history + provenance actor (human | agent | curator | import)
CREATE TABLE IF NOT EXISTS note_revisions (
  id               TEXT PRIMARY KEY,
  note_id          TEXT NOT NULL REFERENCES notes(id),
  body_md          TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  editor           TEXT NOT NULL CHECK (editor IN ('human','agent','curator','import')),
  editor_ref       TEXT,                            -- api_key prefix / user handle
  content_hash     TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_rev_note ON note_revisions(note_id, created_at DESC);

-- tags ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name    TEXT NOT NULL,
  slug    TEXT NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id),
  tag_id  TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);

-- the wikilink mesh ---------------------------------------------------------
-- Unresolved rows (target_note_id IS NULL) are first-class "wanted" stub nodes.
CREATE TABLE IF NOT EXISTS links (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  src_note_id    TEXT NOT NULL REFERENCES notes(id),
  target_slug    TEXT NOT NULL,                     -- raw [[slug]] text (kept even if absent)
  target_note_id TEXT REFERENCES notes(id),         -- NULL until resolved
  kind           TEXT NOT NULL DEFAULT 'wikilink'
                   CHECK (kind IN ('wikilink','embed','ref')),
  anchor_text    TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  resolved       INTEGER NOT NULL DEFAULT 0,         -- 0/1
  UNIQUE(src_note_id, target_slug, position)
);
CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_note_id);          -- backlinks
CREATE INDEX IF NOT EXISTS idx_links_target_slug ON links(user_id, target_slug);  -- stub resolution
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_note_id);

-- rename never breaks inbound wikilinks/backlinks
CREATE TABLE IF NOT EXISTS slug_redirects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  old_slug    TEXT NOT NULL,
  new_note_id TEXT NOT NULL REFERENCES notes(id),
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, old_slug)
);

-- provenance/audit, powers /changes -----------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  actor        TEXT NOT NULL CHECK (actor IN ('human','agent','curator','import')),
  actor_ref    TEXT,
  verb         TEXT NOT NULL,                        -- note.created|note.updated|link.added|...
  target_kind  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  reason       TEXT,
  summary      TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);

-- keyword search: a regular FTS5 table keyed by notes.rowid (app-managed
-- dual-write inside the note transaction; delete-by-rowid then re-insert).
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body, tags, tokenize='porter unicode61'
);

-- system meta (active embedding model, schema version, owner handle)
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
