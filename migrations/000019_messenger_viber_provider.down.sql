DELETE FROM messenger_account WHERE provider = 'viber';

ALTER TABLE messenger_account DROP CONSTRAINT IF EXISTS messenger_account_provider_check;

ALTER TABLE messenger_account
    ADD CONSTRAINT messenger_account_provider_check
    CHECK (provider IN ('telegram'));
