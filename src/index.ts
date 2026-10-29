// amp-claude-native: a Cloudflare Worker that lets Amp's Custom URL model
// provider (API format anthropic-messages) use a Claude Pro/Max subscription.
//
// Amp's servers call <worker>/v1/messages with `Authorization: Bearer <PROXY_KEY>`.
// The Worker checks that key, swaps in the Claude Code OAuth token, puts the
// Claude Code identity first in `system`, adds the OAuth-lane beta headers and
// streams Anthropic's response back unchanged. No request content is logged.

import { mergeBetas, shapeBody } from "./shape.ts";

export interface Env {
  /** Long-lived Claude Code OAuth token (`claude setup-token`). */
  CLAUDE_TOKEN: string;
  /** Shared secret Amp sends as the connection's API key. */
  PROXY_KEY: string;
  /** Optional upstream override, for tests. Defaults to https://api.anthropic.com. */
  UPSTREAM?: string;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const SHAPED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const PASSTHROUGH_PATHS = new Set(["/v1/models"]);
const RESPONSE_HEADERS = ["content-type", "request-id", "x-request-id", "retry-after"];

function json(status: number, message: string, type = "invalid_request_error"): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time comparison of two strings (as UTF-8 bytes). */
export function keysEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % x.length] ?? 0) ^ (y[i % y.length] ?? 0);
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const presented = m?.[1] ?? "";
  return presented.length > 0 && keysEqual(presented, env.PROXY_KEY);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.PROXY_KEY || !env.CLAUDE_TOKEN) return json(500, "Worker secrets PROXY_KEY and CLAUDE_TOKEN are not set.", "api_error");
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return new Response("amp-claude-native proxy\n", { headers: { "content-type": "text/plain" } });
    if (!authorized(req, env)) return json(401, "Invalid proxy key.", "authentication_error");

    const shaped = SHAPED_PATHS.has(path);
    if (!shaped && !PASSTHROUGH_PATHS.has(path)) return json(404, `Not found: ${path}`, "not_found_error");
    if (shaped && req.method !== "POST") return json(405, "Method not allowed.");
    if (!shaped && req.method !== "GET") return json(405, "Method not allowed.");

    const upstream = new URL((env.UPSTREAM ?? DEFAULT_UPSTREAM) + path + url.search);
    const headers = new Headers({
      authorization: `Bearer ${env.CLAUDE_TOKEN}`,
      "anthropic-version": req.headers.get("anthropic-version") ?? DEFAULT_VERSION,
      accept: req.headers.get("accept") ?? "application/json",
    });

    let body: string | undefined;
    if (shaped) {
      let parsed: unknown;
      try {
        parsed = await req.json();
      } catch {
        return json(400, "Request body must be JSON.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, "Request body must be a JSON object.");
      const record = parsed as Record<string, unknown>;
      body = JSON.stringify(shapeBody(record));
      headers.set("content-type", "application/json");
      headers.set("anthropic-beta", mergeBetas(req.headers.get("anthropic-beta"), record));
    } else {
      headers.set("anthropic-beta", mergeBetas(req.headers.get("anthropic-beta"), {}));
    }

    const res = await fetch(upstream, { method: req.method, headers, body });
    const out = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const v = res.headers.get(name);
      if (v) out.set(name, v);
    }
    for (const [name, v] of res.headers) if (name.startsWith("anthropic-")) out.set(name, v);
    return new Response(res.body, { status: res.status, headers: out });
  },
};
