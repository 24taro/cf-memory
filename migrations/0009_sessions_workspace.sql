-- cf-memory — extend workspace isolation (0008_workspace.sql) to sessions.
-- Episodic recall's sessions.episodic()/hasResolvedSession() had no workspace
-- predicate at all, so a resolved session from one project context leaked into
-- recall() calls scoped to an unrelated workspace, and hasResolvedSession()'s
-- cross-workspace check also permanently suppressed the events-derived fallback
-- for every OTHER workspace once any session was resolved anywhere. Mirrors
-- 0008_workspace.sql exactly: NOT NULL DEFAULT 'global' so existing rows stay
-- visible from every workspace (the deliberate cross-workspace escape hatch),
-- same (workspace=? OR workspace='global') predicate pattern as notes.
ALTER TABLE sessions ADD COLUMN workspace TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(user_id, workspace);
