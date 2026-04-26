-- Rollback migration 000002.

DROP TRIGGER IF EXISTS retention_policy_set_updated_at ON retention_policy;

DROP TABLE IF EXISTS retention_policy;
DROP TABLE IF EXISTS job;
DROP TABLE IF EXISTS contact_cache;
