-- Migration 000014: глобальные системные настройки (key-value).
-- Сейчас используется для «Доступ к модулям»: какие модули видят
-- non-admin пользователи. Админы видят всё всегда.
-- value — JSONB чтобы хранить разные форматы (объекты, массивы, скаляры).

CREATE TABLE IF NOT EXISTS system_setting (
    key         TEXT        PRIMARY KEY,
    value       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_by  UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS system_setting_set_updated_at ON system_setting;
CREATE TRIGGER system_setting_set_updated_at
    BEFORE UPDATE ON system_setting
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Сидим дефолт: все модули включены.
INSERT INTO system_setting (key, value) VALUES
    ('module_access', '{"vcs":true,"transcription":true,"messengers":true,"contacts":true,"helpdesk":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
