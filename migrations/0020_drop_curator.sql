-- Curator removed wholesale (owner decision 2026-07-17): cf-memory is personal and
-- curation is done silently client-side by the agent (ADD/UPDATE/DELETE via the
-- normal write tools). The suggestion queue's lifetime stats sealed the case:
-- 64 suggestions -> 47 rejected / 13 superseded / 4 accepted (~8% accept rate).
-- The one primitive worth keeping — the reversible COLD tier — lives on as
-- notes_archive/notes_unarchive (archived_at column is untouched).
-- Ordering: deploy the curator-less Worker BEFORE applying this migration (or
-- apply+deploy back-to-back outside 03:00 UTC) — old code's nightly cron and
-- /curator/* routes error against the dropped table (log noise, no data harm).
DROP TABLE IF EXISTS curator_suggestions;
