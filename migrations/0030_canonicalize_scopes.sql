-- Scopes are a git remote or 'global' (the rule since 0028). Rows written
-- before that rule may still hold a bare label or an absolute path; those have
-- no project of their own, so they become 'global'.
UPDATE notes  SET scope = 'global' WHERE scope <> 'global' AND (scope NOT LIKE '%/%' OR scope LIKE '/%');
UPDATE skills SET scope = 'global' WHERE scope <> 'global' AND (scope NOT LIKE '%/%' OR scope LIKE '/%');
