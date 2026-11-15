-- cf-memory — phase 2b: skill bundle files. A skill's SKILL.md stays in D1 (skills);
-- optional bundle files (scripts/ references/ assets/) keep their BYTES in R2
-- (BUNDLES bucket) with one manifest row PER LIVE PATH here. Deliberately NO
-- `version` column: the shipped
-- skills table keeps no revision history — upsert() overwrites the single row in
-- place and bumpPatch()es the semver on EVERY edit, so a version-keyed manifest
-- would strand file rows + R2 objects on each patch bump and leave a resurrected
-- skill file-less. A current-state manifest (one row per live path) mirrors the
-- single-row skill body; PUT overwrites the row and its R2 object idempotently
-- under the same key skills/<skill_id>/<path>.
CREATE TABLE IF NOT EXISTS skill_files (
  id           TEXT PRIMARY KEY,                       -- ULID (db.ulid)
  skill_id     TEXT NOT NULL REFERENCES skills(id),
  path         TEXT NOT NULL,                          -- validated relative path, e.g. scripts/run.ts
  r2_key       TEXT NOT NULL,                          -- skills/<skill_id>/<path>; composed once, read back verbatim
  content_type TEXT,                                   -- sanitized on upload; NOT trusted when serving
  size         INTEGER,                                -- bytes actually read
  sha256       TEXT,                                   -- hex digest of the stored bytes
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(skill_id, path)
);
-- The UNIQUE(skill_id, path) constraint already indexes skill_id-prefixed manifest
-- scans (listFiles), so no separate CREATE INDEX (matches the minimal-index house style).
