/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import { AgentProvider, AgentSession, AgentSignal, IActiveClient, IAgent, IAgentCreateSessionConfig, IAgentCreateSessionResult, IAgentDescriptor, IAgentModelInfo, IAgentResolveSessionConfigParams, IAgentSessionConfigCompletionsParams, IAgentSessionMetadata } from '../../common/agentService.js';
import { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/channels-root/commands.js';
import { ProtectedResourceMetadata, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { ActionType, type ChatAction, type SessionAction } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ChatInputResponseKind, MessageAttachmentKind, ResponsePartKind, type ChatInputAnswer, type ClientPluginCustomization, type MessageAttachment, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';

/**
 * FORK: one live conversation backed by an external headless agent CLI
 * (Cursor Agent, Antigravity, …). Owns the signal-emission helpers shared by
 * every CLI transport — streaming Markdown / reasoning parts, tool-call
 * lifecycle, usage, turn completion and error surfacing — so subclasses only
 * implement the process spawn + output parsing for their CLI's wire format.
 */
export abstract class ExternalCliSession extends Disposable {

	protected readonly _chatUri: URI;
	protected _model: string | undefined;

	/** Monotonic part-id source; unique within the session, qualified per turn. */
	private _partCounter = 0;
	private _openTextPartId: string | undefined;
	private _openReasoningPartId: string | undefined;

	constructor(
		readonly sessionUri: URI,
		protected readonly _rawSessionId: string,
		protected readonly _cwd: string | undefined,
		model: string | undefined,
		private readonly _onSignal: Emitter<AgentSignal>,
		protected readonly _logService: ILogService,
	) {
		super();
		this._model = model;
		this._chatUri = URI.parse(buildDefaultChatUri(sessionUri));
	}

	setModel(model: string | undefined): void {
		this._model = model;
	}

	/** Run one user turn against the CLI, resolving when the turn is finished. */
	abstract send(prompt: string, turnId: string, attachments?: readonly MessageAttachment[]): Promise<void>;

	/** Kill the active CLI invocation, if any. */
	abstract abort(): void;

	protected _fireAction(action: SessionAction | ChatAction): void {
		this._onSignal.fire({ kind: 'action', resource: this._chatUri, action });
	}

	/**
	 * Append streamed assistant text. Opens a new Markdown response part on
	 * first use (and after {@link _closeParts}, so text resumes in a fresh
	 * part after an interleaved tool call).
	 */
	protected _appendText(turnId: string, text: string): void {
		if (!this._openTextPartId) {
			this._openTextPartId = `${turnId}-text-${this._partCounter++}`;
			this._fireAction({
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Markdown, id: this._openTextPartId, content: '' },
			});
		}
		this._fireAction({ type: ActionType.ChatDelta, turnId, partId: this._openTextPartId, content: text });
	}

	/** Append streamed reasoning ("thinking") text, opening a Reasoning part on first use. */
	protected _appendReasoning(turnId: string, text: string): void {
		if (!this._openReasoningPartId) {
			this._openReasoningPartId = `${turnId}-reasoning-${this._partCounter++}`;
			this._fireAction({
				type: ActionType.ChatResponsePart,
				turnId,
				part: { kind: ResponsePartKind.Reasoning, id: this._openReasoningPartId, content: '' },
			});
		}
		this._fireAction({ type: ActionType.ChatReasoning, turnId, partId: this._openReasoningPartId, content: text });
	}

	/** Close any open text/reasoning parts so the next append starts fresh parts. */
	protected _closeParts(): void {
		this._openTextPartId = undefined;
		this._openReasoningPartId = undefined;
	}

	protected _emitTurnComplete(turnId: string): void {
		this._closeParts();
		this._fireAction({ type: ActionType.ChatTurnComplete, turnId });
	}

	/**
	 * Surface a turn failure as a visible {@link ActionType.ChatError} and close
	 * the turn, so a dropped/failed CLI invocation never leaves the UI spinning.
	 */
	protected _emitTurnError(turnId: string, errorType: string, message: string): void {
		this._fireAction({ type: ActionType.ChatError, turnId, error: { errorType, message } });
		this._emitTurnComplete(turnId);
	}

	override dispose(): void {
		this.abort();
		super.dispose();
	}
}

/**
 * FORK: {@link IAgent} provider base for agents that drive an external
 * headless CLI installed by the user (their own login — no GitHub Copilot, no
 * API keys held by the IDE). Owns the session registry and the many protocol
 * stubs a transport-only provider doesn't need, mirroring `ClaudeCliAgent`;
 * subclasses supply the descriptor, model list and the per-CLI session.
 */
export abstract class ExternalCliAgent extends Disposable implements IAgent {

	abstract readonly id: AgentProvider;
	abstract readonly models: IObservable<readonly IAgentModelInfo[]>;
	abstract getDescriptor(): IAgentDescriptor;

	protected abstract _createCliSession(sessionUri: URI, rawSessionId: string, cwd: string | undefined, model: string | undefined): ExternalCliSession;

	protected readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _sessions = this._register(new DisposableMap<string, ExternalCliSession>());

	constructor(
		protected readonly _logService: ILogService,
	) {
		super();
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return []; // The external CLI owns its own auth; nothing for the host to broker.
	}

	async authenticate(): Promise<boolean> {
		return true;
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const rawSessionId = config?.session ? AgentSession.id(config.session) : generateUuid();
		const sessionUri = AgentSession.uri(this.id, rawSessionId);
		const cwd = config?.workingDirectory?.fsPath;
		const session = this._createCliSession(sessionUri, rawSessionId, cwd, config?.model?.id);
		this._sessions.set(rawSessionId, session);
		return { session: sessionUri, workingDirectory: config?.workingDirectory, provisional: false };
	}

	async resolveSessionConfig(_params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: { type: 'object', properties: {} }, values: {} };
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async sendMessage(session: URI, chat: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const rawSessionId = AgentSession.id(session);
		const cliSession = this._sessions.get(rawSessionId);
		if (!cliSession) {
			// No transcript persistence in this provider, so an unknown session
			// cannot be restored — surface it instead of spinning silently.
			this._logService.error(`[${this.id}] sendMessage for unknown session ${session.toString()}`);
			this._emitSendError(chat, turnId ?? generateUuid(), `This chat session isn't active anymore and can't be restored. Start a new chat to continue.`);
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

	async getSessionMessages(_session: URI): Promise<readonly Turn[]> {
		return []; // No transcript store; sessions live for the host's lifetime only.
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [];
	}

	respondToPermissionRequest(_requestId: string, _approved: boolean): void {
		// Runs with the CLI's permission bypass flags, so no requests arrive.
	}

	respondToUserInputRequest(_requestId: string, _response: ChatInputResponseKind, _answers?: Record<string, ChatInputAnswer>): void {
		// Interactive input tools are not surfaced by headless CLI transports.
	}

	private readonly _activeClients = new Map<string, IActiveClient>();

	getOrCreateActiveClient(session: URI, client: { readonly clientId: string; readonly displayName?: string }): IActiveClient {
		const key = `${AgentSession.id(session)}/${client.clientId}`;
		let active = this._activeClients.get(key);
		if (!active) {
			// Client tools/customizations are not forwarded to the CLI, but we
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
		// No client-provided tools.
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
		// No host-owned customizations.
	}

	async shutdown(): Promise<void> {
		this._sessions.clearAndDisposeAll();
	}
}

/**
 * Flatten the prompt plus any resource attachments into the single prompt
 * string a headless CLI accepts: attached files/selections become plain
 * path references appended after the prompt text.
 */
export function resolvePromptWithAttachments(prompt: string, attachments?: readonly MessageAttachment[]): string {
	const refs = (attachments ?? [])
		.map(att => {
			if (att.type !== MessageAttachmentKind.Resource) {
				return undefined;
			}
			const uri = URI.parse(att.uri);
			const target = uri.scheme === 'file' ? uri.fsPath : uri.toString();
			const selectionSuffix = att.selection ? `:${att.selection.range.start.line + 1}` : '';
			return `${target}${selectionSuffix}`;
		})
		.filter((v): v is string => !!v);
	return refs.length > 0 ? `${prompt}\n\nAttached references:\n${refs.join('\n')}` : prompt;
}
