/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  FORK: "Jiso Settings" webview editor — a GUI for JisoIDE's own agent-host
 *  configuration (NOT the Claude CLI's `/config`).
 *
 *  Renders the context-management knobs from the agent-host root config schema
 *  ({@link agentHostCustomizationConfigSchema}) — token management (local
 *  tool-output trimming, read dedupe) and session lifecycle (harness
 *  auto-compact) — reading and writing the host-level values through the live
 *  agent-host connection (`RootConfigChanged` on the root channel, the same
 *  path the MCP-server config uses). Opened from the title-bar gear button.
 *
 *  Message protocol (webview <-> host):
 *    webview -> host: { type: 'ready' | 'load' | 'save', values? }
 *    host -> webview: { type: 'state' | 'saved' | 'error', ... }
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AgentHostConfigKey, agentHostCustomizationConfigSchema } from '../../../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { AgentHostAntigravityAgentEnabledSettingId, AgentHostCodexFuguAgentEnabledSettingId, AgentHostCursorAgentEnabledSettingId, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

const VIEW_TYPE = 'claudeSettings';

export const IClaudeSettingsService = createDecorator<IClaudeSettingsService>('claudeSettingsService');

export interface IClaudeSettingsService {
	readonly _serviceBrand: undefined;
	/** Reveal (or open) the Jiso Settings editor tab. */
	show(): Promise<void>;
}

/** One rendered settings row, sourced from the agent-host root config schema. */
interface ISettingsField {
	readonly key: string;
	readonly group: string;
	readonly label: string;
	readonly description: string | undefined;
	readonly type: 'boolean' | 'number';
	readonly defaultValue: unknown;
}

interface IAgentCliField {
	readonly provider: string;
	readonly settingKey: string;
	readonly group: string;
	readonly label: string;
	readonly description: string;
}

/**
 * The agent-host root config keys surfaced by the panel, in display order.
 * One section for now: Context Management — token management (local trimming,
 * read dedupe) and lifecycle (harness auto-compact). The compliance-held
 * server-side context editing keys are deliberately NOT surfaced (see the
 * hold notes in `agentHostCustomizationConfig.ts`).
 */
const CONTEXT_MANAGEMENT_KEYS: readonly AgentHostConfigKey[] = [
	AgentHostConfigKey.ClaudeAutoCompact,
	AgentHostConfigKey.ClaudeAutoCompactTriggerTokens,
	AgentHostConfigKey.ClaudeLocalContextTrim,
	AgentHostConfigKey.ClaudeLocalContextTrimMaxChars,
	AgentHostConfigKey.ClaudeLocalContextDedupeReads,
];

const AGENT_CLI_GROUP = localize('jisoSettings.group.agentsAndClis', "Agents and CLIs");

const AGENT_CLI_FIELDS: readonly IAgentCliField[] = [
	{
		provider: 'antigravity',
		settingKey: AgentHostAntigravityAgentEnabledSettingId,
		group: AGENT_CLI_GROUP,
		label: localize('jisoSettings.agent.antigravity', "Antigravity (agy)"),
		description: localize('jisoSettings.agent.antigravity.description', "Enable the local agy headless CLI and load models from agy models."),
	},
	{
		provider: 'cursor-agent',
		settingKey: AgentHostCursorAgentEnabledSettingId,
		group: AGENT_CLI_GROUP,
		label: localize('jisoSettings.agent.cursorAgent', "Cursor Agent"),
		description: localize('jisoSettings.agent.cursorAgent.description', "Enable the local cursor-agent headless CLI. Only the Auto model is surfaced."),
	},
	{
		provider: 'codex-fugu',
		settingKey: AgentHostCodexFuguAgentEnabledSettingId,
		group: AGENT_CLI_GROUP,
		label: localize('jisoSettings.agent.codexFugu', "Codex Fugu"),
		description: localize('jisoSettings.agent.codexFugu.description', "Enable the local codex-fugu headless CLI (Fugu, Fugu Ultra, GPT-5.5 and Codex 5.3 models)."),
	},
];

/**
 * Build the panel's field list from the root config schema so titles,
 * descriptions and defaults stay single-sourced with the agent host.
 */
function buildSettingsFields(): ISettingsField[] {
	const group = localize('claudeSettings.group.contextManagement', "Context Management");
	return CONTEXT_MANAGEMENT_KEYS.map(key => {
		const protocol = agentHostCustomizationConfigSchema.definition[key].protocol;
		return {
			key,
			group,
			label: protocol.title ?? key,
			description: protocol.description,
			type: protocol.type === 'boolean' ? 'boolean' as const : 'number' as const,
			defaultValue: protocol.default,
		};
	});
}

export class ClaudeSettingsPanel extends Disposable implements IClaudeSettingsService {
	declare readonly _serviceBrand: undefined;

	private _current: WebviewInput | undefined;
	private readonly _currentDisposables = this._register(new DisposableStore());
	private readonly _fields = buildSettingsFields();

	constructor(
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupService: IEditorGroupsService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (AGENT_CLI_FIELDS.some(field => e.affectsConfiguration(field.settingKey))) {
				this._postState();
			}
		}));
	}

	async show(): Promise<void> {
		const title = localize('claudeSettings.title', "Jiso Settings");
		const activePane = this._editorService.activeEditorPane;

		if (this._current) {
			this._webviewWorkbenchService.revealWebview(this._current, activePane ? activePane.group : this._editorGroupService.activeGroup, false);
			return;
		}

		this._current = this._webviewWorkbenchService.openWebview(
			{
				title,
				options: {},
				contentOptions: { allowScripts: true, localResourceRoots: [] },
				extension: undefined,
			},
			VIEW_TYPE,
			title,
			Codicon.settingsGear,
			{ group: ACTIVE_GROUP, preserveFocus: false },
		);

		this._currentDisposables.clear();
		this._currentDisposables.add(this._current.webview.onMessage(e => this._onMessage(e.message)));
		// Keep the panel in sync with host-side config changes (another window,
		// the agent host itself) while it is open.
		this._currentDisposables.add(this._agentHostService.rootState.onDidChange(() => this._postState()));
		this._currentDisposables.add(this._current.onWillDispose(() => {
			this._currentDisposables.clear();
			this._current = undefined;
		}));

		this._current.webview.setHtml(this._html());
	}

	private _onMessage(message: { type?: string; values?: Record<string, unknown>; provider?: string; enabled?: boolean }): void {
		try {
			switch (message?.type) {
				case 'ready':
				case 'load':
					this._postState();
					return;
				case 'save':
					this._save(message.values ?? {});
					this._post({ type: 'saved' });
					this._postState();
					return;
				case 'openVsCodeSettings':
					// FORK: the title bar no longer carries the Manage gear, so
					// the vanilla settings UI is reachable from here instead.
					void this._commandService.executeCommand('workbench.action.openSettings');
					return;
				case 'toggleAgent':
					void this._toggleAgent(message.provider, !!message.enabled);
					return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._notificationService.error(localize('claudeSettings.saveError', "Jiso Settings: {0}", msg));
			this._post({ type: 'error', message: msg });
		}
	}

	/**
	 * Push a config patch for the panel's keys to the agent host — the same
	 * `RootConfigChanged` root-channel action the MCP-server config uses; the
	 * host validates, persists to `agent-host-config.json`, and rebroadcasts.
	 */
	private _save(raw: Record<string, unknown>): void {
		const patch: Record<string, unknown> = {};
		for (const field of this._fields) {
			const value = raw[field.key];
			if (field.type === 'boolean') {
				patch[field.key] = !!value;
				continue;
			}
			const asNumber = typeof value === 'string' ? Number(value.trim()) : Number(value);
			patch[field.key] = value !== '' && Number.isFinite(asNumber) ? Math.round(asNumber) : field.defaultValue;
		}
		this._agentHostService.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: patch });
	}

	private async _toggleAgent(provider: string | undefined, enabled: boolean): Promise<void> {
		const field = AGENT_CLI_FIELDS.find(candidate => candidate.provider === provider);
		if (!field) {
			return;
		}
		this._post({ type: 'agentLoading', provider: field.provider, loading: true });
		try {
			// The setting change is forwarded to the agent host as root config
			// (see `_updateCliAgentsEnabled` in the host services), which
			// registers/unregisters the provider live — no restart involved.
			await this._configurationService.updateValue(field.settingKey, enabled, ConfigurationTarget.USER);
			const available = await this._waitForAgentState(field.provider, enabled, 30_000);
			if (!available) {
				throw new Error(enabled
					? localize('jisoSettings.agentEnableTimeout', "{0} did not become available. Check that the CLI is installed and authenticated.", field.label)
					: localize('jisoSettings.agentDisableTimeout', "{0} did not shut down in time.", field.label));
			}
			if (enabled) {
				const pinged = await this._pingAgentWithRetry(field.provider, 45_000);
				if (!pinged) {
					await this._configurationService.updateValue(field.settingKey, false, ConfigurationTarget.USER);
					throw new Error(localize('jisoSettings.agentPingFailed', "{0} did not respond to the validation ping.", field.label));
				}
				await this._waitForAgentState(field.provider, true, 15_000, true);
			}
			this._post({ type: 'saved' });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._notificationService.error(localize('claudeSettings.saveError', "Jiso Settings: {0}", msg));
			this._post({ type: 'error', message: msg });
		} finally {
			this._post({ type: 'agentLoading', provider: field.provider, loading: false });
			this._postState();
		}
	}

	private async _pingAgentWithRetry(provider: string, timeoutMs: number): Promise<boolean> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			try {
				if (await this._agentHostService.pingAgent(provider)) {
					return true;
				}
			} catch {
				// Retry until timeout; auth/model refresh can race provider registration.
			}
			await new Promise(resolve => setTimeout(resolve, 2_000));
		}
		return false;
	}

	private _waitForAgentState(provider: string, enabled: boolean, timeoutMs: number, requireModels = false): Promise<boolean> {
		const matches = (): boolean => {
			const rootState = this._agentHostService.rootState.value;
			if (!rootState || rootState instanceof Error) {
				return false;
			}
			const agent = rootState.agents.find(candidate => candidate.provider === provider);
			return enabled ? !!agent && (!requireModels || agent.models.length > 0) : !agent;
		};
		if (matches()) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const store = new DisposableStore();
			const timeout = setTimeout(() => {
				store.dispose();
				resolve(matches());
			}, timeoutMs);
			const finish = (value: boolean) => {
				clearTimeout(timeout);
				store.dispose();
				resolve(value);
			};
			store.add(this._agentHostService.rootState.onDidChange(() => {
				if (matches()) {
					finish(true);
				}
			}));
			store.add(this._agentHostService.onAgentHostExit(() => {
				if (!enabled) {
					finish(true);
				}
			}));
		});
	}

	private _postState(): void {
		const rootState = this._agentHostService.rootState.value;
		const availableRootState = rootState && !(rootState instanceof Error) ? rootState : undefined;
		const available = !!availableRootState;
		const allValues = availableRootState?.config?.values ?? {};
		const values: Record<string, unknown> = {};
		for (const field of this._fields) {
			if (Object.prototype.hasOwnProperty.call(allValues, field.key)) {
				values[field.key] = allValues[field.key];
			}
		}
		const agents = AGENT_CLI_FIELDS.map(field => {
			const agent = availableRootState?.agents.find(candidate => candidate.provider === field.provider);
			return {
				provider: field.provider,
				enabled: this._configurationService.getValue<boolean>(field.settingKey),
				active: !!agent,
				models: agent?.models.map(model => model.name) ?? [],
			};
		});
		this._post({ type: 'state', available, values, agents });
	}

	private _post(payload: unknown): void {
		this._current?.webview.postMessage(payload);
	}

	private _html(): string {
		const nonce = generateUuid();
		const nls = {
			title: localize('claudeSettings.title', "Jiso Settings"),
			search: localize('claudeSettings.search', "Search settings"),
			openVsCodeSettings: localize('claudeSettings.openVsCodeSettings', "Open VS Code Settings"),
			savedMsg: localize('claudeSettings.saved', "Saved"),
			unavailable: localize('claudeSettings.hostUnavailable', "The agent host is not connected yet — settings will load once it is."),
			loading: localize('jisoSettings.agent.loading', "Checking..."),
			on: localize('jisoSettings.agent.on', "On"),
			off: localize('jisoSettings.agent.off', "Off"),
			models: localize('jisoSettings.agent.models', "{0} models"),
		};
		return HTML_TEMPLATE
			.replace('/*__FIELDS__*/', JSON.stringify(this._fields))
			.replace('/*__AGENTS__*/', JSON.stringify(AGENT_CLI_FIELDS))
			.replace('/*__NLS__*/', JSON.stringify(nls))
			.replace(/__NONCE__/g, nonce);
	}
}

const HTML_TEMPLATE = /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-__NONCE__'; script-src 'nonce-__NONCE__';">
<style nonce="__NONCE__">
	:root { --border: var(--vscode-widget-border, rgba(128,128,128,.18)); }
	html, body { height: 100%; margin: 0; }
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; }
	.app { display: flex; height: 100vh; }

	/* --- Sidebar --- */
	.sidebar { width: 220px; flex: 0 0 220px; border-right: 1px solid var(--border); padding: 18px 12px; box-sizing: border-box; overflow-y: auto; }
	.brand { font-weight: 600; font-size: 14px; padding: 0 8px 12px; }
	.search { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 6px 10px; font-family: inherit; margin-bottom: 8px; }
	.nav { list-style: none; margin: 6px 0 0; padding: 0; }
	.nav li { padding: 6px 10px; border-radius: 6px; cursor: pointer; opacity: .85; }
	.nav li:hover { background: var(--vscode-list-hoverBackground); }
	.nav li.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); opacity: 1; }
	.side-actions { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }
	.side-actions button { width: 100%; box-sizing: border-box; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
		border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-family: inherit; }
	.side-actions button:hover { background: var(--vscode-button-hoverBackground); }

	/* --- Main --- */
	.main { flex: 1; overflow-y: auto; padding: 28px 40px 80px; }
	.topbar { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
	.notice { font-size: 12px; opacity: .55; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.saved { color: var(--vscode-charts-green, #3fb950); font-size: 12px; opacity: 0; transition: opacity .15s; }
	.saved.show { opacity: 1; }
	.unavailable { color: var(--vscode-errorForeground); }

	.group { scroll-margin-top: 20px; }
	.group > h2 { font-size: 16px; font-weight: 600; margin: 28px 0 6px; }
	.group:first-of-type > h2 { margin-top: 6px; }

	.row { display: flex; align-items: center; gap: 24px; padding: 16px 4px; border-top: 1px solid var(--border); }
	.row-text { flex: 1; min-width: 0; }
	.row-title { font-size: 13px; }
	.row-desc { font-size: 12px; opacity: .58; margin-top: 3px; }
	.row-status { font-size: 11px; opacity: .62; margin-top: 5px; }
	.row-control { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
	.spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--vscode-button-background); border-radius: 50%; animation: spin .8s linear infinite; display: none; }
	.row.loading .spinner { display: block; }
	.row.loading .switch { pointer-events: none; opacity: .6; }
	@keyframes spin { to { transform: rotate(360deg); } }

	input[type=text] {
		background: var(--vscode-settings-dropdownBackground, var(--vscode-input-background)); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-settings-dropdownBorder, var(--vscode-input-border, rgba(128,128,128,.3)));
		border-radius: 6px; padding: 7px 10px; font-family: inherit; font-size: 13px; min-width: 200px;
		outline: none; transition: border-color .12s, box-shadow .12s, background .12s;
	}
	input[type=text]:hover { border-color: var(--vscode-inputOption-hoverBackground, rgba(128,128,128,.55)); }
	input[type=text]:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
	input[type=text]::placeholder { color: var(--vscode-input-placeholderForeground); opacity: .7; }

	/* toggle switch */
	.switch { position: relative; width: 38px; height: 22px; }
	.switch input { opacity: 0; width: 0; height: 0; }
	.slider { position: absolute; inset: 0; background: var(--vscode-input-background); border: 1px solid var(--border);
		border-radius: 22px; transition: .15s; cursor: pointer; }
	.slider:before { content: ''; position: absolute; height: 16px; width: 16px; left: 2px; top: 2px;
		background: var(--vscode-foreground); opacity: .7; border-radius: 50%; transition: .15s; }
	.switch input:checked + .slider { background: var(--vscode-button-background); border-color: transparent; }
	.switch input:checked + .slider:before { transform: translateX(16px); background: var(--vscode-button-foreground); opacity: 1; }

	#form.disabled { opacity: .4; pointer-events: none; }
	.row.hidden { display: none; }
	.group.hidden { display: none; }
</style>
</head>
<body>
<div class="app">
	<aside class="sidebar">
		<div class="brand" id="brand"></div>
		<input class="search" id="search" type="text">
		<ul class="nav" id="nav"></ul>
		<div class="side-actions"><button id="openVsCodeSettings"></button></div>
	</aside>
	<main class="main">
		<div class="topbar">
			<div class="notice" id="notice"></div>
			<span class="saved" id="savedMsg"></span>
		</div>
		<div id="form"></div>
	</main>
</div>

<script nonce="__NONCE__">
	const vscode = acquireVsCodeApi();
	const FIELDS = /*__FIELDS__*/;
	const AGENTS = /*__AGENTS__*/;
	const NLS = /*__NLS__*/;
	const $ = id => document.getElementById(id);
	const groups = [...new Set([...AGENTS.map(f => f.group), ...FIELDS.map(f => f.group)])];
	let saveTimer = null;
	const loadingAgents = new Set();

	$('brand').textContent = NLS.title;
	$('search').placeholder = NLS.search;
	$('openVsCodeSettings').textContent = NLS.openVsCodeSettings;
	$('savedMsg').textContent = NLS.savedMsg;

	function slug(g) { return 'g-' + g.replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }

	function buildNav() {
		const nav = $('nav');
		nav.innerHTML = '';
		groups.forEach((g, i) => {
			const li = document.createElement('li');
			li.textContent = g;
			if (i === 0) { li.className = 'active'; }
			li.addEventListener('click', () => {
				document.querySelectorAll('.nav li').forEach(n => n.classList.remove('active'));
				li.classList.add('active');
				const sec = document.getElementById(slug(g));
				if (sec) { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
			});
			nav.appendChild(li);
		});
	}

	function control(f) {
		if (f.type === 'boolean') {
			const label = document.createElement('label'); label.className = 'switch';
			const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'f_' + f.key;
			const sl = document.createElement('span'); sl.className = 'slider';
			cb.addEventListener('change', scheduleSave);
			label.appendChild(cb); label.appendChild(sl);
			return label;
		}
		const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'f_' + f.key;
		if (f.defaultValue !== undefined) { inp.placeholder = String(f.defaultValue); }
		inp.addEventListener('change', scheduleSave);
		return inp;
	}

	function agentControl(agent) {
		const wrap = document.createElement('div');
		wrap.className = 'row-control';
		const spinner = document.createElement('span');
		spinner.className = 'spinner';
		const label = document.createElement('label');
		label.className = 'switch';
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.id = 'agent_' + agent.provider;
		cb.addEventListener('change', () => {
			setAgentLoading(agent.provider, true);
			vscode.postMessage({ type: 'toggleAgent', provider: agent.provider, enabled: cb.checked });
		});
		const sl = document.createElement('span');
		sl.className = 'slider';
		label.appendChild(cb);
		label.appendChild(sl);
		wrap.appendChild(spinner);
		wrap.appendChild(label);
		return wrap;
	}

	function buildForm() {
		const form = $('form');
		form.innerHTML = '';
		for (const g of groups) {
			const sec = document.createElement('div'); sec.className = 'group'; sec.id = slug(g);
			const h = document.createElement('h2'); h.textContent = g; sec.appendChild(h);
			for (const agent of AGENTS.filter(x => x.group === g)) {
				const row = document.createElement('div'); row.className = 'row agent-row'; row.dataset.provider = agent.provider; row.dataset.key = (agent.label + ' ' + agent.description).toLowerCase();
				const text = document.createElement('div'); text.className = 'row-text';
				const t = document.createElement('div'); t.className = 'row-title'; t.textContent = agent.label; text.appendChild(t);
				const d = document.createElement('div'); d.className = 'row-desc'; d.textContent = agent.description; text.appendChild(d);
				const s = document.createElement('div'); s.className = 'row-status'; s.id = 'agent_status_' + agent.provider; text.appendChild(s);
				row.appendChild(text); row.appendChild(agentControl(agent));
				sec.appendChild(row);
			}
			for (const f of FIELDS.filter(x => x.group === g)) {
				const row = document.createElement('div'); row.className = 'row'; row.dataset.key = (f.label + ' ' + (f.description || '')).toLowerCase();
				const text = document.createElement('div'); text.className = 'row-text';
				const t = document.createElement('div'); t.className = 'row-title'; t.textContent = f.label; text.appendChild(t);
				if (f.description) { const d = document.createElement('div'); d.className = 'row-desc'; d.textContent = f.description; text.appendChild(d); }
				const ctrl = document.createElement('div'); ctrl.className = 'row-control'; ctrl.appendChild(control(f));
				row.appendChild(text); row.appendChild(ctrl);
				sec.appendChild(row);
			}
			form.appendChild(sec);
		}
	}

	function setAgentLoading(provider, loading) {
		if (loading) { loadingAgents.add(provider); }
		else { loadingAgents.delete(provider); }
		const row = document.querySelector('.agent-row[data-provider="' + provider + '"]');
		if (row) { row.classList.toggle('loading', loading); }
		const status = $('agent_status_' + provider);
		if (status && loading) { status.textContent = NLS.loading; }
		const cb = $('agent_' + provider);
		if (cb) { cb.disabled = loading; }
	}

	function applyValues(state) {
		const form = $('form');
		if (!state.available) {
			$('notice').innerHTML = '<span class="unavailable"></span>';
			$('notice').firstChild.textContent = NLS.unavailable;
			form.classList.add('disabled');
			return;
		}
		$('notice').textContent = '';
		form.classList.remove('disabled');
		const values = state.values || {};
		const agentState = new Map((state.agents || []).map(agent => [agent.provider, agent]));
		for (const agent of AGENTS) {
			const current = agentState.get(agent.provider);
			const loading = loadingAgents.has(agent.provider);
			const cb = $('agent_' + agent.provider);
			if (cb && !loading) {
				cb.checked = !!current?.active;
				cb.disabled = false;
			}
			const status = $('agent_status_' + agent.provider);
			if (status && !loading) {
				const modelCount = current?.models?.length || 0;
				status.textContent = current?.active
					? (modelCount ? NLS.models.replace('{0}', String(modelCount)) + ': ' + current.models.join(', ') : NLS.on)
					: NLS.off;
			}
			const row = document.querySelector('.agent-row[data-provider="' + agent.provider + '"]');
			if (row && !loading) { row.classList.remove('loading'); }
		}
		for (const f of FIELDS) {
			const el = $('f_' + f.key);
			if (!el) { continue; }
			const has = Object.prototype.hasOwnProperty.call(values, f.key);
			if (f.type === 'boolean') { el.checked = has ? !!values[f.key] : !!f.defaultValue; }
			else { el.value = has ? String(values[f.key]) : ''; }
		}
	}

	function collect() {
		const out = {};
		for (const f of FIELDS) {
			const el = $('f_' + f.key);
			if (!el) { continue; }
			out[f.key] = f.type === 'boolean' ? el.checked : el.value;
		}
		return out;
	}

	// Auto-apply, like Cursor. Debounced so rapid edits coalesce into one write.
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => vscode.postMessage({ type: 'save', values: collect() }), 250);
	}

	function filter() {
		const q = $('search').value.trim().toLowerCase();
		for (const sec of document.querySelectorAll('.group')) {
			let anyVisible = false;
			for (const row of sec.querySelectorAll('.row')) {
				const match = !q || row.dataset.key.includes(q);
				row.classList.toggle('hidden', !match);
				anyVisible = anyVisible || match;
			}
			sec.classList.toggle('hidden', !anyVisible);
		}
	}

	$('search').addEventListener('input', filter);
	$('openVsCodeSettings').addEventListener('click', () => vscode.postMessage({ type: 'openVsCodeSettings' }));

	window.addEventListener('message', e => {
		const m = e.data;
		if (m.type === 'state') { applyValues(m); }
		else if (m.type === 'agentLoading') { setAgentLoading(m.provider, !!m.loading); }
		else if (m.type === 'error') {
			for (const provider of [...loadingAgents]) { setAgentLoading(provider, false); }
		}
		else if (m.type === 'saved') {
			const el = $('savedMsg'); el.classList.add('show');
			setTimeout(() => el.classList.remove('show'), 1400);
		}
	});

	buildNav();
	buildForm();
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
