-- Migration 000009: гостевые ссылки для встречи (E5.3).
-- guest_link_token — публичный URL-safe секрет, переходом по которому любой
-- пользователь может присоединиться к встрече без авторизации Toolkit.
-- NULL значит "гостевой доступ ещё не выпущен" (или отозван).

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS guest_link_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS meeting_guest_link_uniq
    ON meeting (guest_link_token) WHERE guest_link_token IS NOT NULL;
