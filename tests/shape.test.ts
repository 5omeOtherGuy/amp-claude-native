import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_CODE_IDENTITY, INTERLEAVED_THINKING_BETA, mergeBetas, shapeBody, shapeSystem, shapeThinking } from "../src/shape.ts";

const ID = { type: "text", text: CLAUDE_CODE_IDENTITY };

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
  const cases: [unknown, string][] = [
    [{ type: "disabled" }, "low"],
    [{ type: "enabled", budget_tokens: 4095 }, "low"],
    [{ type: "enabled", budget_tokens: 4096 }, "medium"],
    [{ type: "enabled", budget_tokens: 16383 }, "medium"],
    [{ type: "enabled", budget_tokens: 16384 }, "high"],
  ];
  for (const [thinking, effort] of cases) {
    assert.deepEqual(
      shapeThinking({ model: "claude-opus-5-5", thinking, temperature: 0, top_p: 1 }),
      { model: "claude-opus-5-5", thinking: { type: "adaptive" }, output_config: { effort } },
    );
  }
  assert.deepEqual(
    shapeThinking({ model: "claude-opus-4-7", thinking: { type: "disabled" }, output_config: { effort: "xhigh", other: 1 } }),
    { model: "claude-opus-4-7", thinking: { type: "adaptive" }, output_config: { effort: "xhigh", other: 1 } },
  );
});

test("thinking: manual-thinking models and untouched requests pass through unchanged", () => {
  for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"]) {
    const manual = { model, thinking: { type: "enabled", budget_tokens: 4096 }, temperature: 1 };
    assert.deepEqual(shapeThinking(manual), manual);
  }
  const unknownNewModel = shapeThinking({ model: "claude-opus-6", thinking: { type: "disabled" } });
  assert.deepEqual(unknownNewModel.thinking, { type: "adaptive" });
  const adaptive = { model: "claude-opus-5-5", thinking: { type: "adaptive" }, temperature: 1 };
  assert.deepEqual(shapeThinking(adaptive), adaptive);
  const bare = { model: "claude-fable-5-1", max_tokens: 5, temperature: 1 };
  assert.deepEqual(shapeThinking(bare), bare);
});

test("body: strips Amp's provider prefix before the thinking rules apply", () => {
  const out = shapeBody({ model: "anthropic/claude-opus-5-5", thinking: { type: "disabled" } });
  assert.equal(out.model, "claude-opus-5-5");
  assert.deepEqual(out.thinking, { type: "adaptive" });
});
