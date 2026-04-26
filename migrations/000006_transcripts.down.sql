-- Rollback migration 000006.

DROP TRIGGER IF EXISTS transcript_segment_set_updated_at ON transcript_segment;
DROP TRIGGER IF EXISTS transcript_set_updated_at ON transcript;

DROP TABLE IF EXISTS transcript_revision;
DROP TABLE IF EXISTS transcript_segment;
DROP TABLE IF EXISTS transcript;
