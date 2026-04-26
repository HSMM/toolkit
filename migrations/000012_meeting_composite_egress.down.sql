DELETE FROM retention_policy WHERE kind = 'meeting_audio';

ALTER TABLE recording DROP CONSTRAINT IF EXISTS recording_kind_check;
ALTER TABLE recording
    ADD CONSTRAINT recording_kind_check
        CHECK (kind IN ('call', 'meeting_composite', 'meeting_per_track'));

ALTER TABLE recording DROP CONSTRAINT IF EXISTS recording_kind_fk_match;
ALTER TABLE recording
    ADD CONSTRAINT recording_kind_fk_match CHECK (
        (kind = 'call'              AND call_id IS NOT NULL AND meeting_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_composite' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_per_track' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NOT NULL)
        OR
        (kind = 'upload')
    );

DROP INDEX IF EXISTS meeting_current_audio_egress_idx;
DROP INDEX IF EXISTS meeting_current_egress_idx;
ALTER TABLE meeting DROP COLUMN IF EXISTS current_audio_egress_id;
ALTER TABLE meeting DROP COLUMN IF EXISTS current_egress_id;
