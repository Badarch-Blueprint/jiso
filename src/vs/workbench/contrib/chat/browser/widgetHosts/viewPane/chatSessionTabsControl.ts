/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import Severity from '../../../../../../base/common/severity.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import type { IClaudePlanUsage, IClaudePlanUsageWindow } from '../../../../../../platform/agentHost/common/state/protocol/commands.js';
import { ACTION_ID_NEW_CHAT } from '../../actions/chatActions.js';
import { IAgentSession } from '../../agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { isUntitledChatSession } from '../../../common/model/chatUri.js';

const $ = dom.$;

/**
 * Callbacks the chat view provides so the tab bar can reflect / drive the
 * currently shown session.
 */
export interface IChatSessionTabsDelegate {
	/** Resource of the session currently shown in the chat view (for active-tab highlight). */
	getActiveSessionResource(): URI | undefined;
	/** Switch the chat view to the given session. */
	openSession(resource: URI): void;
}

/**
 * FORK: a Cursor-style tab strip for the top of the chat panel. Tracks the set of "open"
 * sessions as tabs (the active session is always open). Clicking a tab switches to it;
 * the tab's close (X) button closes the tab (it does NOT delete the session — it stays reachable via the
 * "Recent Chats" button). A "New Chat" (+) button starts a fresh chat.
 */
export class ChatSessionTabsControl extends Disposable {

	private readonly tabsListEl: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());

	/** Ordered list of session resources currently shown as tabs. */
	private readonly openTabs: URI[] = [];

	constructor(
		container: HTMLElement,
		private readonly delegate: IChatSessionTabsDelegate,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();

		container.classList.add('chat-session-tabs');
		this.tabsListEl = dom.append(container, $('.chat-session-tabs-list'));

		const actions = dom.append(container, $('.chat-session-tabs-actions'));
		this.createActionButton(actions, Codicon.add, localize('chatSessionTabs.newChat', "New Chat"), () => {
			this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
		});
		this.createActionButton(actions, Codicon.history, localize('chatSessionTabs.recent', "Recent Chats"), () => {
			void this.showRecentPicker();
		});
		// FORK: surface the local Claude subscription/plan usage (the `claude` CLI `/usage` view).
		this.createActionButton(actions, Codicon.graph, localize('chatSessionTabs.usage', "Usage"), () => {
			void this.showUsage();
		});

		this._register(this.agentSessionsService.model.onDidChangeSessions(() => this.refresh()));
		this.refresh();
	}

	/** Sync open tabs with the active session + existing sessions, then re-render. */
	refresh(): void {
		const active = this.delegate.getActiveSessionResource();
		if (active && !this.openTabs.some(r => isEqual(r, active))) {
			this.openTabs.push(active);
		}
		// Drop tabs whose underlying session no longer exists.
		for (let i = this.openTabs.length - 1; i >= 0; i--) {
			if (!this.agentSessionsService.model.getSession(this.openTabs[i]) && (!active || !isEqual(this.openTabs[i], active))) {
				this.openTabs.splice(i, 1);
			}
		}
		this.render();
	}

	private render(): void {
		this.renderStore.clear();
		dom.clearNode(this.tabsListEl);

		const active = this.delegate.getActiveSessionResource();
		for (const resource of this.openTabs) {
			const session = this.agentSessionsService.model.getSession(resource);
			const tab = dom.append(this.tabsListEl, $('.chat-session-tab'));
			tab.classList.toggle('active', !!active && isEqual(active, resource));

			const label = dom.append(tab, $('span.chat-session-tab-label'));
			label.textContent = this.sessionLabel(session);
			tab.title = this.sessionLabel(session);
			this.renderStore.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => this.delegate.openSession(resource)));

			// Hide close affordance for pristine untitled sessions.
			// Closing those tabs is a no-op from a user perspective because they have no history yet.
			if (!isUntitledChatSession(resource)) {
				// The close (X) icon closes the tab (not the session).
				const close = dom.append(tab, $('a.chat-session-tab-close.codicon.codicon-close'));
				close.setAttribute('role', 'button');
				close.setAttribute('aria-label', localize('chatSessionTabs.close', "Close Tab"));
				close.title = localize('chatSessionTabs.close', "Close Tab");
				this.renderStore.add(dom.addDisposableListener(close, dom.EventType.CLICK, e => {
					dom.EventHelper.stop(e, true);
					this.closeTab(resource);
				}));
			}
		}
	}

	private closeTab(resource: URI): void {
		const idx = this.openTabs.findIndex(r => isEqual(r, resource));
		if (idx === -1) {
			return;
		}
		const active = this.delegate.getActiveSessionResource();
		const wasActive = !!active && isEqual(active, resource);
		this.openTabs.splice(idx, 1);

		if (wasActive) {
			if (this.openTabs.length > 0) {
				// Activate an adjacent tab (the openSession → showModel path re-renders).
				this.delegate.openSession(this.openTabs[Math.min(idx, this.openTabs.length - 1)]);
			} else {
				// Closed the last tab: start a fresh chat.
				this.commandService.executeCommand(ACTION_ID_NEW_CHAT);
			}
			return;
		}
		this.render();
	}

	private createActionButton(parent: HTMLElement, icon: ThemeIcon, title: string, run: () => void): void {
		const el = dom.append(parent, $('a.chat-session-tabs-action'));
		el.classList.add(...ThemeIcon.asClassName(icon).split(' '));
		el.setAttribute('role', 'button');
		el.setAttribute('aria-label', title);
		el.title = title;
		el.tabIndex = 0;
		this._register(dom.addDisposableListener(el, dom.EventType.CLICK, () => run()));
		this._register(dom.addDisposableListener(el, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				run();
			}
		}));
	}

	private sessionLabel(session: IAgentSession | undefined): string {
		// Use the same default as the session list controller's untitled label so a brand-new
		// session does not flash "Untitled" before resolving.
		return session?.label || localize('chatSessionTabs.newChat', "New Chat");
	}

	private async showRecentPicker(): Promise<void> {
		const items: Array<IQuickPickItem & { resource: URI }> = this.agentSessionsService.model.sessions.map(session => ({
			label: this.sessionLabel(session),
			iconClass: ThemeIcon.asClassName(ThemeIcon.isThemeIcon(session.icon) ? session.icon : Codicon.chatSparkle),
			resource: session.resource,
		}));
		if (items.length === 0) {
			return;
		}
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('chatSessionTabs.pickRecent', "Open a recent chat"),
		});
		if (picked) {
			this.delegate.openSession(picked.resource);
		}
	}

	/**
	 * FORK: fetch and display the local Claude subscription/plan usage (the same
	 * data the `claude` CLI `/usage` view shows) in a WORKBENCH dialog (the
	 * `custom` option forces the HTML dialog handler — never the OS message
	 * box). Renders the full picture: session totals + per-model breakdown,
	 * the 5-hour and weekly rate-limit windows with reset times, behavioral
	 * insights and per-skill attribution. Degrades gracefully when usage is
	 * unavailable (e.g. API-key sessions).
	 */
	private async showUsage(): Promise<void> {
		const title = localize('chatSessionTabs.usage.title', "Claude Usage");
		let usage: IClaudePlanUsage | undefined;
		try {
			usage = await this.agentHostService.getPlanUsage();
		} catch {
			usage = undefined;
		}

		const markdown = new MarkdownString(undefined, { supportHtml: true });
		if (!usage) {
			markdown.appendText(localize('chatSessionTabs.usage.unavailable', "Usage isn't available for this session."));
		} else {
			markdown.appendMarkdown(this.renderUsageHtml(usage));
		}
		await this.dialogService.prompt({
			type: Severity.Info,
			message: title,
			...(usage?.subscriptionType ? { detail: localize('chatSessionTabs.usage.plan', "Plan: {0}", usage.subscriptionType) } : {}),
			cancelButton: localize('chatSessionTabs.usage.close', "Close"),
			custom: {
				markdownDetails: [{ markdown, classes: ['chat-usage-dialog-content'] }],
			},
		});
	}

	/**
	 * Render the `/usage` report as structured HTML (headings, key/value
	 * tables, colored progress bars) — the markdown sanitizer keeps `div`,
	 * `table`, `h4` etc., and allows `background-color: var(--vscode-*)` +
	 * `border-radius` inline styles on `span`, which is what the bars use.
	 * Sections adapt to what the plan exposes: Pro/Max return rate-limit
	 * windows; team plans return `rate_limits: null` but still report session
	 * totals, the local window reconstruction, and activity counts.
	 */
	private renderUsageHtml(usage: IClaudePlanUsage): string {
		const parts: string[] = [];

		// --- Session totals (this agent-host lifetime) ---
		const sessionRows: string[] = [];
		if (typeof usage.sessionCostUsd === 'number') {
			sessionRows.push(kvRow(localize('chatSessionTabs.usage.cost', "Total cost"), `$${usage.sessionCostUsd.toFixed(2)}`));
		}
		if (typeof usage.sessionApiDurationMs === 'number') {
			sessionRows.push(kvRow(localize('chatSessionTabs.usage.apiDuration', "Duration (API)"), formatDuration(usage.sessionApiDurationMs)));
		}
		if (typeof usage.sessionWallDurationMs === 'number') {
			sessionRows.push(kvRow(localize('chatSessionTabs.usage.wallDuration', "Duration (wall)"), formatDuration(usage.sessionWallDurationMs)));
		}
		if (typeof usage.sessionLinesAdded === 'number') {
			sessionRows.push(kvRow(localize('chatSessionTabs.usage.codeChanges', "Code changes"), localize('chatSessionTabs.usage.codeChangesValue', "+{0} / -{1} lines", usage.sessionLinesAdded.toLocaleString(), (usage.sessionLinesRemoved ?? 0).toLocaleString())));
		}
		for (const m of usage.modelUsage ?? []) {
			sessionRows.push(kvRow(escapeHtml(m.model), `${tokenBreakdown(m)} <strong>($${m.costUsd.toFixed(2)})</strong>`));
		}
		if (sessionRows.length > 0) {
			parts.push(section(localize('chatSessionTabs.usage.session', "Session"), `<table>${sessionRows.join('')}</table>`));
		}

		// --- Rate-limit windows (official, when the plan exposes them) ---
		parts.push(this.renderOfficialWindow(localize('chatSessionTabs.usage.fiveHour', "Current session (5-hour window)"), usage.fiveHour));
		parts.push(this.renderOfficialWindow(localize('chatSessionTabs.usage.weekly', "Current week (all models)"), usage.sevenDay));
		parts.push(this.renderOfficialWindow(localize('chatSessionTabs.usage.weeklyOpus', "Current week (Opus)"), usage.sevenDayOpus));
		parts.push(this.renderOfficialWindow(localize('chatSessionTabs.usage.weeklySonnet', "Current week (Sonnet)"), usage.sevenDaySonnet));

		// --- Local 5-hour window reconstruction (IDE sessions only; fills the
		// gap when the plan reports no windows, e.g. team plans) ---
		if (usage.localWindow) {
			const w = usage.localWindow;
			const startMs = Date.parse(w.windowStart);
			const endMs = Date.parse(w.windowEnd);
			const elapsedPct = Math.max(0, Math.min(100, Math.round((Date.now() - startMs) / (endMs - startMs) * 100)));
			const body: string[] = [];
			body.push(bar(elapsedPct, localize('chatSessionTabs.usage.elapsed', "{0}% elapsed", elapsedPct)));
			body.push(`<p>${localize('chatSessionTabs.usage.localWindowTimes', "Started {0} · resets {1}", formatClock(startMs), `<strong>${formatClock(endMs)}</strong>`)}</p>`);
			const modelRows = w.models.map(m => kvRow(escapeHtml(m.model), `${m.requests} req · ${tokenBreakdown(m)}`));
			body.push(`<table>${kvRow(localize('chatSessionTabs.usage.localWindowRequests', "Requests"), w.requests.toLocaleString())}${modelRows.join('')}</table>`);
			// `class` is sanitizer-stripped outside codicon spans — use <em> and style it via the container CSS.
			body.push(`<p><em>${localize('chatSessionTabs.usage.localWindowNote', "Raw totals from this IDE's sessions on this machine. Anthropic weights consumption toward the limit and does not publish the formula.")}</em></p>`);
			parts.push(section(localize('chatSessionTabs.usage.localWindow', "Current 5-hour window (IDE sessions · local estimate)"), body.join('')));
		}

		// --- What's contributing (last 24h, local transcripts) ---
		if (usage.dayBehaviors && usage.dayBehaviors.length > 0) {
			const rows = usage.dayBehaviors.map(b => kvRow(`${Math.round(b.pct)}%`, escapeHtml(behaviorLabel(b.name))));
			parts.push(section(localize('chatSessionTabs.usage.behaviorsHeader', "What's contributing to your limits usage? (last 24h, this machine)"), `<table>${rows.join('')}</table>`));
		}
		if (usage.daySkills && usage.daySkills.length > 0) {
			const rows = usage.daySkills.map(s => kvRow(`${Math.round(s.pct)}%`, escapeHtml(s.name)));
			parts.push(section(localize('chatSessionTabs.usage.skillsHeader', "Skills (share of last 24h usage)"), `<table>${rows.join('')}</table>`));
		}
		if (usage.dayAgents && usage.dayAgents.length > 0) {
			const rows = usage.dayAgents.map(a => kvRow(`${Math.round(a.pct)}%`, escapeHtml(a.name)));
			parts.push(section(localize('chatSessionTabs.usage.agentsHeader', "Subagents (share of last 24h usage)"), `<table>${rows.join('')}</table>`));
		}

		// --- Local activity counts ---
		const activityRows: string[] = [];
		if (typeof usage.dayRequests === 'number') {
			activityRows.push(kvRow(localize('chatSessionTabs.usage.today', "Today"), localize('chatSessionTabs.usage.requestsSessions', "{0} requests · {1} sessions", usage.dayRequests.toLocaleString(), (usage.daySessions ?? 0).toLocaleString())));
		}
		if (typeof usage.weekRequests === 'number') {
			activityRows.push(kvRow(localize('chatSessionTabs.usage.week', "This week"), localize('chatSessionTabs.usage.requestsSessions', "{0} requests · {1} sessions", usage.weekRequests.toLocaleString(), (usage.weekSessions ?? 0).toLocaleString())));
		}
		if (activityRows.length > 0) {
			parts.push(section(localize('chatSessionTabs.usage.activity', "Activity (this machine)"), `<table>${activityRows.join('')}</table>`));
		}

		const html = parts.filter(p => p.length > 0).join('');
		return html.length > 0 ? html : escapeHtml(localize('chatSessionTabs.usage.unavailable', "Usage isn't available for this session."));
	}

	/** One official rate-limit window: heading, utilization bar, reset time. Empty string when absent. */
	private renderOfficialWindow(label: string, window: IClaudePlanUsageWindow | undefined): string {
		if (!window) {
			return '';
		}
		const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
		const body: string[] = [bar(pct, localize('chatSessionTabs.usage.windowUsed', "{0}% used", pct))];
		if (window.resetsAt) {
			body.push(`<p>${localize('chatSessionTabs.usage.resets', "Resets {0}", `<strong>${escapeHtml(new Date(window.resetsAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</strong>`)}</p>`);
		}
		return section(label, body.join(''));
	}
}

/** Minimal HTML escaping for text interpolated into the usage report. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A `<h4>` section with body — the dialog CSS provides spacing/typography. */
function section(heading: string, body: string): string {
	return `<div><h4>${escapeHtml(heading)}</h4>${body}</div>`;
}

/** One key/value table row. `value` may contain markup; `key` must be pre-escaped. */
function kvRow(key: string, value: string): string {
	return `<tr><td>${key}</td><td>${value}</td></tr>`;
}

/**
 * A colored progress bar built from sanitizer-safe primitives: the markdown
 * sanitizer only keeps `background-color: var(--vscode-*)` / `border-radius`
 * styles on `span`, so the bar is two spans of no-break spaces (filled +
 * track) — width is proportional to the space count (quantized to 40 cells).
 */
function bar(pct: number, label: string): string {
	const cells = 40;
	const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * cells);
	const fill = '\u00a0'.repeat(Math.max(filled, 0));
	const track = '\u00a0'.repeat(Math.max(cells - filled, 0));
	const fillSpan = filled > 0 ? `<span style="background-color:var(--vscode-progressBar-background);border-radius:2px;">${fill}</span>` : '';
	const trackSpan = filled < cells ? `<span style="background-color:var(--vscode-input-background);border-radius:2px;">${track}</span>` : '';
	return `<p>${fillSpan}${trackSpan}\u00a0\u00a0<strong>${escapeHtml(label)}</strong></p>`;
}

/** "1.7k input, 44 output, 43.2m cache read, 577.8k cache write" for a model-usage row. */
function tokenBreakdown(m: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): string {
	return `${formatTokens(m.inputTokens)} input, ${formatTokens(m.outputTokens)} output, ${formatTokens(m.cacheReadTokens)} cache read, ${formatTokens(m.cacheCreationTokens)} cache write`;
}

/** Short clock time for window boundaries, e.g. "3:10 PM". */
function formatClock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Format a millisecond duration as "1h 16m 45s" (largest two/three units that apply). */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Compact token count: 1234 → "1.2k", 43_200_000 → "43.2m". */
function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}m`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(1)}k`;
	}
	return String(n);
}

/** Human label for a `/usage` behavioral-characteristic key. */
function behaviorLabel(key: string): string {
	switch (key) {
		case 'cache_miss': return localize('chatSessionTabs.usage.behavior.cacheMiss', "cache misses (idle gaps re-writing the prompt cache)");
		case 'long_context': return localize('chatSessionTabs.usage.behavior.longContext', "long context (requests above 150k tokens)");
		case 'subagent_heavy': return localize('chatSessionTabs.usage.behavior.subagents', "subagent-heavy sessions");
		case 'high_parallel': return localize('chatSessionTabs.usage.behavior.parallel', "highly parallel sessions");
		case 'cron': return localize('chatSessionTabs.usage.behavior.cron', "scheduled / background runs");
		default: return key;
	}
}
