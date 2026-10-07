#!/usr/bin/env bash
# Runs once when the Postgres container is first created.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE leads_app LOGIN PASSWORD '${APP_DB_PASSWORD}' CREATEDB NOSUPERUSER NOBYPASSRLS;
CREATE ROLE leads_backup LOGIN PASSWORD '${BACKUP_DB_PASSWORD:-change-me-dev-only}' NOSUPERUSER BYPASSRLS;
GRANT pg_read_all_data TO leads_backup;
CREATE DATABASE leads_crm OWNER leads_app;
CREATE DATABASE leads_crm_test OWNER leads_app;
SQL
