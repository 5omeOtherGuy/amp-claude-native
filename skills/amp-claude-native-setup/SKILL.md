---
name: amp-claude-native-setup
description: Interactive, step-by-step setup of amp-claude-native, a small proxy that lets Amp's native modes keep their Claude models but bill them to the user's Claude Pro/Max subscription instead of Amp credits. Use when a user wants to set up, verify, rotate secrets for, or troubleshoot this proxy, in any agent harness (Amp, Claude Code, Codex, Pi or others). Asks before every decision and never prints or stores secrets.
---

# amp-claude-native setup

You guide a human through hosting the proxy and wiring it into Amp. Rules for the whole skill:

- One step at a time. Run a command yourself when you have a shell on the user's machine;
  otherwise show it and ask for the output. Never claim you ran something you did not.
- Verify each step before the next. On failure stop and diagnose; do not skip ahead.
- Secrets (the Claude token, the proxy key) never appear in chat, logs or files you leave behind.
  Never `cat`, `echo` or read them yourself. They live only in files under `$ACN` (step 1),
  deleted at the end, or in the user's own secret store. Browser logins are the user's; you wait.
- Prefer asking over assuming: OS, hosting choice, existing tokens, account names.

## 0. Explain and confirm

Tell the user in three sentences: Amp's servers will call a proxy they host; it swaps in a Claude
Code OAuth token, so Claude models in Amp's native modes cost $0 Amp credits and count against
their Claude Pro/Max 5-hour and 7-day windows, shared with their own Claude Code; this sends Amp
traffic through Anthropic's Claude Code lane, which Anthropic has blocked for other third-party
clients, and a block would affect their whole Claude account. Ask "Proceed?" and stop if not.

## 1. Prerequisites

Ask which OS they are on and whether they have: a Claude Pro/Max subscription, an Amp account
with the `amp` CLI signed in, and the `claude` CLI (Claude Code). Check versions:
`git --version`, `node --version` (22.18 or newer), `npm --version`, `amp --version`,
`claude --version`. Point to the official installers for anything missing and wait. Then:

```sh
git clone https://github.com/5omeOtherGuy/amp-claude-native.git && cd amp-claude-native
npm install && npm test
ACN=$(mktemp -d) && chmod 700 "$ACN"      # private scratch dir for this setup; export it in every shell you use
```

All tests must pass. Explain that `$ACN` is deleted in step 8.

## 2. Hosting decision

Ask the user to choose:

- **(a) Cloudflare Worker.** Nothing of theirs has to stay online, free tier, secrets stored
  encrypted at Cloudflare. Needs a Cloudflare account. Recommend this unless they already run a
  server.
- **(b) Their own always-on machine.** The token stays on that machine, but it must be reachable
  over public HTTPS whenever any Amp thread runs, cloud orbs included; a sleeping laptop breaks
  every Claude request in Amp. Needs Bun and a tunnel (Tailscale Funnel or cloudflared). A
  Cloudflare Tunnel still terminates TLS at Cloudflare, so it gains nothing over the Worker
  except local token storage.

For (b) check `bun --version` and ask which tunnel they will use.

## 3. Secrets

Ask: "Do you already have a token from `claude setup-token`?" If not, the user runs
`claude setup-token` in their own terminal (browser login with the Pro/Max account; the token
lasts about a year and is not refreshed by anyone). Have them save it without showing it to you:

```sh
umask 077; cat > "$ACN/claude-token"     # user pastes the token, Enter, Ctrl-D
umask 077; openssl rand -hex 32 | tr -d '\n' > "$ACN/proxy-key"
wc -c "$ACN/claude-token" "$ACN/proxy-key"    # sizes only; the key must be 64 bytes
```

Tell the user: on <https://claude.ai/settings/usage> keep **extra usage** off unless they want
Amp traffic to spend money once the included quota is used up; no request can opt out of it.

## 4a. Deploy as a Cloudflare Worker

Ask whether they have a Cloudflare account; if not, they create one in the browser first. On a
new account Cloudflare also asks them to pick a `workers.dev` subdomain in the dashboard. Then:

```sh
npx cf auth login                        # browser; the user approves, you wait
umask 077; printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(cat "$ACN/claude-token")" "$(cat "$ACN/proxy-key")" > "$ACN/secrets.env"
npx cf deploy --secrets-file "$ACN/secrets.env"
```

Record the printed `https://....workers.dev` URL as `PROXY_URL`. A later code or token change is
the same `cf deploy` again.

## 4b. Or run it on their own machine

```sh
umask 077; cp "$ACN/secrets.env" ~/.config/amp-claude-native.env 2>/dev/null || printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(cat "$ACN/claude-token")" "$(cat "$ACN/proxy-key")" > ~/.config/amp-claude-native.env
bun --env-file ~/.config/amp-claude-native.env scripts/serve.ts     # listens on 127.0.0.1:8787
```

That 0600 env file is the one place the secrets may persist; the user owns it. Expose the port:
`sudo tailscale funnel --bg 8787` (prints the https URL; Funnel must be enabled once for the
tailnet, the command prints the admin link) or `cloudflared tunnel --url http://127.0.0.1:8787`
(temporary URL; a named tunnel gives a stable one). Ask the user to run server and tunnel as
services that survive reboots (systemd, launchd). Record the public URL as `PROXY_URL`.

## 5. Verify the proxy directly

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$PROXY_URL/v1/models"                                                   # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat "$ACN/proxy-key")" "$PROXY_URL/v1/models"   # expect 200
```

Anything else: fix hosting before touching Amp. 401 with the key means a wrong secret, 5xx means
the token or the upstream.

## 6. Register the connection in Amp

Ask: CLI or web UI? CLI (personal connection; `--workspace` instead of `--personal` to share it):

```sh
amp config model-providers add-router custom-url --personal --active --name "amp-claude-native" \
  --api-format anthropic-messages --base-url "$PROXY_URL" --api-key-file - --headers '[]' \
  --model-mapping 'anthropic/*' < "$ACN/proxy-key"
amp config model-providers list
```

Web UI: <https://ampcode.com/settings/model-routing>, add **Custom URL**, API format
anthropic-messages, base URL `$PROXY_URL`, API key the proxy key (the user reads it with
`cat "$ACN/proxy-key"` in their own terminal), no headers, model mapping `anthropic/*`, activate.

Then the user sets, in the same settings page: **Claude Usage = Allow Paid-Per-Token Usage**.
With "Subscription Only" Amp refuses Claude models outside Claude Code mode before consulting any
connection; nothing is billed per token, the proxy uses the subscription. Tune Modes stay on
Auto so the modes keep their native models. Keep Amp's built-in Claude Subscription connection
(Claude Code mode uses it) and make sure the proxy is the only active connection whose mapping
matches `anthropic/*`.

## 7. Verify end to end

1. `amp config model-providers test <connection-id>` must succeed.
2. The user runs one short thread in a mode that uses a Claude model (medium or ultra at the
   time of writing), then `amp threads usage <thread-id> --details`: every Claude line shows
   Routing "Via amp-claude-native" and cost $0, for Agent, Task and Thread Title alike.
   `amp config model-providers check-access` is not authoritative; the thread usage is.
3. If they use cloud orbs, repeat once with `amp -ox`.

## 8. Clean up and hand over

`rm -rf "$ACN"`. The commands above contain no secret values, so shell history is clean. Tell
the user: the token expires after about a year (redo step 3 and the deploy; Amp needs no change);
on a suspected key leak regenerate the key, redeploy and run
`amp config model-providers edit-router <id> --api-key-file - < newkeyfile`; when the proxy is
down or the subscription window is exhausted, Claude requests in Amp fail with the upstream
error, and whether Amp falls back to credits is untested.
