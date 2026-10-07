#!/usr/bin/env bash
# Creates the application role and databases on a local PostgreSQL (no Docker).
# Must be run by a PostgreSQL superuser. The app role is deliberately NOT a superuser and has
# NOBYPASSRLS — otherwise row-level security would silently not apply.
#   APP_DB_PASSWORD=... BACKUP_DB_PASSWORD=... bash scripts/db-setup.sh
set -euo pipefail
: "${APP_DB_PASSWORD:?Set APP_DB_PASSWORD}"
: "${BACKUP_DB_PASSWORD:?Set BACKUP_DB_PASSWORD}"
psql -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leads_app') THEN
    CREATE ROLE leads_app LOGIN PASSWORD '${APP_DB_PASSWORD}' CREATEDB NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- Read-only backup role: BYPASSRLS is required to dump RLS-protected tables.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leads_backup') THEN
    CREATE ROLE leads_backup LOGIN PASSWORD '${BACKUP_DB_PASSWORD}' NOSUPERUSER BYPASSRLS;
  END IF;
END \$\$;
GRANT pg_read_all_data TO leads_backup;
SQL
for db in leads_crm leads_crm_test; do
  psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || createdb -O leads_app "$db"
done
echo "Done. DATABASE_URL=postgresql://leads_app:<password>@localhost:5432/leads_crm?schema=public"
