-- Rollback migration 000001.

DROP TRIGGER IF EXISTS user_set_updated_at ON "user";
DROP FUNCTION IF EXISTS set_updated_at();

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS role_assignment;
DROP TABLE IF EXISTS "user";
