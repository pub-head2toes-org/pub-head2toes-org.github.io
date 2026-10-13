#!/bin/sh
# Cloudflare Realtime TURN - see ../../PLAN.md, "Spike: Cloudflare TURN".
#
# What Northern's /turn/api/ice does when started with
#   NORTHERN_TURN=cloudflare
#   NORTHERN_TURN_KEY_ID=<TURN key id>
#   NORTHERN_TURN_KEY_TOKEN=<its API token>
# by hand, to see the credentials a browser gets. The key and its token come
# from the Cloudflare dashboard: Realtime -> TURN Server -> Create.
#
#   TURN_KEY_ID=... TURN_KEY_API_TOKEN=... ./ice-servers.sh
#
# The token is a secret: it stays on the server and never goes to a browser.
# What the browser gets expires after TTL seconds.
set -eu
: "${TURN_KEY_ID:?set TURN_KEY_ID}"
: "${TURN_KEY_API_TOKEN:?set TURN_KEY_API_TOKEN}"
TTL="${TTL:-43200}"

curl -sS -X POST \
  -H "Authorization: Bearer $TURN_KEY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"ttl\": $TTL}" \
  "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers"
echo

# To take credentials back before they expire (USERNAME from the answer):
#   curl -X POST -H "Authorization: Bearer $TURN_KEY_API_TOKEN" \
#     "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/$USERNAME/revoke"
