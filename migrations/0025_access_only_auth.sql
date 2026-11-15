-- Access-only auth (design 2026-07-25): password/web-session auth is removed.
-- web_sessions backed the eg_session cookie (0010); is_admin/password_hash
-- backed decision 7/8's password login. All three are dead under Access-only
-- single-user auth (the SSO-allowed owner IS the admin). DROP COLUMN requires
-- SQLite >= 3.35 (D1 satisfies this); neither column is indexed / in a CHECK,
-- so DROP COLUMN is legal. Reverse migration lives in the design doc §7.
DROP TABLE IF EXISTS web_sessions;
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN is_admin;
