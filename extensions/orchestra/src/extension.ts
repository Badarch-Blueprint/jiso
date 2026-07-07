/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  Orchestra — drive headless coding agents from the core chat panel.
 *
 *  Registers an `@orchestra` chat participant that shells out to Claude Code headless
 *  (`claude -p ... --output-format stream-json`) and streams the assistant's text back into
 *  the existing VS Code chat UI. No custom panel — we reuse core's chat view.
 *
 *  Conversation continuity: Claude Code reports a `session_id` on every run. We stash it in
 *  the `ChatResult.metadata` we return and read it back from `ChatContext.history` on the next
 *  turn, resuming with `--resume <id>`. This keeps each VS Code chat thread mapped to its own
 *  Claude Code session without fragile module-level state, so concurrent chats stay isolated.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'child_process';

const PARTICIPANT_ID = 'orchestra.agent';

/** Shape of the metadata we round-trip through the chat history to keep a session alive. */
interface IOrchestraResult extends vscode.ChatResult {
	readonly metadata?: { readonly sessionId?: string };
}

export function activate(context: vscode.ExtensionContext): void {
	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	participant.iconPath = new vscode.ThemeIcon('rocket');
	context.subscriptions.push(participant);
}

async function handler(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken
): Promise<IOrchestraResult> {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME;
	const resumeId = previousSessionId(chatContext);

	const args = ['-p', request.prompt, '--output-format', 'stream-json', '--verbose'];
	if (resumeId) {
		args.push('--resume', resumeId);
	}

	const child = spawn('claude', args, { cwd, env: process.env });
	const killSub = token.onCancellationRequested(() => child.kill('SIGTERM'));

	let buffer = '';
	let sawText = false;
	// Capture the latest session id reported by this run. Resuming can fork a new session id,
	// so we always carry forward whatever the run last reported rather than the one we sent in.
	let sessionId = resumeId;

	await new Promise<void>((resolve) => {
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			let nl: number;
			while ((nl = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) {
					continue;
				}
				let evt: any;
				try {
					evt = JSON.parse(line);
				} catch {
					continue;
				}
				if (typeof evt?.session_id === 'string') {
					sessionId = evt.session_id;
				}
				if (handleEvent(evt, stream)) {
					sawText = true;
				}
			}
		});

		child.stderr.on('data', (d: Buffer) => {
			console.error('[orchestra] claude stderr:', d.toString());
		});

		child.on('error', (err: Error) => {
			stream.markdown(`\n\n**Failed to launch \`claude\`:** ${err.message}\n`);
			resolve();
		});

		child.on('close', (code: number | null) => {
			killSub.dispose();
			if (code !== 0 && !sawText) {
				stream.markdown(`\n\n_claude exited with code ${code}_\n`);
			}
			resolve();
		});
	});

	return sessionId ? { metadata: { sessionId } } : {};
}

/** Walk the chat history backwards for the Claude Code session id of this thread's last reply. */
function previousSessionId(chatContext: vscode.ChatContext): string | undefined {
	for (let i = chatContext.history.length - 1; i >= 0; i--) {
		const turn = chatContext.history[i];
		if (turn instanceof vscode.ChatResponseTurn && turn.participant === PARTICIPANT_ID) {
			const sessionId = (turn.result as IOrchestraResult).metadata?.sessionId;
			if (sessionId) {
				return sessionId;
			}
		}
	}
	return undefined;
}

/** Render one stream-json event into the chat response. Returns true if assistant text was emitted. */
function handleEvent(evt: any, stream: vscode.ChatResponseStream): boolean {
	let emittedText = false;
	switch (evt?.type) {
		case 'assistant': {
			const content = evt.message?.content ?? [];
			for (const part of content) {
				if (part?.type === 'text' && part.text) {
					stream.markdown(part.text);
					emittedText = true;
				} else if (part?.type === 'tool_use' && part.name) {
					stream.progress(`Running ${part.name}…`);
				}
			}
			break;
		}
		case 'result': {
			if (evt.is_error) {
				stream.markdown(`\n\n_Error: ${evt.result ?? evt.subtype ?? 'unknown'}_\n`);
			}
			break;
		}
	}
	return emittedText;
}

export function deactivate(): void {
	// no-op
}
