-- Migration 000024: one-time local password reset tokens.

CREATE TABLE IF NOT EXISTS password_reset_token (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip          INET,
    user_agent  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_token_hash_uniq
    ON password_reset_token (token_hash);

CREATE INDEX IF NOT EXISTS password_reset_token_user_active_idx
    ON password_reset_token (user_id, expires_at DESC)
    WHERE used_at IS NULL;
