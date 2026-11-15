-- cf-memory — per-connection `workspace` isolation to prevent cross-context bleed
-- (multi-repo memory pollution). Core-memory blocks are kind='block' notes, so a
-- single column on `notes` isolates all three note-backed tiers at once:
-- working (blocks), archival (notes), and ambient (evergreen). Existing rows fall
-- to 'global' for full backward compatibility — they stay visible from every
-- workspace (the deliberate cross-workspace escape hatch). Mirrors the prior
-- ALTER ADD COLUMN precedent in 0005_stage.sql (SQLite can't add a CHECK here).
ALTER TABLE notes ADD COLUMN workspace TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(user_id, workspace);
