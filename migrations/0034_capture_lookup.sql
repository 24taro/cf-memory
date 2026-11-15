-- Read-time indexes only: no payload backfill, new durable tier or LLM curator.
CREATE INDEX capture_recent ON capture_events(user_id,occurred_at DESC,id DESC);
CREATE INDEX capture_sessions_recent ON capture_sessions(user_id,started_at DESC,id DESC);
