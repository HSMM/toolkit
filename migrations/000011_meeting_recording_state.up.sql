-- Migration 000011: state записи встречи (E5.2).
-- meeting.recording_active        — флаг "сейчас идёт запись" (включается host'ом
--                                    либо автоматом если record_enabled=true).
-- meeting.recording_started_at    — когда фактически стартовали (NULL если не писали).
-- participant.current_egress_id   — id активного LiveKit-egress'а для participant'а
--                                    (NULL если этот участник сейчас не пишется).
--                                    На egress_ended webhook чистим в NULL и
--                                    создаём recording row + enqueue transcribe.

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS recording_active     BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS recording_started_at TIMESTAMPTZ;

ALTER TABLE participant
    ADD COLUMN IF NOT EXISTS current_egress_id TEXT;

-- На webhook egress_ended ищем participant по egress_id — нужен индекс.
CREATE INDEX IF NOT EXISTS participant_current_egress_idx
    ON participant (current_egress_id) WHERE current_egress_id IS NOT NULL;
