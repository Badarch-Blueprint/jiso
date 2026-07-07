/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  FORK: registers the "Jiso Settings" service + the title-bar gear button
 *  that opens it. The panel edits JisoIDE's own agent-host root config
 *  (context management: trimming, auto-compact) — see ./claudeSettingsPanel.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { ClaudeSettingsPanel, IClaudeSettingsService } from './claudeSettingsPanel.js';

registerSingleton(IClaudeSettingsService, ClaudeSettingsPanel, InstantiationType.Delayed);

const OPEN_CLAUDE_SETTINGS_ID = 'workbench.action.openClaudeSettings';

registerAction2(class OpenClaudeSettingsAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CLAUDE_SETTINGS_ID,
			title: localize2('openClaudeSettings', "Jiso Settings"),
			category: localize2('jiso', "Jiso"),
			icon: Codicon.settingsGear,
			f1: true,
			menu: [{
				id: MenuId.TitleBar,
				group: TitleBarLeadingActionsGroup,
				order: 1000,
			}],
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IClaudeSettingsService).show();
	}
});
