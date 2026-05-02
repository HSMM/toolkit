-- Migration 000021: messenger account access grants.
--
-- Accounts can be connected once and then assigned by Toolkit admins to users,
-- similar to WebRTC extension assignment.

CREATE TABLE IF NOT EXISTS messenger_account_access (
    account_id  UUID        NOT NULL REFERENCES messenger_account(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role        TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    granted_by  UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, user_id)
);

INSERT INTO messenger_account_access (account_id, user_id, role)
SELECT id, user_id, 'owner'
FROM messenger_account
ON CONFLICT (account_id, user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS messenger_account_access_user_idx
    ON messenger_account_access (user_id, account_id);
