-- Migration 000020: allow multiple messenger accounts per user/provider.

ALTER TABLE messenger_account
    ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT '';

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname
      INTO constraint_name
      FROM pg_constraint
     WHERE conrelid = 'messenger_account'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, provider)'
     LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE messenger_account DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS messenger_account_user_provider_idx
    ON messenger_account (user_id, provider, status, updated_at DESC);
