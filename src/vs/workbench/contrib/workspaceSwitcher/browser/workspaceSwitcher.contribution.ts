/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual, isEqualOrParent } from '../../../../base/common/resources.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService, isRecentFolder } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IActiveWorkspaceFolderService, WorkspaceSwitcherCanSwitchContext } from '../../../services/workspaces/common/activeWorkspaceFolderService.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../scm/common/scm.js';
import { ADD_ROOT_FOLDER_COMMAND_ID } from '../../../browser/actions/workspaceCommands.js';
import '../../../services/workspaces/browser/activeWorkspaceFolderService.js';

const ADD_FOLDER_ACTION_ID = 'workbench.action.workspaceSwitcher.addFolder';
const SWITCH_FOLDER_ACTION_ID = 'workbench.action.workspaceSwitcher.switchFolder';

class AddWorkspaceFolderAction extends Action2 {
	constructor() {
		super({
			id: ADD_FOLDER_ACTION_ID,
			title: localize2('addWorkspaceFolder', "Add Folder to Workspace"),
			icon: Codicon.add,
			f1: false,
			menu: [{
				id: MenuId.SidebarTitle,
				group: 'navigation',
				order: 100,
				when: WorkspaceSwitcherCanSwitchContext.toNegated()
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const workspacesService = accessor.get(IWorkspacesService);
		const workspaceEditingService = accessor.get(IWorkspaceEditingService);
		const contextService = accessor.get(IWorkspaceContextService);
		const labelService = accessor.get(ILabelService);
		const commandService = accessor.get(ICommandService);
		const activeFolderService = accessor.get(IActiveWorkspaceFolderService);

		const existing = new Set(contextService.getWorkspace().folders.map(f => f.uri.toString()));

		const recent = await workspacesService.getRecentlyOpened();
		const recentFolders = recent.workspaces
			.filter(isRecentFolder)
			.filter(folder => !existing.has(folder.folderUri.toString()));

		interface IFolderPickItem extends IQuickPickItem {
			readonly folderUri?: URI;
			readonly browse?: boolean;
		}

		const browseItem: IFolderPickItem = {
			label: localize('browseFolder', "Add Folder..."),
			browse: true
		};

		const picks: Array<IFolderPickItem | IQuickPickSeparator> = [];
		if (recentFolders.length) {
			picks.push({ type: 'separator', label: localize('recentlyOpened', "Recently Opened") });
			for (const folder of recentFolders) {
				picks.push({
					label: folder.label || labelService.getUriBasenameLabel(folder.folderUri),
					description: labelService.getUriLabel(folder.folderUri, { relative: false }),
					folderUri: folder.folderUri
				});
			}
			picks.push({ type: 'separator' });
		}
		picks.push(browseItem);

		const pick = await quickInputService.pick(picks, {
			placeHolder: localize('addFolderPlaceholder', "Select a folder to add to the workspace")
		});
		if (!pick) {
			return;
		}

		if (pick.browse) {
			// Reuse the built-in folder dialog + add flow.
			await commandService.executeCommand(ADD_ROOT_FOLDER_COMMAND_ID);
		} else if (pick.folderUri) {
			await workspaceEditingService.addFolders([{ uri: pick.folderUri }]);
		}

		// Make the newly added folder the active one (if it ended up in the workspace).
		const added = pick.folderUri && contextService.getWorkspace().folders.find(f => isEqual(f.uri, pick.folderUri!));
		if (added) {
			activeFolderService.setActiveFolder(added);
		}
	}
}

class SwitchWorkspaceFolderAction extends Action2 {
	constructor() {
		super({
			id: SWITCH_FOLDER_ACTION_ID,
			title: localize2('switchWorkspaceFolder', "Switch Active Folder"),
			icon: Codicon.arrowSwap,
			f1: false,
			menu: [{
				id: MenuId.SidebarTitle,
				group: 'navigation',
				order: 100,
				when: WorkspaceSwitcherCanSwitchContext.isEqualTo(true)
			}]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IActiveWorkspaceFolderService).switchToNext();
	}
}

registerAction2(AddWorkspaceFolderAction);
registerAction2(SwitchWorkspaceFolderAction);

/**
 * Keeps the Source Control view filtered to the repositories that belong to the active workspace
 * folder. Other folders' repositories stay open but are hidden from the SCM view.
 */
class ActiveFolderScmFilterContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.activeFolderScmFilter';

	constructor(
		@IActiveWorkspaceFolderService private readonly activeFolderService: IActiveWorkspaceFolderService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
	) {
		super();

		this._register(this.activeFolderService.onDidChangeActiveFolder(() => this.updateVisibleRepositories()));
		this._register(this.scmService.onDidAddRepository(() => this.updateVisibleRepositories()));
		this._register(this.scmService.onDidRemoveRepository(() => this.updateVisibleRepositories()));

		this.updateVisibleRepositories();
	}

	private belongsToActiveFolder(repository: ISCMRepository): boolean {
		const activeFolder = this.activeFolderService.activeFolder;
		const rootUri = repository.provider.rootUri;
		if (!activeFolder || !rootUri) {
			return false;
		}

		return isEqualOrParent(rootUri, activeFolder.uri);
	}

	private updateVisibleRepositories(): void {
		const allRepositories = this.scmViewService.repositories;

		// Only filter when the switcher is active (two or more folders). Otherwise leave the
		// default behavior of showing every repository untouched.
		if (this.contextService.getWorkspace().folders.length < 2) {
			this.scmViewService.visibleRepositories = allRepositories;
			return;
		}

		const matching = allRepositories.filter(repository => this.belongsToActiveFolder(repository));

		// Fall back to showing all repositories when the active folder has no repository of its
		// own, to avoid presenting an empty Source Control view.
		this.scmViewService.visibleRepositories = matching.length ? matching : allRepositories;
	}
}

registerWorkbenchContribution2(ActiveFolderScmFilterContribution.ID, ActiveFolderScmFilterContribution, WorkbenchPhase.AfterRestored);
