-- Migration 000007: gdpr_request + softphone_status.
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3, поток 4.8.

-- =========================================================================
-- gdpr_request
-- Запрос субъекта ПДн на удаление / ограничение обработки (ТЗ 3.3.3).
-- Хранится 3 года с момента исполнения (ТЗ 4.2).
-- =========================================================================

CREATE TABLE IF NOT EXISTS gdpr_request (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Идентификаторы субъекта (хотя бы один должен быть заполнен).
    subject_phone       TEXT,
    subject_email       TEXT,
    subject_name        TEXT,
    -- Жизненный цикл заявки.
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_via        TEXT        NOT NULL DEFAULT 'manual'
                                    CHECK (received_via IN ('manual', 'email', 'web', 'other')),
    created_by          UUID        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    decision            TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (decision IN ('pending', 'delete_all', 'delete_partial', 'rejected')),
    decision_reason     TEXT,
    decision_at         TIMESTAMPTZ,
    decision_by         UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    executed_at         TIMESTAMPTZ,
    executed_by         UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    -- Сводка затронутого: { "calls": N, "recordings": N, "transcripts": N, ... }
    affected_summary    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Ссылка на PDF-отчёт в MinIO (bucket reports).
    report_s3_key       TEXT,
    -- Целевой срок исполнения по ТЗ 3.3.3 — 10 рабочих дней.
    sla_due_at          TIMESTAMPTZ,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Хотя бы один идентификатор субъекта обязателен.
    CONSTRAINT gdpr_subject_present CHECK (
        subject_phone IS NOT NULL OR subject_email IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS gdpr_request_received_idx ON gdpr_request (received_at DESC);
CREATE INDEX IF NOT EXISTS gdpr_request_decision_idx ON gdpr_request (decision, received_at DESC);
CREATE INDEX IF NOT EXISTS gdpr_request_phone_idx ON gdpr_request (subject_phone) WHERE subject_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS gdpr_request_email_idx ON gdpr_request (LOWER(subject_email)) WHERE subject_email IS NOT NULL;
-- SLA-мониторинг: открытые заявки с просроченным сроком.
CREATE INDEX IF NOT EXISTS gdpr_request_sla_idx
    ON gdpr_request (sla_due_at) WHERE decision = 'pending';

DROP TRIGGER IF EXISTS gdpr_request_set_updated_at ON gdpr_request;
CREATE TRIGGER gdpr_request_set_updated_at
    BEFORE UPDATE ON gdpr_request
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- softphone_status
-- Текущий статус присутствия пользователя софтфона (ТЗ 3.2.1).
-- Один пользователь = одна строка (PK = user_id).
-- presence — ручной выбор; auto_in_call — выставляется автоматически API
-- при активном WebRTC-вызове и имеет приоритет в UI (ТЗ 3.2.1).
-- =========================================================================

CREATE TABLE IF NOT EXISTS softphone_status (
    user_id         UUID        PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    presence        TEXT        NOT NULL DEFAULT 'available'
                                CHECK (presence IN ('available', 'busy', 'do_not_disturb', 'lunch', 'away')),
    auto_in_call    BOOLEAN     NOT NULL DEFAULT FALSE,
    schedule        JSONB,                          -- расписание работы (ТЗ 3.3.2), формат уточняется в E5.9
    custom_message  TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Для админ-панели "активные сессии софтфона" (ТЗ 3.3.2 → E8.12).
CREATE INDEX IF NOT EXISTS softphone_status_active_idx
    ON softphone_status (presence) WHERE auto_in_call = TRUE OR presence != 'available';

DROP TRIGGER IF EXISTS softphone_status_set_updated_at ON softphone_status;
CREATE TRIGGER softphone_status_set_updated_at
    BEFORE UPDATE ON softphone_status
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
