-- PostgreSQL init: создаёт вспомогательные роли и схему.
-- Базовая БД уже создана POSTGRES_DB. Здесь только дополнительные роли.
-- Миграции схемы хранятся в migrations/ и запускаются backend-миграционным runner'ом.

\c :POSTGRES_DB

-- Роль для обычных API-запросов (INSERT/UPDATE/SELECT/DELETE, кроме audit_log)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toolkit_app') THEN
        CREATE ROLE toolkit_app WITH LOGIN PASSWORD 'app-password-change-me';
    END IF;
END $$;

-- Роль для записи в audit_log (INSERT only)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toolkit_audit_writer') THEN
        CREATE ROLE toolkit_audit_writer WITH LOGIN PASSWORD 'audit-writer-change-me';
    END IF;
END $$;

-- Роль для чтения audit_log
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'toolkit_audit_reader') THEN
        CREATE ROLE toolkit_audit_reader WITH LOGIN PASSWORD 'audit-reader-change-me';
    END IF;
END $$;

-- Права будут назначены после миграций, через отдельный GRANT-скрипт,
-- когда таблица audit_log действительно существует.

-- Расширения, полезные в схеме Toolkit
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- для поиска по ФИО
CREATE EXTENSION IF NOT EXISTS "btree_gin";   -- для GIN-индексов на jsonb (номера телефонов)
