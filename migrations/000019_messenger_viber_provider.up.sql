-- Migration 000019: allow Viber as a first-class messenger provider.
--
-- Viber uses the same messenger_account / messenger_chat /
-- messenger_message cache as Telegram, with a separate worker/runtime.

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname
      INTO constraint_name
      FROM pg_constraint
     WHERE conrelid = 'messenger_account'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%provider%'
     LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE messenger_account DROP CONSTRAINT %I', constraint_name);
    END IF;

    ALTER TABLE messenger_account
        ADD CONSTRAINT messenger_account_provider_check
        CHECK (provider IN ('telegram', 'viber'));
END $$;
