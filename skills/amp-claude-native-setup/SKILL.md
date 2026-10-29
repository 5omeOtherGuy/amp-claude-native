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
  Never read them yourself. They live only in `$ACN` (step 1), deleted in step 8, or where the
  user chooses to keep them. Browser logins are the user's; you wait for their confirmation.
- Shell state does not survive between your tool calls. Start every block below with the
  preamble `cd <repo root> && export ACN=<path from step 1> PROXY_URL=<url from step 4>`, with
  the literal values. bash or zsh; on Windows, use WSL.
- Prefer asking over assuming: OS, hosting choice, existing tokens, account names.

## 0. Explain and confirm

Tell the user in three sentences: Amp's servers will call a proxy they host; it swaps in a Claude
Code OAuth token, so Claude models in Amp's native modes cost $0 Amp credits and count against
their Claude Pro/Max 5-hour and 7-day windows, shared with their own Claude Code; this sends Amp
traffic through Anthropic's Claude Code lane, which Anthropic has blocked for other third-party
clients, and a block would affect their whole Claude account. Ask "Proceed?" and stop if not.

## 1. Prerequisites

Ask which OS they are on and whether they have: a Claude Pro/Max subscription, an Amp account
with the `amp` CLI signed in, and the `claude` CLI (Claude Code). Check `git --version`,
`node --version` (22.18 or newer), `npm --version`, `amp --version`, `claude --version`. Point
to the official installers for anything missing and wait. Then:

```sh
git clone https://github.com/5omeOtherGuy/amp-claude-native.git && cd amp-claude-native
npm install && npm test
export ACN="${TMPDIR:-/tmp}/acn-$(id -u)"; mkdir -p "$ACN"; chmod 700 "$ACN"; echo "$ACN"
```

All tests must pass. Tell the user the `$ACN` path: it is the private scratch directory for this
setup, and step 8 deletes it. If the setup is abandoned at any point, delete it as well.

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
lasts about a year and is not refreshed by anyone). Then the user, in their own terminal from the
repo root with `ACN` set, pastes it without echo:

```sh
umask 077; printf 'Claude token: '; read -rs T; printf '%s' "$T" | tr -d '[:space:]' > "$ACN/claude-token"; unset T; echo
openssl rand -hex 32 | tr -d '\n' > "$ACN/proxy-key"
printf 'Authorization: Bearer %s\n' "$(cat "$ACN/proxy-key")" > "$ACN/auth-header"
wc -c "$ACN/claude-token" "$ACN/proxy-key"      # sizes only; the key must be 64 bytes
```

Ask the user to save both values in their password manager as well: step 8 deletes `$ACN`, and
the yearly token renewal needs the existing proxy key again. Tell them: on
<https://claude.ai/settings/usage> keep **extra usage** off unless they want Amp traffic to spend
money once the included quota is used up; no request can opt out of it.

## 4a. Deploy as a Cloudflare Worker

Ask whether they have a Cloudflare account; if not, they create one in the browser first. On a
new account Cloudflare also asks them to pick a `workers.dev` subdomain in the dashboard. Then:

```sh
npx cf auth login            # browser; wait for the user to say it is done (this login is theirs and stays)
umask 077; printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(cat "$ACN/claude-token")" "$(cat "$ACN/proxy-key")" > "$ACN/secrets.env"
npx cf deploy --secrets-file "$ACN/secrets.env"
```

Record the printed `https://....workers.dev` URL as `PROXY_URL`, without a trailing slash.
A later code or token change is the same two lines again.

## 4b. Or run it on their own machine

Ask where the two secrets may live permanently on that machine: the user's secret manager that
can inject environment variables, or a 0600 env file of their choosing (for example
`~/.config/amp-claude-native.env`). Only that place may keep them. With an env file:

```sh
mkdir -p ~/.config; rm -f ~/.config/amp-claude-native.env; umask 077
printf 'CLAUDE_TOKEN=%s\nPROXY_KEY=%s\n' "$(cat "$ACN/claude-token")" "$(cat "$ACN/proxy-key")" > ~/.config/amp-claude-native.env
nohup bun --env-file ~/.config/amp-claude-native.env scripts/serve.ts > /dev/null 2>&1 &     # 127.0.0.1:8787, for this test only
curl -s -o /dev/null -w '%{http_code}\n' --retry 5 --retry-connrefused http://127.0.0.1:8787/v1/models   # expect 401
```

If the curl fails because your harness reaped the background process, skip ahead to the service
setup below and test again from there.

Expose the port: `tailscale funnel --bg 8787` (Linux usually needs `sudo`; on macOS the CLI is
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`; Funnel must be enabled once for the
tailnet, the command prints the admin link; the user does that in the browser) or
`nohup cloudflared tunnel --url http://127.0.0.1:8787 &` (temporary URL in its output; a named
tunnel gives a stable one). Record the public URL as `PROXY_URL`, no trailing slash.
Then make both survive reboots: stop the two test processes first (`kill %1 %2` in that shell,
or `pkill -f 'scripts/serve.ts'` and the cloudflared process), so the services, not the test
processes, own the port. On Linux one user systemd service per process
(`systemctl --user edit --force --full amp-claude-native.service`, `EnvironmentFile=` pointing
at the env file, `WantedBy=default.target`, `loginctl enable-linger`), on macOS a launchd agent in
`~/Library/LaunchAgents`. Restart the services and only then run step 5; with a cloudflared
quick tunnel the URL changes on every restart, so read it from the service log again.

## 5. Verify the proxy directly

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$PROXY_URL/v1/models"                       # expect 401
curl -s -w '\n%{http_code}\n' -H @"$ACN/auth-header" "$PROXY_URL/v1/models" | tail -c 300   # expect 200; on 401 the body tells which secret failed
```

401 whose body says `Invalid proxy key.` means a wrong proxy key; any other 401 is Anthropic
rejecting the Claude token (expired or revoked); 404 means a trailing slash or wrong URL; 502 means
the proxy could not reach Anthropic. Fix hosting before touching Amp.

## 6. Register the connection in Amp

Ask: personal connection or shared with their workspace (then change `--personal` to
`--workspace` in `scripts/amp-router.sh`). Then:

```sh
scripts/amp-router.sh "$PROXY_URL" < "$ACN/proxy-key"      # add; rerun with the connection id as 2nd argument to update
```

The script prints `amp config model-providers list`; note the id of `amp-claude-native`.
Without the CLI, the user does the same at <https://ampcode.com/settings/model-routing>: add
**Custom URL**, API format anthropic-messages, base URL `$PROXY_URL`, API key the proxy key
(the user copies it from `$ACN/proxy-key` in their own terminal), no headers, model mapping
`anthropic/*`, activate.

Then the user sets, in the same settings page in the browser: **Claude Usage = Allow
Paid-Per-Token Usage** (with "Subscription Only" Amp refuses Claude models outside Claude Code
mode before consulting any connection; nothing is billed per token, the proxy uses the
subscription), Tune Modes on Auto so the modes keep their native models, Amp's built-in Claude
Subscription connection kept (Claude Code mode uses it), and the proxy as the only active
connection whose mapping matches `anthropic/*`. Wait for the user to confirm all four.

## 7. Verify end to end

1. `amp config model-providers test <connection-id>` must succeed.
2. The user runs one short thread in a mode that uses a Claude model (medium or ultra at the
   time of writing), then `amp threads usage <thread-id> --details`: every Claude line shows
   Routing "Via amp-claude-native" and cost $0, for Agent, Task and Thread Title alike.
   `amp config model-providers check-access` is not authoritative; the thread usage is.
3. If they use cloud orbs, repeat once with `amp -ox`.

## 8. Clean up and hand over

`rm -rf "$ACN"`. No command above carried a secret value, so shell history is clean; the
Cloudflare login from 4a and the env file from 4b are the user's and stay. Tell the user:

- Token renewal (about yearly): new `claude setup-token` into a fresh `$ACN/claude-token`, the
  existing proxy key from their password manager into `$ACN/proxy-key`, then redeploy (4a) or
  rewrite the env file and restart (4b); Amp needs no change.
- Suspected key leak: new `proxy-key`, redeploy or restart, then
  `scripts/amp-router.sh "$PROXY_URL" <connection-id> < "$ACN/proxy-key"`.
- When the proxy is down or the subscription window is exhausted, Claude requests in Amp fail
  with the upstream error; whether Amp falls back to credits is untested.
