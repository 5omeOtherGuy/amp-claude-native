// Runs the Worker's fetch handler in Node against the real Anthropic API,
// authenticated with the Claude Code OAuth token of this machine's Claude Code
// login (or CLAUDE_TOKEN from the environment). Prints status codes, and the
// start of the error body when a request fails.
//
//   node scripts/live-check.mjs [model ...]
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import worker from "../src/index.ts";

async function token() {
  if (process.env.CLAUDE_TOKEN) return process.env.CLAUDE_TOKEN;
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const creds = JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8"));
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("no Claude Code OAuth token found");
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) throw new Error("Claude Code OAuth token expired; use Claude Code once to refresh it");
  return oauth.accessToken;
}

const env = { CLAUDE_TOKEN: await token(), PROXY_KEY: "live-check-key" };
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"];
let failed = 0;

for (const model of models) {
  // The system prompt deliberately lacks the identity: that is what Amp sends.
  const body = {
    model,
    max_tokens: 16,
    stream: true,
    system: "You are Amp, an agentic coding tool. Answer tersely.",
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  };
  const res = await worker.fetch(
    new Request("https://worker.local/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer live-check-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  const ok = res.status === 200 && /"type":\s*"message_stop"/.test(text);
  if (!ok) failed++;
  console.log(`${model}: HTTP ${res.status}${ok ? " stream complete" : " " + text.slice(0, 160).replace(/\s+/g, " ")}`);
}

process.exit(failed ? 1 : 0);
