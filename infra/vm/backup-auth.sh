#!/bin/bash
# Uploads the WhatsApp session to the private, versioned backup bucket (wfb-backup.timer + on every stop).
# shellcheck source=common.sh
source /etc/wfb/common.sh

if [[ ! -s "${AUTH_DIR_HOST}/creds.json" ]]; then
  log "No WhatsApp session to back up yet"
  exit 0
fi
mkdir -p "${RUN_DIR}"
archive="${RUN_DIR}/backup.tar.gz"
tar -czf "$archive" -C "${AUTH_DIR_HOST}" .
status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $(token)" -H 'Content-Type: application/gzip' \
  --data-binary "@${archive}" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${BACKUP_OBJECT}")"
rm -f "$archive"
if [[ "$status" != "200" ]]; then
  log "Backup failed (HTTP ${status})"
  exit 1
fi
log "WhatsApp session backed up to gs://${BUCKET}/auth/latest.tar.gz"
