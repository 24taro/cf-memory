-- cf-memory — record skill USE (issue #95). usage_count (0002) has existed but was
-- never incremented; add last_used_at so the ranking skill tab and the
-- verification badge's 最終利用日 have real data. Both are bumped only on
-- INSTALL (the deliberate "I'm going to use this" action), never on a plain
-- get/view. Nullable, no default: NULL = never used. Mirrors the ADD COLUMN
-- precedent in 0008_workspace.sql / 0010_users_auth.sql.
ALTER TABLE skills ADD COLUMN last_used_at INTEGER;
