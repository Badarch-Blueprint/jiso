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
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { ANTHROPIC_NATIVE_PROTECTED_RESOURCE, IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';

const SECRET_KEY = 'claude.oauthToken';
const SIGN_IN_ACTION_ID = 'workbench.action.claude.signIn';
const SIGN_OUT_ACTION_ID = 'workbench.action.claude.signOut';

/** True when a Claude credential is stored and has been pushed to the agent host. */
export const ClaudeSignedInContext = new RawContextKey<boolean>('claudeSignedIn', false);

export const IClaudeAuthService = createDecorator<IClaudeAuthService>('claudeAuthService');

export interface IClaudeAuthService {
	readonly _serviceBrand: undefined;
	signIn(): Promise<void>;
	signOut(): Promise<void>;
}

/**
 * FORK: in-IDE "Sign in to Claude" for the native `claude` provider. Obtains the user's own
 * Claude subscription token via `claude setup-token`, stores it in VS Code SecretStorage, and
 * delivers it to the agent host (which exposes it to the native SDK as CLAUDE_CODE_OAUTH_TOKEN).
 * Restores the stored token on startup so the user stays signed in. Does NOT read the Keychain.
 */
export class ClaudeAuthService extends Disposable implements IClaudeAuthService {

	declare readonly _serviceBrand: undefined;

	private readonly _signedIn: IContextKey<boolean>;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._signedIn = ClaudeSignedInContext.bindTo(contextKeyService);
		void this._restore();
	}

	/** On startup, push a previously stored token so the user stays signed in across relaunches. */
	private async _restore(): Promise<void> {
		try {
			const token = await this.secretStorageService.get(SECRET_KEY);
			if (token) {
				await this._deliver(token);
			}
		} catch (err) {
			this.logService.warn(`[ClaudeAuth] Failed to restore Claude token: ${err}`);
		}
	}

	/** Push the token to the agent host and reflect the signed-in state. */
	private async _deliver(token: string): Promise<void> {
		try {
			const result = await this.agentHostService.authenticate({ resource: ANTHROPIC_NATIVE_PROTECTED_RESOURCE.resource, token });
			this._signedIn.set(!!token && result.authenticated);
		} catch (err) {
			this.logService.warn(`[ClaudeAuth] Failed to deliver Claude token to agent host: ${err}`);
		}
	}

	async signIn(): Promise<void> {
		// Run the official login in a terminal so the user completes the browser flow and sees the
		// printed token, then paste it back. We never read the Keychain — the token lives in our
		// own SecretStorage from here on.
		await this.commandService.executeCommand('workbench.action.terminal.new');
		await this.terminalService.activeInstance?.sendText('claude setup-token', true);

		const token = await this.quickInputService.input({
			title: localize('claudeAuth.signInTitle', "Sign in to Claude"),
			prompt: localize('claudeAuth.signInPrompt', "Run `claude setup-token` in the terminal, complete the browser sign-in, then paste the token here."),
			placeHolder: 'sk-ant-…',
			password: true,
			ignoreFocusLost: true,
			validateInput: async value => value.trim().length === 0
				? localize('claudeAuth.signInEmpty', "Paste the token printed by `claude setup-token`.")
				: undefined,
		});

		const trimmed = token?.trim();
		if (!trimmed) {
			return;
		}
		await this.secretStorageService.set(SECRET_KEY, trimmed);
		await this._deliver(trimmed);
		this.notificationService.info(localize('claudeAuth.signedIn', "Signed in to Claude."));
	}

	async signOut(): Promise<void> {
		await this.secretStorageService.delete(SECRET_KEY);
		// Clear the token on the agent host too.
		try {
			await this.agentHostService.authenticate({ resource: ANTHROPIC_NATIVE_PROTECTED_RESOURCE.resource, token: '' });
		} catch (err) {
			this.logService.warn(`[ClaudeAuth] Failed to clear Claude token on agent host: ${err}`);
		}
		this._signedIn.set(false);
		this.notificationService.info(localize('claudeAuth.signedOut', "Signed out of Claude."));
	}
}

// Eager so the stored token is restored and pushed to the agent host at startup.
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
