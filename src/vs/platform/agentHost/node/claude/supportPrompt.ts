/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../log/common/log.js';
import type { ICopilotUtilityChatMessage } from '../shared/copilotApiService.js';

/**
 * Backend that fulfils small, throwaway "support" completions (session titles,
 * summaries, quick classifications). These are LIGHT text tasks that would
 * otherwise burn the main chat's Claude subscription / 5-hour usage bucket, so
 * the fork lets them be routed to an idle secondary agent CLI whose token pool
 * is separate:
 * - `claude`       — local headless `claude -p` (default; same auth as chat).
 * - `agy`          — the `agy` CLI on its own pool (cheap Gemini Flash by default).
 * - `cursor-agent` — Cursor's CLI; `composer-2.5` is not metered by the Pro+
 *                    usage cap, so it stays usable even when premium is spent.
 */
export type SupportBackend = 'claude' | 'agy' | 'cursor-agent';

/** Per-backend default model, used when no explicit model is configured. */
const DEFAULT_MODEL: Record<SupportBackend, string> = {
	'claude': 'haiku',
	'agy': 'Gemini 3.5 Flash (Low)',
	'cursor-agent': 'composer-2.5',
};

/**
 * Builds the argv for a one-shot, read-only text completion on the given
 * backend. Every backend is invoked headless (`-p`/`--print`), on a fresh
 * process with no resumed session, so it never touches conversation history.
 * The prompt is the only content; models that can call tools are pinned to
 * read-only modes so a title generator can't edit files or run shell.
 */
function buildArgs(backend: SupportBackend, model: string, prompt: string): string[] {
	switch (backend) {
		case 'agy':
			// `agy -p` runs a single prompt non-interactively. A pure-text prompt
			// won't invoke tools; no filesystem mutation is requested.
			return ['-p', prompt, '--model', model];
		case 'cursor-agent':
			// `--mode ask` = read-only Q&A (no edits/shell); text output only.
			return ['-p', prompt, '--model', model, '--output-format', 'text', '--mode', 'ask'];
		case 'claude':
		default:
			// A bare `claude -p` drags ALL tools/MCP/skills/CLAUDE.md into every call
			// (~11k of tool schemas + MCP + skill listings billed per call). Strip
			// them so this is a minimal text completion (~200 tokens): no filesystem
			// settings, no MCP servers, an empty tool set, and a tiny system prompt
			// (the real instruction is already in `prompt`).
			return [
				'-p', prompt,
				'--model', model,
				'--setting-sources', '',
				'--strict-mcp-config',
				'--tools', '',
				'--system-prompt', 'You generate short, plain labels. Reply with only the label text.',
			];
	}
}

/**
 * Runs a one-shot, throwaway completion for a small "support" prompt on the
 * configured {@link SupportBackend}. Routing light helper work to an idle
 * secondary CLI keeps it off the main chat's Claude usage bucket.
 *
 * The system/user messages are flattened into a single prompt; a fresh process
 * is spawned with no session id, so it never touches the user's conversation
 * history. Returns the raw stdout text, or `undefined` on failure/cancellation
 * (callers fall back to their own default). If the chosen backend's binary or a
 * flag is unavailable, the call fails safely to `undefined`.
 */
export function runSupportPrompt(backend: SupportBackend, model: string | undefined, messages: readonly ICopilotUtilityChatMessage[], token: CancellationToken, logService: ILogService): Promise<string | undefined> {
	const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n').trim();
	const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n').trim();
	const prompt = system ? `${system}\n\n${user}` : user;

	if (!prompt) {
		return Promise.resolve(undefined);
	}

	const command = backend === 'claude' ? 'claude' : backend;
	const args = buildArgs(backend, model || DEFAULT_MODEL[backend], prompt);

	return new Promise<string | undefined>(resolve => {
		if (token.isCancellationRequested) {
			resolve(undefined);
			return;
		}

		const child = spawn(command, args, { env: process.env });
		// The prompt is passed via argv; close stdin so the CLI doesn't wait for piped input.
		child.stdin.end();
		const cancelSub = token.onCancellationRequested(() => child.kill('SIGTERM'));

		let out = '';
		child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => logService.trace(`[SupportPrompt:${backend}] stderr: ${chunk.toString()}`));
		child.on('error', err => {
			cancelSub.dispose();
			logService.warn(`[SupportPrompt:${backend}] failed to launch ${command}: ${err}`);
			resolve(undefined);
		});
		child.on('close', code => {
			cancelSub.dispose();
			if (token.isCancellationRequested) {
				resolve(undefined);
				return;
			}
			resolve(code === 0 && out.trim() ? out : undefined);
		});
	});
}
