-- Migration 000002: contact_cache, job (очередь), retention_policy.
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3.

-- =========================================================================
-- contact_cache
-- Локальный кэш контактов из Bitrix24 (сотрудники + CRM-контакты + компании).
-- Назначение: резолв номера за <10 мс при входящем звонке (ТЗ 6.2).
-- Источник истины — Bitrix24; здесь только проекция последней синхронизации.
-- =========================================================================

CREATE TABLE IF NOT EXISTS contact_cache (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT        NOT NULL
                                CHECK (source IN ('bx24_employee', 'bx24_crm_contact', 'bx24_crm_company')),
    external_id     TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    phones          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    emails          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    company         TEXT,
    raw             JSONB,
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_cache_source_external_uniq
    ON contact_cache (source, external_id);

-- GIN на phones — для быстрого поиска по номеру (jsonb @> '"+71234567890"').
-- Резолв номера должен укладываться в <10 мс при ~10k контрагентов.
CREATE INDEX IF NOT EXISTS contact_cache_phones_gin
    ON contact_cache USING GIN (phones jsonb_path_ops);

CREATE INDEX IF NOT EXISTS contact_cache_emails_gin
    ON contact_cache USING GIN (emails jsonb_path_ops);

CREATE INDEX IF NOT EXISTS contact_cache_name_trgm
    ON contact_cache USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contact_cache_last_synced_idx
    ON contact_cache (last_synced_at);

-- =========================================================================
-- job (очередь задач, реализация через FOR UPDATE SKIP LOCKED).
-- Используется worker-режимом бинарника для фоновых задач:
-- sync_users_bitrix24, sync_contacts_bitrix24, import_cdr_freepbx,
-- import_recording_freepbx, transcribe_recording, transcribe_meeting,
-- retention_cleanup, send_email и т.д.
-- =========================================================================

CREATE TABLE IF NOT EXISTS job (
    id              BIGSERIAL   PRIMARY KEY,
    kind            TEXT        NOT NULL,
    payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead_letter')),
    priority        INT         NOT NULL DEFAULT 0,
    attempts        INT         NOT NULL DEFAULT 0,
    max_attempts    INT         NOT NULL DEFAULT 3,
    scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    locked_by       TEXT,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

-- Главный индекс выборки следующей задачи: WHERE status='pending' AND scheduled_at <= NOW()
-- ORDER BY priority DESC, scheduled_at ASC FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS job_dequeue_idx
    ON job (priority DESC, scheduled_at)
    WHERE status = 'pending';

-- Для алертов и наблюдения
CREATE INDEX IF NOT EXISTS job_status_kind_idx ON job (status, kind);
CREATE INDEX IF NOT EXISTS job_dead_letter_idx ON job (created_at DESC) WHERE status = 'dead_letter';

-- =========================================================================
-- retention_policy
-- Хранит сроки удаления по типам данных. Изменяется только админом из UI.
-- Дефолтные значения seedятся ниже из ТЗ 4.2.
-- =========================================================================

CREATE TABLE IF NOT EXISTS retention_policy (
    kind            TEXT        PRIMARY KEY,
    default_days    INT         NOT NULL CHECK (default_days >= 0),
    min_days        INT         NOT NULL CHECK (min_days >= 0),
    max_days        INT         NOT NULL CHECK (max_days >= min_days),
    description     TEXT,
    updated_by      UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Дефолты из ТЗ MVP, раздел 4.2. Поменять можно из админки (E8.9).
INSERT INTO retention_policy (kind, default_days, min_days, max_days, description) VALUES
    ('call_recording',      90,   30,  365, 'Записи звонков (аудио)'),
    ('meeting_composite',   30,    7,  180, 'Записи ВКС — composite (видео+аудио)'),
    ('meeting_per_track',    0,    0,   30, 'Записи ВКС — per-track аудио (удаляются после транскрибации)'),
    ('transcript',         120,    7,  395, 'Транскрипты (срок записи + 30 дней по умолчанию)'),
    ('cdr',                365,  180, 1095, 'CDR / история звонков (метаданные)'),
    ('meeting_chat',        90,   30,  365, 'Чаты встреч ВКС'),
    ('audit_log',         1095,  365, 1825, 'Audit-log (3 года, можно увеличить)'),
    ('session_refresh',     30,    7,   90, 'Refresh-токены сессий'),
    ('db_backup',           30,    7,   90, 'Резервные копии БД'),
    ('gdpr_request',      1095, 1095, 1825, 'Заявки 152-ФЗ и отчёты по ним')
ON CONFLICT (kind) DO NOTHING;

-- Триггер автообновления updated_at — функция set_updated_at() уже создана в 000001.
DROP TRIGGER IF EXISTS retention_policy_set_updated_at ON retention_policy;
CREATE TRIGGER retention_policy_set_updated_at
    BEFORE UPDATE ON retention_policy
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
