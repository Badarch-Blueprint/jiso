/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IActiveWorkspaceFolderService, WorkspaceSwitcherCanSwitchContext } from '../common/activeWorkspaceFolderService.js';

const ACTIVE_FOLDER_STORAGE_KEY = 'workspaceSwitcher.activeFolder';

export class ActiveWorkspaceFolderService extends Disposable implements IActiveWorkspaceFolderService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveFolder = this._register(new Emitter<void>());
	readonly onDidChangeActiveFolder: Event<void> = this._onDidChangeActiveFolder.event;

	private _activeFolder: IWorkspaceFolder | undefined;
	private readonly canSwitchContext: IContextKey<boolean>;

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this.canSwitchContext = WorkspaceSwitcherCanSwitchContext.bindTo(contextKeyService);

		this._activeFolder = this.restoreActiveFolder();
		this.updateContext();

		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.onDidChangeWorkspaceFolders()));
	}

	get activeFolder(): IWorkspaceFolder | undefined {
		return this._activeFolder;
	}

	setActiveFolder(folder: IWorkspaceFolder): void {
		const match = this.contextService.getWorkspace().folders.find(f => isEqual(f.uri, folder.uri));
		if (!match || (this._activeFolder && isEqual(this._activeFolder.uri, match.uri))) {
			return;
		}

		this._activeFolder = match;
		this.storeActiveFolder();
		this._onDidChangeActiveFolder.fire();
	}

	switchToNext(): void {
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length < 2) {
			return;
		}

		const currentIndex = this._activeFolder ? folders.findIndex(f => isEqual(f.uri, this._activeFolder!.uri)) : -1;
		const next = folders[(currentIndex + 1) % folders.length];
		this.setActiveFolder(next);
	}

	private onDidChangeWorkspaceFolders(): void {
		const folders = this.contextService.getWorkspace().folders;

		// Reset the active folder to the first folder if it was removed from the workspace.
		if (!this._activeFolder || !folders.some(f => isEqual(f.uri, this._activeFolder!.uri))) {
			this._activeFolder = folders.length ? folders[0] : undefined;
			this.storeActiveFolder();
			this.updateContext();
			this._onDidChangeActiveFolder.fire();
			return;
		}

		this.updateContext();
	}

	private updateContext(): void {
		this.canSwitchContext.set(this.contextService.getWorkspace().folders.length >= 2);
	}

	private restoreActiveFolder(): IWorkspaceFolder | undefined {
		const folders = this.contextService.getWorkspace().folders;
		if (!folders.length) {
			return undefined;
		}

		const stored = this.storageService.get(ACTIVE_FOLDER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			const match = folders.find(f => f.uri.toString() === stored);
			if (match) {
				return match;
			}
		}

		return folders[0];
	}

	private storeActiveFolder(): void {
		if (this._activeFolder) {
			this.storageService.store(ACTIVE_FOLDER_STORAGE_KEY, this._activeFolder.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(ACTIVE_FOLDER_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

registerSingleton(IActiveWorkspaceFolderService, ActiveWorkspaceFolderService, InstantiationType.Delayed);
