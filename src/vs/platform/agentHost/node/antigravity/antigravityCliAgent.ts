/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentProvider, IAgentDescriptor, IAgentModelInfo } from '../../common/agentService.js';
import { type MessageAttachment } from '../../common/state/sessionState.js';
import { ExternalCliAgent, ExternalCliSession, resolvePromptWithAttachments } from '../shared/externalCliAgent.js';

/** FORK: provider id for the Antigravity (`agy`) headless CLI provider. */
const ANTIGRAVITY_PROVIDER_ID = 'antigravity';

/**
 * True iff the `agy` binary is on PATH and runnable. Checked at agent-host
 * startup so a missing CLI never surfaces a broken picker entry.
 */
export function isAntigravityCliAvailable(): boolean {
	try {
		const result = spawnSync('agy', ['--help'], { stdio: 'ignore', env: process.env });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * Static model list. The `id` is the display string `agy models` reports and
 * is forwarded verbatim to `agy --model`. Gemini 3-generation models carry a
 * 1M-token context window.
 */
const ANTIGRAVITY_MODELS: readonly IAgentModelInfo[] = [
	{ provider: ANTIGRAVITY_PROVIDER_ID, id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', supportsVision: true, maxContextWindow: 1_000_000 },
	{ provider: ANTIGRAVITY_PROVIDER_ID, id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', supportsVision: true, maxContextWindow: 1_000_000 },
	{ provider: ANTIGRAVITY_PROVIDER_ID, id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', supportsVision: true, maxContextWindow: 1_000_000 },
	{ provider: ANTIGRAVITY_PROVIDER_ID, id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', supportsVision: true, maxContextWindow: 1_000_000 },
	{ provider: ANTIGRAVITY_PROVIDER_ID, id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', supportsVision: true, maxContextWindow: 1_000_000 },
];

async function runAgy(args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn('agy', [...args], { env: process.env });
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

function parseAgyModels(output: string): readonly IAgentModelInfo[] {
	const models = output.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.map((name): IAgentModelInfo => {
			return {
				provider: ANTIGRAVITY_PROVIDER_ID,
				id: name,
				name,
				supportsVision: true,
				...(name.startsWith('Gemini 3') ? { maxContextWindow: 1_000_000 } : {}),
			};
		});
	return models.length ? models : ANTIGRAVITY_MODELS;
}

/**
 * One live conversation backed by the local `agy` (Antigravity) CLI. The CLI
 * has no structured output mode: each user turn spawns `agy -p ...` and the
 * response streams back as plain stdout text, rendered as one Markdown part.
 *
 * Multi-turn context: `agy` persists conversations server-side and resumes by
 * id (`--conversation <id>`), but print mode never prints that id. It does log
 * `Created conversation <uuid>` when `--log-file` is set, so each first turn
 * writes a throwaway log file and scrapes the id from it on process exit.
 */
class AntigravityCliSession extends ExternalCliSession {

	/** The Antigravity-owned conversation id, scraped from the turn log; used to resume. */
	private _conversationId: string | undefined;
	private _activeChild: ChildProcessWithoutNullStreams | undefined;
	private _turnCounter = 0;

	async send(prompt: string, turnId: string, attachments?: readonly MessageAttachment[]): Promise<void> {
		const resolvedPrompt = resolvePromptWithAttachments(prompt, attachments);
		const logPath = join(tmpdir(), `vscode-agy-${this._rawSessionId}-${this._turnCounter++}.log`);
		// `--dangerously-skip-permissions` mirrors the Claude CLI provider's
		// `bypassPermissions` MVP behavior (headless runs can't answer prompts);
		// the default `--print-timeout` of 5m kills long agentic turns, so raise it.
		const args = ['-p', resolvedPrompt, '--dangerously-skip-permissions', '--print-timeout', '60m', '--log-file', logPath];
		if (this._conversationId) {
			args.push('--conversation', this._conversationId);
		}
		if (this._model) {
			args.push('--model', this._model);
		}

		let sawOutput = false;
		let stderr = '';

		const child = spawn('agy', args, { cwd: this._cwd, env: process.env });
		this._activeChild = child;

		await new Promise<void>(resolve => {
			child.stdout.on('data', (chunk: Buffer) => {
				// The CLI leads the response with padding whitespace; trim it off
				// the front of the turn so the Markdown part doesn't render indented.
				let text = chunk.toString();
				if (!sawOutput) {
					text = text.trimStart();
				}
				if (text) {
					this._appendText(turnId, text);
					sawOutput = true;
				}
			});
			child.stderr.on('data', (d: Buffer) => {
				const text = d.toString();
				stderr += text;
				this._logService.warn(`[AntigravityCli:${this._rawSessionId}] stderr: ${text}`);
			});
			child.on('error', err => {
				this._logService.error(`[AntigravityCli:${this._rawSessionId}] failed to launch agy: ${err}`);
				this._emitTurnError(turnId, 'cli_launch_failed', `Couldn't launch the \`agy\` CLI: ${err}. Is it installed and on PATH?`);
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
			child.on('close', code => {
				this._captureConversationId(logPath);
				if (code === 0 && sawOutput) {
					this._emitTurnComplete(turnId);
				} else {
					const detail = stderr.trim() || (typeof code === 'number' ? `exit code ${code}` : 'no output');
					this._emitTurnError(turnId, code === 0 ? 'cli_no_result' : 'cli_failed', `The \`agy\` CLI ended without completing the turn: ${detail}`);
				}
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
		});
	}

	/** Scrape `Created conversation <uuid>` from the turn's log file, then delete it. */
	private _captureConversationId(logPath: string): void {
		try {
			const log = readFileSync(logPath, 'utf8');
			const match = log.match(/Created conversation (?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			if (match?.groups?.id) {
				this._conversationId = match.groups.id;
			}
		} catch (err) {
			this._logService.warn(`[AntigravityCli:${this._rawSessionId}] couldn't read turn log ${logPath}: ${err}`);
		}
		try {
			unlinkSync(logPath);
		} catch {
			// best-effort cleanup
		}
	}

	abort(): void {
		this._activeChild?.kill('SIGTERM');
		this._activeChild = undefined;
	}
}

/**
 * FORK: {@link ExternalCliAgent} provider that drives the user's locally
 * installed Antigravity `agy` CLI in headless mode (Gemini models), using
 * their own Google sign-in — no GitHub Copilot involvement.
 */
export class AntigravityCliAgent extends ExternalCliAgent {

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('antigravityCliModels', []);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	constructor(@ILogService logService: ILogService) {
		super(logService);
		void this._refreshModels();
	}

	readonly id: AgentProvider = ANTIGRAVITY_PROVIDER_ID;

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'Antigravity',
			description: 'Antigravity agent (Gemini) driven by your local `agy` CLI in headless mode',
		};
	}

	protected _createCliSession(sessionUri: URI, rawSessionId: string, cwd: string | undefined, model: string | undefined): ExternalCliSession {
		return new AntigravityCliSession(sessionUri, rawSessionId, cwd, model, this._onDidSessionProgress, this._logService);
	}

	private async _refreshModels(): Promise<void> {
		const result = await runAgy(['models'], 30_000);
		if (result.code === 0) {
			this._models.set(parseAgyModels(result.stdout), undefined);
			return;
		}
		this._logService.warn(`[AntigravityCli] failed to list models: ${result.stderr.trim() || `exit code ${result.code}`}`);
		this._models.set(ANTIGRAVITY_MODELS, undefined);
	}

	async pingAgent(): Promise<boolean> {
		const result = await runAgy(['-p', 'ok', '--print-timeout', '2m', '--model', 'Gemini 3.5 Flash (Low)'], 150_000);
		if (result.code !== 0 || !result.stdout.trim()) {
			this._logService.warn(`[AntigravityCli] ping failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
			return false;
		}
		await this._refreshModels();
		return true;
	}
}
