#!/bin/bash
# Waits for GitHub Actions to change the 'bot-image' metadata and restarts the bot on the new image.
# No SSH and no inbound port needed: the VM listens to its own metadata server.
# shellcheck source=common.sh
source /etc/wfb/common.sh
set +e

url="${METADATA}/instance/attributes/bot-image"
etag=""
while true; do
  headers="$(mktemp)"
  value="$(curl -fsS -D "$headers" -H 'Metadata-Flavor: Google' \
    "${url}?wait_for_change=true&timeout_sec=3600${etag:+&last_etag=${etag}}")"
  code=$?
  new_etag="$(grep -i '^etag:' "$headers" | tr -d '\r' | awk '{print $2}')"
  rm -f "$headers"
  if [[ $code -ne 0 || -z "$new_etag" ]]; then
    sleep 15
    continue
  fi
  if [[ -n "$etag" && "$new_etag" != "$etag" ]]; then
    log "New image deployed: ${value}. Restarting the bot."
    systemctl restart whatsapp-bot.service
  fi
  etag="$new_etag"
done
