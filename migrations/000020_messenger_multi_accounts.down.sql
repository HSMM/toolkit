DROP INDEX IF EXISTS messenger_account_user_provider_idx;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, provider
               ORDER BY updated_at DESC, created_at DESC, id DESC
           ) AS rn
    FROM messenger_account
)
DELETE FROM messenger_account ma
USING ranked
WHERE ma.id = ranked.id
  AND ranked.rn > 1;

ALTER TABLE messenger_account
    ADD CONSTRAINT messenger_account_user_provider_key UNIQUE (user_id, provider);

ALTER TABLE messenger_account
    DROP COLUMN IF EXISTS account_label;
