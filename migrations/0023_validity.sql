-- cf-memory — bi-temporal validity + supersession (decision 10): the one genuine gap
-- vs 2025-2026 Agent Memory research (temporal knowledge graphs / "ghost memory"
-- contradiction handling). Lets a note express WHEN a fact held and that a NEWER
-- note replaced it, so recall auto-drops stale/superseded facts while notes_search
-- keeps them (history). AGENT-DRIVEN: the agent declares supersession via
-- `supersedes`; the server never auto-detects contradictions (this does NOT revive
-- the curator — decision 7). This realizes the "optional bi-temporal note columns"
-- earmarked in DESIGN §10 Phase 5.
--
-- Ordering: apply this migration BEFORE deploying the code that reads these
-- columns (the OPPOSITE of the DROP-column migrations 0020/0021/0022, which deploy
-- first). The new code SELECTs/WHEREs valid_from/valid_until/superseded_by, so if
-- it ships before these columns exist every note write AND the per-message recall
-- hook 500 on "no such column". Old (currently-live) code ignores the new columns,
-- so applying the migration first is safe during the rollout window.
--
-- All columns nullable / DEFAULT NULL, matching the ALTER-ADD (no CHECK) precedent
-- of 0005_stage / 0018_scope / 0019_consolidation. NULL means: still valid / not
-- superseded — so every existing row keeps surfacing in recall unchanged.
--   valid_from    : ms epoch the fact became true. NULL = valid since created_at.
--   valid_until   : ms epoch the fact stopped being true. NULL = still valid.
--   superseded_by  : id of the note that replaced this one — DISPLAY/history pointer
--                    only (notes_get surfaces it). NULL = current. Last-writer-wins;
--                    recall hiding is NOT derived from this column (see below).
--   supersedes    : id of the note THIS note replaced — the never-overwritten FORWARD
--                    pointer. Recall hides a note only while a LIVE note supersedes it:
--                    NOT EXISTS (a live note whose supersedes = this note's id) —
--                    derived, so deleting every superseder auto-revives the older fact.
--                    (Reconciled 2026-07-24: the derive was moved off superseded_by,
--                    which last-writer-wins made unsound when two notes supersede one
--                    target; the forward pointer is per-superseder and never clobbered.)
ALTER TABLE notes ADD COLUMN valid_from    INTEGER;
ALTER TABLE notes ADD COLUMN valid_until   INTEGER;
ALTER TABLE notes ADD COLUMN superseded_by TEXT;
ALTER TABLE notes ADD COLUMN supersedes    TEXT;
-- Supports the recall valid_until range scan. NOTE (2026-07-24): the live-superseder
-- NOT EXISTS derive was moved to correlate on `supersedes` (not superseded_by), which
-- this index does NOT cover — at single-owner scale the correlated scan is negligible;
-- add an index on notes(supersedes) if the corpus ever grows large.
CREATE INDEX IF NOT EXISTS idx_notes_valid ON notes(user_id, superseded_by, valid_until);
