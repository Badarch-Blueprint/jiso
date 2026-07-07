/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentProvider, IAgentDescriptor, IAgentModelInfo } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ToolCallConfirmationReason } from '../../common/state/protocol/state.js';
import { type MessageAttachment } from '../../common/state/sessionState.js';
import { ExternalCliAgent, ExternalCliSession, resolvePromptWithAttachments } from '../shared/externalCliAgent.js';

/**
 * FORK: provider id for the Codex Fugu headless CLI provider. `codex-fugu` is
 * the user's local wrapper that runs the OpenAI codex CLI under its `fugu`
 * profile (Sakana Fugu models), with the user's own login — independent of the
 * Copilot-proxied app-server `codex` provider.
 */
const CODEX_FUGU_PROVIDER_ID = 'codex-fugu';

/**
 * True iff the `codex-fugu` binary is on PATH and runnable. Checked at
 * agent-host startup so a missing CLI never surfaces a broken picker entry.
 * The wrapper may run a throttled self-update check, so allow a generous
 * timeout before declaring it unavailable.
 */
export function isCodexFuguCliAvailable(): boolean {
	try {
		const result = spawnSync('codex-fugu', ['--version'], { stdio: 'ignore', env: process.env, timeout: 15_000 });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Static model list. `codex exec` has no model-listing command, so the ids are
 * forwarded verbatim to `codex-fugu exec --model`. `fugu` is the wrapper
 * profile's go-to model; Fugu Ultra is its high-quality tier.
 */
const CODEX_FUGU_MODELS: readonly IAgentModelInfo[] = [
	{ provider: CODEX_FUGU_PROVIDER_ID, id: 'fugu', name: 'Fugu', supportsVision: true, maxContextWindow: 400_000 },
	{ provider: CODEX_FUGU_PROVIDER_ID, id: 'fugu-ultra', name: 'Fugu Ultra', supportsVision: true, maxContextWindow: 400_000 },
	{ provider: CODEX_FUGU_PROVIDER_ID, id: 'gpt-5.5', name: 'GPT-5.5', supportsVision: true, maxContextWindow: 400_000 },
	{ provider: CODEX_FUGU_PROVIDER_ID, id: 'gpt-5.3-codex', name: 'Codex 5.3', supportsVision: true, maxContextWindow: 400_000 },
];

/**
 * Minimal shape of one `codex exec --json` thread-event line. Items carry the
 * turn's content: `agent_message` / `reasoning` text, `command_execution` and
 * other tool-ish items with lifecycle `item.started` → `item.completed`.
 */
interface CodexFuguThreadEvent {
	readonly type?: string;
	readonly thread_id?: string;
	readonly message?: string;
	readonly error?: { readonly message?: string };
	readonly item?: {
		readonly id?: string;
		readonly type?: string;
		readonly text?: string;
		readonly command?: string;
		readonly aggregated_output?: string;
		readonly exit_code?: number;
		readonly status?: string;
	};
	readonly usage?: { readonly input_tokens?: number; readonly cached_input_tokens?: number; readonly output_tokens?: number };
}

/** Human-readable label for a thread-event item type (e.g. `command_execution` → `Command execution`). */
function itemDisplayName(itemType: string): string {
	const words = itemType.replace(/_/g, ' ');
	return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : 'Tool';
}

/**
 * One live conversation backed by the local `codex-fugu` CLI. Each user turn
 * spawns a fresh `codex-fugu exec --json` process; the first turn's
 * `thread.started` event yields the thread id, which later turns resume via
 * `codex-fugu exec resume <thread_id>` so context carries across turns.
 */
class CodexFuguCliSession extends ExternalCliSession {

	/** The codex-owned thread id, captured from `thread.started`; used to resume. */
	private _threadId: string | undefined;
	private _activeChild: ChildProcessWithoutNullStreams | undefined;
	private _sawTurnEnd = false;
	private _stderr = '';

	async send(prompt: string, turnId: string, attachments?: readonly MessageAttachment[]): Promise<void> {
		const resolvedPrompt = resolvePromptWithAttachments(prompt, attachments);
		// `--dangerously-bypass-approvals-and-sandbox` mirrors the other headless CLI
		// providers' bypass behavior (`exec` is non-interactive, so approval prompts
		// could never be answered). `--skip-git-repo-check` lets sessions run in
		// non-git working directories.
		const args = ['exec'];
		if (this._threadId) {
			args.push('resume', this._threadId);
		}
		args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox');
		if (this._model) {
			args.push('--model', this._model);
		}
		args.push(resolvedPrompt);

		this._sawTurnEnd = false;
		this._stderr = '';

		const child = spawn('codex-fugu', args, { cwd: this._cwd, env: process.env });
		this._activeChild = child;
		// The prompt is passed as an argument; close stdin so `exec` never waits
		// for the additional piped input it otherwise reads.
		child.stdin.end();

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
				this._logService.warn(`[CodexFugu:${this._rawSessionId}] stderr: ${text}`);
			});
			child.on('error', err => {
				this._logService.error(`[CodexFugu:${this._rawSessionId}] failed to launch codex-fugu: ${err}`);
				this._emitTurnError(turnId, 'cli_launch_failed', `Couldn't launch the \`codex-fugu\` CLI: ${err}. Is it installed and on PATH?`);
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
				if (!this._sawTurnEnd) {
					const detail = this._stderr.trim() || (typeof code === 'number' ? `exit code ${code}` : 'no output');
					this._emitTurnError(turnId, 'cli_no_result', `The \`codex-fugu\` CLI ended without completing the turn: ${detail}`);
				}
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
		});
	}

	private _handleLine(line: string, turnId: string): void {
		let event: CodexFuguThreadEvent;
		try {
			event = JSON.parse(line) as CodexFuguThreadEvent;
		} catch {
			return; // non-JSON noise (wrapper notices, update banners)
		}

		switch (event.type) {
			case 'thread.started': {
				if (typeof event.thread_id === 'string') {
					this._threadId = event.thread_id;
				}
				return;
			}

			case 'item.started': {
				const item = event.item;
				if (!item?.id || !item.type || item.type === 'agent_message' || item.type === 'reasoning') {
					return;
				}
				// Tool-ish items (command_execution, file_change, mcp_tool_call, …).
				this._closeParts();
				const displayName = itemDisplayName(item.type);
				this._fireAction({
					type: ActionType.ChatToolCallStart,
					turnId,
					toolCallId: item.id,
					toolName: item.type,
					displayName,
				});
				this._fireAction({
					type: ActionType.ChatToolCallReady,
					turnId,
					toolCallId: item.id,
					invocationMessage: item.command ?? displayName,
					confirmed: ToolCallConfirmationReason.NotNeeded,
				});
				return;
			}

			case 'item.completed': {
				const item = event.item;
				if (!item?.id || !item.type) {
					return;
				}
				if (item.type === 'agent_message') {
					if (item.text) {
						this._appendText(turnId, item.text);
						this._closeParts();
					}
					return;
				}
				if (item.type === 'reasoning') {
					if (item.text) {
						this._appendReasoning(turnId, item.text);
						this._closeParts();
					}
					return;
				}
				const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
				this._fireAction({
					type: ActionType.ChatToolCallComplete,
					turnId,
					toolCallId: item.id,
					result: {
						success: !failed,
						pastTenseMessage: `${itemDisplayName(item.type)} ${failed ? 'failed' : 'finished'}`,
					},
				});
				return;
			}

			case 'turn.completed': {
				this._sawTurnEnd = true;
				if (event.usage) {
					this._fireAction({
						type: ActionType.ChatUsage,
						turnId,
						usage: {
							inputTokens: event.usage.input_tokens ?? 0,
							outputTokens: event.usage.output_tokens ?? 0,
							cacheReadTokens: event.usage.cached_input_tokens,
							...(this._model ? { model: this._model } : {}),
						},
					});
				}
				this._emitTurnComplete(turnId);
				return;
			}

			case 'turn.failed':
			case 'error': {
				// `error` precedes `turn.failed` with the same message; only the
				// first one ends the turn, the duplicate is dropped.
				if (this._sawTurnEnd) {
					return;
				}
				this._sawTurnEnd = true;
				const message = event.error?.message ?? event.message ?? 'The `codex-fugu` CLI reported an error.';
				this._emitTurnError(turnId, 'cli_turn_failed', message);
				return;
			}
		}
	}

	abort(): void {
		this._activeChild?.kill('SIGTERM');
		this._activeChild = undefined;
	}
}

/**
 * FORK: {@link ExternalCliAgent} provider that drives the user's locally
 * installed `codex-fugu` CLI in headless mode (`codex exec` under the `fugu`
 * profile), using their own login — no GitHub Copilot involvement.
 */
export class CodexFuguCliAgent extends ExternalCliAgent {

	constructor(@ILogService logService: ILogService) {
		super(logService);
	}

	readonly id: AgentProvider = CODEX_FUGU_PROVIDER_ID;

	readonly models: IObservable<readonly IAgentModelInfo[]> = observableValue<readonly IAgentModelInfo[]>('codexFuguCliModels', CODEX_FUGU_MODELS);

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'Codex Fugu',
			description: 'Codex agent (Fugu models) driven by your local `codex-fugu` CLI in headless mode',
		};
	}

	protected _createCliSession(sessionUri: URI, rawSessionId: string, cwd: string | undefined, model: string | undefined): ExternalCliSession {
		return new CodexFuguCliSession(sessionUri, rawSessionId, cwd, model, this._onDidSessionProgress, this._logService);
	}

	/**
	 * Validation ping for the settings toggle: one minimal read-only `exec`
	 * turn on the cheapest model. Proves the CLI is installed, authenticated
	 * and the model deployment answers.
	 */
	async pingAgent(): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			const child = spawn('codex-fugu', ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'fugu', 'ok'], { env: process.env });
			child.stdin.end();
			let sawCompleted = false;
			let output = '';
			const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
			child.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes('"turn.completed"')) {
					sawCompleted = true;
					clearTimeout(timeout);
					child.kill('SIGTERM');
				}
			});
			child.on('error', () => {
				clearTimeout(timeout);
				resolve(false);
			});
			child.on('close', code => {
				clearTimeout(timeout);
				if (!sawCompleted && code !== 0) {
					this._logService.warn(`[CodexFugu] ping failed (exit ${code}): ${output.slice(-400)}`);
				}
				resolve(sawCompleted || code === 0);
			});
		});
	}
}
