#!/usr/bin/env bash
# Create or update the Amp "Custom URL" connection that points at the Worker.
#
#   scripts/amp-router.sh <worker-url> [connection-id]
#
# The connection serves every anthropic/* model ID; pick Claude explicitly in
# a mode (Tune Modes or a plugin mode such as amp/claude-modes.ts). The proxy
# key is piped from the vault entry amp-claude-native-proxy-key, never printed.
set -euo pipefail

WORKER_URL=${1:?worker url, e.g. https://amp-claude-native.<subdomain>.workers.dev}
CONNECTION_ID=${2:-}
FLAGS=(--name "Claude Subscription (amp-claude-native)" --api-format anthropic-messages
  --base-url "$WORKER_URL" --api-key-file - --headers '[]' --model-mapping 'anthropic/*')

if [ -z "$CONNECTION_ID" ]; then
  rbw get amp-claude-native-proxy-key | amp config model-providers add-router custom-url --personal --active "${FLAGS[@]}"
else
  rbw get amp-claude-native-proxy-key | amp config model-providers edit-router "$CONNECTION_ID" "${FLAGS[@]}"
  amp config model-providers activate "$CONNECTION_ID"
fi
amp config model-providers list
