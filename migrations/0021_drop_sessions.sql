-- Sessions (episodic journals / 会話ログ) removed wholesale (owner decision
-- 2026-07-17, DESIGN.md decision 8): on a personal instance the episodic layer
-- never earned its keep — the 4 rows it ever held were test artifacts that
-- polluted every recall pack's "Relevant past sessions" tier. Durable outcomes
-- belong in notes; recall is now 4 tiers (working/archival/procedural/ambient).
-- Ordering: deploy the sessions-less Worker FIRST, then apply this migration.
-- Migrate-first is NOT a soft window: the old Worker's recall/build_prompt
-- (the owner's every-message hook) queries sessions_fts/sessions OUTSIDE any
-- try/catch and hard-fails with "no such table" on every call — not just the
-- session_* tools. Nothing enforces the order (no CI); do not reverse it.
DROP TABLE IF EXISTS session_entries;
DROP TABLE IF EXISTS sessions_fts;
DROP TABLE IF EXISTS sessions;
