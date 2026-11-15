-- cf-memory — soft-delete for sessions (issue: session retraction), mirroring
-- notes' (0001) and skills' (0011) deleted_at. Lets a session be retracted from
-- every discovery surface (session_list / session search / recall's episodic +
-- events-fallback tiers) while the row and its entries persist (recoverable).
-- Closes the gap where episodic recall had no way to drop a stale or erroneous
-- session, and sessions were the only first-class primitive without soft-delete.
ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(user_id, deleted_at);
