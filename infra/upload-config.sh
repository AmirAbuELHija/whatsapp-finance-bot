#!/usr/bin/env bash
# Stores the bot's .env in Secret Manager as a new version (the VM reads the latest one on each start).
# Usage: infra/upload-config.sh <gcp-project-id> [path/to/.env]
set -euo pipefail
PROJECT_ID="${1:?project id}"
ENV_FILE="${2:-.env}"
SECRET="${SECRET:-wfb-bot-env}"

[[ -f "$ENV_FILE" ]] || { echo "No such file: $ENV_FILE" >&2; exit 66; }
# AUTH_DIR is fixed inside the container; drop machine-specific paths.
filtered="$(mktemp)"
trap 'rm -f "$filtered"' EXIT
grep -v -E '^\s*AUTH_DIR=' "$ENV_FILE" >"$filtered"

gcloud secrets versions add "$SECRET" --project "$PROJECT_ID" --data-file="$filtered"
echo "✅ Saved. Restart the bot to load it:"
echo "   gcloud compute ssh wfb-bot --zone us-central1-a --tunnel-through-iap -- sudo systemctl restart whatsapp-bot"
