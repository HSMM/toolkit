-- Migration 000012: композитная запись встречи (E5.2 pivot).
-- Параллельно идут ДВА RoomCompositeEgress'а:
--   • видео+аудио (MP4, для просмотра)         → meeting.current_egress_id
--   • только аудио (OGG/Opus, для транскрипта) → meeting.current_audio_egress_id
-- Прежнее participant.current_egress_id остаётся (под будущий per-track),
-- сейчас не используется.
--
-- Для второй (audio) дорожки в recording добавляем kind='meeting_audio'.

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS current_egress_id       TEXT,
    ADD COLUMN IF NOT EXISTS current_audio_egress_id TEXT;

CREATE INDEX IF NOT EXISTS meeting_current_egress_idx
    ON meeting (current_egress_id) WHERE current_egress_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_current_audio_egress_idx
    ON meeting (current_audio_egress_id) WHERE current_audio_egress_id IS NOT NULL;

-- Расширяем CHECK у recording.kind. PG не позволяет ALTER CHECK, поэтому
-- DROP + ADD. Имя дефолтного check'а — recording_kind_check (генерится PG).
ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_check;
ALTER TABLE recording
    ADD CONSTRAINT recording_kind_check
        CHECK (kind IN ('call', 'meeting_composite', 'meeting_per_track', 'meeting_audio', 'upload'));

-- И recording_kind_fk_match — добавляем ветку для meeting_audio (как у composite).
ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_fk_match;
ALTER TABLE recording
    ADD CONSTRAINT recording_kind_fk_match CHECK (
        (kind = 'call'              AND call_id IS NOT NULL AND meeting_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_composite' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_audio'     AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_per_track' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NOT NULL)
        OR
        (kind = 'upload')
    );

-- Retention для аудио-дорожки встречи. Удаляем после транскрипции (по аналогии с per_track).
INSERT INTO retention_policy (kind, default_days, min_days, max_days, description) VALUES
    ('meeting_audio', 0, 0, 30, 'Записи ВКС — composite аудио (удаляются после транскрибации)')
ON CONFLICT (kind) DO NOTHING;
