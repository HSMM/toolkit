-- Migration 000023: optional local password authentication.
--
-- Bitrix24 OAuth remains the primary SSO path. A Toolkit user can also log in
-- by email + password after an admin sets password_hash.

ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS user_password_enabled_idx
    ON "user" (LOWER(email))
    WHERE password_hash <> '';
