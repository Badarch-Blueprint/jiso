/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const IActiveWorkspaceFolderService = createDecorator<IActiveWorkspaceFolderService>('activeWorkspaceFolderService');

/**
 * Context key that is `true` when the window has two or more workspace folders and therefore
 * the workspace switcher can switch the active folder. When `false` the switcher offers to add
 * a folder instead.
 */
export const WorkspaceSwitcherCanSwitchContext = new RawContextKey<boolean>('workspaceSwitcherCanSwitch', false);

/**
 * Tracks which workspace folder is currently the "active" one. Several views (Explorer, Source
 * Control) observe this to filter their content to the active folder while other folders stay
 * loaded in the workspace.
 */
export interface IActiveWorkspaceFolderService {

	readonly _serviceBrand: undefined;

	/**
	 * The currently active workspace folder, or `undefined` when there are no folders.
	 */
	readonly activeFolder: IWorkspaceFolder | undefined;

	/**
	 * Fires when the active folder changes (including when it is reset because folders were
	 * added or removed from the workspace).
	 */
	readonly onDidChangeActiveFolder: Event<void>;

	/**
	 * Sets the active folder. No-op if the folder is not part of the workspace.
	 */
	setActiveFolder(folder: IWorkspaceFolder): void;

	/**
	 * Cycles the active folder to the next folder in the workspace.
	 */
	switchToNext(): void;
}
