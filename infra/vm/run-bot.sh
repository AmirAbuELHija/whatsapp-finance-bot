#!/bin/bash
# Starts the bot container (systemd: whatsapp-bot.service). Exit 75 = nothing deployed yet.
# shellcheck source=common.sh
source /etc/wfb/common.sh

mkdir -p "${AUTH_DIR_HOST}" "${STATE_DIR}/home" "${RUN_DIR}"
chmod 700 "${RUN_DIR}" "${STATE_DIR}"

image="$(md instance/attributes/bot-image)"
if [[ -z "$image" ]]; then
  log "No image deployed yet (instance metadata 'bot-image' is empty). Waiting for the first deploy from GitHub Actions."
  exit 75
fi

fetch_env "${RUN_DIR}/bot.env"
restore_auth_if_missing
chown -R "${CONTAINER_UID}:${CONTAINER_UID}" "${AUTH_DIR_HOST}"
chmod 700 "${AUTH_DIR_HOST}"

# Pull from the private registry with the VM's own identity (no stored credentials).
export HOME="${STATE_DIR}/home"
docker-credential-gcr configure-docker --registries="${REGISTRY_HOST}" >/dev/null
log "Pulling ${image}"
docker pull --quiet "$image"
docker rm -f wfb >/dev/null 2>&1 || true

log "Starting ${image}"
exec docker run --rm --name wfb \
  --init \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 600m --memory-swap 600m \
  --pids-limit 256 \
  --log-opt max-size=10m --log-opt max-file=3 \
  -e NODE_ENV=production \
  -e AUTH_DIR=/app/auth \
  -e ENV_FILE=/run/secrets/bot.env \
  -e BOT_IMAGE="$image" \
  -v "${RUN_DIR}/bot.env:/run/secrets/bot.env:ro" \
  -v "${AUTH_DIR_HOST}:/app/auth" \
  "$image"
