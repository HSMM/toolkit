-- Migration 000004: meeting + participant (ВКС, LiveKit).
-- См. модель данных: toolkit-tz/toolkit-architecture.md, раздел 3, поток 4.4 / 4.6.

-- =========================================================================
-- meeting
-- Видеоконференция, разовая или запланированная (ТЗ 3.2.2).
-- livekit_room_id — идентификатор комнаты в LiveKit, уникален.
-- chat — массив сообщений, сохраняется при завершении встречи.
-- =========================================================================

CREATE TABLE IF NOT EXISTS meeting (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by          UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    title               TEXT        NOT NULL,
    description         TEXT,
    scheduled_at        TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    livekit_room_id     TEXT        NOT NULL,
    record_enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
    auto_transcribe     BOOLEAN     NOT NULL DEFAULT FALSE,
    chat                JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Помечаем встречи с внешними гостями для алертов СБ (ТЗ 4.1).
    has_external        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_livekit_room_uniq ON meeting (livekit_room_id);
CREATE INDEX IF NOT EXISTS meeting_created_by_idx
    ON meeting (created_by, COALESCE(started_at, scheduled_at) DESC) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_scheduled_idx
    ON meeting (scheduled_at) WHERE scheduled_at IS NOT NULL AND started_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_active_idx
    ON meeting (started_at DESC) WHERE started_at IS NOT NULL AND ended_at IS NULL;

DROP TRIGGER IF EXISTS meeting_set_updated_at ON meeting;
CREATE TRIGGER meeting_set_updated_at
    BEFORE UPDATE ON meeting
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- participant
-- Участник встречи. Может быть сотрудником (user_id NOT NULL) или гостем
-- (is_guest=true, external_name NOT NULL, guest_token_hash NOT NULL).
-- Identity участника связывается с аудио-треком через external_id (LiveKit
-- participant identity, передаётся в токене).
-- =========================================================================

CREATE TABLE IF NOT EXISTS participant (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id          UUID        NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    user_id             UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    is_guest            BOOLEAN     NOT NULL DEFAULT FALSE,
    external_name       TEXT,
    external_email      TEXT,
    guest_token_hash    TEXT,
    livekit_identity    TEXT        NOT NULL,
    role                TEXT        NOT NULL DEFAULT 'participant'
                                    CHECK (role IN ('host', 'participant', 'guest')),
    joined_at           TIMESTAMPTZ,
    left_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Сотрудник имеет user_id, гость — external_name + guest_token_hash.
    CONSTRAINT participant_user_or_guest CHECK (
        (is_guest = FALSE AND user_id IS NOT NULL)
        OR
        (is_guest = TRUE  AND user_id IS NULL AND external_name IS NOT NULL AND guest_token_hash IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS participant_meeting_idx ON participant (meeting_id);
CREATE INDEX IF NOT EXISTS participant_user_idx
    ON participant (user_id, joined_at DESC) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participant_livekit_identity_uniq
    ON participant (meeting_id, livekit_identity);
