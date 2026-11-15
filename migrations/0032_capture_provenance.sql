-- Short-lived sources, never a Recall tier. Composite keys isolate clients/users.
CREATE TABLE capture_sessions (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  platform_source TEXT NOT NULL,
  client_version TEXT NOT NULL,
  repo_context_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE capture_events (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  payload_redacted TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('personal','project')),
  occurred_at INTEGER NOT NULL,
  distill_status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES capture_sessions(user_id, id),
  UNIQUE (user_id, session_id, event_type, tool_use_id)
);
CREATE INDEX capture_timeline ON capture_events(user_id,session_id,occurred_at,id);
CREATE INDEX capture_expiry ON capture_events(expires_at);
CREATE TABLE memory_provenance (
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('note','skill')),
  memory_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('derived_from','confirms','contradicts')),
  generated_by TEXT NOT NULL,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  source_metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_kind,memory_id,event_id,relation)
);
CREATE TABLE client_heartbeats (
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  status_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,client_id)
);
