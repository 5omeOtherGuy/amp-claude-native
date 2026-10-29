# amp-claude-native

Claude models in Amp, billed to a Claude Pro/Max subscription instead of Amp credits.

Amp's native modes use Claude models for some of them (on 2026-10-29: medium on Opus 5.5, ultra
on Fable 5.1), billed to Amp credits; Amp's own "Claude Subscription" connection only covers the
Claude Code mode. Amp's "Custom URL" model provider lets Amp's servers send Anthropic Messages
requests to an HTTPS URL of your choice for the model IDs you map to it. This proxy is that URL:
it checks a shared key, swaps in a Claude Code OAuth setup token, shapes the request for
Anthropic's OAuth lane and returns the response unchanged, streaming included. Mapped to
`anthropic/*`, it takes every Claude request Amp makes, so the modes keep their native models
and only the billing changes. Subagents, thread titles, compaction and cloud orbs follow the same
routing.

**Read this first.** Anthropic's OAuth lane is meant for Claude Code. This sends Amp's prompts
through it from Amp's servers, which is what Anthropic has blocked for other third-party clients
since 2026-10-18; the Claude Code identity block is what currently separates accepted from
rejected requests, and a block would hit your whole Claude account, Claude Code included. Amp and
your own Claude Code share the subscription's 5-hour and 7-day windows. Decide with that in mind.

The guided version of this document is `skills/amp-claude-native-setup/SKILL.md`: an agent skill
that walks a user through the setup interactively in any harness.

## What the proxy does

Measured 2026-10-29, see `src/shape.ts`: the Claude Code identity becomes the first `system`
block (Opus 4.6 answers 429 without it), the betas `oauth-2025-04-20,claude-code-20250219` are
added, the `anthropic/` prefix Amp puts on the model ID is removed, and on every model newer
than Opus 4.6, Sonnet 4.6 and Haiku 4.5 disabled or budgeted thinking becomes adaptive thinking.
Anthropic counts the requests against the subscription windows (the
`anthropic-ratelimit-unified-*` response headers); API credits are not touched, and extra usage
only if you have it enabled on claude.ai.

## Layout

- `src/index.ts` fetch handler, `src/shape.ts` pure request shaping, `tests/` (`npm test`).
- `cloudflare.config.ts` the Cloudflare `cf` project; `scripts/serve.ts` runs the same handler
  as a local server under Bun.
- `scripts/amp-router.sh` creates or updates the Amp connection from the CLI;
  `scripts/live-check.mjs` runs the handler in Node against the real API with the Claude Code
  login of this machine (reads `~/.claude/.credentials.json`; on macOS, where Claude Code uses
  the Keychain, set `CLAUDE_TOKEN` instead).
- `skills/amp-claude-native-setup/SKILL.md` the interactive setup skill.

## You need

A Claude Pro/Max subscription and the `claude` CLI (Claude Code) to mint a token; an Amp account
and the `amp` CLI for setup and verification; git, Node 22.18 or newer and npm. Then either a
Cloudflare account (free tier is enough) or an always-on machine with Bun and a tunnel
(Tailscale Funnel or cloudflared). The `cf` CLI is a devDependency, so `npx cf ...` works after
`npm install`.

## 1. Secrets

- `claude setup-token` opens a browser login and prints a long-lived OAuth token that does not
  share Claude Code's refresh chain. It expires after about a year and nobody refreshes it.
- A random proxy key, `openssl rand -hex 32`. Amp sends it as the connection's API key; the proxy
  accepts nothing else.
- Keep both in your secret store. Below they are written only to a private temporary file.
- On <https://claude.ai/settings/usage> keep **extra usage** off unless you want Amp's traffic
  to spend money once the included quota is used up; no request can opt out of it.

## 2. Hosting

Amp's servers call the proxy, not your Amp client. So the proxy needs a public HTTPS address and
must be reachable whenever any Amp thread runs, including cloud orbs that run while your
workstation is off: either an external host such as a Cloudflare Worker, or a machine of yours
that runs permanently and is exposed to the internet. A proxy on a laptop that sleeps breaks
every Claude request in Amp while it is away.

**Cloudflare Worker.** Nothing of yours stays online, free tier, secrets stored encrypted at
Cloudflare. On a new account, pick a `workers.dev` subdomain in the dashboard first.

```sh
npm install
npx cf auth login                                   # browser
umask 077; T=$(mktemp -d)
printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "<token>" "<proxy key>" > "$T/secrets.env"   # or from your secret store
npx cf deploy --secrets-file "$T/secrets.env"; rm -rf "$T"
```

`cf deploy` prints the URL. A later code or token change is the same deploy again.

**Your own always-on machine.** The token never leaves it; its uptime and uplink become a
dependency for every Amp request, and the public entry point lands on it.

```sh
bun --env-file /path/to/0600-env-file scripts/serve.ts     # CLAUDE_TOKEN=..., PROXY_KEY=...; listens on 127.0.0.1:8787
```

Expose the port with Tailscale Funnel (`sudo tailscale funnel --bg 8787`, gives
`https://<host>.<tailnet>.ts.net`; the tailnet admin must enable Funnel once, the command prints
the link) or a Cloudflare Tunnel (`cloudflared tunnel --url http://127.0.0.1:8787` prints a
temporary `trycloudflare.com` URL; a named tunnel gives a stable one; Cloudflare still terminates
TLS and sees the traffic, so this buys nothing over the Worker except local token storage). Run
server and tunnel as services that survive reboots. Verified 2026-10-29 through a quick Tunnel,
cloud orb thread included.

## 3. Amp connection and model routing

`scripts/amp-router.sh <proxy-url> [connection-id] < proxy-key-file` adds (or updates) a personal
connection; or do the same at <https://ampcode.com/settings/model-routing>: type **Custom URL**,
API format **anthropic-messages**, base URL the proxy URL (Amp appends `/v1/messages`), API key
the proxy key, no extra headers, model mapping one line `anthropic/*`, activate. Amp tries
connections in priority order and uses the first active one whose mapping matches, so this should
be the only active connection mapping `anthropic/*`.

Then, in the same settings page, three things the script cannot do:

1. **Claude Usage** to *Allow Paid-Per-Token Usage*. With *Subscription Only*, Amp refuses Claude
   models outside Claude Code mode before any connection is consulted (measured). Nothing is
   billed per token: the proxy uses the subscription.
2. Leave Tune Modes on Auto so each mode keeps its native model; a pin moves it.
3. Keep Amp's built-in Claude Subscription connection: the Claude Code mode still needs it.

## Verify

`curl <url>/v1/models` without a key must give 401, with `Authorization: Bearer <proxy key>` 200.
`amp config model-providers test <id>` calls the same path through Amp. Then run one thread in a
mode that uses a Claude model and read `amp threads usage <thread> --details`: the Claude model
must show Routing "Via <connection name>" and cost $0, for Agent, Task and Thread Title alike.
Do the same once with `amp -ox` for an orb. `amp config model-providers check-access` can name
Amp's built-in "Subscription" connection for a Claude model even though real threads go through
the proxy; the usage details of a real thread are the authority.

## When it fails

An exhausted subscription window comes back as Anthropic's 429, an expired or revoked token as
401, both unchanged from upstream; whether Amp then falls back to credits was not tested. Token
expiry: mint a new one and redeploy, Amp needs no change. Suspected key leak: new key, redeploy,
`amp config model-providers edit-router <id> --api-key-file - < newkeyfile`.
