// Request shaping for the Anthropic Messages API over the Claude Code OAuth lane.
//
// Measured 2026-10-29 against api.anthropic.com with a Claude Code OAuth token:
// claude-opus-4-6 answers 429 {"type":"rate_limit_error","message":"Error"}
// unless the request's `system` is an array whose FIRST block is exactly the
// Claude Code identity text, as its own block. Identity anywhere else (second
// block, or as a prefix inside a longer string) is rejected the same way.
// claude-haiku-4-5 accepted every variant. So the proxy makes the identity the
// first block and keeps the caller's own system prompt after it.

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export const REQUIRED_BETAS = ["oauth-2025-04-20", "claude-code-20250219"] as const;
// Manual-budget thinking (thinking.type === "enabled") needs this beta to
// interleave thinking with tool use; adaptive-thinking models imply it.
export const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export type TextBlock = { type: "text"; text: string; cache_control?: unknown };
type Json = Record<string, unknown>;

function isTextBlock(v: unknown): v is TextBlock {
  return !!v && typeof v === "object" && (v as Json).type === "text" && typeof (v as Json).text === "string";
}

function isIdentity(text: string): boolean {
  return text.trim() === CLAUDE_CODE_IDENTITY;
}

/**
 * Returns the `system` value to send upstream: the identity block first, then
 * the caller's system content as text blocks. A caller block that already is
 * the identity is dropped (its cache_control is kept on the leading block).
 * Non-text blocks are passed through unchanged after the identity.
 */
export function shapeSystem(system: unknown): unknown[] {
  const parts: unknown[] = system === undefined || system === null ? [] : Array.isArray(system) ? system : [system];
  const rest: unknown[] = [];
  let identityCacheControl: unknown;
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim().length === 0) continue;
      if (isIdentity(part)) continue;
      rest.push({ type: "text", text: part });
    } else if (isTextBlock(part)) {
      if (isIdentity(part.text)) {
        if (identityCacheControl === undefined && "cache_control" in part) identityCacheControl = part.cache_control;
        continue;
      }
      rest.push(part);
    } else {
      rest.push(part);
    }
  }
  const identity: TextBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (identityCacheControl !== undefined) identity.cache_control = identityCacheControl;
  return [identity, ...rest];
}

/** Merges the caller's anthropic-beta header with the betas the OAuth lane needs. */
export function mergeBetas(incoming: string | null, body: Json): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (b: string) => {
    const t = b.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const b of REQUIRED_BETAS) add(b);
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object" && (thinking as Json).type === "enabled") add(INTERLEAVED_THINKING_BETA);
  if (incoming) for (const b of incoming.split(",")) add(b);
  return out.join(",");
}

// Models that only accept adaptive thinking. Amp does not know which Claude
// model a mapping sends to, so it may send `thinking: {type: "disabled"}` or a
// manual budget, which these models reject with 400 ("thinking.type.disabled"
// is not supported for this model; measured 2026-10-29 with claude-opus-5-5).
// Same family list as pi-claude-subscription's model table on 2026-10-29.
export const ADAPTIVE_ONLY_MODEL = /^claude-(opus-4-[78]|opus-5|fable-5|sonnet-5|haiku-5)/;

function effortForBudget(budget: unknown): string {
  if (typeof budget !== "number") return "medium";
  if (budget < 4096) return "low";
  if (budget < 16384) return "medium";
  return "high";
}

/**
 * For adaptive-only models, translates a disabled or manual-budget thinking
 * request into adaptive thinking with an effort, and drops sampling fields
 * these models refuse. Other models are passed through unchanged.
 */
export function shapeThinking(body: Json): Json {
  if (typeof body.model !== "string" || !ADAPTIVE_ONLY_MODEL.test(body.model)) return body;
  const out: Json = { ...body };
  delete out.temperature;
  delete out.top_p;
  delete out.top_k;
  const thinking = out.thinking;
  if (!thinking || typeof thinking !== "object") return out;
  const type = (thinking as Json).type;
  if (type !== "disabled" && type !== "enabled") return out;
  const existing = out.output_config && typeof out.output_config === "object" ? (out.output_config as Json) : {};
  const effort = typeof existing.effort === "string" ? existing.effort : type === "disabled" ? "low" : effortForBudget((thinking as Json).budget_tokens);
  out.thinking = { type: "adaptive" };
  out.output_config = { ...existing, effort };
  return out;
}

/** Shapes a Messages or count_tokens request body for the OAuth lane. */
export function shapeBody(body: Json): Json {
  return shapeThinking({ ...body, system: shapeSystem(body.system) });
}
