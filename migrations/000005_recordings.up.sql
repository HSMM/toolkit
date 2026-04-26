-- Migration 000005: recording (полиморфная — call / meeting_composite / meeting_per_track).
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3.
-- Потоки: 4.3 (импорт записей звонков), 4.4 (запись ВКС composite + per_track).

-- =========================================================================
-- recording
-- Полиморфная по полю kind:
--   - 'call'                  → call_id NOT NULL, meeting_id NULL, participant_id NULL
--   - 'meeting_composite'     → meeting_id NOT NULL, call_id NULL, participant_id NULL
--   - 'meeting_per_track'     → meeting_id NOT NULL, participant_id NOT NULL, call_id NULL
-- s3_key уникален — идемпотентность импорта.
-- retention_until заполняется при INSERT по retention_policy для соответствующего kind.
-- retention_hold позволяет заморозить удаление (ТЗ 4.2).
-- =========================================================================

CREATE TABLE IF NOT EXISTS recording (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                     TEXT        NOT NULL
                                         CHECK (kind IN ('call', 'meeting_composite', 'meeting_per_track')),
    call_id                  UUID        REFERENCES call(id) ON DELETE CASCADE,
    meeting_id               UUID        REFERENCES meeting(id) ON DELETE CASCADE,
    participant_id           UUID        REFERENCES participant(id) ON DELETE CASCADE,
    s3_bucket                TEXT        NOT NULL,
    s3_key                   TEXT        NOT NULL,
    size_bytes               BIGINT,
    duration_ms              INT,
    mime_type                TEXT,
    -- Стерео ли запись звонка (важно для GigaAM-диаризации, см. reference_gigaam_api).
    is_stereo                BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Retention (ТЗ 4.2)
    retention_until          TIMESTAMPTZ NOT NULL,
    retention_hold           BOOLEAN     NOT NULL DEFAULT FALSE,
    retention_hold_reason    TEXT,
    retention_hold_by        UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    retention_hold_at        TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Полиморфизм: ровно одна группа FK активна по kind.
    CONSTRAINT recording_kind_fk_match CHECK (
        (kind = 'call'              AND call_id IS NOT NULL AND meeting_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_composite' AND meeting_id IS NOT NULL AND call_id IS NULL AND participant_id IS NULL)
        OR
        (kind = 'meeting_per_track' AND meeting_id IS NOT NULL AND participant_id IS NOT NULL AND call_id IS NULL)
    )
);

-- Идемпотентность импорта (повторный pull из FreePBX или повторный egress не дублирует).
CREATE UNIQUE INDEX IF NOT EXISTS recording_s3_key_uniq ON recording (s3_bucket, s3_key);

-- Один call → одна запись.
CREATE UNIQUE INDEX IF NOT EXISTS recording_call_uniq
    ON recording (call_id) WHERE kind = 'call';

-- Один meeting → одна composite.
CREATE UNIQUE INDEX IF NOT EXISTS recording_meeting_composite_uniq
    ON recording (meeting_id) WHERE kind = 'meeting_composite';

-- Один participant → одна per_track запись на встречу.
CREATE UNIQUE INDEX IF NOT EXISTS recording_per_track_uniq
    ON recording (meeting_id, participant_id) WHERE kind = 'meeting_per_track';

-- Поиск записей по call/meeting (карточка).
CREATE INDEX IF NOT EXISTS recording_call_idx ON recording (call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recording_meeting_idx ON recording (meeting_id) WHERE meeting_id IS NOT NULL;

-- Retention cleanup (worker-задача).
CREATE INDEX IF NOT EXISTS recording_retention_idx
    ON recording (retention_until) WHERE retention_hold = FALSE;
