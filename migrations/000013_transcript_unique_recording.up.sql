-- Migration 000013: idempotency для transcript на одной recording.
-- Защищает от дубля при retry webhook'а LiveKit egress_ended (мы вставляем
-- transcript + enqueue job в OnEgressEnded; ретрай мог бы создать дубль
-- расшифровки и сжечь GigaAM-квоту).
--
-- Уникальный partial: в схеме могут быть исторически несколько transcript на
-- одну recording (revisions), но active queued/processing/completed — только один.

CREATE UNIQUE INDEX IF NOT EXISTS transcript_recording_active_uniq
    ON transcript (recording_id)
    WHERE status IN ('queued', 'processing', 'completed', 'partial');
