-- cf-memory — remove the workspace / team-sharing subsystem entirely (issue #115).
-- cf-memory is single-user, so the multi-user `workspace` dimension (per-connection
-- X-Cf-Memory-Workspace isolation + membership-gated team sharing) was pure dead
-- weight AND actively misleading: the header was accepted but silently no-op'd
-- for the owner. All read paths collapse to owner-or-public (visibility), so the
-- workspace columns and their side-tables are dropped here. Auth/identity
-- (users, api_keys, web_sessions, is_admin) and `visibility` are untouched.
--
-- Drop the indexes first: SQLite refuses to DROP a column still referenced by an
-- index. FTS triggers index title/body only (never workspace), so the column
-- drops are FTS-safe. Note identity is UNIQUE(user_id, slug) — workspace-free —
-- so dropping the column cannot collide existing rows.
DROP INDEX IF EXISTS idx_notes_workspace;
DROP INDEX IF EXISTS idx_sessions_workspace;
ALTER TABLE notes DROP COLUMN workspace;
ALTER TABLE sessions DROP COLUMN workspace;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspace_labels;
