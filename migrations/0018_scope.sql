-- cf-memory — context-scoped memory (issue #117): a per-project `scope` axis on
-- notes + skills so recall/search can pre-filter to the caller's CURRENT project
-- (`scope IN (<current>, 'global')`) and stop cross-project misfires.
--
-- This is a RELEVANCE filter, NOT access control (that's `owner`/`visibility`,
-- and #115 removed the old team-sharing `workspace` axis entirely). `scope` is
-- the client-resolved normalized repo (`github.com/acme/cf-memory`) ?? workdir ??
-- 'global'. Existing rows backfill to 'global' (the DEFAULT) so nothing is hidden
-- and an unset-context read still sees everything (staged rollout).
ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE skills ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(user_id, scope);
