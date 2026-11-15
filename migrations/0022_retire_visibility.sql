-- Decision 9 (2026-07-17): the visibility axis (public/unlisted/private) is
-- RETIRED. cf-memory is a single-owner personal instance — every read door is
-- owner-only and fail-closed (web redirects to /login; API/MCP 401). All 15
-- live notes + 1 skill were already 'private'; nothing public ever shipped.
-- published_at only ever stamped public notes, so it dies with the axis.
-- Ordering: deploy the owner-only Worker FIRST, then apply (old code SELECTs
-- these columns and would 500 against a migrated DB).
DROP INDEX IF EXISTS idx_notes_visibility;
DROP INDEX IF EXISTS idx_skills_visibility;
ALTER TABLE notes DROP COLUMN visibility;
ALTER TABLE notes DROP COLUMN published_at;
ALTER TABLE skills DROP COLUMN visibility;
