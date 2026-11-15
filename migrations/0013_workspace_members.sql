-- cf-memory — explicit per-user workspace membership (issue #83, SECURITY CORE).
-- Today "team sharing" is connection-header equality: anyone sending the same
-- X-Cf-Memory-Workspace string can read that workspace's shared rows (see
-- isReadableInWorkspace). This table adds an explicit membership gate so only
-- INVITED members get teammate read-access. Approved scope: (B) single-owner —
-- a production audit confirmed ZERO multi-author non-'global' workspaces and
-- users=1, so backfilling the single author as 'owner' and a one-owner-per-key
-- constraint are safe. Migrate to a surrogate workspace-id later if/when
-- multiple owners exist. Integer epoch (ms) timestamps mirror 0001_init.sql.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_key TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  added_by      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, user_id),
  CHECK (workspace_key <> 'global')
);
-- one owner per key (critique fix): a key cannot have two owner-lineages
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_one_owner ON workspace_members(workspace_key) WHERE role = 'owner';
-- backfill: single-author confirmed by audit, so each existing non-global key's
-- author becomes its owner (idempotent). Keys are lower(trim())-canonicalized to
-- match the runtime gate (canonicalWorkspaceKey), which lowercases the header
-- before every isMember lookup — so the backfilled key must equal what the gate
-- will look up. Production audit confirmed all existing keys are already
-- canonical, so this is a no-op on current data but keeps the invariant.
INSERT OR IGNORE INTO workspace_members (workspace_key, user_id, role, added_by, created_at, updated_at)
SELECT DISTINCT lower(trim(workspace)), user_id, 'owner', NULL, CAST(strftime('%s','now') AS INTEGER)*1000, CAST(strftime('%s','now') AS INTEGER)*1000
FROM notes    WHERE workspace <> 'global' AND deleted_at IS NULL
UNION
SELECT DISTINCT lower(trim(workspace)), user_id, 'owner', NULL, CAST(strftime('%s','now') AS INTEGER)*1000, CAST(strftime('%s','now') AS INTEGER)*1000
FROM sessions WHERE workspace <> 'global';
