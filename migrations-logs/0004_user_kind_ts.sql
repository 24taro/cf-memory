-- 2026-11-05 accuracy follow-up: log_search's 1–2 character (LIKE) windows read
-- the newest prompts and replies apart from the newest actions and errors, one
-- kind at a time and newest first. log_kind_ts is not per user, so it walked
-- every user's rows of that kind; this one reads only the caller's.
CREATE INDEX IF NOT EXISTS log_user_kind_ts ON log_entries(user_id, kind, ts);
