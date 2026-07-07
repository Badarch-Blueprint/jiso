/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentProvider, IAgentDescriptor, IAgentModelInfo } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ToolCallConfirmationReason } from '../../common/state/protocol/state.js';
import { type MessageAttachment } from '../../common/state/sessionState.js';
import { ExternalCliAgent, ExternalCliSession, resolvePromptWithAttachments } from '../shared/externalCliAgent.js';

/** FORK: provider id for the Cursor Agent headless CLI provider. */
const CURSOR_PROVIDER_ID = 'cursor-agent';

/**
 * True iff the `cursor-agent` binary is on PATH and runnable. Checked at
 * agent-host startup so a missing CLI never surfaces a broken picker entry.
 */
export function isCursorAgentCliAvailable(): boolean {
	try {
		const result = spawnSync('cursor-agent', ['--version'], { stdio: 'ignore', env: process.env });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Fallback model list. The `id` is forwarded verbatim to `cursor-agent --model`;
 * `auto` lets Cursor's backend pick the model per request. We intentionally
 * expose only Auto so the picker does not advertise Cursor's paid catalog.
 */
const CURSOR_AUTO_MODELS: readonly IAgentModelInfo[] = [
	{ provider: CURSOR_PROVIDER_ID, id: 'auto', name: 'Auto', supportsVision: true, maxContextWindow: 200_000 },
];

async function runCursorAgent(args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn('cursor-agent', [...args], { env: process.env });
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on('error', err => {
			clearTimeout(timeout);
			resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
		});
		child.on('close', code => {
			clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});
	});
}

function parseCursorAutoModels(output: string): readonly IAgentModelInfo[] {
	const models: IAgentModelInfo[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^(?<id>\S+)\s+-\s+(?<name>.+?)\s*(?:\(.+\))?$/.exec(line.trim());
		if (!match?.groups || match.groups.id !== 'auto') {
			continue;
		}
		models.push({
			provider: CURSOR_PROVIDER_ID,
			id: match.groups.id,
			name: match.groups.name.trim() || 'Auto',
			supportsVision: true,
			maxContextWindow: 200_000,
		});
	}
	return models.length ? models : CURSOR_AUTO_MODELS;
}

/** Minimal shape of one `cursor-agent --output-format stream-json` line. */
interface CursorStreamEvent {
	readonly type?: string;
	readonly subtype?: string;
	readonly session_id?: string;
	readonly timestamp_ms?: number;
	readonly model_call_id?: string;
	readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] };
	readonly text?: string;
	readonly call_id?: string;
	readonly tool_call?: Record<string, unknown>;
	readonly is_error?: boolean;
	readonly result?: string;
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number };
}

/**
 * One live conversation backed by the local `cursor-agent` CLI. Each user turn
 * spawns a fresh `cursor-agent -p ... --output-format stream-json` process,
 * resuming the prior turn's Cursor chat so context carries across turns. The
 * wire format is Claude-Code-like but not identical, so this session does its
 * own (much smaller) mapping to agent signals:
 *
 * - `assistant` envelopes with `timestamp_ms` and no `model_call_id` are the
 *   incremental text deltas (`--stream-partial-output`); envelopes with a
 *   `model_call_id` (per-model-call accumulation) or without `timestamp_ms`
 *   (final whole-message replay) duplicate them and are dropped.
 * - `thinking` delta/completed events stream reasoning.
 * - `tool_call` started/completed events wrap one `<name>ToolCall` object.
 * - `result` carries the terminal outcome + token usage.
 */
class CursorCliSession extends ExternalCliSession {

	/** The Cursor-owned chat id, captured from stream events; used to `--resume`. */
	private _cursorSessionId: string | undefined;
	private _activeChild: ChildProcessWithoutNullStreams | undefined;
	private _sawResult = false;
	/** True once any streamed text delta was rendered for the active turn. */
	private _sawStreamText = false;
	private _stderr = '';
	/** Display names of started tool calls, for the completion message. */
	private readonly _toolDisplayNames = new Map<string, string>();

	async send(prompt: string, turnId: string, attachments?: readonly MessageAttachment[]): Promise<void> {
		const resolvedPrompt = resolvePromptWithAttachments(prompt, attachments);
		// `--trust` skips the interactive workspace-trust prompt (headless runs
		// can't answer it); `--force` auto-allows tool/shell executions, mirroring
		// the Claude CLI provider's `bypassPermissions` MVP behavior.
		const args = ['-p', resolvedPrompt, '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--force'];
		if (this._cursorSessionId) {
			args.push('--resume', this._cursorSessionId);
		}
		if (this._model) {
			args.push('--model', this._model);
		}

		this._sawResult = false;
		this._sawStreamText = false;
		this._stderr = '';

		const child = spawn('cursor-agent', args, { cwd: this._cwd, env: process.env });
		this._activeChild = child;

		let buffer = '';
		const drain = () => {
			let nl: number;
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line) {
					this._handleLine(line, turnId);
				}
			}
		};

		await new Promise<void>(resolve => {
			child.stdout.on('data', (chunk: Buffer) => { buffer += chunk.toString(); drain(); });
			child.stderr.on('data', (d: Buffer) => {
				const text = d.toString();
				this._stderr += text;
				this._logService.warn(`[CursorCli:${this._rawSessionId}] stderr: ${text}`);
			});
			child.on('error', err => {
				this._logService.error(`[CursorCli:${this._rawSessionId}] failed to launch cursor-agent: ${err}`);
				this._emitTurnError(turnId, 'cli_launch_failed', `Couldn't launch the \`cursor-agent\` CLI: ${err}. Is it installed and on PATH?`);
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
			child.on('close', code => {
				if (buffer.trim()) {
					this._handleLine(buffer.trim(), turnId);
					buffer = '';
				}
				if (!this._sawResult) {
					const detail = this._stderr.trim() || (typeof code === 'number' ? `exit code ${code}` : 'no output');
					this._emitTurnError(turnId, 'cli_no_result', `The \`cursor-agent\` CLI ended without completing the turn: ${detail}`);
				}
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
		});
	}

	private _handleLine(line: string, turnId: string): void {
		let event: CursorStreamEvent;
		try {
			event = JSON.parse(line) as CursorStreamEvent;
		} catch {
			return; // non-JSON noise
		}

		if (typeof event.session_id === 'string') {
			this._cursorSessionId = event.session_id;
		}

		switch (event.type) {
			case 'assistant': {
				// Only pure deltas: accumulated (`model_call_id`) and final-replay
				// (no `timestamp_ms`) envelopes repeat text already streamed.
				if (typeof event.timestamp_ms !== 'number' || typeof event.model_call_id === 'string') {
					return;
				}
				const text = (event.message?.content ?? [])
					.filter(block => block.type === 'text' && typeof block.text === 'string')
					.map(block => block.text)
					.join('');
				if (text) {
					this._appendText(turnId, text);
					this._sawStreamText = true;
				}
				return;
			}

			case 'thinking': {
				if (event.subtype === 'delta' && typeof event.text === 'string') {
					this._appendReasoning(turnId, event.text);
				} else if (event.subtype === 'completed') {
					this._closeParts();
				}
				return;
			}

			case 'tool_call': {
				if (typeof event.call_id !== 'string' || !event.tool_call) {
					return;
				}
				if (event.subtype === 'started') {
					this._handleToolCallStarted(event.call_id, event.tool_call, turnId);
				} else if (event.subtype === 'completed') {
					this._handleToolCallCompleted(event.call_id, event.tool_call, turnId);
				}
				return;
			}

			case 'result': {
				this._sawResult = true;
				// Belt-and-braces: if partial streaming yielded nothing (e.g. a
				// future CLI drops the flag), render the terminal result text.
				if (!this._sawStreamText && !event.is_error && typeof event.result === 'string' && event.result) {
					this._appendText(turnId, event.result);
				}
				if (event.usage) {
					this._fireAction({
						type: ActionType.ChatUsage,
						turnId,
						usage: {
							inputTokens: event.usage.inputTokens ?? 0,
							outputTokens: event.usage.outputTokens ?? 0,
							cacheReadTokens: event.usage.cacheReadTokens,
							cacheCreationTokens: event.usage.cacheWriteTokens,
							...(this._model ? { model: this._model } : {}),
						},
					});
				}
				if (event.is_error) {
					this._emitTurnError(turnId, 'cli_result_error', typeof event.result === 'string' && event.result ? event.result : 'The `cursor-agent` CLI reported an error.');
				} else {
					this._emitTurnComplete(turnId);
				}
				return;
			}
		}
	}

	/**
	 * A `tool_call.tool_call` envelope wraps exactly one `<name>ToolCall`
	 * object (e.g. `shellToolCall`, `readToolCall`). Unwrap it to a display
	 * name plus its `args`/`description` payload.
	 */
	private _unwrapToolCall(toolCall: Record<string, unknown>): { name: string; payload: Record<string, unknown> | undefined } {
		const key = Object.keys(toolCall).find(k => k.endsWith('ToolCall') && typeof toolCall[k] === 'object' && toolCall[k] !== null);
		if (!key) {
			return { name: 'tool', payload: undefined };
		}
		const raw = key.slice(0, -'ToolCall'.length);
		return { name: raw.length > 0 ? raw[0].toUpperCase() + raw.slice(1) : 'tool', payload: toolCall[key] as Record<string, unknown> };
	}

	private _handleToolCallStarted(callId: string, toolCall: Record<string, unknown>, turnId: string): void {
		// Text after a tool call belongs in a fresh response part.
		this._closeParts();
		const { name, payload } = this._unwrapToolCall(toolCall);
		const args = payload?.args as Record<string, unknown> | undefined;
		const description = [payload?.description, args?.description, args?.command]
			.find((v): v is string => typeof v === 'string' && v.length > 0);
		this._toolDisplayNames.set(callId, name);
		this._fireAction({
			type: ActionType.ChatToolCallStart,
			turnId,
			toolCallId: callId,
			toolName: name,
			displayName: name,
		});
		this._fireAction({
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId: callId,
			invocationMessage: description ?? name,
			...(args !== undefined ? { toolInput: JSON.stringify(args) } : {}),
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	private _handleToolCallCompleted(callId: string, toolCall: Record<string, unknown>, turnId: string): void {
		const { payload } = this._unwrapToolCall(toolCall);
		const result = payload?.result as Record<string, unknown> | undefined;
		// Cursor reports the outcome as a single-key discriminator on `result`
		// (`success`, `rejected`, `error`, `aborted`, …).
		const failed = !!result && (hasKey(result, { rejected: true }) || hasKey(result, { error: true }) || hasKey(result, { aborted: true }) || hasKey(result, { failure: true }));
		const name = this._toolDisplayNames.get(callId) ?? 'Tool';
		this._toolDisplayNames.delete(callId);
		this._fireAction({
			type: ActionType.ChatToolCallComplete,
			turnId,
			toolCallId: callId,
			result: {
				success: !failed,
				pastTenseMessage: failed ? `${name} failed` : `${name} finished`,
			},
		});
	}

	abort(): void {
		this._activeChild?.kill('SIGTERM');
		this._activeChild = undefined;
	}
}

/**
 * FORK: {@link ExternalCliAgent} provider that drives the user's locally
 * installed `cursor-agent` CLI in headless mode, using their own Cursor
 * login — no GitHub Copilot involvement.
 */
export class CursorCliAgent extends ExternalCliAgent {

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('cursorCliModels', []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	constructor(@ILogService logService: ILogService) {
		super(logService);
		void this._refreshModels();
	}

	readonly id: AgentProvider = CURSOR_PROVIDER_ID;

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'Cursor Agent',
			description: 'Cursor agent driven by your local `cursor-agent` CLI in headless mode',
		};
	}

	protected _createCliSession(sessionUri: URI, rawSessionId: string, cwd: string | undefined, model: string | undefined): ExternalCliSession {
		return new CursorCliSession(sessionUri, rawSessionId, cwd, model, this._onDidSessionProgress, this._logService);
	}

	private async _refreshModels(): Promise<void> {
		const result = await runCursorAgent(['models'], 30_000);
		if (result.code === 0) {
			this._models.set(parseCursorAutoModels(result.stdout), undefined);
			return;
		}
		this._logService.warn(`[CursorCli] failed to list models: ${result.stderr.trim() || `exit code ${result.code}`}`);
		this._models.set(CURSOR_AUTO_MODELS, undefined);
	}

	async pingAgent(): Promise<boolean> {
		const result = await runCursorAgent(['-p', 'ok', '--output-format', 'json', '--mode', 'ask', '--trust', '--force', '--model', 'auto'], 60_000);
		if (result.code !== 0) {
			this._logService.warn(`[CursorCli] ping failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
			return false;
		}
		await this._refreshModels();
		return true;
	}
}
