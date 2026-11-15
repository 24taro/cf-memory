-- cf-memory — T5 skill outcome memory (skills_log_use -> success_rate). The 2025-26
-- Agent-Memory essay's "experience memory": record whether USING a skill actually
-- WORKED, so discovery can surface "what worked last time" instead of only recency.
-- Agent-declared, consistent with the silent-curation stance (the agent logs the
-- outcome through the normal write tools; the server never infers success). Realizes
-- the `success_rate` column + `skill_invocations` telemetry DESIGN.md earmarked but
-- never shipped (FIDELITY F5).
--
-- Ordering: apply this migration BEFORE deploying the code that reads the new
-- columns (additive; opposite of the DROP migrations). Old live code ignores
-- success_rate / invocation_count, so applying first is safe during rollout.
--
-- Columns nullable / DEFAULT, matching the ALTER-ADD (no CHECK) precedent of
-- 0005_stage / 0018_scope. success_rate NULL = no invocation logged yet.
ALTER TABLE skills ADD COLUMN success_rate     REAL;                        -- AVG outcome value (success=1, partial=.5, failure=0); NULL until first log
ALTER TABLE skills ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 0;  -- total skills_log_use records (distinct from usage_count = INSTALLS)

-- One row per logged invocation (the source of truth; success_rate/invocation_count
-- on `skills` are denormalized from here for cheap reads/surfacing). CHECK is fine on a
-- fresh CREATE TABLE (unlike the ALTER-ADD columns above).
CREATE TABLE IF NOT EXISTS skill_invocations (
  id         TEXT PRIMARY KEY,                       -- ULID
  skill_id   TEXT NOT NULL REFERENCES skills(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  outcome    TEXT NOT NULL CHECK (outcome IN ('success','partial','failure')),
  note       TEXT,                                   -- optional: what happened / why it failed / the lesson
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_invocations ON skill_invocations(skill_id, created_at);
