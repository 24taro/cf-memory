-- Review round 2 (2026-11-03): keep log_fts in sync when a stored row is
-- changed. log_append never updates a row, but an operator redaction
-- (`UPDATE log_entries SET text=…`) must remove the old
-- text's trigrams; without this trigger they stay searchable and the
-- external-content index fails integrity-check. Apply with 0001 and 0002.
CREATE TRIGGER log_entries_au AFTER UPDATE ON log_entries BEGIN
  INSERT INTO log_fts(log_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO log_fts(rowid, text) VALUES (new.rowid, new.text);
END;
