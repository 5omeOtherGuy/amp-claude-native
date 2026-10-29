// amp-claude-native: a Cloudflare Worker behind Amp's "Custom URL" model
// provider (API format anthropic-messages) that serves Claude models from a
// Claude Pro/Max subscription.
//
// Amp's servers call <worker>/v1/messages with `Authorization: Bearer <PROXY_KEY>`.
// The Worker checks that key, swaps in the Claude Code OAuth token, shapes the
// body for the OAuth lane (src/shape.ts) and returns Anthropic's response as
// is, streaming included. No request content is logged.

import { mergeBetas, shapeBody } from "./shape.ts";

export interface Env {
  /** Long-lived Claude Code OAuth token (`claude setup-token`). */
  CLAUDE_TOKEN: string;
  /** Shared secret Amp sends as the connection's API key. */
  PROXY_KEY: string;
}

const UPSTREAM = "https://api.anthropic.com";
const ROUTES: Record<string, "GET" | "POST"> = {
  "/v1/messages": "POST",
  "/v1/messages/count_tokens": "POST",
  "/v1/models": "GET", // Amp's connection test
};

function error(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Constant-time string comparison. */
export function keysEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // `!env.PROXY_KEY` keeps an unset secret from matching an empty header.
    if (!env.PROXY_KEY || !keysEqual(req.headers.get("authorization") ?? "", `Bearer ${env.PROXY_KEY}`)) {
      return error(401, "authentication_error", "Invalid proxy key.");
    }
    const method = ROUTES[url.pathname];
    if (!method) return error(404, "not_found_error", `Not found: ${url.pathname}`);
    if (req.method !== method) return error(405, "invalid_request_error", "Method not allowed.");

    let body: Record<string, unknown> = {};
    if (method === "POST") {
      const parsed: unknown = await req.json().catch(() => undefined);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return error(400, "invalid_request_error", "Request body must be a JSON object.");
      }
      body = shapeBody(parsed as Record<string, unknown>);
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${env.CLAUDE_TOKEN}`,
      "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
      "anthropic-beta": mergeBetas(req.headers.get("anthropic-beta"), body),
    };
    if (method === "POST") headers["content-type"] = "application/json";
    try {
      return await fetch(UPSTREAM + url.pathname + url.search, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
    } catch {
      return error(502, "api_error", "Upstream request to Anthropic failed.");
    }
  },
};
