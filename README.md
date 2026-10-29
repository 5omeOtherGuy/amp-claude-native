# amp-claude-native

Claude models in Amp, served by a Claude Pro/Max subscription instead of Amp credits.

Amp's built-in modes run OpenAI models, and its own "Claude Subscription" connection only covers
the Claude Code mode. Amp's "Custom URL" model provider lets Amp's servers send Anthropic Messages
requests to a URL of your choice for the model IDs you map to it. This Cloudflare Worker is that
URL: it checks a shared key, swaps in a Claude Code OAuth setup token, shapes the request for
Anthropic's OAuth lane and returns the response unchanged, streaming included. The connection
serves every `anthropic/*` model ID, so Claude is used exactly where a mode asks for it; OpenAI
modes stay on their own models.

What the OAuth lane needs beyond a plain Messages request (all measured 2026-10-29, see
`src/shape.ts`): the Claude Code identity as the first `system` block (Opus 4.6 answers 429
without it), the betas `oauth-2025-04-20,claude-code-20250219`, no `anthropic/` prefix on the
model ID, and adaptive thinking instead of disabled or budgeted thinking on adaptive-only models.
Anthropic counts these requests against the subscription's 5-hour and 7-day windows (the
`anthropic-ratelimit-unified-*` response headers); extra usage and API credits are not touched.

## Layout

- `src/index.ts` fetch handler, `src/shape.ts` pure request shaping, `tests/` (`node --test tests/`).
- `scripts/live-check.mjs` runs the handler in Node against the real API with this machine's
  Claude Code login; `scripts/amp-router.sh` creates or updates the Amp connection.
- `amp/claude-modes.ts` optional Amp system plugin with `claude-low/medium/high` modes that
  extend the built-in modes with Claude models.
- `cloudflare.config.ts` the `cf` project; secrets `CLAUDE_TOKEN` and `PROXY_KEY`.

Canonical copy: P720, `~/Work/amp-claude-native`.

## Setup

1. **Secrets in the vault.** `claude setup-token` (browser) gives a long-lived token that does
   not share Claude Code's refresh chain; store it as `amp-claude-native-claude-token`. Store
   `openssl rand -hex 32` as `amp-claude-native-proxy-key`.
2. **Deploy** after `cf auth login` on the deploying machine:

   ```sh
   mise exec -- npm install
   umask 077; F=$(mktemp /dev/shm/acn-XXXXXX)
   printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(rbw get amp-claude-native-claude-token)" "$(rbw get amp-claude-native-proxy-key)" > "$F"
   mise exec -- npx cf deploy --secrets-file "$F"; shred -u "$F"
   ```

3. **Amp.** `scripts/amp-router.sh <worker-url> [connection-id]`, then set Amp's **Claude
   Usage** to *Allow Paid-Per-Token Usage* (ampcode.com/settings/model-routing); with
   *Subscription Only* Amp refuses Claude models outside Claude Code mode before any connection
   is consulted. Nothing is billed per token: the Worker uses the subscription.
4. **Choose Claude in a mode:** pin a Claude model in Tune Modes, or install the plugin
   (`cp amp/claude-modes.ts ~/.config/amp/plugins/`) and use `--mode claude-high`.

## Verify

`amp config model-providers test <id>` calls `/v1/models` through the Worker. For a thread,
`amp threads usage <thread> --details` must show the Routing column "Via Claude Subscription
(amp-claude-native)" and cost $0.

## Risks

Anthropic's OAuth lane is meant for Claude Code; this sends Amp's prompts through it from Amp's
servers. Anthropic has rejected other third-party OAuth clients since 2026-10-18, and the identity
block is what currently separates accepted from rejected requests. A leaked proxy key spends your
subscription quota: rotate it (vault entry, redeploy, `scripts/amp-router.sh`) on suspicion.
