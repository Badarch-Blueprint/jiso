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
	 * data the `claude` CLI `/usage` view shows) in a dialog. Fetched on demand;
	 * degrades gracefully when usage is unavailable (e.g. API-key sessions).
	 */
	private async showUsage(): Promise<void> {
		const title = localize('chatSessionTabs.usage.title', "Claude Usage");
		let usage: IClaudePlanUsage | undefined;
		try {
			usage = await this.agentHostService.getPlanUsage();
		} catch {
			usage = undefined;
		}

		if (!usage) {
			await this.dialogService.info(title, localize('chatSessionTabs.usage.unavailable', "Usage isn't available for this session."));
			return;
		}

		// Build the dialog as blank-line-separated sections so it adapts to what the plan exposes:
		// Pro/Max return rate-limit windows; team plans return `rate_limits: null` but still report
		// daily/weekly activity counts.
		const sections: string[] = [];
		if (usage.subscriptionType) {
			sections.push(localize('chatSessionTabs.usage.plan', "Plan: {0}", usage.subscriptionType));
		}

		const windowLines: string[] = [];
		this.appendUsageWindow(windowLines, localize('chatSessionTabs.usage.fiveHour', "5-hour limit"), usage.fiveHour);
		this.appendUsageWindow(windowLines, localize('chatSessionTabs.usage.weekly', "Weekly limit"), usage.sevenDay);
		this.appendUsageWindow(windowLines, localize('chatSessionTabs.usage.weeklyOpus', "Weekly (Opus)"), usage.sevenDayOpus);
		this.appendUsageWindow(windowLines, localize('chatSessionTabs.usage.weeklySonnet', "Weekly (Sonnet)"), usage.sevenDaySonnet);
		if (windowLines.length > 0) {
			sections.push(windowLines.join('\n'));
		}

		const activityLines: string[] = [];
		if (typeof usage.dayRequests === 'number') {
			activityLines.push(localize('chatSessionTabs.usage.today', "Today: {0} requests · {1} sessions", usage.dayRequests.toLocaleString(), (usage.daySessions ?? 0).toLocaleString()));
		}
		if (typeof usage.weekRequests === 'number') {
			activityLines.push(localize('chatSessionTabs.usage.week', "This week: {0} requests · {1} sessions", usage.weekRequests.toLocaleString(), (usage.weekSessions ?? 0).toLocaleString()));
		}
		if (activityLines.length > 0) {
			// Header clarifies these are local-machine transcript counts, not the (absent) plan windows.
			sections.push(localize('chatSessionTabs.usage.activity', "Activity (this machine)") + '\n' + activityLines.join('\n'));
		}

		if (typeof usage.sessionCostUsd === 'number') {
			sections.push(localize('chatSessionTabs.usage.cost', "Session cost: ${0}", usage.sessionCostUsd.toFixed(2)));
		}

		await this.dialogService.info(title, sections.length > 0
			? sections.join('\n\n')
			: localize('chatSessionTabs.usage.unavailable', "Usage isn't available for this session."));
	}

	// allow-any-unicode-next-line
	/** Append a "label: ▓▓▓░░░░░░░ 42% · resets <time>" line for a rate-limit window. */
	private appendUsageWindow(lines: string[], label: string, window: IClaudePlanUsageWindow | undefined): void {
		if (!window) {
			return;
		}
		const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
		const filled = Math.round(pct / 10);
		// allow-any-unicode-next-line
		const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
		const reset = window.resetsAt
			? localize('chatSessionTabs.usage.resets', " · resets {0}", new Date(window.resetsAt).toLocaleString())
			: '';
		lines.push(localize('chatSessionTabs.usage.window', "{0}: {1} {2}%{3}", label, bar, pct, reset));
	}
}
