-- Заявки пользователей на закрепление внутреннего номера. Создаются, когда у
-- пользователя нет привязанного extension'а в phone_config.extensions[].
-- Админ закрывает заявку через approve (с указанием ext) или reject (с причиной).

CREATE TABLE IF NOT EXISTS phone_extension_request (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status              TEXT        NOT NULL
                                    CHECK (status IN ('pending','approved','rejected','cancelled')),
    comment             TEXT,                       -- от заявителя
    reject_reason       TEXT,                       -- от админа при отклонении
    assigned_extension  TEXT,                       -- заполняется при approve
    resolved_at         TIMESTAMPTZ,
    resolved_by         UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Не больше одной активной заявки на пользователя.
CREATE UNIQUE INDEX IF NOT EXISTS phone_extension_request_active_uniq
    ON phone_extension_request (user_id) WHERE status = 'pending';

-- Часто фильтруем по статусу + сортируем по created_at DESC (страница админа).
CREATE INDEX IF NOT EXISTS phone_extension_request_status_created_idx
    ON phone_extension_request (status, created_at DESC);

DROP TRIGGER IF EXISTS phone_extension_request_set_updated_at ON phone_extension_request;
CREATE TRIGGER phone_extension_request_set_updated_at
    BEFORE UPDATE ON phone_extension_request
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
