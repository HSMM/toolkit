-- Migration 000003: call (история звонков, импорт из FreePBX CDR).
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3, поток 4.3.

-- =========================================================================
-- call
-- Источник истины — FreePBX CDR (ТЗ 3.2.1). Toolkit инкрементально импортирует
-- CDR через API FreePBX, обогащает метаданными (резолв контакта, ссылка на
-- запись и транскрипт) и сохраняет здесь для быстрого поиска.
-- =========================================================================

CREATE TABLE IF NOT EXISTS call (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    freepbx_cdr_id      TEXT        NOT NULL,
    direction           TEXT        NOT NULL
                                    CHECK (direction IN ('inbound', 'outbound', 'internal')),
    from_number         TEXT,
    to_number           TEXT,
    from_user_id        UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    to_user_id          UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    from_contact_id     UUID        REFERENCES contact_cache(id) ON DELETE SET NULL,
    to_contact_id       UUID        REFERENCES contact_cache(id) ON DELETE SET NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    answered_at         TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    duration_ms         INT,
    status              TEXT        NOT NULL
                                    CHECK (status IN ('answered', 'no_answer', 'busy', 'failed', 'cancelled')),
    has_recording       BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Постобработка звонка пользователем (ТЗ 3.2.1)
    rating              INT         CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    rating_comment      TEXT,
    -- Метаданные импорта
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_cdr             JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Идемпотентность импорта CDR — повторный прогон не создаёт дублей.
CREATE UNIQUE INDEX IF NOT EXISTS call_freepbx_cdr_uniq ON call (freepbx_cdr_id);

-- Пагинация общей истории (админка, отчёты).
CREATE INDEX IF NOT EXISTS call_started_idx ON call (started_at DESC);

-- "Моя история звонков" — выборка по пользователю с сортировкой по дате.
-- Два partial-индекса вместо одного на (COALESCE(from,to)) — для производительности
-- и совместимости с обычным WHERE from_user_id = $1.
CREATE INDEX IF NOT EXISTS call_from_user_started_idx
    ON call (from_user_id, started_at DESC) WHERE from_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_to_user_started_idx
    ON call (to_user_id, started_at DESC) WHERE to_user_id IS NOT NULL;

-- Поиск по номеру (фильтры в истории).
CREATE INDEX IF NOT EXISTS call_from_number_idx ON call (from_number) WHERE from_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_to_number_idx ON call (to_number) WHERE to_number IS NOT NULL;

-- Direction + status — для дашбордов админа (E0.11) и отчётов.
CREATE INDEX IF NOT EXISTS call_direction_status_idx ON call (direction, status, started_at DESC);

-- Триггер автообновления updated_at — функция уже создана в 000001.
DROP TRIGGER IF EXISTS call_set_updated_at ON call;
CREATE TRIGGER call_set_updated_at
    BEFORE UPDATE ON call
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
