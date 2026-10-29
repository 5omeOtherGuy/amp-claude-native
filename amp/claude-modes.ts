// Amp system plugin: the built-in low/medium/high modes with Claude models.
// Install: cp amp/claude-modes.ts ~/.config/amp/plugins/. The anthropic/* IDs
// are served by the Worker connection (scripts/amp-router.sh), so these modes
// run on the subscription and Amp shows the Claude model name.
import type { PluginAPI } from "@ampcode/plugin";

export const description = "Amp low/medium/high modes on Claude models via the Claude subscription";

// @amp-agent-mode {"key":"claude-low","label":"claude-low"}
// @amp-agent-mode {"key":"claude-medium","label":"claude-medium"}
// @amp-agent-mode {"key":"claude-high","label":"claude-high"}
export default function (amp: PluginAPI) {
  const modes = [
    { key: "claude-low", extends: "low", model: "anthropic/claude-sonnet-4-6" },
    { key: "claude-medium", extends: "medium", model: "anthropic/claude-opus-4-6" },
    { key: "claude-high", extends: "high", model: "anthropic/claude-opus-5-5" },
  ] as const;
  for (const mode of modes) {
    const agent = amp.createAgent({ extends: mode.extends, model: mode.model, display: { label: mode.key } });
    amp.registerAgentMode({
      key: mode.key,
      agent: agent.definition,
      description: `Amp ${mode.extends} mode on ${mode.model} via the Claude subscription`,
    });
  }
}
