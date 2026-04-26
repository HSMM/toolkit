DROP INDEX IF EXISTS meeting_guest_link_uniq;
ALTER TABLE meeting DROP COLUMN IF EXISTS guest_link_token;
