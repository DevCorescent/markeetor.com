#!/usr/bin/env bash
# Restores a backup produced by scripts/backup.sh into the database in RESTORE_DATABASE_URL.
# Use a scratch database first so restores can be verified without touching live data.
# RESTORE_DATABASE_URL must use an administrative role (superuser or BYPASSRLS owner), because every
# table enforces row-level security. Afterwards ensure the app role owns the restored objects.
#   RESTORE_DATABASE_URL=postgresql://.../leads_crm_restore bash scripts/restore.sh backups/<timestamp>
set -euo pipefail
DIR="${1:?Usage: restore.sh backups/<timestamp>}"
: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL (use a scratch database first)}"
(cd "$DIR" && shasum -a 256 -c SHA256SUMS)
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "${RESTORE_DATABASE_URL%%\?*}" "$DIR/db.dump"
psql "${RESTORE_DATABASE_URL%%\?*}" -tAc "SELECT 'leads=' || count(*) FROM leads" -c "SELECT * FROM audit_verify_chain()" || true
echo "Restore complete. Verify row counts and the audit chain above before cutting over."
