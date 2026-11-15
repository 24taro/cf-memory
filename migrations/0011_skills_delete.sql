-- cf-memory — soft-delete for skills (issue #36), mirroring notes' deleted_at
-- pattern (migrations/0001_init.sql). Skills previously had no delete path at
-- all (upsert-overwrite was the only cleanup mechanism).
ALTER TABLE skills ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_skills_deleted ON skills(user_id, deleted_at);
