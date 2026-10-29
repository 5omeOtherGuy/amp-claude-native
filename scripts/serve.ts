// Runs the same Worker as a local HTTP server (Bun), for hosting the proxy on
// your own machine instead of Cloudflare. Secrets come from the environment:
//
//   CLAUDE_TOKEN=... PROXY_KEY=... bun scripts/serve.ts        # port 8787
//
// Amp's servers must reach it over public HTTPS, so put it behind a Tailscale
// Funnel or a Cloudflare Tunnel (see README, "Hosting").
import worker from "../src/index.ts";

const { CLAUDE_TOKEN, PROXY_KEY, PORT } = process.env;
if (!CLAUDE_TOKEN || !PROXY_KEY) throw new Error("CLAUDE_TOKEN and PROXY_KEY must be set");

Bun.serve({
  port: Number(PORT ?? 8787),
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: (req) => worker.fetch(req, { CLAUDE_TOKEN, PROXY_KEY }),
});
console.log(`amp-claude-native listening on http://127.0.0.1:${PORT ?? 8787}`);
