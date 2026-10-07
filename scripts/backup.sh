#!/usr/bin/env bash
# Logical backup of the database plus private file storage.
#   npm run db:backup                 → backups/<timestamp>/{db.dump,storage.tar.gz,SHA256SUMS}
# Schedule this (cron / k8s CronJob) and ship backups to encrypted, access-controlled off-site storage.
set -euo pipefail
# Portable .env read (macOS ships bash 3.2, where `source <(...)` is unreliable).
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in BACKUP_DATABASE_URL|STORAGE_DIR) [ -z "${!k:-}" ] && export "$k=$v" ;; esac
  done < <(grep -E '^(BACKUP_DATABASE_URL|STORAGE_DIR)=' .env)
fi
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required — a read-only role with BYPASSRLS (see scripts/db-setup.sh)}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="backups/$STAMP"
mkdir -p "$OUT"
chmod 700 backups "$OUT"
# Tables use FORCE ROW LEVEL SECURITY, so even the owner cannot dump them; the backup role has BYPASSRLS + pg_read_all_data.
pg_dump --format=custom --no-owner --no-privileges --file "$OUT/db.dump" "${BACKUP_DATABASE_URL%%\?*}"
if [ -d "${STORAGE_DIR:-./storage}" ]; then tar -czf "$OUT/storage.tar.gz" -C "${STORAGE_DIR:-./storage}" .; fi
(cd "$OUT" && shasum -a 256 * > SHA256SUMS)
echo "Backup written to $OUT"
