-- The implicit rowid suffix orders revisions of each note by commit insertion.
CREATE INDEX IF NOT EXISTS idx_note_revision_commit_order ON note_revisions(note_id);
