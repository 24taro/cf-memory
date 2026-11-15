CREATE TABLE embedding_jobs (
  kind TEXT NOT NULL CHECK(kind IN ('note','skill')),
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(kind,memory_id)
);
CREATE INDEX embedding_jobs_pending ON embedding_jobs(status,updated_at);
