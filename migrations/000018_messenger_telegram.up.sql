-- Migration 000018: Messenger / Telegram MVP storage.
--
-- Telegram works as a user client via MTProto. Toolkit stores local cache and
-- encrypted per-user session data; Telegram remains the source of truth.

CREATE TABLE IF NOT EXISTS messenger_account (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider            TEXT        NOT NULL CHECK (provider IN ('telegram')),
    provider_user_id    TEXT        NOT NULL DEFAULT '',
    display_name        TEXT        NOT NULL DEFAULT '',
    username            TEXT        NOT NULL DEFAULT '',
    phone_masked        TEXT        NOT NULL DEFAULT '',
    status              TEXT        NOT NULL DEFAULT 'connected'
        CHECK (status IN ('connecting', 'connected', 'error', 'revoked')),
    error_message       TEXT,
    connected_at        TIMESTAMPTZ,
    last_sync_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, provider)
);

-- provider_user_id is intentionally not globally unique: one shared Telegram
-- account may be connected by several Toolkit users, each with a separate
-- encrypted session.
CREATE INDEX IF NOT EXISTS messenger_account_provider_user_idx
    ON messenger_account (provider, provider_user_id)
    WHERE provider_user_id <> '';

CREATE INDEX IF NOT EXISTS messenger_account_status_idx
    ON messenger_account (provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messenger_telegram_session (
    account_id              UUID        PRIMARY KEY REFERENCES messenger_account(id) ON DELETE CASCADE,
    session_encrypted       TEXT        NOT NULL,
    session_fingerprint     TEXT        NOT NULL,
    dc_id                   INTEGER,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messenger_chat (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID        NOT NULL REFERENCES messenger_account(id) ON DELETE CASCADE,
    provider_chat_id     TEXT        NOT NULL,
    type                 TEXT        NOT NULL CHECK (type IN ('private', 'group', 'channel', 'bot', 'unknown')),
    title                TEXT        NOT NULL DEFAULT '',
    avatar_file_id       TEXT,
    unread_count         INTEGER     NOT NULL DEFAULT 0,
    last_message_at      TIMESTAMPTZ,
    last_message_preview TEXT        NOT NULL DEFAULT '',
    pinned               BOOLEAN     NOT NULL DEFAULT FALSE,
    muted                BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, provider_chat_id)
);

CREATE INDEX IF NOT EXISTS messenger_chat_account_last_idx
    ON messenger_chat (account_id, last_message_at DESC NULLS LAST, updated_at DESC);

CREATE TABLE IF NOT EXISTS messenger_message (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id                 UUID        NOT NULL REFERENCES messenger_chat(id) ON DELETE CASCADE,
    provider_message_id     TEXT        NOT NULL,
    direction               TEXT        NOT NULL CHECK (direction IN ('in', 'out')),
    sender_provider_id      TEXT,
    sender_name             TEXT        NOT NULL DEFAULT '',
    text                    TEXT        NOT NULL DEFAULT '',
    status                  TEXT        NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
    sent_at                 TIMESTAMPTZ NOT NULL,
    edited_at               TIMESTAMPTZ,
    raw                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (chat_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS messenger_message_chat_sent_idx
    ON messenger_message (chat_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS messenger_message_retention_idx
    ON messenger_message (created_at);

CREATE TABLE IF NOT EXISTS messenger_attachment (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id              UUID        NOT NULL REFERENCES messenger_message(id) ON DELETE CASCADE,
    provider_file_id        TEXT        NOT NULL,
    kind                    TEXT        NOT NULL CHECK (kind IN ('photo', 'document', 'audio', 'voice', 'video', 'sticker', 'unknown')),
    file_name               TEXT        NOT NULL DEFAULT '',
    mime_type               TEXT        NOT NULL DEFAULT '',
    size_bytes              BIGINT,
    width                   INTEGER,
    height                  INTEGER,
    duration_sec            INTEGER,
    storage_key             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messenger_attachment_message_idx
    ON messenger_attachment (message_id);

CREATE INDEX IF NOT EXISTS messenger_attachment_retention_idx
    ON messenger_attachment (created_at)
    WHERE storage_key IS NOT NULL AND storage_key <> '';
