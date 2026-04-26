-- Rollback migration 000007.

DROP TRIGGER IF EXISTS softphone_status_set_updated_at ON softphone_status;
DROP TRIGGER IF EXISTS gdpr_request_set_updated_at ON gdpr_request;

DROP TABLE IF EXISTS softphone_status;
DROP TABLE IF EXISTS gdpr_request;
