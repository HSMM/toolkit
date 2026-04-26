# apps/worker

Worker-процесс Toolkit — запускает фоновые задачи.

## Статус: плейсхолдер

Реализуется как **тот же бинарник**, что `apps/api`, только с флагом `--mode=worker`. Отдельной кодовой базы не нужно.

В итерации 2+ будут задачи:

- `sync_users_bitrix24` — синхронизация сотрудников из Bitrix24 (E2.4).
- `sync_contacts_bitrix24` — синхронизация CRM-контактов (E2.5).
- `transcribe_recording` — отправка записи в GigaAM (E7.3).
- `transcribe_meeting` — N параллельных transcribe для per-track + мёрдж (E7.4).
- `retention_cleanup` — удаление устаревших записей/транскриптов (E7.11 + общая логика).
- `audit_snapshot` — ежесуточный снэпшот audit-log с хешем в MinIO.
