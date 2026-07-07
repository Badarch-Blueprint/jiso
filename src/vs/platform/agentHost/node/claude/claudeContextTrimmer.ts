/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HookCallback, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/**
 * FORK: fully client-side ("bring your own") context management for native
 * Claude sessions. This manages context entirely inside the harness
 * via the SDK's documented `PostToolUse` hook (`updatedToolOutput`
 * "replaces the tool output before it is sent to the model"). Nothing on the
 * wire changes, no beta is injected, and it works identically on any
 * transport (subscription / API key / Copilot).
 *
 * The mechanism is FORWARD-ONLY: it shrinks a tool's output at the moment the
 * tool runs, before that output is first sent and cached. It never rewrites
 * already-stored history, so the prompt prefix stays byte-stable and prompt
 * caching keeps working (contrast with reclaiming old context via truncation
 * / compaction, which invalidates the cache after the cut point).
 *
 * Two independent levers:
 *  1. **Cap** (default on) — an output larger than {@link IClaudeContextTrimConfig.maxChars}
 *     is replaced with its head + tail and an elision marker. Bounds the
 *     worst offenders (large file reads, wide greps, verbose command output).
 *  2. **Dedupe reads** (default off) — a repeated read of a file whose content
 *     is byte-identical to an earlier read this session is replaced with a
 *     pointer back to the earlier read. More behaviorally aggressive (the
 *     model must look upward for the content), hence opt-in.
 */
export interface IClaudeContextTrimConfig {
	/** Master switch for output capping. */
	readonly enabled: boolean;
	/** Outputs longer than this (characters) are capped. */
	readonly maxChars: number;
	/** Replace re-reads of unchanged files with a pointer to the earlier read. */
	readonly dedupeReads: boolean;
}

/** Marker text is intentionally explicit so a human reading the transcript knows why content is missing. */
const ELISION_MARKER = (elided: number) =>
	`\n\n… [${elided} characters elided by JisoIDE local context management — the full output was large; head and tail are shown] …\n\n`;

const DEDUPE_MARKER = (path: string) =>
	`[JisoIDE local context management: "${path}" is byte-identical to an earlier read in this session — see that earlier read above rather than re-reading.]`;

/** Fraction of the budget kept from the head; the remainder is kept from the tail. */
const HEAD_FRACTION = 0.6;

/** Bound the per-agent dedupe map so a very long-lived agent can't grow it without limit. */
const MAX_DEDUPE_ENTRIES = 2000;

/** Tool names (SDK/CLI built-ins) whose output is a file read, eligible for dedupe. */
const READ_TOOL_NAMES = new Set(['Read', 'read']);

/**
 * Cap a single text blob to `maxChars`, keeping head + tail around an elision
 * marker. Returns the input unchanged when it already fits. Pure.
 */
export function capText(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) {
		return text;
	}
	const headLen = Math.max(0, Math.floor(maxChars * HEAD_FRACTION));
	const tailLen = Math.max(0, maxChars - headLen);
	const elided = text.length - headLen - tailLen;
	if (elided <= 0) {
		return text;
	}
	return text.slice(0, headLen) + ELISION_MARKER(elided) + text.slice(text.length - tailLen);
}

/**
 * A tool response is either a plain string or the block-array form
 * (`[{type:'text', text}, …]`) that Claude Code uses for textual tool output.
 * Anything else (structured/object payloads) is passed through untouched so we
 * never corrupt a shape a tool depends on.
 */
type TextBlock = { readonly type: string; readonly text?: unknown };

function isTextBlockArray(value: unknown): value is TextBlock[] {
	return Array.isArray(value) && value.every(b => b !== null && typeof b === 'object' && 'type' in (b as object));
}

/** Total character length of the trimmable text in a response (0 when nothing is trimmable). */
function textLengthOf(response: unknown): number {
	if (typeof response === 'string') {
		return response.length;
	}
	if (isTextBlockArray(response)) {
		return response.reduce((sum, b) => sum + (typeof b.text === 'string' ? b.text.length : 0), 0);
	}
	return 0;
}

/** Map `fn` over the trimmable text of a response, preserving its shape. */
function mapText(response: unknown, fn: (text: string) => string): unknown {
	if (typeof response === 'string') {
		return fn(response);
	}
	if (isTextBlockArray(response)) {
		return response.map(b => (typeof b.text === 'string' ? { ...b, text: fn(b.text) } : b));
	}
	return response;
}

/** Concatenate the trimmable text of a response (for hashing / dedupe comparison). */
function concatText(response: unknown): string {
	if (typeof response === 'string') {
		return response;
	}
	if (isTextBlockArray(response)) {
		return response.map(b => (typeof b.text === 'string' ? b.text : '')).join('');
	}
	return '';
}

/**
 * Fast, allocation-cheap non-cryptographic hash (FNV-1a, 32-bit). Used only to
 * detect "same file content as before" for dedupe — collisions merely cause a
 * missed dedupe, never wrong output, so cryptographic strength is unnecessary.
 */
function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/** Best-effort extraction of the `file_path` a Read tool was invoked with. */
function readPathOf(toolInput: unknown): string | undefined {
	if (toolInput !== null && typeof toolInput === 'object') {
		const p = (toolInput as Record<string, unknown>).file_path;
		if (typeof p === 'string' && p.length > 0) {
			return p;
		}
	}
	return undefined;
}

/**
 * Per-session, per-file record of the last-seen read hash, used by dedupe.
 * Insertion-ordered so the oldest entry can be evicted when the cap is hit.
 * Keyed by `${sessionId}\0${agentId}\0${filePath}` so subagents don't alias
 * the main thread and concurrent sessions stay isolated.
 */
export type ReadDedupeState = Map<string, string>;

/**
 * Core decision, factored out as a pure function for testing: given a tool
 * result and the current dedupe state, return the (possibly replaced) output
 * and whether it changed. Mutates `readState` only for read tools (records the
 * new hash, evicting the oldest entry past {@link MAX_DEDUPE_ENTRIES}).
 */
export function trimToolResult(
	args: { readonly toolName: string; readonly toolInput: unknown; readonly toolResponse: unknown; readonly stateKeyPrefix: string },
	config: IClaudeContextTrimConfig,
	readState: ReadDedupeState,
): { readonly output: unknown; readonly changed: boolean; readonly reason?: 'cap' | 'dedupe' } {
	const { toolName, toolInput, toolResponse, stateKeyPrefix } = args;

	// Dedupe first: a re-read that collapses to a pointer needs no capping.
	if (config.dedupeReads && READ_TOOL_NAMES.has(toolName)) {
		const path = readPathOf(toolInput);
		const text = concatText(toolResponse);
		if (path !== undefined && text.length > 0) {
			const key = `${stateKeyPrefix}\0${path}`;
			const hash = hashText(text);
			const previous = readState.get(key);
			// Refresh insertion order + bound size on every observation.
			readState.delete(key);
			readState.set(key, hash);
			if (readState.size > MAX_DEDUPE_ENTRIES) {
				const oldest = readState.keys().next().value;
				if (oldest !== undefined) {
					readState.delete(oldest);
				}
			}
			if (previous === hash) {
				return { output: DEDUPE_MARKER(path), changed: true, reason: 'dedupe' };
			}
		}
	}

	if (config.enabled && textLengthOf(toolResponse) > config.maxChars) {
		return { output: mapText(toolResponse, t => capText(t, config.maxChars)), changed: true, reason: 'cap' };
	}

	return { output: toolResponse, changed: false };
}

/**
 * Build the `PostToolUse` {@link HookCallback} to hand to `Options.hooks`.
 * Closes over a single dedupe map for the agent's lifetime (bounded by
 * {@link MAX_DEDUPE_ENTRIES}). `getConfig` is read per-invocation so config
 * changes take effect on the next tool call with no restart. When the config
 * is fully off (no cap, no dedupe) the hook is a no-op passthrough.
 */
export function createPostToolUseTrimHook(
	getConfig: () => IClaudeContextTrimConfig,
	log?: (message: string, sessionId: string) => void,
): HookCallback {
	const readState: ReadDedupeState = new Map();
	return async input => {
		if (input.hook_event_name !== 'PostToolUse') {
			return {};
		}
		const config = getConfig();
		if (!config.enabled && !config.dedupeReads) {
			return {};
		}
		const post = input as PostToolUseHookInput;
		const stateKeyPrefix = `${post.session_id}\0${post.agent_id ?? ''}`;
		const { output, changed, reason } = trimToolResult(
			{ toolName: post.tool_name, toolInput: post.tool_input, toolResponse: post.tool_response, stateKeyPrefix },
			config,
			readState,
		);
		if (!changed) {
			return {};
		}
		const before = textLengthOf(post.tool_response);
		const after = textLengthOf(output);
		log?.(`context trim (${reason}): ${post.tool_name} output ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} chars`, post.session_id);
		return {
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				updatedToolOutput: output,
			},
		};
	};
}
