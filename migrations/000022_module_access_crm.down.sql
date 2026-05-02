UPDATE system_setting
SET value = value - 'crm',
    updated_at = NOW()
WHERE key = 'module_access';
