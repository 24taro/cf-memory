-- cf-memory — Phase 2: skills as portable procedural memory (SKILL.md), in the
-- SAME substrate as notes. Bundle files (scripts/references/assets in R2) remain
-- phase-2b; a skill's instructions always live in D1 so discovery/activation
-- never touch R2.

CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,                 -- ULID
  user_id          TEXT NOT NULL REFERENCES users(id),
  slug             TEXT NOT NULL,
  name             TEXT NOT NULL,                    -- SKILL.md frontmatter
  description      TEXT NOT NULL,                    -- discovery + embedded
  instructions_md  TEXT NOT NULL,                    -- SKILL.md body (sans frontmatter)
  skill_md         TEXT NOT NULL,                    -- full SKILL.md (frontmatter + body)
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  visibility       TEXT NOT NULL DEFAULT 'private'
                     CHECK (visibility IN ('public','unlisted','private')),
  version          TEXT NOT NULL DEFAULT '0.1.0',    -- semver
  parent_skill_id  TEXT,                             -- fork lineage (federation)
  embedding        BLOB,
  embedding_model  TEXT,
  content_hash     TEXT NOT NULL,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_skills_user_updated ON skills(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility);

-- keyword search over skills, keyed by skills.rowid (app-managed dual-write)
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, instructions, tokenize='porter unicode61'
);
