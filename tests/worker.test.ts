import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { keysEqual } from "../src/index.ts";
import { CLAUDE_CODE_IDENTITY } from "../src/shape.ts";

const ENV = { CLAUDE_TOKEN: "tok-secret", PROXY_KEY: "proxy-key" };
const AUTH = { authorization: "Bearer proxy-key" };

function request(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return new Request(`https://w.example${path}`, json === undefined ? rest : { method: "POST", ...rest, body: JSON.stringify(json) });
}

/** Runs the handler with a fake upstream and returns what it sent upstream. */
async function proxied(req: Request, upstream = new Response("ok")) {
  const seen: { url?: string; headers?: Headers; body?: string } = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.headers = new Headers(init?.headers);
    seen.body = init?.body === undefined ? undefined : String(init.body);
    return upstream;
  }) as typeof fetch;
  try {
    return { res: await worker.fetch(req, ENV), ...seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("keysEqual", () => {
  assert.equal(keysEqual("abc", "abc"), true);
  assert.equal(keysEqual("abc", "abd"), false);
  assert.equal(keysEqual("abc", "abcd"), false);
});

test("rejects before touching upstream: key, path, method, body", async () => {
  const status = async (req: Request, env = ENV) => (await worker.fetch(req, env)).status;
  assert.equal(await status(request("/v1/messages", { headers: { authorization: "Bearer nope" }, json: {} })), 401);
  assert.equal(await status(request("/v1/messages", { headers: { "x-api-key": "proxy-key" }, json: {} })), 401);
  assert.equal(await status(request("/v1/messages", { headers: {}, json: {} }), { ...ENV, PROXY_KEY: "" }), 401);
  assert.equal(await status(request("/", { headers: AUTH })), 404);
  assert.equal(await status(request("/v1/complete", { headers: AUTH, json: {} })), 404);
  assert.equal(await status(request("/v1/models", { headers: AUTH, json: {} })), 405);
  assert.equal(await status(request("/v1/messages", { method: "POST", headers: AUTH, body: "not json" })), 400);
  assert.equal(await status(request("/v1/messages", { headers: AUTH, json: [1] })), 400);
});

test("messages: shapes the body, swaps the credential, returns upstream as is", async () => {
  const upstream = new Response("event: message_stop\n", { status: 429, headers: { "retry-after": "7" } });
  const { res, url, headers, body } = await proxied(
    request("/v1/messages", {
      headers: { ...AUTH, "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "leak" },
      json: { model: "anthropic/claude-opus-5-5", system: "You are Amp.", thinking: { type: "enabled", budget_tokens: 2048 }, messages: [], max_tokens: 5 },
    }),
    upstream,
  );
  assert.equal(res, upstream);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers?.get("authorization"), "Bearer tok-secret");
  assert.equal(headers?.get("x-api-key"), null);
  assert.equal(headers?.get("anthropic-version"), "2023-06-01");
  // betas come from the shaped body: thinking became adaptive, so no interleaved beta
  assert.equal(headers?.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07");
  const sent = JSON.parse(body!);
  assert.equal(sent.model, "claude-opus-5-5");
  assert.deepEqual(sent.system, [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: "You are Amp." }]);
  assert.deepEqual(sent.thinking, { type: "adaptive" });
  assert.deepEqual(sent.output_config, { effort: "low" });
});

test("models: GET passes through with the query and no body", async () => {
  const { res, url, headers, body } = await proxied(request("/v1/models?limit=1", { headers: AUTH }));
  assert.equal(res.status, 200);
  assert.equal(url, "https://api.anthropic.com/v1/models?limit=1");
  assert.equal(headers?.get("authorization"), "Bearer tok-secret");
  assert.equal(headers?.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219");
  assert.equal(headers?.get("content-type"), null);
  assert.equal(body, undefined);
});

test("upstream network failure becomes a JSON 502", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  try {
    const res = await worker.fetch(request("/v1/messages", { headers: AUTH, json: { model: "claude-opus-4-6", messages: [] } }), ENV);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.type, "api_error");
  } finally {
    globalThis.fetch = realFetch;
  }
});
