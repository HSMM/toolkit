DROP INDEX IF EXISTS user_password_enabled_idx;

ALTER TABLE "user"
    DROP COLUMN IF EXISTS password_changed_at,
    DROP COLUMN IF EXISTS password_hash;
