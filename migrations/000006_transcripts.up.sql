-- Migration 000006: transcript + transcript_segment + transcript_revision.
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3, поток 4.5.
-- Спецификация GigaAM: memory reference_gigaam_api (polling, segments, emo).

-- =========================================================================
-- transcript
-- Один транскрипт = одна запись (recording).
--   - Для звонка: 1 transcript на 1 call recording.
--   - Для ВКС: 1 transcript на каждую per_track recording (N на встречу),
--     "единый транскрипт" формируется JOIN'ом всех segments через recording → meeting.
-- gigaam_task_id — для polling и идемпотентности повторных вызовов.
-- engine_metadata — сырые поля от GigaAM (emo, info, file_path и др.) для будущих фич
-- (ТЗ v1.4 LLM-суммаризация может использовать emo).
-- =========================================================================

CREATE TABLE IF NOT EXISTS transcript (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id             UUID        NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    status                   TEXT        NOT NULL DEFAULT 'pending'
                                         CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'partial', 'failed')),
    engine                   TEXT        NOT NULL DEFAULT 'gigaam',
    engine_version           TEXT,                    -- например "GigaAM v3 E2E RNN-T"
    -- GigaAM интеграция (см. reference_gigaam_api.md)
    gigaam_task_id           TEXT,                    -- task_id из POST /stt/transcribe, для polling
    engine_metadata          JSONB,                   -- сырой result для будущего использования (emo, info)
    execution_time_ms        INT,                     -- result.execution_time × 1000
    -- Retention (ТЗ 4.2): дефолт = retention_until записи + 30 дней.
    retention_until          TIMESTAMPTZ NOT NULL,
    retention_hold           BOOLEAN     NOT NULL DEFAULT FALSE,
    retention_hold_reason    TEXT,
    retention_hold_by        UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    retention_hold_at        TIMESTAMPTZ,
    error_message            TEXT,
    attempts                 INT         NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at             TIMESTAMPTZ
);

-- Один транскрипт на recording.
CREATE UNIQUE INDEX IF NOT EXISTS transcript_recording_uniq ON transcript (recording_id);

-- Worker выбирает в работу: status='queued' или 'processing' (для polling).
CREATE INDEX IF NOT EXISTS transcript_status_idx
    ON transcript (status, created_at) WHERE status IN ('queued', 'processing');

-- Retention cleanup.
CREATE INDEX IF NOT EXISTS transcript_retention_idx
    ON transcript (retention_until) WHERE retention_hold = FALSE;

-- Поиск висящих GigaAM задач (для recovery после рестарта worker'а).
CREATE INDEX IF NOT EXISTS transcript_gigaam_task_idx
    ON transcript (gigaam_task_id) WHERE gigaam_task_id IS NOT NULL;

DROP TRIGGER IF EXISTS transcript_set_updated_at ON transcript;
CREATE TRIGGER transcript_set_updated_at
    BEFORE UPDATE ON transcript
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- transcript_segment
-- Сегмент транскрипта (одна "фраза"). Тайм-коды wall-clock от начала встречи
-- (для ВКС per-track применяется сдвиг = participant.joined_at - meeting.started_at).
-- speaker_ref:
--   - Для ВКС per-track: "user:<uuid>" или "external:<имя гостя>" (известно из participant).
--   - Для звонков: "channel:1" / "channel:2" если стерео+диаризация (GigaAM channel),
--     иначе "side:internal" / "side:external" определяется по from/to_user_id call.
-- =========================================================================

CREATE TABLE IF NOT EXISTS transcript_segment (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id   UUID        NOT NULL REFERENCES transcript(id) ON DELETE CASCADE,
    segment_no      INT         NOT NULL,                -- порядковый из GigaAM result.segments[].segment
    speaker_ref     TEXT        NOT NULL,
    start_ms        INT         NOT NULL,
    end_ms          INT         NOT NULL,
    text            TEXT        NOT NULL,
    -- Версионирование правок (ТЗ 3.2.3): инкремент при ручном редактировании.
    is_edited       BOOLEAN     NOT NULL DEFAULT FALSE,
    version         INT         NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_ms >= start_ms)
);

-- Рендер транскрипта по transcript_id, ORDER BY start_ms.
CREATE INDEX IF NOT EXISTS transcript_segment_render_idx
    ON transcript_segment (transcript_id, start_ms);

-- Поиск по speaker (например, "все реплики Иванова в этой встрече").
CREATE INDEX IF NOT EXISTS transcript_segment_speaker_idx
    ON transcript_segment (transcript_id, speaker_ref);

DROP TRIGGER IF EXISTS transcript_segment_set_updated_at ON transcript_segment;
CREATE TRIGGER transcript_segment_set_updated_at
    BEFORE UPDATE ON transcript_segment
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- transcript_revision
-- История правок транскрипта (ТЗ 3.2.3: "хранится полная история версий;
-- откат доступен администратору и владельцу записи").
-- diff содержит изменения (формат — уточняется при имплементации E7.8,
-- ориентировочно {"segment_id": ..., "old_text": ..., "new_text": ...} или JSON Patch).
-- =========================================================================

CREATE TABLE IF NOT EXISTS transcript_revision (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id   UUID        NOT NULL REFERENCES transcript(id) ON DELETE CASCADE,
    editor_id       UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    edited_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    diff            JSONB       NOT NULL,
    note            TEXT
);

CREATE INDEX IF NOT EXISTS transcript_revision_transcript_idx
    ON transcript_revision (transcript_id, edited_at DESC);
