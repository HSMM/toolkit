-- Migration 000001: базовые таблицы авторизации и аудита.
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =========================================================================
-- user
-- =========================================================================

CREATE TABLE IF NOT EXISTS "user" (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bitrix_id          TEXT        NOT NULL,
    email              TEXT        NOT NULL,
    full_name          TEXT        NOT NULL,
    phone              TEXT,
    department         TEXT,
    position           TEXT,
    avatar_url         TEXT,
    supervisor_id      UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    extension          TEXT,
    status             TEXT        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'blocked', 'deactivated_in_bitrix')),
    deleted_in_bx24    BOOLEAN     NOT NULL DEFAULT FALSE,
    last_login_at      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_bitrix_id_uniq ON "user" (bitrix_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_email_lower_uniq ON "user" (LOWER(email));
CREATE INDEX IF NOT EXISTS user_supervisor_idx ON "user" (supervisor_id) WHERE supervisor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_full_name_trgm_idx ON "user" USING GIN (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS user_status_idx ON "user" (status);

-- =========================================================================
-- role_assignment
-- Хранится только роль 'admin'. Роль 'user' — дефолт для всех, не материализуется.
-- Роль 'manager' — вычисляется из поля supervisor_id в "user" (контекстно).
-- =========================================================================

CREATE TABLE IF NOT EXISTS role_assignment (
    user_id     UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role        TEXT        NOT NULL CHECK (role IN ('admin')),
    granted_by  UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role)
);

-- =========================================================================
-- session
-- Одна строка = один активный refresh-токен (браузерная сессия пользователя).
-- bitrix_refresh_token_encrypted — для фоновой синхронизации без активного
-- пользовательского запроса. Шифруется ключом из JWT_SECRET производным.
-- =========================================================================

CREATE TABLE IF NOT EXISTS session (
    id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                         UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    refresh_token_hash              TEXT        NOT NULL,
    bitrix_refresh_token_encrypted  TEXT,
    ip                              INET,
    user_agent                      TEXT,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at                      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS session_refresh_token_hash_uniq ON session (refresh_token_hash);
CREATE INDEX IF NOT EXISTS session_user_active_idx ON session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS session_last_used_idx ON session (last_used_at) WHERE revoked_at IS NULL;

-- =========================================================================
-- audit_log (append-only)
-- =========================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL   PRIMARY KEY,
    actor_id     UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    action       TEXT        NOT NULL,
    target_kind  TEXT,
    target_id    TEXT,
    reason       TEXT,
    ip           INET,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_log_actor_occurred_idx ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_kind, target_id) WHERE target_kind IS NOT NULL;

-- =========================================================================
-- Автоматическое обновление updated_at
-- =========================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_set_updated_at ON "user";
CREATE TRIGGER user_set_updated_at
    BEFORE UPDATE ON "user"
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
