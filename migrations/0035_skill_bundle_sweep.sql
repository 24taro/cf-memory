-- Keep the scheduled R2 reconciliation proportional to the current list page.
CREATE INDEX IF NOT EXISTS skill_files_r2_key ON skill_files(r2_key);
