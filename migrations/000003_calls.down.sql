-- Rollback migration 000003.

DROP TRIGGER IF EXISTS call_set_updated_at ON call;
DROP TABLE IF EXISTS call;
