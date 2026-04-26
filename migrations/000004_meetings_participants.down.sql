-- Rollback migration 000004.

DROP TRIGGER IF EXISTS meeting_set_updated_at ON meeting;
DROP TABLE IF EXISTS participant;
DROP TABLE IF EXISTS meeting;
