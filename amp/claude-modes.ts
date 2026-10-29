// Amp's built-in modes with Claude models from the Claude Subscription connection.
// Install: copy to ~/.config/amp/plugins/ (system plugin). The anthropic/* IDs these modes
// request are mapped to the Worker by scripts/amp-router.sh, so they run on the subscription
// and Amp shows the Claude model name (measured 2026-10-29: claude-high via the connection, $0).
import type { PluginAPI } from '@ampcode/plugin'

export const description = 'Amp low/medium/high modes served by Claude models via the Claude subscription'

// @amp-agent-mode {"key":"claude-low","label":"claude-low"}
// @amp-agent-mode {"key":"claude-medium","label":"claude-medium"}
// @amp-agent-mode {"key":"claude-high","label":"claude-high"}
export default function (amp: PluginAPI) {
	const modes = [
		{ key: 'claude-low', extends: 'low', model: 'anthropic/claude-sonnet-4-6', label: 'claude-low' },
		{ key: 'claude-medium', extends: 'medium', model: 'anthropic/claude-opus-4-6', label: 'claude-medium' },
		{ key: 'claude-high', extends: 'high', model: 'anthropic/claude-opus-5-5', label: 'claude-high' },
	] as const
	for (const m of modes) {
		const agent = amp.createAgent({
			extends: m.extends,
			model: m.model,
			display: { label: m.label },
		})
		amp.registerAgentMode({
			key: m.key,
			agent: agent.definition,
			label: m.label,
			description: `Amp ${m.extends} mode on ${m.model} via the Claude subscription`,
		})
	}
}
