/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import type { SDKMessage, SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/channels-root/commands.js';
import { ProtectedResourceMetadata, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ChatInputResponseKind, MessageAttachmentKind, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import { ClaudeMapperState, mapSDKMessageToAgentSignals } from './claudeMapSessionEvents.js';
import { resolvePromptToContentBlocks } from './claudePromptResolver.js';
import { SubagentRegistry } from './claudeSubagentRegistry.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { mapSessionMessagesToTurns } from './claudeReplayMapper.js';

/**
 * Provider id for the Claude Code headless CLI agent. Distinct from the SDK-
 * backed `claude` provider so both can coexist in the agent picker.
 */
const CLAUDE_CLI_PROVIDER_ID = 'claude-cli';

/**
 * True iff the `claude` binary is on PATH and runnable. Used at agent-host
 * startup to decide whether to register the provider — mirrors how the SDK
 * providers gate on SDK availability so a missing CLI never surfaces a broken
 * entry in the agent picker.
 */
export function isClaudeCliAvailable(): boolean {
	try {
		const result = spawnSync('claude', ['--version'], { stdio: 'ignore', env: process.env });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * True iff `claude` has a persisted transcript for the given session id. The CLI stores one
 * `<sessionId>.jsonl` per session under a per-cwd project directory in `~/.claude/projects`;
 * session ids are UUIDs, so we can locate it by filename across all project dirs without
 * reconstructing the cwd-mangling scheme. Used to avoid `--resume`-ing a session the CLI has
 * no record of (which it rejects outright rather than creating).
 */
function transcriptExists(claudeSessionId: string): boolean {
	try {
		const projectsRoot = join(homedir(), '.claude', 'projects');
		return readdirSync(projectsRoot).some(dir => existsSync(join(projectsRoot, dir, `${claudeSessionId}.jsonl`)));
	} catch {
		return false;
	}
}

/** Static model list. The `id` is forwarded verbatim to `claude --model`. */
const CLAUDE_CLI_MODELS: readonly IAgentModelInfo[] = [
	{ provider: CLAUDE_CLI_PROVIDER_ID, id: 'sonnet', name: 'Claude Sonnet', supportsVision: true, maxContextWindow: 200_000 },
	{ provider: CLAUDE_CLI_PROVIDER_ID, id: 'opus', name: 'Claude Opus', supportsVision: true, maxContextWindow: 200_000 },
	{ provider: CLAUDE_CLI_PROVIDER_ID, id: 'haiku', name: 'Claude Haiku', supportsVision: false, maxContextWindow: 200_000 },
];

/**
 * FORK: fraction of the model's context window at which we auto-compact before the next turn.
 * The native CLI only auto-compacts inside its interactive loop; each `claude -p` invocation is
 * one-shot and never does. So we simulate it: once a turn's context crosses this ratio, the next
 * `send()` runs `/compact` first. Mirrors the CLI's "compact then retrigger next turn" behavior.
 */
const AUTO_COMPACT_RATIO = 0.85;

/** Minimal shape of the token-usage block the CLI emits on assistant / result messages. */
interface ClaudeUsage {
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/**
 * One live conversation backed by the local `claude` headless CLI. Each user
 * turn spawns a fresh `claude -p ... --output-format stream-json` process,
 * resuming the prior turn's Claude session so context carries across turns.
 * The CLI's stream-json output is the SAME message shape the Claude Agent SDK
 * yields, so it is fed straight into the shared {@link mapSDKMessageToAgentSignals}
 * mapper — only the transport differs from the SDK-backed `ClaudeAgent`.
 */
class ClaudeCliSession extends Disposable {

	/** Mapper state lives for the session's whole lifetime (cross-turn tool linkage). */
	private readonly _mapperState = new ClaudeMapperState();
	private readonly _subagents = this._register(new SubagentRegistry());
	private readonly _chatUri: URI;

	/** The Claude-owned session id, captured from stream-json events; used to `--resume`. */
	private _claudeSessionId: string | undefined;
	private _model: string | undefined;
	private _activeChild: ChildProcessWithoutNullStreams | undefined;
	/** Set once the CLI emits a terminal `result` for the active turn; gates the no-output error. */
	private _sawResult = false;
	/** Accumulated stderr for the active turn, surfaced in the error notice on a bad exit. */
	private _stderr = '';
	/** Total context input tokens from the most recent turn's usage; drives auto-compact. */
	private _lastContextTokens = 0;
	/** When true, the active `_spawnTurn` is an internal pass (e.g. auto `/compact`): no turn-complete/error. */
	private _suppressComplete = false;

	constructor(
		readonly sessionUri: URI,
		private readonly _rawSessionId: string,
		private readonly _cwd: string | undefined,
		model: string | undefined,
		private readonly _onSignal: Emitter<AgentSignal>,
		private readonly _logService: ILogService,
		resumeSessionId?: string,
	) {
		super();
		this._model = model;
		// Restored session: seed the Claude session id so the first send uses `--resume`
		// (instead of `--session-id`, which would fail with "session already exists").
		this._claudeSessionId = resumeSessionId;
		this._chatUri = URI.parse(buildDefaultChatUri(sessionUri));
	}

	setModel(model: string | undefined): void {
		this._model = model;
	}

	/** Context window (tokens) of the active model. The `[1m]` variants get 1M; everything else 200k. */
	private _contextWindow(): number {
		return /\[1m\]/i.test(this._model ?? '') ? 1_000_000 : 200_000;
	}

	/** True when the last turn's context is near the model window and we should compact first. */
	private _shouldAutoCompact(): boolean {
		return this._lastContextTokens > 0 && this._lastContextTokens >= this._contextWindow() * AUTO_COMPACT_RATIO;
	}

	/**
	 * Run one user turn. FORK: if the previous turn left the context near the model window, run
	 * `/compact` first (an internal pass that renders a `compact_boundary` notice but doesn't
	 * complete the turn), then run the real prompt on the now-smaller context. This gives the
	 * headless CLI provider the auto-compaction its per-`-p`-invocation model can't do natively.
	 */
	async send(prompt: string, turnId: string, attachments?: readonly MessageAttachment[]): Promise<void> {
		const resolvedPrompt = resolvePromptForCli(prompt, attachments);
		if (this._shouldAutoCompact()) {
			// allow-any-unicode-next-line
			this._logService.info(`[ClaudeCli:${this._rawSessionId}] context ~${this._lastContextTokens} tokens ≥ ${Math.round(this._contextWindow() * AUTO_COMPACT_RATIO)} threshold; auto-compacting before turn`);
			await this._spawnTurn('/compact', turnId, /*suppressComplete*/ true);
			this._lastContextTokens = 0; // recomputed from the post-compact turn's usage below
		}
		await this._spawnTurn(resolvedPrompt, turnId, /*suppressComplete*/ false);
	}

	/** Spawn one `claude -p` invocation and stream its output as agent signals. */
	private async _spawnTurn(resolvedPrompt: string, turnId: string, suppressComplete: boolean): Promise<void> {
		this._suppressComplete = suppressComplete;
		// `--include-partial-messages` makes the CLI emit `stream_event` deltas (the same partial
		// assistant stream the SDK yields). The shared mapper renders assistant text from those
		// deltas — the canonical `assistant` message is intentionally a no-op for top-level text —
		// so without this flag replies stream back empty. `--verbose` is required by stream-json.
		// `--disallowedTools Task Agent`: never let the CLI fan out to sub-agents (each is a separate
		// context with its own cold prefix + turn loop). Mirrors the SDK provider's `disallowedTools`.
		const args = ['-p', resolvedPrompt, '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Task,Agent'];
		// Only `--resume` when the target session was actually persisted. A captured session id can be
		// a phantom — an `init` event fired but its turn never wrote a transcript, or a restored-session
		// id whose file no longer exists — and the current `claude` CLI hard-errors ("No conversation
		// found with session ID") on resuming a missing session instead of creating it. When it's a
		// phantom, fall back to `--session-id` so the turn starts a fresh, resumable session.
		if (this._claudeSessionId && transcriptExists(this._claudeSessionId)) {
			args.push('--resume', this._claudeSessionId);
		} else {
			// First turn (or phantom resume id): pin Claude's session id to ours so resume is stable.
			// Clear any phantom id; the real one is re-captured from this turn's stream events.
			this._claudeSessionId = undefined;
			args.push('--session-id', this._rawSessionId);
		}
		if (this._model) {
			args.push('--model', this._model);
		}

		// Reset per-turn failure tracking so a bad exit / no output surfaces as a visible error.
		this._sawResult = false;
		this._stderr = '';

		const child = spawn('claude', args, { cwd: this._cwd, env: process.env });
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
				this._logService.warn(`[ClaudeCli:${this._rawSessionId}] stderr: ${text}`);
			});
			child.on('error', err => {
				this._logService.error(`[ClaudeCli:${this._rawSessionId}] failed to launch claude: ${err}`);
				// Surface instead of failing silently (the spinner would otherwise spin forever).
				// Suppressed for the internal auto-compact pass — the real turn owns error/completion.
				if (!suppressComplete) {
					this._emitTurnError(turnId, 'cli_launch_failed', `Couldn't launch the \`claude\` CLI: ${err}. Is it installed and on PATH?`);
				}
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
				if (code !== 0) {
					this._logService.warn(`[ClaudeCli:${this._rawSessionId}] claude exited with code ${code}`);
				}
				// If the CLI ended without a terminal `result`, the turn never completed and the UI
				// would spin forever. Surface the failure (with any stderr) and close the turn.
				// Suppressed for the internal auto-compact pass (a failed compact just proceeds).
				if (!this._sawResult && !suppressComplete) {
					const detail = this._stderr.trim() || (typeof code === 'number' ? `exit code ${code}` : 'no output');
					this._emitTurnError(turnId, 'cli_no_result', `The \`claude\` CLI ended without completing the turn: ${detail}`);
				}
				if (this._activeChild === child) {
					this._activeChild = undefined;
				}
				resolve();
			});
		});
	}

	private _handleLine(line: string, turnId: string): void {
		let message: SDKMessage;
		try {
			message = JSON.parse(line) as SDKMessage;
		} catch {
			return; // non-JSON noise
		}

		const sessionId = (message as { session_id?: string }).session_id;
		if (typeof sessionId === 'string') {
			this._claudeSessionId = sessionId;
		}

		// Track the running context size (input + cache tokens) so the next send can auto-compact.
		const usage = ((message as { message?: { usage?: ClaudeUsage } }).message?.usage) ?? (message as { usage?: ClaudeUsage }).usage;
		if (usage && typeof usage.input_tokens === 'number') {
			this._lastContextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		}

		const signals = mapSDKMessageToAgentSignals(message, this._chatUri, turnId, this._mapperState, this._logService, this._subagents);
		for (const signal of signals) {
			this._onSignal.fire(signal);
		}

		// The mapper emits response parts / tool calls / usage, but NOT the
		// turn-complete action (in the SDK path the pipeline owns that). Emit it
		// here when Claude reports the turn's terminal `result` envelope — except for the
		// internal auto-compact pass, whose result must not end the user's turn early.
		if (message.type === 'result') {
			this._sawResult = true;
			if (!this._suppressComplete) {
				this._onSignal.fire({
					kind: 'action',
					resource: this._chatUri,
					action: { type: ActionType.ChatTurnComplete, turnId },
				});
			}
		}
	}

	/**
	 * Surface a turn failure as a visible {@link ActionType.ChatError} and close the
	 * turn, so a dropped/failed `claude` invocation never leaves the UI spinning silently.
	 */
	private _emitTurnError(turnId: string, errorType: string, message: string): void {
		this._onSignal.fire({
			kind: 'action',
			resource: this._chatUri,
			action: { type: ActionType.ChatError, turnId, error: { errorType, message } },
		});
		this._onSignal.fire({
			kind: 'action',
			resource: this._chatUri,
			action: { type: ActionType.ChatTurnComplete, turnId },
		});
	}

	abort(): void {
		this._activeChild?.kill('SIGTERM');
		this._activeChild = undefined;
	}

	override dispose(): void {
		this.abort();
		super.dispose();
	}
}

/**
 * {@link IAgent} provider that drives the user's locally installed `claude`
 * CLI in headless mode, using their own Claude Code login — no GitHub Copilot,
 * no Anthropic API key, no SDK proxy. Reuses the SDK provider's event mapper;
 * only the transport (a `claude -p` subprocess) is new.
 */
export class ClaudeCliAgent extends Disposable implements IAgent {

	readonly id: AgentProvider = CLAUDE_CLI_PROVIDER_ID;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	readonly models: IObservable<readonly IAgentModelInfo[]> = observableValue<readonly IAgentModelInfo[]>('claudeCliModels', CLAUDE_CLI_MODELS);

	private readonly _sessions = this._register(new DisposableMap<string, ClaudeCliSession>());

	/** Session ids known to exist on disk (from `listSessions`); they resume instead of recreate. */
	private readonly _resumableSessions = new Set<string>();
	/** Original cwd per known session, so a restored session resumes in the right project. */
	private readonly _knownSessionCwd = new Map<string, string>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IClaudeAgentSdkService private readonly _sdkService: IClaudeAgentSdkService,
	) {
		super();
	}

	getDescriptor(): IAgentDescriptor {
		return {
			provider: this.id,
			displayName: 'Claude Code (CLI)',
			description: 'Claude Code agent driven by your local `claude` CLI in headless mode',
		};
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return []; // The local `claude` CLI owns its own auth; nothing for the host to broker.
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const rawSessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = AgentSession.uri(this.id, rawSessionId);
		const model = config?.model?.id;
		let cwd = config?.workingDirectory?.fsPath;

		// Restored session (its id was seen by a prior `listSessions`): resume it instead of
		// recreating, and adopt its original cwd when the caller didn't supply one. This is a pure
		// in-memory lookup — never an SDK round-trip — so it can't stall the send path.
		const resumeSessionId = this._resumableSessions.has(rawSessionId) ? rawSessionId : undefined;
		if (resumeSessionId) {
			cwd = cwd ?? this._knownSessionCwd.get(rawSessionId);
		}

		const session = new ClaudeCliSession(sessionUri, rawSessionId, cwd, model, this._onDidSessionProgress, this._logService, resumeSessionId);
		this._sessions.set(rawSessionId, session);

		return { session: sessionUri, workingDirectory: cwd ? URI.file(cwd) : config?.workingDirectory, provisional: false };
	}

	/** Best-effort SDK session-info lookup (local store read); never throws. */
	private async _tryGetSessionInfo(rawSessionId: string): Promise<SDKSessionInfo | undefined> {
		try {
			if (!(await this._sdkService.canLoadWithoutDownload())) {
				return undefined;
			}
			return await this._sdkService.getSessionInfo(rawSessionId);
		} catch (err) {
			this._logService.warn(`[ClaudeCli] getSessionInfo failed for ${rawSessionId}: ${err}`);
			return undefined;
		}
	}

	async resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: {} };
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(session: URI, _chat: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const rawSessionId = AgentSession.id(session);
		let cliSession = this._sessions.get(rawSessionId);
		if (!cliSession) {
			// Restored-but-unbound session: the host restored it from disk (it appears in the chat
			// list) but never called createSession, so the in-memory session is missing. Recreate it
			// on demand — resuming from disk when known — instead of silently dropping the message
			// (which left the UI spinning forever with only a log-only error).
			this._logService.warn(`[ClaudeCli] sendMessage: session ${rawSessionId} not bound; recreating on demand`);
			try {
				const cwd = this._knownSessionCwd.get(rawSessionId);
				await this.createSession({ session, workingDirectory: cwd ? URI.file(cwd) : undefined });
				cliSession = this._sessions.get(rawSessionId);
			} catch (err) {
				this._logService.error(`[ClaudeCli] failed to recreate session ${rawSessionId}: ${err}`);
			}
		}
		if (!cliSession) {
			this._logService.error(`[ClaudeCli] sendMessage for unknown session ${session.toString()}`);
			this._emitSendError(_chat, turnId ?? generateUuid(), `This chat session isn't active anymore and couldn't be restored. Start a new chat to continue.`);
			return;
		}
		await cliSession.send(prompt, turnId ?? generateUuid(), attachments);
	}

	/** Surface a pre-flight send failure as a visible chat error + turn end (never silent). */
	private _emitSendError(chat: URI, turnId: string, message: string): void {
		this._onDidSessionProgress.fire({
			kind: 'action',
			resource: chat,
			action: { type: ActionType.ChatError, turnId, error: { errorType: 'unknown_session', message } },
		});
		this._onDidSessionProgress.fire({
			kind: 'action',
			resource: chat,
			action: { type: ActionType.ChatTurnComplete, turnId },
		});
	}

	async abortSession(session: URI): Promise<void> {
		this._sessions.get(AgentSession.id(session))?.abort();
	}

	async disposeSession(session: URI): Promise<void> {
		this._sessions.deleteAndDispose(AgentSession.id(session));
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		this._sessions.get(AgentSession.id(session))?.setModel(model.id);
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const rawSessionId = AgentSession.id(session);
		try {
			if (!(await this._sdkService.canLoadWithoutDownload())) {
				return [];
			}
			const messages = await this._sdkService.getSessionMessages(rawSessionId, { includeSystemMessages: true });
			if (messages.length) {
				this._resumableSessions.add(rawSessionId);
			}
			// Injected-context stripping for restored user messages lives in the shared
			// `mapSessionMessagesToTurns` so the SDK `claude` provider gets it too.
			return mapSessionMessagesToTurns(messages, session, this._logService);
		} catch (err) {
			this._logService.warn(`[ClaudeCli] getSessionMessages failed for ${rawSessionId}: ${err}`);
			return [];
		}
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		try {
			if (!(await this._sdkService.canLoadWithoutDownload())) {
				return [];
			}
			const entries = await this._sdkService.listSessions();
			for (const entry of entries) {
				this._resumableSessions.add(entry.sessionId);
				if (entry.cwd) {
					this._knownSessionCwd.set(entry.sessionId, entry.cwd);
				}
			}
			return entries.map(entry => this._projectMetadata(entry));
		} catch (err) {
			this._logService.warn(`[ClaudeCli] listSessions failed: ${err}`);
			return [];
		}
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const info = await this._tryGetSessionInfo(AgentSession.id(session));
		return info ? this._projectMetadata(info) : undefined;
	}

	/** Project an SDK session-store entry into the platform session metadata shape. */
	private _projectMetadata(entry: SDKSessionInfo): IAgentSessionMetadata {
		return {
			session: AgentSession.uri(this.id, entry.sessionId),
			startTime: entry.createdAt ?? entry.lastModified,
			modifiedTime: entry.lastModified,
			summary: entry.customTitle ?? entry.summary,
			workingDirectory: entry.cwd ? URI.file(entry.cwd) : undefined,
		};
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// MVP runs with `--permission-mode bypassPermissions`, so no requests arrive.
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// Interactive input tools are not surfaced in the MVP.
	}

	private readonly _activeClients = new Map<string, IActiveClient>();

	getOrCreateActiveClient(session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${AgentSession.id(session)}/${client.clientId}`;
		let active = this._activeClients.get(key);
		if (!active) {
			// MVP does not forward client tools/customizations to the CLI, but we
			// honor get-or-create semantics so the client's handle is stable.
			active = { clientId: client.clientId, displayName: client.displayName, tools: [] as readonly ToolDefinition[], customizations: [] as readonly ClientPluginCustomization[] };
			this._activeClients.set(key, active);
		}
		return active;
	}

	removeActiveClient(session: URI, clientId: string): void {
		this._activeClients.delete(`${AgentSession.id(session)}/${clientId}`);
	}

	onClientToolCallComplete(_session: URI, _chat: URI, _toolCallId: string, _result: ToolCallResult): void {
		// No client-provided tools in the MVP.
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
		// No host-owned customizations in the MVP.
	}

	async shutdown(): Promise<void> {
		this._sessions.clearAndDisposeAll();
	}
}

function resolvePromptForCli(prompt: string, attachments?: readonly MessageAttachment[]): string {
	const contentBlocks = resolvePromptToContentBlocks(prompt, attachments);
	const textBlocks = contentBlocks
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
		.map(block => block.text.trim())
		.filter(block => block.length > 0);
	const attachmentPathRefs = (attachments ?? [])
		.map(att => {
			if (att.type !== MessageAttachmentKind.Resource) {
				return undefined;
			}
			const uri = URI.parse(att.uri);
			const target = uri.scheme === 'file' ? uri.fsPath : uri.toString();
			const selectionSuffix = att.selection ? `:${att.selection.range.start.line + 1}` : '';
			return `@${target}${selectionSuffix}`;
		})
		.filter((v): v is string => !!v);
	const attachmentRefsBlock = attachmentPathRefs.length > 0
		? `Attached references:\n${attachmentPathRefs.join('\n')}`
		: undefined;
	const parts = [...textBlocks];
	if (attachmentRefsBlock) {
		parts.push(attachmentRefsBlock);
	}
	return parts.length > 0 ? parts.join('\n\n') : prompt;
}
