-- Migration 000008: добавляет recording.kind='upload' для пользовательских
-- загрузок аудиофайлов на транскрибацию (E7 — модуль «Транскрибация»).
--
-- Загрузка не привязана к call/meeting — используется когда пользователь
-- вручную грузит аудио для расшифровки. Все три FK (call_id, meeting_id,
-- participant_id) при kind='upload' = NULL, добавляется uploaded_by для
-- атрибуции к пользователю-загрузчику.

ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_fk_match;

ALTER TABLE recording
    DROP CONSTRAINT IF EXISTS recording_kind_check;

ALTER TABLE recording
    ADD CONSTRAINT recording_kind_check
    CHECK (kind IN ('call', 'meeting_composite', 'meeting_per_track', 'upload'));

ALTER TABLE recording
    ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS original_filename TEXT;

ALTER TABLE recording
    ADD CONSTRAINT recording_kind_fk_match CHECK (
        (kind = 'call'              AND call_id IS NOT NULL AND meeting_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_composite' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_per_track' AND meeting_id IS NOT NULL AND participant_id IS NOT NULL AND call_id IS NULL)
        OR
        (kind = 'upload'            AND call_id IS NULL AND meeting_id IS NULL AND participant_id IS NULL AND uploaded_by IS NOT NULL)
    );

-- Индекс для пользовательских списков загрузок (история «мои загрузки»).
CREATE INDEX IF NOT EXISTS recording_upload_user_idx
    ON recording (uploaded_by, created_at DESC) WHERE kind = 'upload';
