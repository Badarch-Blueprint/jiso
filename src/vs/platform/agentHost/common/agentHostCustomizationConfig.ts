/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { createSchema, schemaProperty } from './agentHostSchema.js';
import { CustomizationType, type Customization, type PluginCustomization } from './state/protocol/state.js';
import { customizationId } from './state/sessionState.js';

/**
 * Well-known root-config keys used by the platform to configure agent-host
 * customizations.
 */
export const enum AgentHostConfigKey {
	/** Host-owned Open Plugins available to remote sessions. */
	Customizations = 'customizations',
	/**
	 * Absolute path to the shell executable for host-managed terminals.
	 * TODO: revisit magic key in config; refine into a dedicated typed channel. https://github.com/microsoft/vscode/issues/313812
	 */
	DefaultShell = 'defaultShell',
	/** When true, Copilot SDK sessions use Agent Host's custom terminal tool override instead of the SDK's default terminal behavior. Disabled by default. */
	EnableCustomTerminalTool = 'enableCustomTerminalTool',
	/** When true, Copilot SDK sessions enable the rubber duck critic subagent. */
	RubberDuck = 'rubberDuck',
	/**
	 * When true, Copilot SDK sessions running a Claude Opus 4.8 model apply the
	 * Opus 4.8-tuned system-prompt section overrides on top of the SDK
	 * foundation prompt. Opt-in; disabled by default.
	 */
	Opus48Prompt = 'opus48Prompt',
	/**
	 * When true (the default), the Claude provider routes all Anthropic
	 * `messages` traffic through the local Copilot-CAPI proxy (Copilot-routed
	 * Claude). When false, the Claude Agent SDK talks to Anthropic directly on
	 * the user's own credentials (BYO Anthropic — Phase 19).
	 */
	ClaudeUseCopilotProxy = 'claudeUseCopilotProxy',
	/**
	 * FORK: fully client-side context management (no wire changes, transport-
	 * independent — see `claudeContextTrimmer.ts`). When true (the default),
	 * a `PostToolUse` hook caps oversized tool outputs (head + tail around an
	 * elision marker) before they enter the transcript, bounding per-turn
	 * context growth without touching already-cached history.
	 */
	ClaudeLocalContextTrim = 'claudeLocalContextTrim',
	/** Character cap applied to a single tool output by {@link ClaudeLocalContextTrim}. */
	ClaudeLocalContextTrimMaxChars = 'claudeLocalContextTrimMaxChars',
	/**
	 * Opt-in second lever of {@link ClaudeLocalContextTrim}: replace re-reads
	 * of byte-identical files with a pointer to the earlier read. Off by
	 * default (more behaviorally aggressive — the model must refer upward).
	 */
	ClaudeLocalContextDedupeReads = 'claudeLocalContextDedupeReads',
	/**
	 * FORK: harness-triggered conversation compaction. When true (the
	 * default), the harness watches each session's context-window usage after
	 * every turn and, once it crosses {@link ClaudeAutoCompactTriggerTokens},
	 * runs the CLI's own `/compact` before the next user prompt — the same
	 * summarization stock Claude Code performs near the window limit, just
	 * triggered earlier so long sessions stop paying an ever-growing
	 * per-turn cache-read tax. Fully client-side: no wire changes, works on
	 * every transport.
	 */
	ClaudeAutoCompact = 'claudeAutoCompact',
	/** Context size (tokens) at which {@link ClaudeAutoCompact} compacts before the next prompt. */
	ClaudeAutoCompactTriggerTokens = 'claudeAutoCompactTriggerTokens',
	/**
	 * Which secondary agent CLI fulfils light "support" completions (session
	 * titles, summaries, quick classifications). Routing these off the main
	 * Claude chat keeps them from burning its subscription / 5-hour usage
	 * bucket. `claude` (the default) keeps them on the local headless CLI;
	 * `agy` / `cursor-agent` push them to an idle secondary pool.
	 */
	ChatSupportBackend = 'chatSupportBackend',
	/** Model for {@link ChatSupportBackend}. Empty => a cheap per-backend default. */
	ChatSupportModel = 'chatSupportModel',
}

/**
 * Persisted on-disk shape for a host-configured plugin. Kept stable across
 * the customization protocol refactor so existing `agent-host-config.json`
 * files keep working; entries are mapped to the new
 * {@link Customization} shape at read time by
 * {@link getAgentHostConfiguredCustomizations}.
 */
interface IPersistedCustomizationConfigEntry {
	uri: string;
	displayName: string;
	description?: string;
}

export const agentHostCustomizationConfigSchema = createSchema({
	[AgentHostConfigKey.Customizations]: schemaProperty<IPersistedCustomizationConfigEntry[]>({
		type: 'array',
		title: localize('agentHost.config.customizations.title', "Plugins"),
		description: localize('agentHost.config.customizations.description', "Plugins configured on this agent host and available to remote sessions."),
		default: [],
		items: {
			type: 'object',
			title: localize('agentHost.config.customizations.itemTitle', "Plugin"),
			properties: {
				uri: {
					type: 'string',
					title: localize('agentHost.config.customizations.uri', "Plugin URI"),
				},
				displayName: {
					type: 'string',
					title: localize('agentHost.config.customizations.displayName', "Name"),
				},
				description: {
					type: 'string',
					title: localize('agentHost.config.customizations.descriptionField', "Description"),
				},
			},
			required: ['uri', 'displayName'],
		},
	}),
	[AgentHostConfigKey.DefaultShell]: schemaProperty<string>({
		type: 'string',
		title: localize('agentHost.config.defaultShell.title', "Default Shell"),
		description: localize('agentHost.config.defaultShell.description', "Absolute path to the shell executable used by host-managed terminals. Normally pushed by the connected VS Code client from `terminal.integrated.agentHostProfile.<os>` (falling back to `terminal.integrated.defaultProfile.<os>`); when unset, the agent host falls back to the system shell. Only the path is supported; `args` and `env` from the workbench profile are not piped through yet. The workbench only pushes this for the local agent host — remote agent host operators should set this directly in the remote machine's `agent-host-config.json`."),
	}),
	[AgentHostConfigKey.EnableCustomTerminalTool]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.enableCustomTerminalTool.title', "Use Agent Host Terminal Tool"),
		description: localize('agentHost.config.enableCustomTerminalTool.description', "When enabled, Copilot SDK sessions use Agent Host's terminal tool override instead of the SDK's default terminal behavior."),
		default: false,
	}),
	[AgentHostConfigKey.RubberDuck]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.rubberDuck.title', "Rubber Duck Agent"),
		description: localize('agentHost.config.rubberDuck.description', "When enabled, the coding agent uses a rubber duck critic subagent to review code changes using a complementary model."),
		default: false,
	}),
	[AgentHostConfigKey.Opus48Prompt]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.opus48Prompt.title', "Opus 4.8 Agent Prompt"),
		description: localize('agentHost.config.opus48Prompt.description', "When enabled, Copilot SDK sessions running a Claude Opus 4.8 model apply Opus 4.8-tuned system-prompt section overrides on top of the default system message."),
		default: false,
	}),
	[AgentHostConfigKey.ClaudeUseCopilotProxy]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.claudeUseCopilotProxy.title', "Route Claude Through Copilot"),
		// FORK: default to native (off). The Claude agent then runs on the user's local `claude`
		// login / subscription (no Copilot, no API key) — the same auth as the `claude` CLI.
		description: localize('agentHost.config.claudeUseCopilotProxy.description', "When enabled, the Claude agent routes all requests through GitHub Copilot. When disabled (the default), Claude runs on your own local Claude login (subscription) — no Copilot and no separate API key."),
		default: false,
	}),
	[AgentHostConfigKey.ClaudeLocalContextTrim]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.claudeLocalContextTrim.title', "Claude Local Context Trimming"),
		description: localize('agentHost.config.claudeLocalContextTrim.description', "When enabled (the default), oversized tool outputs (large file reads, wide searches, verbose command output) are capped before they enter the conversation: the head and tail are kept around an elision marker. This bounds context growth and cost in long sessions, runs entirely on your machine, and works on every transport. Already-sent history is never modified, so prompt caching keeps working."),
		default: true,
	}),
	[AgentHostConfigKey.ClaudeLocalContextTrimMaxChars]: schemaProperty<number>({
		type: 'number',
		title: localize('agentHost.config.claudeLocalContextTrimMaxChars.title', "Local Context Trim Cap (Characters)"),
		description: localize('agentHost.config.claudeLocalContextTrimMaxChars.description', "Maximum characters a single tool output may contribute to the conversation while Claude Local Context Trimming is enabled. Larger outputs keep their head and tail around an elision marker. Roughly 4 characters per token."),
		default: 20000,
	}),
	[AgentHostConfigKey.ClaudeLocalContextDedupeReads]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.claudeLocalContextDedupeReads.title', "Claude Deduplicate Repeated File Reads"),
		description: localize('agentHost.config.claudeLocalContextDedupeReads.description', "When enabled, re-reading a file whose content is identical to an earlier read in the same session replaces the duplicate content with a pointer to the earlier read. Saves tokens in read-heavy sessions, but the model must refer back to the earlier copy — disable if it struggles to find content it just read. Off by default."),
		default: false,
	}),
	[AgentHostConfigKey.ClaudeAutoCompact]: schemaProperty<boolean>({
		type: 'boolean',
		title: localize('agentHost.config.claudeAutoCompact.title', "Claude Auto-Compact Conversations"),
		description: localize('agentHost.config.claudeAutoCompact.description', "When enabled (the default), a session whose context grows past the configured trigger size is compacted before the next prompt: the earlier conversation is summarized by Claude's built-in /compact, freeing up context and keeping long sessions responsive and affordable. A notice appears in the transcript whenever compaction runs."),
		default: true,
	}),
	[AgentHostConfigKey.ClaudeAutoCompactTriggerTokens]: schemaProperty<number>({
		type: 'number',
		title: localize('agentHost.config.claudeAutoCompactTriggerTokens.title', "Auto-Compact Trigger (Tokens)"),
		description: localize('agentHost.config.claudeAutoCompactTriggerTokens.description', "Context size in tokens at which the conversation is compacted before the next prompt. Lower values keep sessions cheaper but summarize earlier conversation sooner. Only used while Claude Auto-Compact Conversations is enabled."),
		default: 120000,
	}),
	[AgentHostConfigKey.ChatSupportBackend]: schemaProperty<string>({
		type: 'string',
		enum: ['claude', 'agy', 'cursor-agent'],
		title: localize('agentHost.config.chatSupportBackend.title', "Support Task Backend"),
		description: localize('agentHost.config.chatSupportBackend.description', "Which agent CLI runs light support completions (session titles, summaries). Route these to an idle secondary tool to keep them off the main Claude chat's usage bucket. `claude` (the default) keeps them local; `agy` and `cursor-agent` use their own separate token pools."),
		default: 'claude',
	}),
	[AgentHostConfigKey.ChatSupportModel]: schemaProperty<string>({
		type: 'string',
		title: localize('agentHost.config.chatSupportModel.title', "Support Task Model"),
		description: localize('agentHost.config.chatSupportModel.description', "Model passed to the support task backend. When empty, a cheap per-backend default is used (claude: `haiku`, agy: `Gemini 3.5 Flash (Low)`, cursor-agent: `composer-2.5`)."),
		default: '',
	}),
});

export const defaultAgentHostCustomizationConfigValues = {
	[AgentHostConfigKey.Customizations]: [] as IPersistedCustomizationConfigEntry[],
};

/**
 * Reads the persisted (legacy-shaped) plugin entries from the agent-host
 * root config and lifts them into the new {@link Customization} container
 * shape used by the rest of the platform.
 */
export function getAgentHostConfiguredCustomizations(values: Record<string, unknown> | undefined): readonly Customization[] {
	const raw = values?.[AgentHostConfigKey.Customizations];
	const entries = agentHostCustomizationConfigSchema.validate(AgentHostConfigKey.Customizations, raw)
		? raw
		: defaultAgentHostCustomizationConfigValues[AgentHostConfigKey.Customizations];
	return entries.map(toContainerCustomization);
}

/**
 * Lifts a persisted plugin config entry into the new
 * {@link Customization} container shape.
 */
export function toContainerCustomization(entry: IPersistedCustomizationConfigEntry): PluginCustomization {
	return {
		type: CustomizationType.Plugin,
		id: customizationId(entry.uri),
		uri: entry.uri,
		name: entry.displayName,
		enabled: true,
	};
}
