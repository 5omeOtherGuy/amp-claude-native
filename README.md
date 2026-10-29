# amp-claude-native

Claude models in Amp's own modes, served by a Claude Pro/Max subscription instead of Amp credits.

Amp routes each mode to a model ID (measured 2026-10-29: low → `openai/gpt-5.6-terra`,
medium → `openai/gpt-6.1-sol`, high → `openai/gpt-6-astra`; ultra gave no usage record). An Amp
"Custom URL" model provider connection can take those IDs over, rewrite each to a Claude model ID
and send the request in Anthropic Messages format to a URL of your choice. Amp's own "Claude
Subscription" connection only covers its Claude Code mode, where Amp runs Claude Code.

The URL is this Cloudflare Worker. It holds the Claude Code OAuth token, checks a shared proxy
key, and forwards to `api.anthropic.com` with the two things the OAuth lane requires and Amp does
not send: the Claude Code identity as the first `system` block, and the `anthropic-beta` values
`oauth-2025-04-20,claude-code-20250219`. Without the identity block Opus 4.6 answers
`429 rate_limit_error "Error"` (Haiku 4.5 does not care); measured 2026-10-29 from this repo's
`scripts/live-check.mjs` and a direct probe. Request content is not logged.

Status 2026-10-29: deployed at `https://amp-claude-native.simon-gies.workers.dev` and in use by
the Amp connection "Claude Subscription via amp-claude-native" (id ffa5cec0-0ccc-4438-a3dc-265cfde5f664).
A high-mode thread answered as Claude with `amp threads usage --details` showing every request
"Via Claude Subscription via amp-claude-native", cost $0. Amp still labels the model by its own
ID (GPT-6 Astra) in that table; the Routing column and the `providerModelID` in `check-access`
show the Claude model actually served.

Adaptive-only models (Opus 4.7+, Opus 5.x, Fable 5.x, Sonnet 5.x, Haiku 5.5) reject the
`thinking: {type: "disabled"}` or manual budgets Amp sends; the Worker rewrites those to adaptive
thinking with an effort and drops temperature (`shapeThinking`, measured 2026-10-29 with Opus 5.5).

## Layout

- `src/index.ts` fetch handler; `src/shape.ts` system-prompt and beta shaping (pure, tested).
- `tests/` unit tests, `node --test tests/`. `scripts/live-check.mjs` runs the handler in Node
  against the real API using this machine's Claude Code login (prints status codes only).
- `cloudflare.config.ts` the `cf` project; secrets `CLAUDE_TOKEN` and `PROXY_KEY`.
- `scripts/amp-router.sh` creates or updates the Amp connection and its model mapping.

Canonical copy: P720, `~/Work/amp-claude-native`. No data outside the repository.

## Setup

1. **Token.** The Worker must not share Claude Code's refresh-token chain (refreshing from two
   places logs the other out), so it uses a long-lived token: run `claude setup-token` in a
   browser session and store the printed token in the Bitwarden agent vault as
   `amp-claude-native-claude-token`. Also store a random proxy key as
   `amp-claude-native-proxy-key` (`openssl rand -hex 32`).
2. **Cloudflare.** Sign in once on the deploying machine (`cf auth login`, or `--no-browser` over
   SSH), then from this directory:

   ```sh
   mise exec -- npm install
   printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(rbw get amp-claude-native-claude-token)" \
     "$(rbw get amp-claude-native-proxy-key)" > /dev/shm/amp-claude-native.env
   mise exec -- npx cf deploy --secrets-file /dev/shm/amp-claude-native.env
   rm /dev/shm/amp-claude-native.env
   ```

   `cf deploy` prints the `*.workers.dev` URL. `curl <url>/` answers `amp-claude-native proxy`.
3. **Amp.** `scripts/amp-router.sh <url>` adds the connection (or pass an existing connection ID
   to update it) and activates it. Then set Amp's **Claude Usage** setting to *Allow
   Paid-Per-Token Usage* at <https://ampcode.com/settings/model-routing>: with *Subscription
   Only*, Amp refuses any Claude model outside Claude Code mode before the request reaches the
   connection (measured 2026-10-29, error text "claude-opus-4-6 is paid per token outside Claude
   Code"). The connection still bills nothing per token: the Worker uses the subscription.

Verify: `amp config model-providers test <id>` (GET /v1/models through the Worker), then
`amp config model-providers check-access --provider-model openai/gpt-6-astra --thread <a thread
you own>` must report `modelProviderName` of this connection and `ok: true`, and
`amp threads usage <thread> --details` of a new high-mode thread must list the Claude model.

## Mode mapping

Edit `MAPPING` in `scripts/amp-router.sh` and rerun it with the connection ID. Only exact Amp
model IDs may carry `-> claude-...`; wildcard lines would forward the OpenAI IDs to Anthropic.
Models known to work through this Worker on a Max plan: `claude-haiku-4-5`, `claude-sonnet-4-6`,
`claude-opus-4-6`, `claude-opus-5-5`, `claude-fable-5-1` (2026-10-29).

## Notes

- Anthropic's OAuth lane is meant for Claude Code; this sends Amp's prompts through it from
  Amp's servers. Anthropic has rejected other third-party OAuth clients since 2026-10-18
  ("Third-party apps now draw from your extra usage"). The identity block is what currently
  distinguishes accepted from rejected requests; that can change without notice.
- Secrets live only in the vault and the Worker. Never pass a token on a command line.
