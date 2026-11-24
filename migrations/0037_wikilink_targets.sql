-- Resolve a bounded set of wikilink slugs across visible owner namespaces.
CREATE INDEX IF NOT EXISTS idx_notes_live_slug ON notes(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_slug_redirects_old_slug ON slug_redirects(old_slug);
