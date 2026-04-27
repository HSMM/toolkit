-- Email-приглашения на встречу. Внутренние сотрудники приглашаются через
-- participant rows (user_id + role='participant'); это таблица для внешних
-- адресатов, которым отправляется ссылка на гостевой вход.

CREATE TABLE IF NOT EXISTS meeting_invitation (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id    UUID        NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    email         TEXT        NOT NULL,
    invited_by    UUID        REFERENCES "user"(id) ON DELETE SET NULL,
    status        TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'sent', 'failed')),
    sent_at       TIMESTAMPTZ,
    last_error    TEXT,
    attempts      INT         NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meeting_invitation_meeting_idx
    ON meeting_invitation (meeting_id);

-- Один email — одно приглашение на встречу (повторное «invite» не плодит дубль).
CREATE UNIQUE INDEX IF NOT EXISTS meeting_invitation_meeting_email_uniq
    ON meeting_invitation (meeting_id, LOWER(email));
