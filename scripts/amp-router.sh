#!/usr/bin/env bash
# Create or update the Amp "Custom URL" connection that points at the proxy.
#
#   scripts/amp-router.sh <proxy-url> [connection-id] < proxy-key-file
#
# The proxy key is read from stdin (a file or a secret-manager command piped
# in) and handed to amp through --api-key-file -, so it never appears in
# process arguments or output. The connection serves every anthropic/* model
# ID, so Amp's modes keep their native models. Afterwards set Amp's Claude
# Usage to "Allow Paid-Per-Token Usage" in Settings > Model Routing; the
# script cannot do that.
set -euo pipefail

PROXY_URL=${1:?proxy url, e.g. https://amp-claude-native.<subdomain>.workers.dev}
CONNECTION_ID=${2:-}
if [ -t 0 ]; then echo "pipe the proxy key on stdin, e.g. scripts/amp-router.sh URL < keyfile" >&2; exit 2; fi

FLAGS=(--name "amp-claude-native" --api-format anthropic-messages --base-url "$PROXY_URL"
  --api-key-file - --headers '[]' --model-mapping 'anthropic/*')

if [ -z "$CONNECTION_ID" ]; then
  amp config model-providers add-router custom-url --personal --active "${FLAGS[@]}"
else
  amp config model-providers edit-router "$CONNECTION_ID" "${FLAGS[@]}"
  amp config model-providers activate "$CONNECTION_ID"
fi
amp config model-providers list
