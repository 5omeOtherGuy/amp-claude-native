# amp-claude-native

Claude models in Amp, served by a Claude Pro/Max subscription instead of Amp credits.

Amp's native modes use Claude for some of them (on 2026-10-29: medium on Opus 5.5, ultra on
Fable 5.1; high on GPT-6 Astra, low on GLM-5.3-Flash), billed to Amp credits. Amp's own "Claude
Subscription" connection only covers the Claude Code mode. Amp's "Custom URL" model provider
lets Amp's servers send Anthropic Messages requests to a URL of your choice for the model IDs you
map to it. This proxy is that URL: it checks a shared key, swaps in a Claude Code OAuth setup
token, shapes the request for Anthropic's OAuth lane and returns the response unchanged, streaming
included. The connection serves every `anthropic/*` model ID, so the modes keep their native
models and only the billing of the Claude ones changes. Subagents, thread titles and compaction
run on the thread's model and follow it.

What the OAuth lane needs beyond a plain Messages request (all measured 2026-10-29, see
`src/shape.ts`): the Claude Code identity as the first `system` block (Opus 4.6 answers 429
without it), the betas `oauth-2025-04-20,claude-code-20250219`, no `anthropic/` prefix on the
model ID, and adaptive thinking instead of disabled or budgeted thinking on every model newer
than Opus 4.6, Sonnet 4.6 and Haiku 4.5. Anthropic counts these requests against the
subscription's 5-hour and 7-day windows (the `anthropic-ratelimit-unified-*` response headers);
extra usage and API credits are not touched.

## Layout

- `src/index.ts` fetch handler, `src/shape.ts` pure request shaping, `tests/` (`node --test tests/`).
- `cloudflare.config.ts` the `cf` project for the Worker; `scripts/serve.ts` runs the same
  handler as a local server under Bun.
- `scripts/amp-router.sh` creates or updates the Amp connection from the CLI;
  `scripts/live-check.mjs` runs the handler in Node against the real API with this machine's
  Claude Code login.

Canonical copy: P720, `~/Work/amp-claude-native`.

## 1. Secrets

- `claude setup-token` (opens the browser) prints a long-lived OAuth token that does not share
  Claude Code's refresh chain. Store it in the vault as `amp-claude-native-claude-token`.
- A random proxy key, `openssl rand -hex 32`, as `amp-claude-native-proxy-key`. Amp sends it as
  the connection's API key; the proxy accepts nothing else.

## 2. Hosting

Amp's servers call the proxy, so it needs a public HTTPS address. Two ways to get one:

**Cloudflare Worker** (what runs today, `https://amp-claude-native.simon-gies.workers.dev`).
No machine of yours involved, free tier, secrets stored encrypted on Cloudflare. After
`cf auth login` on the deploying machine:

```sh
mise exec -- npm install
umask 077; F=$(mktemp /dev/shm/acn-XXXXXX)
printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(rbw get amp-claude-native-claude-token)" "$(rbw get amp-claude-native-proxy-key)" > "$F"
mise exec -- npx cf deploy --secrets-file "$F"; shred -u "$F"
```

`cf deploy` prints the URL. Redeploy the same way after a code or token change.

**Local proxy** (the token never leaves your machine; your machine and internet uplink become a
dependency for every Amp request, and the public entry point lands on your workstation):

```sh
CLAUDE_TOKEN="$(rbw get amp-claude-native-claude-token)" PROXY_KEY="$(rbw get amp-claude-native-proxy-key)" bun scripts/serve.ts   # 127.0.0.1:8787
```

Expose it with Tailscale Funnel (`tailscale funnel 8787`, gives `https://<host>.<tailnet>.ts.net`)
or a Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8787`; with the Tunnel,
Cloudflare still terminates TLS and sees the traffic, so it buys nothing over the Worker except
local token storage). Run it as a user systemd service if you keep it. Verified 2026-10-29 that
`scripts/serve.ts` proxies correctly on localhost; the exposure step was not set up here.

## 3. Amp connection and model routing

Either run `scripts/amp-router.sh <proxy-url> [connection-id]`, or do the same in the web UI at
<https://ampcode.com/settings/model-routing>:

1. Add a connection of type **Custom URL**. Name it, API format **anthropic-messages**, base URL
   the proxy URL (Amp appends `/v1/messages`), API key the proxy key, no extra headers.
2. Model mapping: one line, `anthropic/*`. Every Claude model ID Amp uses in any mode then goes
   through the proxy; nothing else is touched. Amp tries connections in priority order and uses
   the first active one whose mapping matches, so the proxy should be the only active connection
   mapping `anthropic/*`.
3. Activate the connection and set **Claude Usage** to *Allow Paid-Per-Token Usage*. With
   *Subscription Only*, Amp refuses Claude models outside Claude Code mode before any connection
   is consulted (measured). Nothing is billed per token: the proxy uses the subscription.
4. Leave Tune Modes on Auto so each mode keeps its native model; a pin moves it.
5. Keep Amp's built-in Claude Subscription connection: the Claude Code mode still needs it.

## Verify

`amp config model-providers test <id>` calls `/v1/models` through the proxy. Run one thread in
medium or ultra; `amp threads usage <thread> --details` must list the Claude model with Routing
"Via <connection name>" and cost $0, for Agent, Task and Thread Title alike.

## Risks

Anthropic's OAuth lane is meant for Claude Code; this sends Amp's prompts through it from Amp's
servers. Anthropic has rejected other third-party OAuth clients since 2026-10-18, and the identity
block is what currently separates accepted from rejected requests; a block would hit the whole
Claude account, Claude Code included. Amp and your own Claude Code share the subscription's
5-hour and 7-day windows. A leaked proxy key spends that quota: rotate it (vault entry, redeploy,
`scripts/amp-router.sh`) on suspicion. The setup token expires after about a year and nobody
refreshes it; the connection then fails until a new one is deployed. Whether Amp falls back to
credits when the proxy answers 429 was not tested.
