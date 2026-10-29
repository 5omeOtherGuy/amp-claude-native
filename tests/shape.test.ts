import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_CODE_IDENTITY, INTERLEAVED_THINKING_BETA, mergeBetas, shapeBody, shapeSystem, shapeThinking } from "../src/shape.ts";
import worker, { keysEqual } from "../src/index.ts";

const ID = { type: "text", text: CLAUDE_CODE_IDENTITY };
const ENV = { CLAUDE_TOKEN: "tok-secret", PROXY_KEY: "proxy-key" };

test("system: identity first, caller's prompt after it", () => {
  assert.deepEqual(shapeSystem("You are Amp."), [ID, { type: "text", text: "You are Amp." }]);
  const blocks = [{ type: "text", text: "You are Amp.", cache_control: { type: "ephemeral" } }];
  assert.deepEqual(shapeSystem(blocks), [ID, ...blocks]);
  assert.deepEqual(shapeSystem(undefined), [ID]);
  assert.deepEqual(shapeSystem(""), [ID]);
});

test("betas: required first, incoming kept, interleaved only for manual thinking", () => {
  assert.equal(mergeBetas(null, {}), "oauth-2025-04-20,claude-code-20250219");
  assert.equal(mergeBetas("context-1m-2025-08-07, oauth-2025-04-20", {}), "oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07");
  assert.equal(mergeBetas(null, { thinking: { type: "enabled", budget_tokens: 1024 } }), `oauth-2025-04-20,claude-code-20250219,${INTERLEAVED_THINKING_BETA}`);
  assert.equal(mergeBetas(null, { thinking: { type: "adaptive" } }), "oauth-2025-04-20,claude-code-20250219");
});

test("thinking: adaptive-only models get adaptive thinking instead of disabled/manual", () => {
  assert.deepEqual(
    shapeThinking({ model: "claude-opus-5-5", thinking: { type: "disabled" }, temperature: 0 }),
    { model: "claude-opus-5-5", thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  );
  assert.deepEqual(
    shapeThinking({ model: "claude-fable-5-1", thinking: { type: "enabled", budget_tokens: 32000 } }),
    { model: "claude-fable-5-1", thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  );
  assert.deepEqual(
    shapeThinking({ model: "claude-opus-4-7", thinking: { type: "disabled" }, output_config: { effort: "xhigh" } }),
    { model: "claude-opus-4-7", thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } },
  );
  const manual = { model: "claude-opus-4-6", thinking: { type: "enabled", budget_tokens: 4096 }, temperature: 1 };
  assert.deepEqual(shapeThinking(manual), manual);
  const bare = { model: "claude-opus-5-5", max_tokens: 5 };
  assert.deepEqual(shapeThinking(bare), bare);
});

test("body: strips Amp's provider prefix before the thinking rules apply", () => {
  const out = shapeBody({ model: "anthropic/claude-opus-5-5", thinking: { type: "disabled" } });
  assert.equal(out.model, "claude-opus-5-5");
  assert.deepEqual(out.thinking, { type: "adaptive" });
});

test("keysEqual", () => {
  assert.equal(keysEqual("abc", "abc"), true);
  assert.equal(keysEqual("abc", "abd"), false);
  assert.equal(keysEqual("abc", "abcd"), false);
});

function post(path: string, headers: Record<string, string>, body: unknown) {
  return new Request(`https://w.example${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

test("worker: wrong or missing bearer key, unknown path, wrong method", async () => {
  assert.equal((await worker.fetch(post("/v1/messages", { authorization: "Bearer nope" }, {}), ENV)).status, 401);
  assert.equal((await worker.fetch(post("/v1/messages", { "x-api-key": "proxy-key" }, {}), ENV)).status, 401);
  assert.equal((await worker.fetch(post("/v1/complete", { authorization: "Bearer proxy-key" }, {}), ENV)).status, 404);
  assert.equal((await worker.fetch(post("/v1/models", { authorization: "Bearer proxy-key" }, {}), ENV)).status, 405);
});

test("worker: shapes the body, swaps the credential, returns upstream as is", async () => {
  const seen: { url?: string; headers?: Headers; body?: string } = {};
  const realFetch = globalThis.fetch;
  const upstream = new Response("event: message_stop\n", { status: 429, headers: { "content-type": "text/event-stream", "retry-after": "7" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.headers = new Headers(init?.headers);
    seen.body = String(init?.body);
    return upstream;
  }) as typeof fetch;
  try {
    const req = post(
      "/v1/messages",
      { authorization: "Bearer proxy-key", "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "leak" },
      { model: "anthropic/claude-opus-5-5", system: "You are Amp.", thinking: { type: "enabled", budget_tokens: 2048 }, messages: [], max_tokens: 5 },
    );
    const res = await worker.fetch(req, ENV);
    assert.equal(res, upstream);
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.headers?.get("authorization"), "Bearer tok-secret");
    assert.equal(seen.headers?.get("x-api-key"), null);
    assert.equal(seen.headers?.get("anthropic-version"), "2023-06-01");
    // betas come from the shaped body: thinking became adaptive, so no interleaved beta
    assert.equal(seen.headers?.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07");
    const sent = JSON.parse(seen.body!);
    assert.equal(sent.model, "claude-opus-5-5");
    assert.deepEqual(sent.system, [ID, { type: "text", text: "You are Amp." }]);
    assert.deepEqual(sent.thinking, { type: "adaptive" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: upstream network failure becomes a JSON 502", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  try {
    const res = await worker.fetch(post("/v1/messages", { authorization: "Bearer proxy-key" }, { model: "claude-opus-4-6", messages: [] }), ENV);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.type, "api_error");
  } finally {
    globalThis.fetch = realFetch;
  }
});
