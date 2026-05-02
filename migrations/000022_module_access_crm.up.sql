-- Migration 000022: enable CRM module flag in module access settings.

INSERT INTO system_setting (key, value)
VALUES ('module_access', '{"vcs":true,"transcription":true,"messengers":true,"crm":true,"contacts":true,"helpdesk":true}'::jsonb)
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(system_setting.value, '{}'::jsonb) || '{"crm":true}'::jsonb,
    updated_at = NOW();
