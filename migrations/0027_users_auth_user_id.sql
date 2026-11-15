-- Link an cf-memory account to its auth.example.com account (2026-08-17).
--
-- Until now this instance had one person and the token subject was their email,
-- so resolvePrincipal looked them up with `WHERE lower(email)=?`. An address is a
-- name someone can change; resolving people by it means a change silently makes
-- them a different person — here, one who falls through to anonymous and sees
-- nothing. With one owner that never happened.
--
-- Unlike tasks, cf-memory DOES provision on first sight: a personal memory store has
-- no workspace to be a member of, so an account that auth vouches for gets its
-- own space. What keeps one person's space private is unchanged and predates this
-- migration — every notes/skills/tags/links/events row carries user_id and
-- isReadable() has always been `row.user_id === principal.userId`.
ALTER TABLE users ADD COLUMN auth_user_id TEXT;

-- One cf-memory account per auth account: without this a second row could claim the
-- same identity and a person's notes would split across two spaces.
CREATE UNIQUE INDEX idx_users_auth_user_id ON users(auth_user_id) WHERE auth_user_id IS NOT NULL;
