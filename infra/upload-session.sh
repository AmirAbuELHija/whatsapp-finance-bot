#!/usr/bin/env bash
# Moves an existing WhatsApp login (the auth folder) to the cloud, so the server doesn't need a new QR scan.
# STOP the bot on this computer first: two copies with the same login kick each other off (code 440).
# Usage: infra/upload-session.sh <gcp-project-id> [path/to/auth]
set -euo pipefail
PROJECT_ID="${1:?project id}"
AUTH="${2:-auth}"
BUCKET="${BUCKET:-${PROJECT_ID}-wfb-backups}"

[[ -s "${AUTH}/creds.json" ]] || { echo "No WhatsApp login in ${AUTH}/ (creds.json missing)" >&2; exit 66; }
if pgrep -f "dist/main.js" >/dev/null 2>&1; then
  echo "The bot is still running on this computer. Stop it (Ctrl+C) first." >&2
  exit 1
fi

archive="$(mktemp -t wfb-auth.XXXXXX).tar.gz"
trap 'rm -f "$archive"' EXIT
# No macOS metadata (extended attributes) in the archive: Linux tar warns about every file otherwise.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$AUTH" . 2>/dev/null || tar -czf "$archive" -C "$AUTH" .
gcloud storage cp "$archive" "gs://${BUCKET}/auth/latest.tar.gz" --project "$PROJECT_ID"
echo "✅ Session uploaded. The VM restores it on its next start (only if it has no session yet)."
echo "   Don't start the bot on this computer again, or both copies will fight over the login."
