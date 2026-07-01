/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../log/common/log.js';
import type { ICopilotUtilityChatMessage } from '../shared/copilotApiService.js';

/**
 * Runs a one-shot, throwaway `claude -p` completion for small "utility" prompts
 * (e.g. session-title generation) using the local headless CLI. This keeps such
 * helper prompts on the same local Claude backend as the chat itself, with no
 * dependency on GitHub Copilot auth.
 *
 * The system/user messages are flattened into a single prompt; a fresh process
 * is spawned with no session id / `--resume`, so it never touches the user's
 * conversation history. A small/fast model is used to keep cost negligible.
 * Returns the raw stdout text, or `undefined` on failure/cancellation (callers
 * fall back to their own default).
 */
export function runClaudeUtilityPrompt(messages: readonly ICopilotUtilityChatMessage[], token: CancellationToken, logService: ILogService): Promise<string | undefined> {
	const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n').trim();
	const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n').trim();
	const prompt = system ? `${system}\n\n${user}` : user;

	if (!prompt) {
		return Promise.resolve(undefined);
	}

	return new Promise<string | undefined>(resolve => {
		if (token.isCancellationRequested) {
			resolve(undefined);
			return;
		}

		// FORK: a title/utility completion needs no tools, MCP servers, skills, or the full Claude
		// Code system prompt — but a bare `claude -p` drags ALL of them into every call (measured
		// ~11k of built-in tool schemas + the user's MCP servers + skill listings ~20k billed per
		// title). Strip them so this is a minimal text completion (~200 tokens total): no filesystem
		// settings (skills / project MCP / CLAUDE.md), no MCP servers, an empty tool set, and a tiny
		// replacement system prompt (the real instruction is already in `prompt`). If a `claude`
		// build rejects any flag the call fails and the caller falls back to its default title.
		const child = spawn('claude', [
			'-p', prompt,
			'--model', 'haiku',
			'--setting-sources', '',
			'--strict-mcp-config',
			'--tools', '',
			'--system-prompt', 'You generate short, plain labels. Reply with only the label text.',
		], { env: process.env });
		// The prompt is passed via argv; close stdin so the CLI doesn't wait ~3s for piped input.
		child.stdin.end();
		const cancelSub = token.onCancellationRequested(() => child.kill('SIGTERM'));

		let out = '';
		child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
		child.stderr.on('data', (chunk: Buffer) => logService.trace(`[ClaudeUtilityPrompt] stderr: ${chunk.toString()}`));
		child.on('error', err => {
			cancelSub.dispose();
			logService.warn(`[ClaudeUtilityPrompt] failed to launch claude: ${err}`);
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
