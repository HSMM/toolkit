-- Migration 000017: user-scoped browser softphone call log.
--
-- Журнал привязан к паре user_id + extension. Это важно для переиспользования
-- внутренних номеров: новый владелец extension'а не видит старую историю, но
-- прежний владелец снова увидит её при возврате того же extension'а.

CREATE TABLE IF NOT EXISTS softphone_call_log (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension       TEXT        NOT NULL,
    session_id      TEXT,
    direction       TEXT        NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'missed')),
    peer_number     TEXT        NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    duration_sec    INT,
    status          TEXT        NOT NULL CHECK (status IN ('answered', 'missed', 'failed', 'cancelled', 'ended')),
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS softphone_call_log_owner_ext_started_idx
    ON softphone_call_log (user_id, extension, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS softphone_call_log_session_uniq
    ON softphone_call_log (user_id, extension, session_id)
    WHERE session_id IS NOT NULL AND session_id <> '';
