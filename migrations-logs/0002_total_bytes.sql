-- Review round 1 (2026-11-03): a per-user daily cap on stored bytes across ALL
-- kinds (LOG_DAILY_TOTAL_BYTES), beside the action-only cap. Additive; apply
-- together with 0001 before the first deploy that binds LOGS.
ALTER TABLE log_daily ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE log_daily ADD COLUMN total_dropped INTEGER NOT NULL DEFAULT 0;
