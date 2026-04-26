-- Migration 000010: lobby / комната ожидания для гостей встречи (E5.4).
-- admit_state — стейт-машина допуска участника к комнате LiveKit.
--   'admitted'  — допущен (default — для сотрудников, host'а и admin'а; гости при ручном approve)
--   'pending'   — ждёт подтверждения от host'а (только для is_guest=true сразу после /request)
--   'rejected'  — host явно отказал; гость видит сообщение и не получает токен
--
-- Все существующие participant'ы получают 'admitted' (миграционно безопасно для
-- созданных ранее встреч).

ALTER TABLE participant
    ADD COLUMN IF NOT EXISTS admit_state TEXT NOT NULL DEFAULT 'admitted'
        CHECK (admit_state IN ('pending', 'admitted', 'rejected'));

-- Часто идёт «дай pending для встречи» при поллинге host'ом.
CREATE INDEX IF NOT EXISTS participant_pending_idx
    ON participant (meeting_id, created_at DESC)
    WHERE admit_state = 'pending';
