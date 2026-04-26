-- Rollback migration 000008.

DROP INDEX IF EXISTS recording_upload_user_idx;

ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_fk_match;

ALTER TABLE recording
    DROP COLUMN IF EXISTS uploaded_by,
    DROP COLUMN IF EXISTS original_filename;

ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_check;

-- Восстанавливаем оригинальный CHECK без 'upload' (DDL из миграции 000005).
ALTER TABLE recording
    ADD CONSTRAINT recording_kind_check
    CHECK (kind IN ('call', 'meeting_composite', 'meeting_per_track'));

ALTER TABLE recording
    ADD CONSTRAINT recording_kind_fk_match CHECK (
        (kind = 'call'              AND call_id IS NOT NULL AND meeting_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_composite' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_per_track' AND meeting_id IS NOT NULL AND participant_id IS NOT NULL AND call_id IS NULL)
    );
