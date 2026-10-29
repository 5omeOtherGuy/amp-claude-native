import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_CODE_IDENTITY, INTERLEAVED_THINKING_BETA, mergeBetas, shapeSystem, shapeThinking } from "../src/shape.ts";
import worker, { keysEqual } from "../src/index.ts";

const ID = { type: "text", text: CLAUDE_CODE_IDENTITY };

test("string system becomes identity + caller block", () => {
  assert.deepEqual(shapeSystem("You are Amp."), [ID, { type: "text", text: "You are Amp." }]);
});

test("missing or empty system becomes identity alone", () => {
  assert.deepEqual(shapeSystem(undefined), [ID]);
  assert.deepEqual(shapeSystem(""), [ID]);
  assert.deepEqual(shapeSystem([]), [ID]);
});

test("identity in second position is moved first, cache_control kept", () => {
  const amp = { type: "text", text: "You are Amp.", cache_control: { type: "ephemeral" } };
  const out = shapeSystem([amp, { ...ID, cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(out, [{ ...ID, cache_control: { type: "ephemeral" } }, amp]);
});

test("identity as a prefix of a longer string is not treated as identity", () => {
  const text = `${CLAUDE_CODE_IDENTITY}\n\nYou are Amp.`;
  assert.deepEqual(shapeSystem(text), [ID, { type: "text", text }]);
});

test("betas: required first, incoming kept, no duplicates", () => {
  assert.equal(mergeBetas(null, {}), "oauth-2025-04-20,claude-code-20250219");
  assert.equal(
    mergeBetas("context-1m-2025-08-07, oauth-2025-04-20", {}),
    "oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07",
  );
  assert.equal(
    mergeBetas(null, { thinking: { type: "enabled", budget_tokens: 1024 } }),
    `oauth-2025-04-20,claude-code-20250219,${INTERLEAVED_THINKING_BETA}`,
  );
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

test("keysEqual", () => {
  assert.equal(keysEqual("abc", "abc"), true);
  assert.equal(keysEqual("abc", "abd"), false);
  assert.equal(keysEqual("abc", "abcd"), false);
  assert.equal(keysEqual("", ""), true);
});

function env(upstream: string) {
  return { CLAUDE_TOKEN: "tok-secret", PROXY_KEY: "proxy-key", UPSTREAM: upstream };
}

test("worker: rejects a wrong key before touching upstream", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/v1/messages", { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" }),
    env("https://127.0.0.1:9"),
  );
  assert.equal(res.status, 401);
});

test("worker: shapes the body and swaps the credential", async () => {
  const seen: { url?: string; headers?: Headers; body?: string } = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.headers = new Headers(init?.headers);
    seen.body = String(init?.body);
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "request-id": "req_1", "x-secret": "no" } });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(
      new Request("https://w.example/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer proxy-key", "content-type": "application/json", "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "leak" },
        body: JSON.stringify({ model: "claude-opus-4-6", system: "You are Amp.", messages: [], max_tokens: 5 }),
      }),
      env("https://upstream.example"),
    );
    assert.equal(res.status, 200);
    assert.equal(seen.url, "https://upstream.example/v1/messages");
    assert.equal(seen.headers?.get("authorization"), "Bearer tok-secret");
    assert.equal(seen.headers?.get("x-api-key"), null);
    assert.equal(seen.headers?.get("anthropic-version"), "2023-06-01");
    assert.equal(seen.headers?.get("anthropic-beta"), "oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07");
    const sent = JSON.parse(seen.body!);
    assert.deepEqual(sent.system, [ID, { type: "text", text: "You are Amp." }]);
    assert.equal(sent.model, "claude-opus-4-6");
    assert.equal(res.headers.get("request-id"), "req_1");
    assert.equal(res.headers.get("x-secret"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: unknown paths are not proxied", async () => {
  const res = await worker.fetch(
    new Request("https://w.example/v1/complete", { method: "POST", headers: { authorization: "Bearer proxy-key" }, body: "{}" }),
    env("https://127.0.0.1:9"),
  );
  assert.equal(res.status, 404);
});
