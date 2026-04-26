DROP INDEX IF EXISTS participant_pending_idx;
ALTER TABLE participant DROP COLUMN IF EXISTS admit_state;
