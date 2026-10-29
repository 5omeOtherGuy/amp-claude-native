# amp-claude-native

Claude models in Amp, served by a Claude Pro/Max subscription instead of Amp credits.

Amp's native modes use Claude for some of them (on 2026-10-29: medium on Opus 5.5, ultra on
Fable 5.1; high on GPT-6 Astra, low on GLM-5.3-Flash), billed to Amp credits. Amp's own "Claude
Subscription" connection only covers the Claude Code mode. Amp's "Custom URL" model provider
lets Amp's servers send Anthropic Messages requests to a URL of your choice for the model IDs you
map to it. This proxy is that URL: it checks a shared key, swaps in a Claude Code OAuth setup
token, shapes the request for Anthropic's OAuth lane and returns the response unchanged, streaming
included. The connection serves every `anthropic/*` model ID, so the modes keep their native
models and only the billing of the Claude ones changes. Subagents, thread titles, compaction and
Amp's cloud orbs run on the thread's model and follow the same routing.

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

Requirements: Node 22.18 or newer (the `cf` CLI; this repo uses it through mise), Bun for the
local server, the `amp` CLI signed in to the account that should use the subscription.
Canonical copy: P720, `~/Work/amp-claude-native`.

## 1. Secrets

- `claude setup-token` (opens the browser, needs a Claude Pro/Max login) prints a long-lived
  OAuth token that does not share Claude Code's refresh chain. Store it in the vault as
  `amp-claude-native-claude-token`. It expires after about a year and nobody refreshes it.
- A random proxy key, `openssl rand -hex 32`, as `amp-claude-native-proxy-key`. Amp sends it as
  the connection's API key; the proxy accepts nothing else.
- On <https://claude.ai/settings/usage> keep **extra usage** off unless you want Amp's traffic
  to spend money once the included quota is used up. Nothing in a request can opt out of it.

## 2. Hosting

Amp's servers call the proxy, not your Amp client. So the proxy needs a public HTTPS address and
must be reachable whenever any Amp thread runs, including cloud orbs that run while your
workstation is off. That means either an external host such as a Cloudflare Worker, or a machine
of yours that runs permanently and is exposed to the internet. A proxy on a laptop that sleeps
breaks every Claude request in Amp, orbs included, while it is away.

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

**Local proxy on an always-on machine** (the token never leaves that machine; its uptime and
internet uplink become a dependency for every Amp request, and the public entry point lands on
it):

```sh
CLAUDE_TOKEN="$(rbw get amp-claude-native-claude-token)" PROXY_KEY="$(rbw get amp-claude-native-proxy-key)" bun scripts/serve.ts   # 127.0.0.1:8787
```

Expose it with Tailscale Funnel (`sudo tailscale funnel --bg 8787`, gives
`https://<host>.<tailnet>.ts.net`; the tailnet admin must enable Funnel once, the command prints
the link) or a Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8787` prints a
`trycloudflare.com` URL that lives as long as the process; a named tunnel gives a stable one. With
a Tunnel, Cloudflare still terminates TLS and sees the traffic, so it buys nothing over the Worker
except local token storage). Run the server and the tunnel as systemd services so they survive
reboots. Verified 2026-10-29 through a quick Tunnel: Amp threads, including a cloud orb thread,
routed via the connection at $0.

## 3. Amp connection and model routing

Either run `scripts/amp-router.sh <proxy-url> [connection-id]` (adds a personal connection; use
`--workspace` in the script's `add-router` call for a shared one), or do the same in the web UI
at <https://ampcode.com/settings/model-routing>:

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

`amp config model-providers test <id>` calls `/v1/models` through the proxy. Then run one thread
in medium or ultra and read `amp threads usage <thread> --details`: the Claude model must show
Routing "Via <connection name>" and cost $0, for Agent, Task and Thread Title alike. Do the same
once with `amp -ox` for an orb. Note that `amp config model-providers check-access` can name
Amp's built-in "Subscription" connection for a Claude model even though real threads go through
the proxy; the usage details of a real thread are the authority.

## Risks

Anthropic's OAuth lane is meant for Claude Code; this sends Amp's prompts through it from Amp's
servers. Anthropic has rejected other third-party OAuth clients since 2026-10-18, and the identity
block is what currently separates accepted from rejected requests; a block would hit the whole
Claude account, Claude Code included. Amp and your own Claude Code share the subscription's
5-hour and 7-day windows. A leaked proxy key spends that quota: rotate it (vault entry, redeploy,
`scripts/amp-router.sh`) on suspicion. When the setup token expires or the proxy is down, Claude
requests in Amp fail; whether Amp then falls back to credits was not tested.
