DROP INDEX IF EXISTS participant_current_egress_idx;
ALTER TABLE participant DROP COLUMN IF EXISTS current_egress_id;
ALTER TABLE meeting     DROP COLUMN IF EXISTS recording_started_at;
ALTER TABLE meeting     DROP COLUMN IF EXISTS recording_active;
