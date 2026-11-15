-- cf-memory — sleep-time consolidation (issue #119): unattended, REVERSIBLE curator
-- housekeeping run in the daily cron. Two new note columns support it:
--
-- last_viewed_at: the last time a note was DELIVERED (notes_get / recall pack).
-- auto-demote must key off real USE, not `updated_at` (last edit) — a frequently
-- recalled but rarely edited evergreen would otherwise be wrongly demoted. NULL =
-- never viewed. incrementView() now sets it alongside view_count.
--
-- archived_at: a COLD tier distinct from `deleted_at`. Archiving must NOT delete
-- (owner requirement): an archived note drops out of recall candidate generation
-- but STAYS in notes_search / FTS (still findable, just not auto-surfaced), and is
-- reversible (un-archive clears the column). Auto-archive AND manual archive-apply
-- both set this instead of soft-deleting. NULL = not archived.
ALTER TABLE notes ADD COLUMN last_viewed_at INTEGER;
ALTER TABLE notes ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(user_id, archived_at);
