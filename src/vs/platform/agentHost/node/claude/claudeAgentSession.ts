/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HookCallback, McpSdkServerConfigWithInstance, Options, PermissionMode, SDKControlGetContextUsageResponse, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { AgentHostConfigKey, agentHostCustomizationConfigSchema } from '../../common/agentHostCustomizationConfig.js';
import { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { ClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { ClaudeRuntimeEffortLevel, clampEffortForRuntime, resolveClaudeEffort } from '../../common/claudeModelConfig.js';
import { AgentSignal, IAgentSessionProjectInfo } from '../../common/agentService.js';
import type { IAgentServerToolHost } from '../../common/agentServerTools.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import { ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { PendingMessage, ChatInputAnswer, ChatInputRequest, ChatInputResponseKind, ToolCallPendingConfirmationState, type AgentSelection, type ModelSelection, type ToolDefinition } from '../../common/state/protocol/state.js';
import { buildDefaultChatUri, type Customization, type ToolCallResult } from '../../common/state/sessionState.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { buildClientMcpServers, buildOptions } from './claudeSdkOptions.js';
import { FABLE_PLAN_MODEL_ID, resolveTieredModelId, toSdkModelId } from './claudeModelId.js';
import { buildServerToolMcpServer, CLAUDE_SERVER_TOOL_MCP_SERVER_NAME, serverToolAllowList } from './claudeServerToolMcpServer.js';
import { ClaudeSessionMetadataStore } from './claudeSessionMetadataStore.js';
import { convertToolCallResult } from './clientTools/claudeClientToolResult.js';
import { readClaudePermissionMode } from './claudeSessionPermissionMode.js';
import { SessionClientToolsDiff } from './clientTools/claudeSessionClientToolsModel.js';
import { SessionClientCustomizationsDiff } from './customizations/claudeSessionClientCustomizationsModel.js';
import { ClaudeCustomizationWatcher, buildDiscoveredCustomizations, resolveClaudeAgentName } from './customizations/claudeSessionCustomizationDiscovery.js';
import { scanClaudeDiskCustomizations } from './customizations/scan/claudeAgentSkillScan.js';
import { scanClaudeHooks } from './customizations/scan/claudeHookScan.js';
import { scanClaudeMcpServers } from './customizations/scan/claudeMcpScan.js';
import { scanClaudeNativePlugins } from './customizations/scan/claudeNativePluginScan.js';
import { scanClaudeRules } from './customizations/scan/claudeRuleScan.js';
import { resolvePromptToContentBlocks } from './claudePromptResolver.js';
import type { ClaudeTransport } from './claudeProxyService.js';
import { ClaudeSdkPipeline, IRematerializer, type ISdkResolvedCustomizations } from './claudeSdkPipeline.js';
import { SubagentRegistry } from './claudeSubagentRegistry.js';
import { ClaudePermissionKind } from './claudeToolDisplay.js';

// Re-export for callers that import IRematerializer from the session.
export type { IRematerializer } from './claudeSdkPipeline.js';

/** FORK: cap on the per-session harness-diagnostics ring buffer (see `_diagnosticsLog`). */
const MAX_DIAGNOSTIC_LOG_LINES = 500;

/**
 * FORK: collapse a blob to a single diagnostics-friendly line — whitespace
 * runs become one space, backticks are stripped (the dialog renders snippets
 * inside markdown), and anything past `maxChars` is elided.
 */
function abbreviateForDiagnostics(text: string, maxChars: number): string {
	const flat = text.replace(/[`\r\n\t ]+/g, ' ').trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * Inputs to {@link ClaudeAgentSession.materialize}. Carries the
 * agent-supplied dependencies that the session itself does not own
 * (proxy auth, the `canUseTool` closure that bridges back to the
 * agent's per-session lookup, and the resume-vs-fresh discriminator).
 */
export interface IMaterializeContext {
	readonly transport: ClaudeTransport;
	readonly canUseTool: NonNullable<Options['canUseTool']>;
	readonly isResume: boolean;
	/**
	 * Agent host's server-tool host. When present, the session exposes the
	 * agent host's server tools (feedback "comments" today, more in the future)
	 * as an in-process MCP server and advertises them as server tools. Omitted
	 * by providers that don't support server-side tools.
	 */
	readonly serverToolHost?: IAgentServerToolHost;
	/**
	 * FORK: `PostToolUse` hook for client-side context management, owned by the
	 * agent (holds config + per-agent dedupe state) and threaded through to
	 * `buildOptions`. Applied to both the initial materialize and the
	 * yield-restart rebuild so trimming survives a rematerialize. Omitted when
	 * context management is fully disabled.
	 */
	readonly postToolUseHook?: HookCallback;
}

function resolveCurrentPermissionMode(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
	permissionModeFallback: ClaudePermissionMode,
): ClaudePermissionMode {
	return readClaudePermissionMode(configurationService, sessionUri) ?? permissionModeFallback;
}

/**
 * Per-session coordinator. Owns:
 *   • Per-session identity (sessionId / sessionUri / workingDirectory).
 *   • The {@link ClaudeSdkPipeline} that drives the SDK Query lifecycle
 *     and emits every {@link AgentSignal} for this session (router-
 *     mapped per-message signals plus `ChatTurnComplete` and
 *     `steering_consumed`).
 *   • Pending-permission and pending-user-input registries (Phase 7),
 *     surfaced via `requestPermission` / `requestUserInput`.
 */
export class ClaudeAgentSession extends Disposable {

	private _pipeline: ClaudeSdkPipeline | undefined;
	private readonly _chatChannelUri: URI;

	/** Pre-materialize model selection. Mutable; flows into `Options.model` on first installPipeline. */
	private _provisionalModel: ModelSelection | undefined;
	/**
	 * Pre-materialize custom-agent selection. Mutable; flows into
	 * `Options.agent` (resolved to the SDK agent name) on materialize
	 * and on every rematerializer call. Mid-session changes via
	 * {@link setAgent} flip {@link clientCustomizationsDiff} dirty so the
	 * next `send()` rebinds and the new agent reaches the SDK on the
	 * rebuilt `Query`. The SDK's `Options.agent` is captured at startup
	 * — there is no runtime control-plane equivalent.
	 */
	private _provisionalAgent: AgentSelection | undefined;
	/** Pre-materialize `IAgentCreateSessionConfig.config` bag. Read at materialize time. */
	readonly provisionalConfig: Record<string, unknown> | undefined;
	/** Resolved project metadata captured at create time (if any). */
	readonly project: IAgentSessionProjectInfo | undefined;
	/** Always-present abort controller; wired into `Options.abortController` at materialize time. */
	readonly abortController: AbortController;

	/** Exposed for the materializer's MCP-server build closure. */
	get pendingClientToolCalls(): PendingRequestRegistry<CallToolResult> { return this._pendingClientToolCalls; }
	/** Snapshot of permission-mode fallback used when live read is undefined. */
	get permissionModeFallback(): ClaudePermissionMode { return this._permissionModeFallback; }

	static createProvisional(
		sessionId: string,
		sessionUri: URI,
		workingDirectory: URI | undefined,
		additionalDirectories: readonly URI[],
		project: IAgentSessionProjectInfo | undefined,
		model: ModelSelection | undefined,
		agent: AgentSelection | undefined,
		config: Record<string, unknown> | undefined,
		pendingClientToolCalls: PendingRequestRegistry<CallToolResult>,
		permissionModeFallback: ClaudePermissionMode,
		metadataStore: ClaudeSessionMetadataStore,
		instantiationService: IInstantiationService,
	): ClaudeAgentSession {
		return instantiationService.createInstance(
			ClaudeAgentSession,
			sessionId,
			sessionUri,
			workingDirectory,
			additionalDirectories,
			project,
			model,
			agent,
			config,
			new AbortController(),
			pendingClientToolCalls,
			new SessionClientToolsDiff(),
			permissionModeFallback,
			metadataStore,
		);
	}

	/**
	 * Phase 12 — per-session registry of Task tool calls that spawn
	 * subagents (`SubagentSpawn` records keyed by `tool_use_id`, plus a
	 * reverse index from inner `tool_use_id` to its parent Task). Owned
	 * here so the registry dies with the session; consumers in the live
	 * mapper (`ClaudeSdkMessageRouter` / `claudeMapSessionEvents` /
	 * `claudeSubagentSignals`) and the `canUseTool` bridge read from
	 * the same instance via the session.
	 */
	readonly subagents: SubagentRegistry = this._register(new SubagentRegistry());

	/**
	 * Phase 7 / S3.2. Tool-permission deferreds parked inside
	 * {@link Options.canUseTool}. Keyed by SDK `tool_use_id`.
	 */
	private readonly _pendingPermissions = new PendingRequestRegistry<boolean>();

	/**
	 * Phase 7 / S3.2. User-input deferreds parked for interactive tools
	 * (`AskUserQuestion`, `ExitPlanMode`). Keyed by `ChatInputRequest.id`.
	 */
	private readonly _pendingUserInputs = new PendingRequestRegistry<{ response: ChatInputResponseKind; answers?: Record<string, ChatInputAnswer> }>();

	/**
	 * Phase 10 — owns the workbench-registered client-tool snapshot
	 * (via {@link SessionClientToolsDiff.model}) plus the
	 * "changed since last successful build" dirty bit. Read by the
	 * agent's sendMessage diff check; used by the materialize /
	 * rematerializer flow to pin the SDK build against a specific
	 * snapshot. See {@link SessionClientToolsDiff} for the C6 race
	 * semantics this collaborator enforces.
	 */
	readonly toolDiff: SessionClientToolsDiff;

	/**
	 * Phase 11 — per-session **client-pushed** synced customization
	 * snapshot + enablement map. Owns the workbench-supplied
	 * {@link ISyncedCustomization} list, the per-URI enablement bits,
	 * and the dirty flag drained at the next {@link send} pre-flight.
	 * Exists from `createProvisional` onward so client-side reads /
	 * toggles work uniformly before and after materialize.
	 *
	 * Server-side (SDK-discovered) customizations are NOT stored here
	 * — they're fetched on demand from the live `Query` in
	 * {@link getSessionCustomizations}.
	 *
	 * See {@link SessionClientCustomizationsDiff}.
	 */
	readonly clientCustomizationsDiff: SessionClientCustomizationsDiff = this._register(new SessionClientCustomizationsDiff());

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	/**
	 * Real Copilot credits (in nano-AIU) billed by CAPI for the current
	 * turn, summed across every `/v1/messages` request the SDK made
	 * (including subagents). Fed by {@link recordTurnCredits} from the
	 * proxy's `onDidReportCredits`, reset at the start of each {@link send},
	 * and attached to the turn's `ChatUsage` signal by
	 * {@link _enrichSignalWithCredits}. Unlike the SDK's `total_cost_usd`
	 * (an Anthropic-list-price estimate), this is what CAPI actually bills.
	 */
	private _currentTurnNanoAiu = 0;

	/**
	 * FORK: context-window size (tokens) reported by the SDK after the most
	 * recent completed turn, via the fire-and-forget
	 * {@link _refreshContextUsage} fetch. Drives the auto-compact trigger in
	 * {@link send}. `undefined` until the first post-turn refresh lands (a
	 * freshly-resumed session's first turn is never auto-compacted — the
	 * refresh after that turn catches it) and reset when a compact preflight
	 * is enqueued (the pre-compaction reading is stale the moment `/compact`
	 * runs).
	 */
	private _lastContextTotalTokens: number | undefined;
	private _contextUsageRefreshInFlight = false;
	private readonly _contextUsageRefreshTimer = this._register(new MutableDisposable());

	/**
	 * FORK: bounded per-session harness-diagnostics log — the data behind the
	 * chat's "Session Logs" affordance. Records what the fork's client-side
	 * context management actually did this session: tool-output caps / read
	 * dedupes (fed by {@link ClaudeAgent}'s shared trim hook via
	 * {@link appendDiagnostic}), auto-compact triggers, and per-turn
	 * context-usage readings. In-memory only; lost on host restart.
	 */
	private readonly _diagnosticsLog: string[] = [];

	/** Append an ISO-timestamped line to the session's diagnostics log, evicting the oldest past the cap. */
	appendDiagnostic(message: string): void {
		this._diagnosticsLog.push(`${new Date().toISOString()} ${message}`);
		if (this._diagnosticsLog.length > MAX_DIAGNOSTIC_LOG_LINES) {
			this._diagnosticsLog.shift();
		}
	}

	get diagnosticsLog(): readonly string[] { return this._diagnosticsLog; }

	/**
	 * Transport the session materialized under (Phase 19). Defaults to `proxy`
	 * until {@link materialize} resolves it from {@link IMaterializeContext}.
	 * Gates {@link _enrichSignalWithCredits} so native turns never carry a
	 * Copilot credits overlay (the proxy is the only credit source).
	 */
	private _transportKind: ClaudeTransport['kind'] = 'proxy';

	/**
	 * Accumulate proxy-reported billed credits for the in-flight turn.
	 * Called from {@link ClaudeAgent} for every proxy `onDidReportCredits`
	 * routed to this session. Ignores non-positive / non-finite values.
	 */
	recordTurnCredits(totalNanoAiu: number): void {
		if (Number.isFinite(totalNanoAiu) && totalNanoAiu > 0) {
			this._currentTurnNanoAiu += totalNanoAiu;
		}
	}

	/**
	 * FORK: in-flight tool names keyed by toolCallId, recorded at
	 * `ChatToolCallStart` so the `ChatToolCallReady` / `ChatToolCallComplete`
	 * diagnostics lines can name the tool (those actions carry only the id).
	 * Cleared at each turn start in {@link send}.
	 */
	private readonly _turnToolNames = new Map<string, string>();

	/**
	 * FORK: record pipeline signals into the session diagnostics log so the
	 * chat's "Session Logs" view tells the story of each turn:
	 * - every tool call (name + one-line input) as it becomes ready,
	 * - tool failures with the tool's name,
	 * - the per-turn `ChatUsage` report — input/output plus cache read/write
	 *   tokens (cold rewrites show as large cache writes; a warm prefix as
	 *   large reads).
	 */
	private _recordSignalDiagnostics(signal: AgentSignal): void {
		if (signal.kind !== 'action') {
			return;
		}
		const action = signal.action;
		switch (action.type) {
			case ActionType.ChatToolCallStart:
				this._turnToolNames.set(action.toolCallId, action.toolName);
				break;
			case ActionType.ChatToolCallReady: {
				const name = this._turnToolNames.get(action.toolCallId) ?? action.toolCallId;
				const input = action.toolInput ? ` — ${abbreviateForDiagnostics(action.toolInput, 120)}` : '';
				this.appendDiagnostic(`tool: ${name}${input}`);
				break;
			}
			case ActionType.ChatToolCallComplete: {
				const name = this._turnToolNames.get(action.toolCallId) ?? action.toolCallId;
				this._turnToolNames.delete(action.toolCallId);
				if (!action.result.success) {
					this.appendDiagnostic(`tool FAILED: ${name}`);
				}
				break;
			}
			case ActionType.ChatUsage: {
				const usage = action.usage;
				const fmt = (n: number | undefined) => typeof n === 'number' ? n.toLocaleString('en-US') : '0';
				this.appendDiagnostic(`usage: input ${fmt(usage.inputTokens)}, output ${fmt(usage.outputTokens)}, cache read ${fmt(usage.cacheReadTokens)}, cache write ${fmt(usage.cacheCreationTokens)}${usage.model ? ` — ${usage.model}` : ''}`);
				break;
			}
		}
	}

	/**
	 * Inject the turn's accumulated Copilot credits into its `ChatUsage`
	 * signal as `_meta.copilotUsage.totalNanoAiu` — the well-known key the
	 * workbench prefers over `_meta.cost` when rendering per-turn credits.
	 * All other signals pass through untouched.
	 */
	private _enrichSignalWithCredits(signal: AgentSignal): AgentSignal {
		if (this._transportKind !== 'proxy' || signal.kind !== 'action' || signal.action.type !== ActionType.ChatUsage || this._currentTurnNanoAiu <= 0) {
			return signal;
		}
		const usage = signal.action.usage;
		return {
			...signal,
			action: {
				...signal.action,
				usage: {
					...usage,
					_meta: {
						...usage._meta,
						copilotUsage: { totalNanoAiu: this._currentTurnNanoAiu },
					},
				},
			},
		};
	}

	constructor(
		readonly sessionId: string,
		readonly sessionUri: URI,
		readonly workingDirectory: URI | undefined,
		readonly additionalDirectories: readonly URI[],
		project: IAgentSessionProjectInfo | undefined,
		model: ModelSelection | undefined,
		agent: AgentSelection | undefined,
		config: Record<string, unknown> | undefined,
		abortController: AbortController,
		private readonly _pendingClientToolCalls: PendingRequestRegistry<CallToolResult>,
		toolDiff: SessionClientToolsDiff,
		private readonly _permissionModeFallback: ClaudePermissionMode,
		private readonly _metadataStore: ClaudeSessionMetadataStore,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IClaudeAgentSdkService private readonly _sdkService: IClaudeAgentSdkService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
		this._chatChannelUri = URI.parse(buildDefaultChatUri(sessionUri));
		this.project = project;
		this._provisionalModel = model;
		this._provisionalAgent = agent;
		this.provisionalConfig = config;
		this.abortController = abortController;
		this.toolDiff = this._register(toolDiff);
		this._register(this.clientCustomizationsDiff.onDidChange(() => this._onDidCustomizationsChange.fire()));

		// Watch the on-disk Claude customization sources so edits made outside
		// the session (a new `~/.claude/agents/*.md`, an edited skill, a changed
		// `.mcp.json`) drive a workbench re-fetch. Active from construction so
		// it covers the provisional (pre-materialize) window too.
		const customizationWatcher = this._register(new ClaudeCustomizationWatcher(
			this.workingDirectory,
			this._environmentService.userHome,
			this._fileService,
			this._logService,
		));
		this._register(customizationWatcher.onDidChange(() => this._onDidCustomizationsChange.fire()));
	}

	/**
	 * One-shot SDK assistant-message uuid that the next materialize / rebuild
	 * resumes *up to and including* (the SDK's `Options.resumeSessionAt`).
	 * Staged by {@link truncateToTurn}; read by the next build and cleared
	 * only once that build *succeeds* (so a thrown / cancelled rebuild keeps
	 * the anchor staged and the next send retries the truncation rather than
	 * silently proceeding without it and undoing the checkpoint restore).
	 */
	private _pendingResumeSessionAt: string | undefined;

	/**
	 * In-place truncation to `turnId` ("Restore Checkpoint"): prune the
	 * per-turn DB rows (file edits, checkpoint refs) past the boundary AND
	 * stage the SDK resume anchor that the next rebuild applies via
	 * `Options.resumeSessionAt`. These two halves are one invariant — pruning
	 * without staging the anchor would drop DB rows while the SDK still
	 * replays the truncated turns; staging without pruning would leave stale
	 * rows — so they live behind a single call rather than two the caller
	 * could half-invoke. The prune runs first because it is the fallible half:
	 * a DB failure then rejects without leaving an anchor staged for the next
	 * turn. `turnId` is the protocol turn id (DB key); `resumeAnchorUuid` is
	 * the SDK assistant-message uuid the agent resolved for it.
	 */
	async truncateToTurn(turnId: string, resumeAnchorUuid: string): Promise<void> {
		await this._withDatabase(db => db.deleteTurnsAfter(turnId));
		this._pendingResumeSessionAt = resumeAnchorUuid;
	}

	/** Prunes all per-turn DB rows (remove-all truncation). */
	async pruneAllTurns(): Promise<void> {
		await this._withDatabase(db => db.deleteAllTurns());
	}

	/**
	 * Runs `fn` against a short-lived, ref-counted session DB handle so the
	 * write is safe regardless of the pipeline's own dbRef lifecycle (the
	 * ref-count keeps the shared DB alive; disposing only decrements).
	 */
	private async _withDatabase(fn: (db: ISessionDatabase) => Promise<void>): Promise<void> {
		const ref = this._sessionDataService.openDatabase(this.sessionUri);
		try {
			await fn(ref.object);
		} finally {
			ref.dispose();
		}
	}

	/**
	 * Bring the session up: build SDK `Options`, start the SDK, open the
	 * session-scoped DB ref, construct the pipeline, and attach the
	 * rematerializer used for yield-restart (e.g. after a client-tool
	 * snapshot change). Idempotent on re-call: extra calls throw rather
	 * than silently re-materialize.
	 *
	 * If the supplied {@link IMaterializeContext.proxyHandle}'s underlying
	 * `abortController` fires while `sdk.startup()` is in flight, the SDK
	 * unwinds via the controller; if `startup` resolves anyway, the
	 * `WarmQuery` is asyncDisposed and a {@link CancellationError} is
	 * thrown (Q8 belt-and-suspenders).
	 */
	async materialize(ctx: IMaterializeContext): Promise<void> {
		if (this._pipeline) {
			throw new Error('ClaudeAgentSession is already materialized');
		}
		if (!this.workingDirectory) {
			throw new Error(`Cannot materialize Claude session ${this.sessionId}: workingDirectory is required`);
		}
		this._transportKind = ctx.transport.kind;

		const permissionMode = readClaudePermissionMode(this._configurationService, this.sessionUri) ?? this._permissionModeFallback;
		const { mcpServers, allowedTools } = await this._buildStartupToolWiring(ctx.serverToolHost);
		const agentName = await resolveClaudeAgentName(this._provisionalAgent, this._fileService, this._logService, this.sessionId);

		const options = await buildOptions(
			{
				sessionId: this.sessionId,
				workingDirectory: this.workingDirectory,
				additionalDirectories: this.additionalDirectories,
				// FORK: fableplan resolves per permission mode; raw id never reaches the SDK.
				model: this._effectiveModel(permissionMode),
				abortController: this.abortController,
				permissionMode,
				canUseTool: ctx.canUseTool,
				isResume: ctx.isResume,
				resumeSessionAt: this._pendingResumeSessionAt,
				mcpServers,
				allowedTools,
				plugins: this.clientCustomizationsDiff.consume(),
				agent: agentName,
				postToolUseHook: ctx.postToolUseHook,
			},
			ctx.transport,
			data => this._logService.error(`[Claude SDK stderr] ${data}`),
			msg => this._logService.info(`[Claude] declining elicitation from MCP server (Phase 7 stub): ${msg}`),
		);

		this._logService.info(`[Claude] session ${this.sessionId}: enableFileCheckpointing=${options.enableFileCheckpointing} isResume=${ctx.isResume}`);

		const warm = await this._sdkService.startup({ options });

		if (this.abortController.signal.aborted) {
			await warm[Symbol.asyncDispose]();
			throw new CancellationError();
		}

		const dbRef = this._sessionDataService.openDatabase(this.sessionUri);
		let pipeline: ClaudeSdkPipeline;
		try {
			pipeline = this._register(this._instantiationService.createInstance(
				ClaudeSdkPipeline,
				this.sessionId,
				this.sessionUri,
				this._chatChannelUri,
				warm,
				this.abortController,
				dbRef,
				this.subagents,
				(toolName: string) => this.toolDiff.model.ownerOf(toolName),
			));
		} catch (err) {
			dbRef.dispose();
			await warm[Symbol.asyncDispose]();
			throw err;
		}
		this._register(pipeline.onDidProduceSignal(s => {
			// FORK: record tool calls + token usage into the session diagnostics log before forwarding.
			this._recordSignalDiagnostics(s);
			this._onDidSessionProgress.fire(this._enrichSignalWithCredits(s));
		}));
		this._pipeline = pipeline;
		// The materialize succeeded with the staged anchor applied to `Options`
		// — clear it now so it isn't re-applied. A throw before this point (e.g.
		// `startup` / pipeline-create) leaves it staged for the next retry.
		this._pendingResumeSessionAt = undefined;

		// Seed the pipeline's bijective config cache so a rebuild re-applies
		// the user's last-chosen model / effort without losing the picker
		// config. Read provisional state directly off the session.
		pipeline.seedCurrentConfig(
			toSdkModelId(this._effectiveModel(permissionMode)?.id),
			clampEffortForRuntime(resolveClaudeEffort(this._provisionalModel)),
			permissionMode,
		);

		// Fresh sessions persist their customization-directory / model /
		// permissionMode overlay so a later resume re-reads them. Resume
		// sessions skip the write because they READ from the overlay
		// upstream and would otherwise overwrite their source.
		if (!ctx.isResume) {
			try {
				await this._metadataStore.write(this.sessionUri, {
					customizationDirectory: this.workingDirectory,
					model: this._provisionalModel,
					permissionMode,
					transport: ctx.transport.kind,
				});
			} catch (err) {
				this._logService.error(`[Claude] Failed to persist customization directory; aborting materialize`, err);
				throw err;
			}
		}

		// Final pre-commit abort gate. The first gate above caught aborts
		// that landed while `sdk.startup()` was in flight; this one catches
		// aborts that landed during the metadata write (a separate async
		// boundary). Without it, a racing `disposeSession` could complete
		// before this method returns and leave the pipeline live.
		if (this.abortController.signal.aborted) {
			throw new CancellationError();
		}

		pipeline.attachRematerializer(async (_reason) => {
			const liveMode = readClaudePermissionMode(this._configurationService, this.sessionUri) ?? this._permissionModeFallback;
			try {
				const { mcpServers: rebuildMcp, allowedTools: rebuildAllowedTools } = await this._buildStartupToolWiring(ctx.serverToolHost);
				const rebuildAgentName = await resolveClaudeAgentName(this._provisionalAgent, this._fileService, this._logService, this.sessionId);
				const rebuildAbort = new AbortController();
				const rebuildOptions = await buildOptions(
					{
						sessionId: this.sessionId,
						workingDirectory: this.workingDirectory!,
						additionalDirectories: this.additionalDirectories,
						// FORK: fableplan resolves per permission mode; raw id never reaches the SDK.
						model: this._effectiveModel(liveMode),
						abortController: rebuildAbort,
						permissionMode: liveMode,
						canUseTool: ctx.canUseTool,
						isResume: true,
						resumeSessionAt: this._pendingResumeSessionAt,
						mcpServers: rebuildMcp,
						allowedTools: rebuildAllowedTools,
						plugins: this.clientCustomizationsDiff.consume(),
						agent: rebuildAgentName,
						postToolUseHook: ctx.postToolUseHook,
					},
					ctx.transport,
					data => this._logService.error(`[Claude SDK stderr] ${data}`),
					msg => this._logService.info(`[Claude] declining elicitation from MCP server (Phase 7 stub): ${msg}`),
				);
				this._logService.info(`[Claude] session ${this.sessionId}: resume rebuild agent=${rebuildOptions.agent ?? '(none)'}`);
				const rebuildWarm = await this._sdkService.startup({ options: rebuildOptions });
				// Rebuild succeeded with the anchor applied — clear it so it
				// isn't re-applied. A throw above keeps it staged (handled in the
				// catch alongside the tool/customization diffs) so the next send
				// retries the truncation instead of dropping the restore.
				this._pendingResumeSessionAt = undefined;
				return { warm: rebuildWarm, abortController: rebuildAbort };
			} catch (err) {
				this.toolDiff.markDirty();
				this.clientCustomizationsDiff.markDirty();
				throw err;
			}
		});

		// Advertise the agent host's server tools on this session so the client
		// sees them as server-provided. Execution happens in-process via the
		// server-tool MCP server built in `_buildStartupToolWiring`.
		ctx.serverToolHost?.advertise(this.sessionUri.toString());

		// Surface the SDK-resolved customization tier to the workbench.
		// Pre-materialize, getSessionCustomizations returns only the
		// client-pushed slice; firing here prompts the workbench to refetch
		// and pick up the bundled `Discovered in Claude` entry.
		this._onDidCustomizationsChange.fire();
	}

	/**
	 * Build the SDK tool wiring shared by the initial materialize and every
	 * yield-restart rematerialize: the in-process MCP servers plus the
	 * auto-approve allow-list.
	 *
	 * The MCP servers are the workbench client tools (which round-trip to the
	 * workbench) plus, when a server-tool host is wired, the agent host's own
	 * server tools (executed in-process). `mcpServers` is `undefined` when
	 * neither is present so `Options.mcpServers` is omitted entirely and the
	 * SDK keeps its default; `allowedTools` carries the SDK-prefixed server tool
	 * names (so they auto-approve without prompting) and is `undefined` when no
	 * server-tool host is wired.
	 *
	 * Keeping both in one place ensures the two startup paths can never drift,
	 * and that a newly registered server tool is wired everywhere at once.
	 */
	private async _buildStartupToolWiring(
		serverToolHost: IAgentServerToolHost | undefined,
	): Promise<{ mcpServers: Record<string, McpSdkServerConfigWithInstance> | undefined; allowedTools: readonly string[] | undefined }> {
		const clientServers = await buildClientMcpServers(this.toolDiff, this._pendingClientToolCalls, this._sdkService);
		const serverToolServer = serverToolHost
			? await buildServerToolMcpServer(serverToolHost, this.sessionUri.toString(), this._sdkService)
			: undefined;
		const mcpServers = (!clientServers && !serverToolServer)
			? undefined
			: {
				...(clientServers ?? {}),
				...(serverToolServer ? { [CLAUDE_SERVER_TOOL_MCP_SERVER_NAME]: serverToolServer } : {}),
			};
		// Exclude server tools that require user confirmation from the
		// auto-approve allow-list so the SDK surfaces them via `canUseTool`
		// (the host then renders a custom confirmation) instead of running them
		// silently.
		const autoApproveToolNames = serverToolHost
			? serverToolHost.toolNames.filter(name => !serverToolHost.requiresConfirmation(name))
			: undefined;
		return { mcpServers, allowedTools: autoApproveToolNames ? serverToolAllowList(autoApproveToolNames) : undefined };
	}

	/** True once {@link materialize} has installed the SDK pipeline. */
	get isPipelineReady(): boolean { return this._pipeline !== undefined; }

	/** Pre-materialize model selection accessor (read by materializer to build Options). */
	get provisionalModel(): ModelSelection | undefined { return this._provisionalModel; }

	/**
	 * FORK: `fableplan` tiered routing — the selection the SDK should
	 * actually run under the given permission mode. `fableplan` is
	 * IDE-synthetic (no CLI alias), so it resolves to `fable` in plan mode
	 * and `sonnet` otherwise; every other selection passes through
	 * unchanged. Metadata writes intentionally keep the raw
	 * {@link _provisionalModel} so the picker choice survives a resume.
	 */
	private _effectiveModel(mode: PermissionMode | undefined): ModelSelection | undefined {
		const model = this._provisionalModel;
		if (!model || model.id !== FABLE_PLAN_MODEL_ID) {
			return model;
		}
		return { ...model, id: resolveTieredModelId(model.id, mode) };
	}

	private _requirePipeline(): ClaudeSdkPipeline {
		if (!this._pipeline) {
			throw new Error('ClaudeAgentSession is not materialized');
		}
		return this._pipeline;
	}

	get isResumed(): boolean { return this._requirePipeline().isResumed; }

	/**
	 * FORK: current context-window usage (the `↓ N tokens` indicator). Returns undefined before the
	 * SDK pipeline is materialized (no live query yet to query).
	 */
	async getContextUsage(): Promise<SDKControlGetContextUsageResponse | undefined> {
		if (!this.isPipelineReady) {
			return undefined;
		}
		return this._requirePipeline().getContextUsage();
	}

	/**
	 * Abort the live SDK subprocess and await its full teardown so the
	 * session id is released. No-op when the session was never materialized
	 * (no subprocess to stop). Used by remove-all truncation before it
	 * recreates a fresh session under the same id — the CLI keeps the id
	 * locked until the old subprocess exits.
	 */
	async shutdownLiveQuery(): Promise<void> {
		await this._pipeline?.shutdownAndWait();
	}

	/**
	 * Seed the pipeline's current + applied config cache from
	 * materialize-time `Options`. The SDK already starts with these
	 * values, so the cache prevents a redundant first `setModel` /
	 * `applyFlagSettings` call.
	 */
	seedBijectiveState(state: { model?: string; effort?: ClaudeRuntimeEffortLevel; permissionMode?: PermissionMode }): void {
		this._requirePipeline().seedCurrentConfig(state.model, state.effort, state.permissionMode);
	}

	attachRematerializer(rematerializer: IRematerializer): void {
		this._requirePipeline().attachRematerializer(rematerializer);
	}

	/**
	 * Send a user prompt. Performs the per-turn pre-flight before
	 * yielding to the pipeline:
	 *
	 * - If {@link toolDiff} or {@link clientCustomizationsDiff} reports the
	 *   live `Query` is out of sync with the workbench's view, yield-restart
	 *   so the SDK picks up the new `Options.mcpServers` / `Options.plugins`.
	 *   `Query.reloadPlugins()` cannot help here — the SDK's plugin URI set
	 *   is captured at startup, so any add / remove / nonce-bump must go
	 *   through a full rebuild. The rebind itself re-applies the live
	 *   `permissionMode` via the rematerializer.
	 * - Otherwise forward the live `permissionMode` to the bound `Query` so
	 *   a `SessionConfigChanged` action that arrived between turns wins.
	 *   The pipeline's bijective cache dedupes a no-op `setPermissionMode`,
	 *   so this is free when nothing changed.
	 *
	 * Model / effort are not threaded through here — the pipeline's current
	 * model / effort (set eagerly via {@link setModel}) is whatever
	 * the SDK has been told.
	 */
	async send(prompt: SDKUserMessage, turnId: string, options?: { readonly allowAutoCompact?: boolean }): Promise<void> {
		const pipeline = this._requirePipeline();
		// New turn: reset the per-turn credit accumulator so proxy reports
		// for this turn's `/v1/messages` calls sum from zero.
		this._currentTurnNanoAiu = 0;
		const livePermissionMode = resolveCurrentPermissionMode(this._configurationService, this.sessionUri, this._permissionModeFallback);
		if (this.toolDiff.hasDifference || this.clientCustomizationsDiff.hasDifference || this._pendingResumeSessionAt !== undefined) {
			await this._rebindForSyncedState();
		} else {
			await pipeline.setPermissionMode(livePermissionMode);
		}
		// FORK: fableplan tiered routing — a permission-mode flip (plan ↔
		// execute) changes the effective model, so re-assert it every turn.
		// The pipeline's bijective cache dedupes the no-op case.
		if (this._provisionalModel?.id === FABLE_PLAN_MODEL_ID) {
			await pipeline.setModel(toSdkModelId(resolveTieredModelId(this._provisionalModel.id, livePermissionMode)));
		}
		// FORK: harness auto-compact — when the last completed turn left the
		// context above the trigger, run `/compact` ahead of this prompt (same
		// turnId; see the pipeline's preflight contract).
		const preflight = this._buildAutoCompactPreflight(options?.allowAutoCompact ?? true);
		// FORK: the prompt snippet on the turn-started line is what the
		// "Session Logs" dialog groups the log by — one section per prompt.
		this._turnToolNames.clear();
		const content = prompt.message.content;
		const promptText = typeof content === 'string'
			? content
			: content.map(b => b.type === 'text' ? b.text : `[${b.type}]`).join(' ');
		this.appendDiagnostic(`turn started (turnId ${turnId})${preflight ? ' — /compact preflight enqueued' : ''} — prompt: ${abbreviateForDiagnostics(promptText, 100)}`);
		await pipeline.send(prompt, turnId, preflight);
		// FORK: post-turn instrumentation + auto-compact bookkeeping. Fire and
		// forget so the caller's sequencer scope is not held for the fetch.
		this._refreshContextUsage();
	}

	/**
	 * FORK: build the `/compact` preflight for {@link send}, or `undefined`
	 * when compaction should not run: the caller disallowed it (the prompt is
	 * itself a slash command), auto-compact is disabled, no post-turn usage
	 * reading exists yet, or the context is still under the trigger.
	 */
	private _buildAutoCompactPreflight(allowAutoCompact: boolean): SDKUserMessage | undefined {
		if (!allowAutoCompact || this._lastContextTotalTokens === undefined) {
			return undefined;
		}
		// Fallbacks mirror the schema defaults — `getRootValue` returns
		// `undefined` for unset keys; schema defaults are not applied at runtime.
		const enabled = this._configurationService.getRootValue(agentHostCustomizationConfigSchema, AgentHostConfigKey.ClaudeAutoCompact) ?? true;
		const triggerTokens = this._configurationService.getRootValue(agentHostCustomizationConfigSchema, AgentHostConfigKey.ClaudeAutoCompactTriggerTokens) ?? 120000;
		if (!enabled || this._lastContextTotalTokens < triggerTokens) {
			return undefined;
		}
		const message = `auto-compact: context ${this._lastContextTotalTokens} tokens >= trigger ${triggerTokens} — compacting before this turn`;
		this._logService.info(`[Claude:${this.sessionId}] ${message}`);
		this.appendDiagnostic(message);
		this._lastContextTotalTokens = undefined;
		return {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: '/compact' }] },
			session_id: this.sessionId,
			parent_tool_use_id: null,
			uuid: generateUuid() as `${string}-${string}-${string}-${string}-${string}`,
		};
	}

	/**
	 * FORK: post-turn context instrumentation. Fetches the SDK's context
	 * gauge, caches the total for the auto-compact trigger, and logs one line
	 * per turn including the CLI's own auto-compact state — the visibility
	 * that confirms whether the SDK's built-in compaction is armed at all.
	 *
	 * The fetch runs on a session-registered timer (one beat of delay lets
	 * the control transport settle after `result`; it can momentarily report
	 * "not ready for writing") and makes a single no-retry attempt, so no
	 * timer or control request ever outlives the session — dispose cancels
	 * the timer. A missed sample self-heals on the next turn.
	 */
	private _refreshContextUsage(): void {
		if (this._contextUsageRefreshInFlight || !this.isPipelineReady) {
			return;
		}
		this._contextUsageRefreshInFlight = true;
		this._contextUsageRefreshTimer.value = disposableTimeout(() => {
			void (async () => {
				try {
					const pipeline = this._requirePipeline();
					if (pipeline.isAborted) {
						return;
					}
					const usage = await pipeline.getContextUsage(false);
					this._lastContextTotalTokens = usage.totalTokens;
					const message = `context usage: ${usage.totalTokens}/${usage.maxTokens} tokens (${Math.round(usage.percentage)}%) — SDK auto-compact ${usage.isAutoCompactEnabled ? `enabled (threshold ${usage.autoCompactThreshold ?? 'unknown'})` : 'DISABLED'}`;
					this._logService.info(`[Claude:${this.sessionId}] ${message}`);
					this.appendDiagnostic(message);
				} catch (err) {
					this._logService.warn(`[Claude:${this.sessionId}] context usage refresh failed: ${err}`);
					this.appendDiagnostic(`context usage refresh failed: ${err}`);
				} finally {
					this._contextUsageRefreshInFlight = false;
				}
			})();
		}, 500);
	}

	/**
	 * Single yield-restart that covers both client-tool and
	 * customization divergence in one trip. Drains the parked
	 * client-tool MCP handlers (same as the original tool-only
	 * rebind), then triggers the pipeline rebind — the rematerializer
	 * reads `toolDiff` and `clientCustomizationsDiff.consume()` while
	 * building the new `Options`, so the bit on each diff clears in
	 * lockstep with the SDK actually receiving the new values. Fires
	 * `_onDidCustomizationsChange` afterwards so the workbench
	 * refetches `getSessionCustomizations` and picks up any newly
	 * resolved server-side entries from the rebuilt `Query`.
	 */
	private async _rebindForSyncedState(): Promise<void> {
		this._pendingClientToolCalls.rejectAll(new CancellationError());
		await this._requirePipeline().rebindForRestart();
		this._onDidCustomizationsChange.fire();
	}

	/**
	 * Cancel the in-flight SDK turn. Mirrors the production reference;
	 * see {@link ClaudeSdkPipeline.abort}. Also denies any parked
	 * permission / user-input requests so the SDK's `canUseTool`
	 * callback (and any interactive tool waiting on user input) unwinds
	 * with a deny / cancel result instead of leaving stale UI behind.
	 */
	abort(): void {
		this._pendingPermissions.denyAll(false);
		this._pendingUserInputs.denyAll({ response: ChatInputResponseKind.Cancel });
		this._requirePipeline().abort();
	}

	/**
	 * Eagerly apply a model change and persist the new selection. Safe to
	 * call before or after materialize:
	 *
	 * - Pre-materialize: stash the model on the session so the first SDK
	 *   startup picks it up via `Options.model` / `Options.effort`.
	 * - Post-materialize: queue the change on the pipeline; the SDK
	 *   applies it on the NEXT user request via
	 *   `Query.setModel` / `Query.applyFlagSettings`. `'max'` effort is
	 *   clamped to `'xhigh'` on the runtime path (CAPI lacks a `'max'`
	 *   tier today).
	 *
	 * In both cases the new model is persisted to the per-session
	 * metadata overlay so a later resume sees the user's choice.
	 */
	async setModel(model: ModelSelection): Promise<void> {
		this._provisionalModel = model;
		if (this._pipeline) {
			const requestedEffort = resolveClaudeEffort(model);
			const runtimeEffort = clampEffortForRuntime(requestedEffort);
			if (requestedEffort === 'max') {
				this._logService.warn(`[Claude:${this.sessionId}] setModel: 'max' effort clamped to 'xhigh' (Copilot CAPI has no 'max' model yet)`);
			}
			// FORK: fableplan tiered routing — resolve per the live permission
			// mode; the raw pseudo-id never reaches the SDK.
			const liveMode = resolveCurrentPermissionMode(this._configurationService, this.sessionUri, this._permissionModeFallback);
			await this._pipeline.setModel(toSdkModelId(resolveTieredModelId(model.id, liveMode)));
			// Always push the resolved effort, including `undefined`. Switching
			// to a model that does not support reasoning effort (e.g. Haiku)
			// resolves to `undefined`, which must actively CLEAR any effort the
			// SDK is still applying from a prior effort-capable model — otherwise
			// the next turn replays e.g. `'high'` onto Haiku and the API 400s
			// (`output_config.effort ... does not support reasoning effort`).
			await this._pipeline.setEffort(runtimeEffort);
		}
		await this._metadataStore.write(this.sessionUri, { model });
	}

	/**
	 * Pre-materialize custom-agent selection accessor.
	 */
	get provisionalAgent(): AgentSelection | undefined { return this._provisionalAgent; }

	/**
	 * Change (or clear with `undefined`) the selected custom agent for this
	 * session. The SDK captures `Options.agent` at startup with no
	 * working runtime control (`applyFlagSettings({ agent })` exists on
	 * the SDK surface but doesn't actually swap the live agent), so
	 * post-materialize calls flip {@link clientCustomizationsDiff}
	 * dirty and the next `send()` pre-flight rebinds with the new agent
	 * baked into the rebuilt `Query`. Persisted to the per-session
	 * metadata overlay so a resume picks up the choice.
	 */
	async setAgent(agent: AgentSelection | undefined): Promise<void> {
		if (this._provisionalAgent === agent) {
			return;
		}
		this._provisionalAgent = agent;
		if (this._pipeline) {
			// Force a rebind on the next send(); the SDK has no working
			// runtime hook to swap the agent in place.
			this.clientCustomizationsDiff.markDirty();
		}
		await this._metadataStore.write(this.sessionUri, { agent: agent ?? null });
	}

	/**
	 * Inject a steering message. Builds the `priority: 'now'`
	 * {@link SDKUserMessage} and hands it to the pipeline; the pipeline
	 * inherits the parent's turnId (CONTEXT.md M10) and fires
	 * `steering_consumed` when the SDK accepts it. No-op if the pipeline
	 * is aborted.
	 */
	injectSteering(steeringMessage: PendingMessage): void {
		const pipeline = this._requirePipeline();
		if (pipeline.isAborted) {
			return;
		}
		const contentBlocks = resolvePromptToContentBlocks(
			steeringMessage.message.text,
			steeringMessage.message.attachments,
		);
		const sdkMessage: SDKUserMessage = {
			type: 'user',
			message: { role: 'user', content: contentBlocks },
			session_id: this.sessionId,
			parent_tool_use_id: null,
			priority: 'now',
			// Reuse the protocol PendingMessage.id as the SDK uuid — same
			// pattern as `ClaudeAgent.sendMessage` reusing turnId. The SDK's
			// `uuid` field is typed as a branded UUID, but the cast at the
			// boundary is the convention for both code paths.
			uuid: steeringMessage.id as `${string}-${string}-${string}-${string}-${string}`,
		};
		pipeline.injectSteering(sdkMessage, steeringMessage.id);
	}

	/** Live permission-mode change. Forwards to the pipeline; the pipeline remembers it for re-application after a rebind. */
	async setPermissionMode(mode: PermissionMode): Promise<void> {
		const pipeline = this._requirePipeline();
		await pipeline.setPermissionMode(mode);
		// FORK: fableplan tiered routing — the mode flip changes the
		// effective model (plan → fable, else sonnet); push it eagerly so a
		// mid-session mode change doesn't run the wrong tier on the next turn.
		if (this._provisionalModel?.id === FABLE_PLAN_MODEL_ID) {
			await pipeline.setModel(toSdkModelId(resolveTieredModelId(this._provisionalModel.id, mode)));
		}
	}

	// #region Phase 7 / S3.2 — pending state

	/**
	 * Atomically register a pending-permission deferred and fire the
	 * `pending_confirmation` signal. The SDK is blocked on the returned
	 * promise inside its `canUseTool` callback until
	 * {@link respondToPermissionRequest} resolves it. Resolves with
	 * `false` if the pipeline is aborted.
	 */
	requestPermission(args: {
		readonly toolUseID: string;
		readonly state: ToolCallPendingConfirmationState;
		readonly permissionKind: ClaudePermissionKind;
		readonly permissionPath?: string;
		/** Phase 12 step 5 — when the confirmation belongs to a subagent context, route it to the subagent session. */
		readonly parentToolCallId?: string;
	}): Promise<boolean> {
		if (!this._pipeline || this._pipeline.isAborted) {
			return Promise.resolve(false);
		}
		return this._pendingPermissions.registerAndFire(args.toolUseID, () => {
			this._onDidSessionProgress.fire({
				kind: 'pending_confirmation',
				chat: this._chatChannelUri,
				state: args.state,
				permissionKind: args.permissionKind,
				...(args.permissionPath !== undefined ? { permissionPath: args.permissionPath } : {}),
				...(args.parentToolCallId !== undefined ? { parentToolCallId: args.parentToolCallId } : {}),
			});
		});
	}

	respondToPermissionRequest(requestId: string, approved: boolean): boolean {
		return this._pendingPermissions.respond(requestId, approved);
	}

	/**
	 * Fire a {@link ActionType.ChatInputRequested} action and park on
	 * a deferred until {@link respondToUserInputRequest} resolves it.
	 * Resolves with `{ response: Cancel }` if the pipeline is aborted.
	 */
	requestUserInput(request: ChatInputRequest, parentToolCallId?: string): Promise<{ response: ChatInputResponseKind; answers?: Record<string, ChatInputAnswer> }> {
		if (!this._pipeline || this._pipeline.isAborted) {
			return Promise.resolve({ response: ChatInputResponseKind.Cancel });
		}
		return this._pendingUserInputs.registerAndFire(request.id, () => {
			this._onDidSessionProgress.fire({
				kind: 'action',
				resource: this._chatChannelUri,
				action: {
					type: ActionType.ChatInputRequested,
					request,
				},
				...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
			});
		});
	}

	respondToUserInputRequest(
		requestId: string,
		response: ChatInputResponseKind,
		answers?: Record<string, ChatInputAnswer>,
	): boolean {
		return this._pendingUserInputs.respond(requestId, { response, answers });
	}

	// #endregion

	// #region Phase 10 — client tools

	/** Replace a client's registered tools (full replacement). */
	setClientTools(clientId: string, tools: readonly ToolDefinition[]): void {
		this.toolDiff.model.setTools(clientId, tools);
	}

	/** This client's registered tools (empty when absent). */
	getClientTools(clientId: string): readonly ToolDefinition[] {
		return this.toolDiff.model.getTools(clientId);
	}

	/** Remove a client's tool contribution from this session. */
	removeClientTools(clientId: string): void {
		this.toolDiff.model.removeClient(clientId);
	}

	/** Remove a client's customization contribution from this session. */
	removeClientCustomizations(clientId: string): void {
		this.clientCustomizationsDiff.model.removeClient(clientId);
	}

	/**
	 * Resolve a parked client-tool MCP handler with the workbench-supplied
	 * result. Returns `true` if a matching deferred was found and settled.
	 * Unknown ids are a benign no-op — `agentSideEffects.ts` forwards every
	 * `ChatToolCallComplete` envelope, so SDK-owned tool completions land
	 * here too and must NOT throw.
	 */
	completeClientToolCall(toolCallId: string, result: ToolCallResult): boolean {
		const converted = convertToolCallResult(result, toolCallId);
		return this._pendingClientToolCalls.respond(toolCallId, converted);
	}

	/**
	 * Drive a yield-restart so the SDK picks up the new client-tool set
	 * on its next user request. Public entry point for callers that need
	 * to force a tool-only rebind; internal pre-flight goes through
	 * {@link _rebindForSyncedState}.
	 */
	async rebindForClientTools(): Promise<void> {
		await this._rebindForSyncedState();
	}

	// #endregion

	// #region Phase 11 — customizations / plugins

	/**
	 * Merged fire-and-forget signal that this session's customization
	 * surface changed. Fires from three sources:
	 *
	 * 1. Client-side writes (`adoptClientCustomizations` /
	 *    `setClientCustomizationEnabled`) — via the
	 *    {@link SessionClientCustomizationsDiff} observable wired up in the
	 *    constructor.
	 * 2. Materialize completes — surfaces the server-side
	 *    (SDK-discovered) tier to the workbench for the first time.
	 * 3. The send() pre-flight rebind completes — the rebuilt SDK's
	 *    resolved set may have changed.
	 *
	 * Drives a workbench refetch of {@link getSessionCustomizations}.
	 * Does NOT itself trigger any SDK action — the dirty bit on
	 * {@link SessionClientCustomizationsDiff} drives plugin rebinds,
	 * and only flips on client-side writes.
	 */
	private readonly _onDidCustomizationsChange = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange: Event<void> = this._onDidCustomizationsChange.event;

	/**
	 * Adopt the result of a global {@link IAgentPluginManager.syncCustomizations}
	 * pass (**client-pushed** path). The agent owns the manager (it's
	 * a process-wide singleton with a shared on-disk cache) and pushes
	 * the resulting snapshot down here. Flips the client-side dirty bit
	 * so the next {@link send} pre-flight reloads SDK plugins.
	 */
	adoptClientCustomizations(clientId: string, synced: readonly ISyncedCustomization[]): void {
		this.clientCustomizationsDiff.model.setSyncedCustomizations(clientId, synced);
	}

	/** Toggle a **client-pushed** customization on/off for this session. */
	setClientCustomizationEnabled(id: string, enabled: boolean): void {
		this.clientCustomizationsDiff.model.setEnabled(id, enabled);
	}

	/**
	 * Snapshot of the **client-pushed** customizations on this session.
	 * Does NOT include server-side (SDK-discovered) entries — use
	 * {@link getSessionCustomizations} for the merged view.
	 */
	getClientCustomizations(): readonly ISyncedCustomization[] {
		return this.clientCustomizationsDiff.model.state.get().synced;
	}

	/**
	 * Project the union of (a) **client-pushed** customizations and
	 * (b) the **server-side** (SDK-discovered) view (commands / agents
	 * / MCP servers, including those the SDK discovered on its own
	 * from `~/.claude/**`) onto the protocol's
	 * {@link Customization} surface, with the per-id enablement
	 * overlay applied to client-pushed entries.
	 *
	 * Pre-materialize sessions return only the client-pushed projection
	 * — the SDK side has no Query to query yet. A failure to read the
	 * SDK snapshot is warn-logged and the client-pushed projection is
	 * still returned, so a transient SDK hiccup doesn't blank the UI.
	 */
	async getSessionCustomizations(): Promise<readonly Customization[]> {
		const { synced, enablement } = this.clientCustomizationsDiff.model.state.get();
		const userHome = this._environmentService.userHome;
		const [discovered, rules, mcpServers, hooks, nativePlugins] = await Promise.all([
			scanClaudeDiskCustomizations(this.workingDirectory, userHome, this._fileService),
			scanClaudeRules(this.workingDirectory, userHome, this._fileService),
			scanClaudeMcpServers(this.workingDirectory, userHome, this._fileService),
			scanClaudeHooks(this.workingDirectory, userHome, this._fileService),
			scanClaudeNativePlugins(this.workingDirectory, userHome, this._fileService, this._logService),
		]);

		// Post-materialize, the live SDK snapshot filters the disk set down to
		// what the session actually loaded (and surfaces SDK-only items as
		// non-editable). Pre-materialize there is no Query, so the full disk
		// set is shown. A transient SDK read failure leaves `sdk` undefined,
		// falling back to the unfiltered disk set rather than blanking the UI.
		let sdk: ISdkResolvedCustomizations | undefined;
		if (this._pipeline) {
			try {
				sdk = await this._pipeline.snapshotResolvedCustomizations();
			} catch (err) {
				this._logService.warn(`[Claude:${this.sessionId}] snapshotResolvedCustomizations failed`, err);
			}
		}

		// `buildDiscoveredCustomizations` also folds in the read-only "Built-in"
		// surfacing (curated pre-materialize, SDK-derived post-materialize) for
		// both agents and skills, so the SDK-vs-curated decision lives in one place.
		const discoveredCustomizations = buildDiscoveredCustomizations([...discovered, ...rules], mcpServers, hooks, nativePlugins, this.workingDirectory, userHome, sdk);

		// Final projection: the client-pushed tier (with the per-id enablement
		// overlay) first, then the discovered tier appended verbatim — the
		// enablement map is deliberately NOT applied to discovered entries.
		const result: Customization[] = synced.map(item => ({
			...item.customization,
			enabled: enablement.get(item.customization.id) ?? item.customization.enabled,
		}));
		result.push(...discoveredCustomizations);
		return result;
	}

	// #endregion

	override dispose(): void {
		// Resolve parked deferreds before tearing the pipeline down so the
		// SDK's canUseTool callback unwinds with a deny and the loop exits.
		this._pendingPermissions.denyAll(false);
		this._pendingUserInputs.denyAll({ response: ChatInputResponseKind.Cancel });
		this._pendingClientToolCalls.rejectAll(new CancellationError());
		super.dispose();
	}
}
