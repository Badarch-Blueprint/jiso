/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../../nls.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { createDecorator, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { ISecretStorageService } from '../../../../../../platform/secrets/common/secrets.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';

/** Pre-Claude-login-era secret ('claude setup-token' OAuth token). Purged on startup, never read. */
const LEGACY_SECRET_KEY = 'claude.oauthToken';
const SIGN_IN_ACTION_ID = 'workbench.action.claude.signIn';
const SIGN_OUT_ACTION_ID = 'workbench.action.claude.signOut';

export const IClaudeAuthService = createDecorator<IClaudeAuthService>('claudeAuthService');

export interface IClaudeAuthService {
	readonly _serviceBrand: undefined;
	signIn(): Promise<void>;
	signOut(): Promise<void>;
}

/**
 * FORK: Claude auth for the native `claude` provider. The IDE holds NO Anthropic
 * credential: the user signs in with their own Claude Code (`/login` inside the
 * `claude` CLI), which stores its credential where the CLI keeps it (Keychain /
 * `~/.claude`). The headless SDK subprocess inherits the user's environment
 * (see `buildSubprocessEnv`), so it authenticates exactly like the user's own
 * terminal `claude` — no token is minted, stored, or injected by the IDE.
 * The sign-in/out actions here only open the official CLI flow in a terminal.
 */
export class ClaudeAuthService extends Disposable implements IClaudeAuthService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this._purgeLegacyToken();
	}

	/** Delete the setup-token credential earlier builds stored; the IDE no longer holds one. */
	private async _purgeLegacyToken(): Promise<void> {
		try {
			if (await this.secretStorageService.get(LEGACY_SECRET_KEY) !== undefined) {
				await this.secretStorageService.delete(LEGACY_SECRET_KEY);
				this.logService.info('[ClaudeAuth] Removed legacy stored Claude token; auth now follows the `claude` CLI login.');
			}
		} catch (err) {
			this.logService.warn(`[ClaudeAuth] Failed to purge legacy Claude token: ${err}`);
		}
	}

	/** Open the official Claude Code login in a terminal; the CLI owns the credential. */
	private async _openCliFlow(slashCommand: string): Promise<void> {
		await this.commandService.executeCommand('workbench.action.terminal.new');
		await this.terminalService.activeInstance?.sendText(`claude ${slashCommand}`, true);
	}

	async signIn(): Promise<void> {
		await this._openCliFlow('/login');
		this.notificationService.info(localize('claudeAuth.signIn', "Complete the sign-in in the terminal that just opened. Claude sessions in this window use that same account automatically."));
	}

	async signOut(): Promise<void> {
		await this._openCliFlow('/logout');
		this.notificationService.info(localize('claudeAuth.signOut', "Complete the sign-out in the terminal that just opened."));
	}
}

// Eager so the legacy stored token is purged at startup.
registerSingleton(IClaudeAuthService, ClaudeAuthService, InstantiationType.Eager);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SIGN_IN_ACTION_ID, title: localize2('claudeAuth.signInAction', "Sign in to Claude"), f1: true, category: localize2('claudeAuth.category', "Claude") });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IClaudeAuthService).signIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SIGN_OUT_ACTION_ID, title: localize2('claudeAuth.signOutAction', "Sign out of Claude"), f1: true, category: localize2('claudeAuth.category', "Claude") });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IClaudeAuthService).signOut();
	}
});
