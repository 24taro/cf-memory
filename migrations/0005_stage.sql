-- cf-memory — epistemic `stage` for notes (digital-garden growth: seedling →
-- budding → evergreen). Settable via frontmatter; the curator's recall-side
-- (auto-demote / graveyard) reasons over it. SQLite ALTER can't add a CHECK, so
-- the value set is enforced in app code.
ALTER TABLE notes ADD COLUMN stage TEXT NOT NULL DEFAULT 'seedling';
CREATE INDEX IF NOT EXISTS idx_notes_stage ON notes(user_id, stage);
