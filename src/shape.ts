// Request shaping for the Anthropic Messages API over the Claude Code OAuth lane.
// Everything here is pure; src/index.ts applies it to the request body.

// Anthropic's OAuth lane answers 429 {"type":"rate_limit_error","message":"Error"}
// for claude-opus-4-6 unless `system` is an array whose first block is exactly
// this text, as its own block (measured 2026-10-29; Haiku 4.5 did not care).
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const REQUIRED_BETAS = ["oauth-2025-04-20", "claude-code-20250219"];
// Manual-budget thinking (thinking.type === "enabled") needs this beta to
// interleave thinking with tool use; adaptive-thinking models imply it.
export const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

// Models that only accept adaptive thinking. Amp does not know which Claude
// model it talks to and may send `thinking: {type: "disabled"}` or a manual
// budget, which these models reject with 400 (measured 2026-10-29, Opus 5.5).
const ADAPTIVE_ONLY_MODEL = /^claude-(opus-4-[789]|opus-5|fable-5|sonnet-5|haiku-5-5)/;

type Json = Record<string, unknown>;

/** The identity block first, then the caller's system prompt (string or blocks). */
export function shapeSystem(system: unknown): unknown[] {
  const identity = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (typeof system === "string") return system ? [identity, { type: "text", text: system }] : [identity];
  return [identity, ...(Array.isArray(system) ? system : [])];
}

/** The caller's anthropic-beta header plus the betas the OAuth lane needs. */
export function mergeBetas(incoming: string | null, body: Json): string {
  const thinking = body.thinking as Json | undefined;
  const betas = new Set([
    ...REQUIRED_BETAS,
    ...(thinking?.type === "enabled" ? [INTERLEAVED_THINKING_BETA] : []),
    ...(incoming ?? "").split(",").map((b) => b.trim()).filter(Boolean),
  ]);
  return [...betas].join(",");
}

/** Effort for a manual thinking budget; no budget (thinking disabled) means the lowest. */
function effortForBudget(budget: unknown): string {
  return typeof budget !== "number" || budget < 4096 ? "low" : budget < 16384 ? "medium" : "high";
}

/**
 * Adaptive-only models: disabled or manual thinking becomes adaptive with an
 * effort. Sampling parameters go too, because Anthropic rejects them together
 * with thinking.
 */
export function shapeThinking(body: Json): Json {
  const thinking = body.thinking as Json | undefined;
  if (typeof body.model !== "string" || !ADAPTIVE_ONLY_MODEL.test(body.model)) return body;
  if (thinking?.type !== "disabled" && thinking?.type !== "enabled") return body;
  const { temperature, top_p, top_k, ...out } = body;
  const config = (out.output_config ?? {}) as Json;
  const effort = typeof config.effort === "string" ? config.effort : effortForBudget(thinking.budget_tokens);
  return { ...out, thinking: { type: "adaptive" }, output_config: { ...config, effort } };
}

/**
 * Shapes a Messages or count_tokens body. Amp's mapping line `anthropic/*`
 * forwards its own IDs (`anthropic/claude-...`); Anthropic wants no prefix.
 */
export function shapeBody(body: Json): Json {
  const model = typeof body.model === "string" ? body.model.replace(/^anthropic\//, "") : body.model;
  return shapeThinking({ ...body, model, system: shapeSystem(body.system) });
}
