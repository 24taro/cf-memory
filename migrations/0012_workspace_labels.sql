-- cf-memory — human-friendly display names + colors for workspaces (issue #73).
-- "workspace" is otherwise only the raw X-Cf-Memory-Workspace header string stamped
-- onto notes.workspace (0008) and sessions.workspace (0009); the 記憶ライブラリ
-- screen needs to render those keys with a friendly name/color. This is a pure
-- side-table keyed by (user_id, workspace_key) — it touches no existing table and
-- carries NO isolation logic (the workspace column on notes/sessions still owns
-- that). Rows are per-user, so labels never bleed across users. Integer epoch
-- (ms) timestamps, mirroring the created_at/updated_at idiom in 0001_init.sql.
CREATE TABLE IF NOT EXISTS workspace_labels (
  user_id       TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  display_name  TEXT,
  color         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_key)
);
