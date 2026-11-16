#!/bin/bash
# Shared helpers for the bot's systemd units on Container-Optimized OS.
# Settings (PROJECT_ID, SECRET_NAME, BUCKET, REGISTRY_HOST) come from /etc/wfb/config, written by cloud-init.
set -euo pipefail
# shellcheck disable=SC1091
source /etc/wfb/config

readonly STATE_DIR=/var/lib/wfb
readonly AUTH_DIR_HOST="${STATE_DIR}/auth"
readonly RUN_DIR=/run/wfb
readonly METADATA=http://metadata.google.internal/computeMetadata/v1
readonly BACKUP_OBJECT=auth%2Flatest.tar.gz
readonly CONTAINER_UID=1000 # the "node" user in the image

log() { echo "[wfb] $*"; }

# Reads a metadata value (empty if missing).
md() { curl -fsS -H 'Metadata-Flavor: Google' "${METADATA}/$1" 2>/dev/null || true; }

# Short-lived OAuth token of the VM's service account (never written to disk).
token() {
  md instance/service-accounts/default/token | sed -nE 's/.*"access_token" *: *"([^"]+)".*/\1/p'
}

# The bot's .env from Secret Manager, written to a RAM-only file readable by the container user only.
fetch_env() {
  local out="$1" resp data
  resp="$(curl -fsS -H "Authorization: Bearer $(token)" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest:access")" || {
    log "Could not read secret ${SECRET_NAME}. Add it with: gcloud secrets versions add ${SECRET_NAME} --data-file=.env"
    return 1
  }
  data="$(printf '%s' "$resp" | tr -d '\n ' | sed -nE 's/.*"data":"([^"]+)".*/\1/p')"
  (umask 077 && printf '%s' "$data" | base64 -d >"$out")
  chown "${CONTAINER_UID}:${CONTAINER_UID}" "$out"
  chmod 400 "$out"
}

# Restores the WhatsApp session from the latest backup when this disk has none (new or rebuilt VM).
restore_auth_if_missing() {
  if [[ -s "${AUTH_DIR_HOST}/creds.json" ]]; then return 0; fi
  local archive="${RUN_DIR}/restore.tar.gz" status
  status="$(curl -sS -o "$archive" -w '%{http_code}' -H "Authorization: Bearer $(token)" \
    "https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${BACKUP_OBJECT}?alt=media")"
  if [[ "$status" == "200" ]]; then
    tar -xzf "$archive" -C "${AUTH_DIR_HOST}"
    log "WhatsApp session restored from gs://${BUCKET}/auth/latest.tar.gz"
  else
    log "No WhatsApp session backup (HTTP ${status}): link the bot with a pairing code (see infra/README.md)."
  fi
  rm -f "$archive"
}
