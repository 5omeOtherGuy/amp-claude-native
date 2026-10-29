#!/usr/bin/env bash
# Create or update the Amp "Custom URL" model provider connection that points
# at the deployed Worker, and map Amp's mode models to Claude models.
#
#   scripts/amp-router.sh <worker-url> [connection-id]
#
# The proxy key is read from the Bitwarden agent vault entry named by
# AMP_CLAUDE_NATIVE_KEY_ENTRY (default: amp-claude-native-proxy-key); it is
# piped to amp and never printed. The model mapping lives in MAPPING below;
# Amp mode -> Amp model was measured on 2026-10-29 with `amp threads usage`.
set -euo pipefail

WORKER_URL=${1:?worker url, e.g. https://amp-claude-native.<subdomain>.workers.dev}
CONNECTION_ID=${2:-}
KEY_ENTRY=${AMP_CLAUDE_NATIVE_KEY_ENTRY:-amp-claude-native-proxy-key}

# Amp model ID (left) served by the Claude model ID (right). Lines are
# newline-separated; only exact IDs may carry "->".
MAPPING=$(cat <<'EOF'
openai/gpt-5.6-terra -> claude-sonnet-4-6
openai/gpt-6.1-sol -> claude-opus-4-6
openai/gpt-6-astra -> claude-opus-5-5
# Plugin modes from amp/claude-modes.ts request these IDs directly.
anthropic/claude-sonnet-4-6 -> claude-sonnet-4-6
anthropic/claude-opus-4-6 -> claude-opus-4-6
anthropic/claude-opus-5-5 -> claude-opus-5-5
anthropic/claude-fable-5-1 -> claude-fable-5-1
EOF
)

if [ -z "$CONNECTION_ID" ]; then
  rbw get "$KEY_ENTRY" | amp config model-providers add-router custom-url \
    --personal --active --name "Claude Subscription via amp-claude-native" \
    --api-format anthropic-messages --base-url "$WORKER_URL" \
    --api-key-file - --headers '[]' --model-mapping "$MAPPING"
else
  rbw get "$KEY_ENTRY" | amp config model-providers edit-router "$CONNECTION_ID" \
    --name "Claude Subscription via amp-claude-native" \
    --api-format anthropic-messages --base-url "$WORKER_URL" \
    --api-key-file - --headers '[]' --model-mapping "$MAPPING"
  amp config model-providers activate "$CONNECTION_ID"
fi
amp config model-providers list
