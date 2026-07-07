/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import { Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { AgentHostEnabledSettingId, claudePreferAgentHostSettingId, IAgentHostService, isLocalClaudeProvider, shouldSurfaceLocalAgentHostProvider, type AgentProvider } from '../../../../../../platform/agentHost/common/agentService.js';
import { type ProtectedResourceMetadata } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import { type AgentInfo, type RootState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDefaultAccountService } from '../../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IAgentHostFileSystemService } from '../../../../../services/agentHost/common/agentHostFileSystemService.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { ChatSessionsExtensions, IAsyncChatSessionActivationRegistry, IChatSessionsService, isLocalAgentHostTarget } from '../../../common/chatSessionsService.js';
import { ICustomizationHarnessService } from '../../../common/customizationHarnessService.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { Target } from '../../../common/promptSyntax/promptTypes.js';
import { AgentCustomizationItemProvider } from './agentCustomizationItemProvider.js';
import { authenticateProtectedResources, AgentHostAuthTokenCache, resolveAuthenticationInteractively } from './agentHostAuth.js';
import { AgentHostLanguageModelProvider, agentHostProviderSupportsAutoModel } from './agentHostLanguageModelProvider.js';
import { AgentHostSessionHandler } from './agentHostSessionHandler.js';
import { IAgentHostActiveClientService } from './agentHostActiveClientService.js';
import { AICustomizationManagementSection } from '../../../common/aiCustomizationWorkspaceService.js';

const LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX = 'agent-host-';

Registry.as<IAsyncChatSessionActivationRegistry>(ChatSessionsExtensions.AsyncActivation).register({
	matchSessionType: sessionType => isLocalAgentHostTarget(sessionType),
	waitForActivation: waitForLocalAgentHostActivation,
});

async function waitForLocalAgentHostActivation(accessor: ServicesAccessor, sessionType: string): Promise<boolean> {
	const configurationService = accessor.get(IConfigurationService);
	if (!configurationService.getValue<boolean>(AgentHostEnabledSettingId)) {
		return false;
	}

	const provider = getLocalAgentHostProviderForSessionType(sessionType);
	if (!provider) {
		return false;
	}

	const agentHostService = accessor.get(IAgentHostService);
	const environmentService = accessor.get(IWorkbenchEnvironmentService);
	while (true) {
		const rootState = agentHostService.rootState.value;
		if (rootState instanceof Error) {
			return false;
		}
		if (rootState) {
			return rootState.agents.some(agent => agent.provider === provider && shouldSurfaceLocalAgentHostProvider(agent.provider, configurationService, environmentService.isSessionsWindow));
		}

		const changed = await Promise.race([
			Event.toPromise(agentHostService.rootState.onDidChange).then(() => true),
			Event.toPromise(agentHostService.onAgentHostExit).then(() => false),
		]);
		if (!changed) {
			return false;
		}
	}
}

function getLocalAgentHostProviderForSessionType(sessionType: string): AgentProvider | undefined {
	if (!isLocalAgentHostTarget(sessionType) || !sessionType.startsWith(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX)) {
		return undefined;
	}
	return sessionType.slice(LOCAL_AGENT_HOST_SESSION_TYPE_PREFIX.length) || undefined;
}

export { AgentHostSessionHandler } from './agentHostSessionHandler.js';

/**
 * Discovers available agents from the agent host process and dynamically
 * registers each one as a chat session type with its own session handler,
 * customization harness, and language model provider.
 *
 * Gated on the `chat.agentHost.enabled` setting.
 */


/**
 * FORK: the Claude "spark" mark, inlined as a `data:` URI so the chat welcome view can render it
 * (large) for fresh Claude Code (CLI) sessions — no bundled image asset or build wiring needed.
 */
const CLAUDE_CLI_LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAACAoAMABAAAAAEAAACAAAAAAEiOBHcAAAHNaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj4xMDAwPC9leGlmOlBpeGVsWERpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6UGl4ZWxZRGltZW5zaW9uPjEwMDA8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KFy909QAALE1JREFUeAHtXQd8HNWZn7ZFkjsuYKqLJMumBDA99ECABC4EVAwhNNPLUWxJNiGRaZZkU3IEgk1vtmVBuECCfxcIJXBwoZfYkiwb07tt2bKlLVPu/5/VyKv1zOzM7qpx90Ce2Tevf9/72vvee6IwQMKqub/aKaCrFWjOrqIgvGJIxidxIfCVEYyun1bTGBsgzfzBNQNj3f9hVXX5zDxJukUQxTESmqPjL65quiEIbQFZ+iau6SvUPH3O/yNC7mHV7wjQXHnadEUOvCiJ4hAAuruHbJgoioIsiQKQQOiMqX8KifLM3WuXbOxO1EcvRk2NtDrSdF5AkiIbvt/yp+mLn+noo6p7vZp+RYC1VaXDNUF6OaDI+8RUzbWzQ0IBYUs0fn9xXcNM14Q5/thUVbpXQJTrgIQngiIJmmZ8qOr6PUXr9EViY6N7o3Pclt4ojhS334JqSAvDASUt8NnAjpgKiiCUr64+Y2JfNPitRRcGVleXzw7Kyj8I/AgQNIo/URL2AjLe1TJRurwv2tHbdfQbArTMmXF2QJFmRuKqpz7qhiGEFWWIYajne8qQZaIhH7Wdmh8I1Bu6MYLAtwLZVCfarEjiDc2zZuxtxQ/WZ78gwJrrKnYVdONWA0AlWfUaYhoBIf36k+ozRnrNk0k6NIus8SKQekHDj9TAOEWShomKfvfKS0uHpH4fTL/7BQGEqDFcEIwRdoPrNnjUC8IBaZeooZW5pcv2W0tVxf6KKB/uJpeQHeQrymGBYfLp2dbXn/n7BQE0Tackv0U0J5q/7hMJQDkuXllTGvSX00dq0ZgZVKTA9nO/ZxlEYBCJLT1jB9evfkEAdbjwHYbpCxlSnd9AHgyt4UeBTvk4v3m9pP9o7oxxaNVpCXbjnIMtBxVQDVFrcU418L/0CwJ0GXTeUKDfZxKIOIZoXJpJ3nR5NFWfAJvEaJ1mKJeANPhqbBAk9UuXZAP+U2YQyEG3YN95nkJgJiEKYRBI8JNVs8v3yyS/Wx40aTQk/LTCqYQ0MFV9NWVfpc2tvIH+rd8QwBDk1wHIjsRM8jdMxJugLAdlUbjIX870qUVZHJsArntakwoJwqdi2eA2BvUbAry3Nv4JAPkBzbyZBErhAFTph1QpcxpEyACc3e6BZmq0fK17qoH/VemvJpbBjNoyp+xG8NpnMNySX2ZAw1BeQBlpxONnow835aofhqGPQ3M8FQd9ZI2nhD4TtcyuOFxShJFQMbqGRaYVNN62Yejfpy9eHPdZnGtybz11LSLzj8Xzlz8b1/XHYA7OqBBqBIYhntd6xZnDMirAJhPKG+vFPEUjEWSAj2yKyDhqXc054dbqitsURXwZC09/VmT56cSf8HQoIK0YMmLTZRkX7pCxXxGAbZIM5bqoqn5NwctvIBDCAXmCPiR+qt+8julFYwxlDLdABQDIF5cE6VO3dH6+NV1VsYceiT4TUuSrNUMXyeJiQHDrj78xRjUrry2d6qfcdGn7HQEK6x//XNeE62Ups6aYRFIXLzFqjsqMjCSNEJd98XMHshe3IJkygrFRV4Vv3NJ5/dY8q3RCICw8i7WRn3Cdwa56GsAgLw0HdbgD7cy6r1bbMht1K3eOnl8WfPMQMPz5sCL7LpEGG8yMA1sjY4/ynTklwwdb1uYhakQ69dRSAYs+VbP2TWi5unRnWZGfAnBLCHy3wEUpLIgdt7qzOWfaz4BAgKNrXlJFWZ8NstqZiVqIhRkRsyZrw5AUVLGwIw6zRC8nYHQZoj7J1h+gdU7pGCkkPwmz8z7JK45O9TIeMhO0H+GG5srSYrd0Xr8NCARgY4tuaXxPNYzF4IFe296djoYhSZROXDWrfM/uyAxe8iURwqRR4M4AEp5KkiF9kEEV3VneveoXoDTScvT3oEh823JzdwKHF7KCkCyPEkW40OUgDBgEYF80Xa+Ff8CXfgVC8kwMZFiWhQuzGZNIRB8F+S5ky4STCqaMgIWgd5OifL2+P+v4goJw6HGQ86PSkX27gk0txRCjdt/8xg0oBJi2oPFrSNg3Z7JGwKVbGHBmfFpZMd7vIFjplYC+A+oW3SgANQDIK1FJU1dZ+fw8jdJSOU8ZuShPUU7KBPhmXWgg2vEXP/U6pR1QCMBGKuG8Bzrj+tsw9Tq12TaeS7NQCUd3isYVtgm8RGrCGPJ3t5D4Ln4xdOgOn7qlc/rWMlGuxcw/syONwOeUnzIS5IV2VY39t1MaP/HuvXUoqaWybE5QUQ6K6dp3WDX5HkLJd+CJX0U18a2pC5a0OmTzHN1UVfZT8Lln4Rnuy0JI4IBFbpAFbd9JdY2+AUQfQACn3m1mUkaJxrVni+sbfua5Q10Jm6rKrwGfujUOmcWNyriVy4kBavdKUV3DkehupsV0V+GbAjRXll8VCii3AOj/BjI2Mz+gVIdk5daAIi4JKcabrVXll3SXnuFLSd3y/4Jg91QokBEVGAWR8OpMqjZ0AWZg98AZCMdQ3/y/aXbZjKAs1dF4lQ3UTPkIK6m5AD576gsBAPwzYaxYQBMsJVfOFJIyPjvxG8LJcPDQu9fMKb8HHjtZ+crJhnh9TDXa/aqFtJhhoea81tnlk9xBafNVEsZCC7D5sC2KAqCu6+9ti0n/1jyn7LCgIi+CfUFJZ2RyK43k2tR4DOFvbun8fPOMAC1V5ScGZHGxWyeoohA54Ep9UTiirMhGVy2qb2hSDf0uv8YhDjDI9DBNNGb5GQimhQfwGDcbAGYdARCTNcGzANha+ctdwB4fgaV7KMcnm8A1E7jTPTx5uv5mNuUk5/WMAGj6+cDi/HSdYBdJERRZ/LEiKy8ACU5JrtDXuxRb2KGqn8DQ4ysbqQBMy2etriwv8ZqxBmZgAAkI4AwkUwA0hC86xPAnXsrl4o4hBR4MKdJE2vSzCZQ9MK5vSfmBK3Ppg+B9ZA1jjcvYbNc3WrYwY8ZjNetJyAW/pfqzXaI0ESXzn1ov6sI8bg/zE7qoQIEhCpVe81V0vFMA5codARKI2LzPwke3eik31tlZD6HyJ34MPXblcgKAsn4H/fTXhTWPb7ZLk2mcdwQQpFbnuWFfPaR42lQUCHPz1kyWnlg195c72ad0ji1sG/4YpO7/5gzwE4iAQJzy5rneNm9oYmgkZJiRbkjeJY+876UdLVVlF8C+f4XXjS9OZdLxBAYOFZtlLyJbdEqXabx3BJDEdVRf/AbORgqI0BR+ETJCL6ycffrhfsoQ4QChG/p1kJ5VP3SACzpQmfJEVav2Uh/JP3x8CtwWgtgX/JdWA1gJhw5Fkm+nP4ffSZPa1rAiCapq3Dx1YeNTqd9y8dszAhgx/XPw/7iJkRnUTLkAgzwlrARWYOOFL8eGkgWNL6ua0eDXcSSiqoIsS6e1VJcfkK7JsibtBLnF0e5gCoCqFpcFeaVbWdz1FFSEh5G+wO/Gl9Ry4fHEyfOfX+Z/nTOPp9Q6PCPA8GEdn2MGfghdNrUMz78pCGGGFUAo+kPrnIr7uDvYc2ZBvxGOI77UQpJzkOEgKp2Tth5J2NlN2KQAiPK+jLWrnziV9dnVpXmGJjyEMZpAbSibQIMPhNkmWYtdxNXSbMpyy+sZmuNrnumAQHYBqECb20C5VcZvnBW028Midr4gKX/j9ut0efh9Sn1jC2wovlcLIT9QIziZurhbPboo7Or23XRYEYWWaXc3Ou4E2hIUF0BWOSZboY9CL7yCNmO6nD154VPfurUr22+eEYAVFS5oeCemq5eBEsQxszKum3yRBiR09MCAqLwAGwOPhkkbgoa+EKzkaz9aAeuCf50iasJcvDuKEZCwgQBMbR8SAqDhuATcXFl2cVhWLsta6EP1rAv6/pXFtQ050/fte+XTEshCSuoal0R17WSYTVvIoxxH1KnGpPiE1c4YrYjiktVzKhaQhCZ93u51AlYLdUG81e9CEeuBOnpCS3Xp0dsVui1ivJudhsKh6OAD0DS79EhMiFuxnO2CQtsqcnujnAPt6Y7i+uUPu6XL1beMpjFt9YYaOQKq1kNcuvW7fp/ceBWjDiOyCJYwKxpWVqQz3ohGxyJQgRY/FIjzGlRDEnVpbpffX3IThBfhY4dJt2O3F3aPrwmyAflFNwLCdmpYy3WlOyuK/CBmbX62Qh+tnp3x+AuBvLz0MktKGzP9mRECsDLypqLaZedCMzwLQ/SNX5NtcoMprFFLCEjikZDaX1pdVXFG8vfk9yn1T7dDubqpSydP/uT6TrkDSHPM2kjL8akJx25aOQxtGO00f1kXVMD1YkT8ODnvWxdeGBDi0mKsXE7I1tJHhI7p+idwCT13Qs1DkeR6evM9YwSwGlVYt/QxiKhHQVl/0WQJGKxMA4034MNjMRaPwz/+zubKU4balbVl44iGSFx/3Y9xiFQAtl5RM7Q5qVZJCNzURoYSEe1CQuYQ1xUNLd6Q/H3oiLa5ecEsHDu6CiOCgcV0gu+fOy2DZezkNvl9zxoBWGHx/KXNcuirkzpVbT7266l+yHNqg02WALYA4F4uy/nPQUDcJzUNd8dgwGpAlCG8ew+UBQKSfPjqPcSfJufCqjNXLkPk83bBRABRaBJrarp1u5bZZSdBrsCeBiJtdoGqNRa+rptSv/zF7ErynzsnCMBqJ9S8FCmuXTYXO+ZPxUB+TGqQaSAYEixBOggrkC+0Vpedl1pWyYKG52KG9hc/VIBlkApAzK5anrQ2EYczKKIVe/AzF9DM2KYBNFVX7CHJ0mLEBmgdzCZwnGDfeKIoPPX32ZSTad6cIYDVgKIFDX+J6NqR4Ll/plzA8c40cHaBGIySJfn+NdXl937Q82wgQ9fEeWA9ET/WyQQVkA7fc6JwgtUuSZdGJMi8FdPzSScOyAemBbD1ihNDkmHcB1funeminU3gzIedojUqy5cnU5dsyvSbN+cIwAaQj72zVjsNmF2Fhawtfmdpcie4/MxFJbigzcwXjb+3VJYeaH2fCruEpmuP+hVAAWzsApe69xFgFo9I+PpZJW97EoGx+aQDwsNqxhoFQ+dh1h6brbGH5aJrEbiXzNzrlqXfbKuxb996BQHYBe7+LapbXg/h/mgcrviPPDDaTKmBxRKgq+2rKMpzrdXl3cAzNGM+jC9tTgC0G05K7DD8HLLqqsTqJGjUSCcqwjbjv0+mLGxchzWFmVjkmc01hmwDZz/Mxb/FGP0j27Kyyd9rCGA1akr9srf0rW3HR1W9Gvx3s9/ZapXDJ92h4LUzLCDLd62trniUO2sIGJgRbsO5QclJXd/Jt+HcMlIJK4cyIQA80olRJXi8sUNzVVkjrDx3gSKBA7gWn/Yj+T6Q6KkP1um3pU3cywl6HQHY/sI7V0QLa5fVRXTjqLhmvEBrl58ZmzwGNLaYfFyRf4WThOFxVDG9sG7ZTaACH/rRPjizsRX8RLNs0RjlBFMiAGxIY+EAezqoRDCBEMkt8vfONgKR16KgS0kl/eXOfWonxM99TV0lriwtDSqTxCtASn8Dkt7jFE6/lWIWc2GJuvlD4M4zAKidvALI9LLR9Y+K99eLWt6W7s0PyOfSb6E3A5EO6zyQ+/QT+0Pls+tbnyOA1YjmWaftHQgEFgAQx1OaprCXSeCgYnkZVAGSuk/aDBO2oar6z2EkPg/IBKG1dxGAwjDU27kl9cvnZ9LX3sjTJyzAruFTFj75waehr3+GQb8KWLghU9mAQOfM9Qt8tknjkbCSsAyodxJNxb0ZCHz09bWtbSMW9mY9fsvuNwqQ3NCVVadNC4mgBjiVmzp3ptQguUyv76YsAOnOJ/HwWryZjoMMSsduHT+5dukLvjJnmPj9WWcVFCjGTnDUn4gDLabpmOq6qC0vvrnxi+QiBwQCsEFcpcPBB5fAlFwDQWl0Yl0guamD951Sf0cs/gT4fmmue2G6nsdj4/S4OlGXpGIAdBqoYQkE1gkY1R1h74B4kzjTBMLnN0D0JdCk7rUcTAcMAlgDw80ksiwvhBPHz/uaGlhtyOWTFAZha8yIHzSt7klXf0K3eg2cjbw2Lo+DCWMPSROK4HM/FXO6BLbISahhJ6jYQy0/CbJD+iaAxXGRqbtYWjuZBuO6Bcate6bULZ894BCAreUmjTM7my5Cp+aBLYzJ1urWPQL98IK9k/R+ug03nVzrtfrX4BizQ1jZPWDoe4FtTMeK11RwKW51G4+ZPRxmaNouTLmHfIUA9yMDUQMCEmwGZSgakAhgDZRFDYKgBtloClZ5ff2ko4xqCF+pmrYfzz5wqp83pgUFfQqsXPtjxh4IeO6NGb47rIVhUpDEjPYPaKf6LKDrhniA9e6Utt/ja2oEUIPyQUkNAEAjoumXlNQ1LLIGkptm82LKRGz02Bd2iwOwe4nnHRcBV3YgeSbJNpfE4XOXRL2t7Dl5UiaALeLD9ryOgwc8Alg9JjUIKMoCWBBPHgyyAQcW3DeOVYdzJMHYCNI9HTEHIBLnGIm7wHYRQJzJqwlwPyTcGpNMnxRKt6rxWSW1y28dNAjAzg422YCDSyBT+CLfTZDyxDU0vTW70yEF2wEBsQ0b1fekSjioEMDqnCUb/FA0BatfvfGkDJGMgKgDF7Bpi3HCiHmIRjcCrKosPzgkizMhVcaAt+thGiHZ2iAa+npNEjbocXFTMCRuCmjSFj0c7OxLx0W7gSE1OCPSfCHsGzf+0OwGdv31GkeAU/jkRhZSHKh77aIhtsDi+U8cLfcqTjd5e2JL/CPrjEORQkkgIlfCAHMt9/8nkyYKJCyki0fhlGojgvNRsDPGaAcv24RGbQIG4SlugjF2E5STNlTWBhN7G1bMNymysVlVpXZ4X2yRiDiaHlE71QjO4Yjl6hrYZGpAc+42rdfrkA3edCZ76ZrhXF2lbAThjnBpwrfXAYdX43H93eIh0z4Rk/wZk3ssrq4uO21IMPjEVlzM6CaIoHxT97SeQDKTv5GEMI5frZBAHNrasUCDQgGUGD5HkaITbYwAC7cCUluRntussN9dbMdzE9JshpXqW3hrfClK0lcBTflWk6MblFBBezqK01pVcTOQvhIUzMW3z2rh4HtawObs5iwnsDExOzGOn2PcmjDG72PyvQnPxvcm37zsM689VOBMcbhlTHDLRCiCLfAfBPMft+Td3wB0tj0EwwX+hGES/DZoxACwuhEIP804PMySiYjAZCEuxqPYjbMZBy1shDfOd3DM+wZlfYECv0C7v0C6r7Dn69uYJEVx18+zuiheicHB5ZLe29fd0AH0wgkFE65Jyjl4tOoB4B2A02d4bcbAvQsd8T2MYVMwqn+26+2NnZk2XwE6LYXd/dcQFEYSEXIdLHwxkYeFWxEeKupCnDFo2xggfpEEPsUBMYsBkMmaVF1SJQjW9NpA2QGnzR0equu3JOwTZzYldCIv4AFPOn2dpgr/Alt9F4z4ffiiNCl5yufpKKHfTpijubq64hzsynmQsy73KOC3Sf7Sd+GDmWmwTPztBTUd7NBYA2C8Ca75Gm4LeTPUqa/NZmZ7HcXEdEJqHAH3wNBw4Fxc027KAoMNEbx2uD/SUUDjHkqLd4PSbkQ7mjDd3wDvew3G3ncnhb/7WOzFcwCc+t29eyMmyddujcVxTIp4IBo1lg4a5NXJwZIBiBwkVYknqTr+68KYxAP/Jv5Pzv5/4p0jhkUsbkk32RW9jDA6X2M94F9Yufsn7jt8LV823t81ZV2+vwanJ4TRCnrawn1hMgBcDAl+BFSJIVg0wM4ZbJ8SBW6i5DYq8w8wzkcB+YgPAwPCiA8CaRQwkgCfxPjEHwaFtNr8P4FWCUTp2W0Tpbo+WN8tgW7b7wTCWQhm5kExFgL2LLFvf3Ew0U5uVPkYbucfYMz+xxDlN0KhWNOuNY099hX2bcuca2ObMw4v4pqWyZvGBGJBAF5WwrpoBHGyQQhTIKyqYhgDgdUsHdumhTxUlAcv3AIgVD7i8yHBE3mINCH8BYEdIcSFMGhBlBOCShMw4/Ebo4rvQhBADgCJAvjNsnGWgI5yxSAGHeKh0O/qX2KZFWTd0O8G9q/C85tITNgyDOrvLsOnRZ10cfSt30JWCNCXrQbwxZfmHSXvsj5Pju0wJKC0K2E5bORpusjzAIOirh2HjZ8LKcj2Z7CoHlVZ/MUwwFvxuhmIS77/PX5/C4RdD/6wwdD1DWAU7SCPFoHbrumgwjDgiR1cUIKjTJsah2VPUNpj8VgHLD6dh2SJWIMGAbYbmZSI5uqK8/Jk6f6B5EqW4HqgURhlCzGsOKv5yWzPikt9EjuootP4gwBTvcDzAzpQrGlIQ+xmlL8RCNcGhIIZX9hoiPoGMOCN0O42iB2db0644z9tr7gd9AjAMwQUqeBCDEglBnMsZ94PNZjAwj+UoixEMp/4h+7dYIs9um6NBQxJ/8LhE7N4skuPBMyTGjFYfiecSJvKwHfnYjFoL94e1huGrMEyHm7t5D5E7KjC4SPiXRCi5u1eu4TsyAyDEgFa58w4Ehu7rod+fSzne3/z/a6x5MMAKRY54JyMCUsl6NIAoEpsD84t5litBGU4C1v13mWDBxUCrJxTOjVsyHMg9FVg5iu9vZOHA+Q1kMcD1N9Bzz/H0MRxsAUcgRh4AQmTsJk1j9/Jw0mlLNLstexcpqM3EMZtZVCQDicl6DYE5bKSXJe1cnbpjvCX4w6ii7ELeDi3Z3sBPrG7ryQCAhXGn9G4+q6suH7ZOaj6QSy1B/PU0ARNV/fHplgcVCkeBCQpAoUYyvX6xCJP3yIET14BEkzDZtpb0cbzBjQFeKvm5PwRnfk4UVScBQTYjUD3OnuokzMt/riZv88QnTMMg/unzXkdZ03H6aqouztQbmnZsnJ3UZF/BPfPQ+AveDAwtASLXaPpqMn2kkpA9etVxCXQaa3EuUQ3DlgEoJ8CrOfXwQd+X8weSwXqHkynF3aI28+xC2YdOjhbMsTZGNyD+lJO6CKzTw8Pa2eOrXE+WpZ9WFdTumM8puwl6cbBoFaHAgn2BrcYT35N2YFyBClFrikZ1ycgGNIuMbDCmqqKQyGZXA8MPYGN83P+HmcRHErwv/CAKkWrRC10dFARH8GsghWyb/tpUgJV++tmQztzel0jvXQ8hZVXl44KBeUpWEE4GGNwCDqzL8Zjd6zNmFQsV4LlkFBA2BKNXztgEGDt7DMKdVmvBmL+Crw06MeggzyWhNuMuVJVOH/Z0zhn8ChQub8C7mmvufEEmQwScVdQRFP/a0tntGJfB0NMumK/xibPzUGtEFtLD8AOocNACqZDuJwIWcgULP3KEWSNnChxXVsXjRun9zsCvHNF6ZhhBfIVAOJlkJZHUcDzM1stHReA/yOupZhXMv+R9avmlu8ZMsTnoJHt6ET6wXfNU0r8UJh0wLL7zrORcCLEix1arGKfHJz8bQqWHaEJhqTtB0nhUCDFgRiwYgB2uCX38FCt1GNrE4DngVf6GuT7YzikP8QFqn5DgBfPOSq887hxZ0uSVAkgTvQj4HGgqVZ17bl/H8dFzi6qX/oc43FkzHgg+PPA8hInTYGDoera55DKP8SiDbak9y5/IDuAoeqtDiNevnftkx+xnbkKmCzi2t9U7ALBcR8sth0Ki+BBKHsaADuOJ6iY4iS6h9teWhD/hw5Bfnzv/jYEtVaVnSzxiBgcF5/gaf4WcAh46NMR5LpDCEnzrYuUaBaWpPxncM3KkU7HvdBciqNpcJ6ldoKuS4fkB+UbqBr1dqB/BYTZVjgvlmGfoK97B/22rWtJfyqQ4CAQuv3hnPuSsEV5vPDO7S+c6lMKwDP+sKJ1HSo9hTPYL/ntnvWa9k9d12YV1zW+ag1OTY0gzeiseBib4X/ldi8vZyN2RiyYUt9QiWNo3wD1OcBvO6w6/T659w8y6lcxwzijpHbZS37z90b6PkGA5lmlE5SgXAl6BN9DKUzS7JfoctZDmt+CjPVtG7beOn1xTx27pbrsalzYcJub8MhZiO+vBfPyjm2PtI8PG8qHoAj0TegxtqQSlC2cWEiPxD5/mJoK9lQA6c4rqW/4k8/sOU/ORaReDTj//1wlIL8elOSLwWrDBFDP4XavnvoqAQfB5iVkPXpy7bIbU4G/uqrsCEWUb3abyRT6cKzseknVL6BnbdBQ9gIwbIEPRbIdgtuj7i3b/qtFofh0Cgmh1BgelMUlvFrOKV1fxfcaAlAYw6LNY7hr+AEsXo4jn/W7KELAYzZuhCqFyyS0n/LQydSBoZkYae4HfPNSZ7KVluAgUKAyXVN4a6N57SuEo0LzHiArUdcTcgnexI+K1unn4uV5Uh4voUsCfxfH2FcjfZS/nQLlHhCdEKjhIlCuPrscwq49zq20S+0xDtu1TsEVbK+EZOlMzkqaN/0EzlYOPGbLimhcP6IY25jttpIZy0txv4R0T0hRJrvNfloG8f1+nNLxiNUOdLzIek9+ElFAoTZy7xyk6jkUNt1mtJWX0jYQcXQoP7wIiHgqyvjWDXmopvGUMtyneEtL1Yxbk08vt8rsi2dOEYDXwK2prvh9QFaeAgwnZiJdU2/GuvW3ANglk8JTfj51YcO/nAai+W25Cun/za0eCl74/mEoLzqrZznSJDuKQeqNP/PwZlIcIO+9pETpAlf5sOd/11gkcjcQbUVE149H3IcUOp0C6+d+xryAeM2+k6QH0t2Z5FRONvE5QwBg8Y9xStVL0D2vhNohORlgnBpLkknBK64aT0YF9TBcR3OP6LChkWWsriw9LiiJv4vhgEinwJmLQcY+RH3mhJptLlE8gwfzfDcCLTXQ2wazufv07pgs3dypql+4kXSrDMgNWBEUZ/AWtD3rGt6HUet4AHgFkYCMxS6wBVRZQcV+3RmSG2kKtkvXW3FZIwDPz8fOousVyfgbBulHCV7vvbkcGA4QJsPnGKxzJtUuPX1abeMatxJ4Oyc2j94H+Lqe3WsilK5fV1zf+EZyeeOCwhgM/DhbCoCEuB+x+zwfHuUO2WVeQjZILmX7dwIT/SArWMjLpHgukBwO/xLH5t9No4wbK+G4gdL8LBSSnn7v6tKdty+9d2KyQoDWqhnTxCEjVqDhN2Ay5bnNRrvmUyWiIAZ167GooR7m5ao0mkK1uLAYA7qbG5UhUuEKmyeL80ruTK0bN4TsCmDgjiCCrGcgUoA1dyMAvxZNHPEQZqmnC6wp72A8dtbj0kLmpcZRWNtwGfp4LeqMu1ESIgFs/IcNDcl/XVNdOpn5eztkjAAtuCAZsPs7SN7RbLjdbHJqPPksAYQ8a+OGXgb3pLO8XpYkd4rX5wXlE9yOjiNi8URuSP22N3GIujiJ1GF78HNLO8Avb2MB7IN40WLcmaxXQ3rH06lX2+I5HpAHKpIvxIRccBucRcrBC76nXOIU2C9ItvugEbhjefv7kpzyZRqfEQJ8WXNhPlyf7oe0Ps7N8GLXKHPWi5IOIW8RZsRhU2obGu3S2cVRu8CCUTUXjJwCySxmdlQzxAudjmYDny9kutTAGNgbQALE71K/0eqIbw9znd5LSLACwWQFVnrcqfQUbl49AW4tTaawa31IedIAhe3hk0Edn22pKv1xyuec/swIATZ3bMaWMWGsGwlObSX4YtesF1ZhjE+ZPH/pxRN9XJXSNKe8CEfML8K0VWwod3d1VL1wQ8mNU1zO5MXML7J1sSDywOceu3Ntt3HJgjIPM/RbqqnpQoIVKN2swEpfUtv4tiZqx8VU43lSQadAL2dUMx4I/2feUOaULtv4jBAA1rmRGKh8cksvgeQWfrJxYPbt0Yh6eFHdsr96yWel4TE2siE+BOqxo5tNgbMK5HfF5rbh9Vbe1Ce3s0FUK7LTABKDYbTrnZKtA0dh/eOfg/LdyP54CXasgPl4OtdWVfkFXMceooppQ4zM4jnBYIsYBblgeTI78VK31zTeepJSmiYK4zDTAm4zkVlIZonl4KvvgGifAF5/zbTb/W+SlDulhXmKfIgbu0nwff0zSCMX817BlCZ3/9ylY9SO+DHRDgFIpQCNtuDQEHfc2AY1rC/uUPWX3Yw8yRk5RpjJPVgBv++z8NGthXUN58V07QaeBkKTt10gwgMNCiA8PrK6qvwiuzTZxGWEALjk9GOQqBZib2pgPwh4DhA63hlR9ZtVreMoN5KcWkby7yZ0GhbFizibnAIBB76v6qp+cTphEveP0XlimJ3QalJ2Q9jgdgoHLZKSpl0FwGyxkyNS20gAQsffWYjLC1K/YaiMwvkNv4Pv4gXoQieR2C4QWdFeWNWlP8LTqcouTaZx9jWmKa0ITg2aIJ6A7UZv0LeMrk8kv+wAMF6FpLueizfwSzm2qHbpb3jfb5oibT9jLeEQXBy5kAPgxmyIiBjo+uIFy5+1LSg5UhJ/5DTQJiIJwnYCYHJ2vhdhPR9yWr1XKkDkDSgJA1FqWfyNa+Lvw31Kp2HsvrKbVExDhKVtGgdN1IIdzMd42JMMJvYRMkIAlo/17I/1mPizzpj2e5yHW4uZflFMF06EcrcfyNm0SbXLjimc3/i6j7b0SMpFHvT6YXDIIVTNnEI4wfdflDrab3BK0yNeN/Z3QidzRhsJM3CPPDY/CuLaQgD2La9IwC5gli9scTDyTIP5WI3FjsGh2K+QbdpBl0gAzx7aGapbKyvuNi+vtmmbnyi7evzk75W07NiQkZueBGU52Y3006gC0v817g78ceGChrXpGsNyh47c9DYowF52GgwHviOu3TSlbtn16cri9yZ4MAcl4QUQKJ5tkDYLy98aV5fh8OgZTompYndE2m8Bsvw7OAQo2/blEmhc4IJMtLRTDVxAecKpvHTxGVOAdAVn833IiLbr0wEfA8QZRRHpci/AZ3vyh34/Ho897ARAq70osocV0Iq3e5bULXsNbl7/4US2U/NA6hcgz/QwEKWmGV+zuAPXylwFj6ezYJJab0dhiBKcGKh3Rp4SW95y7YzRqeV4/T3gEKClsuwXsJTNdZP42bnERkft90W1y5/02lncUkYBcKjTbGU8kMozArBeOV+5CS5oq7yohgRcNyvAWoFbuwvrlj+GFcVjgaxvUMayI9VEgoJg4CRBzvwCygGFAC1zZkzBRdGLMFCynZ3eGjDOio6Y9vrQvM7fWHFenjhNZF8nAZD5Ibjygoe0QmByXXRIxWGWV2FNUiVVSheoFQB5d9bVxFqBW3quKG7U1eNhfLqX7bYzQJkmcewXyHQpecAgAD16KfTBkWQsB8kpcFXOdO0SjPPHp+y9c8pjxUNZ3NcJsQg8CJvxgBT43krv9UmXdFwAcZ9XM7EXVmDVzV1FuBn1QrQNh2CIm1PXEXgcL9q+y+agMtHK4+c5YBAAZz7dDlXyQNrBnQInGFU13Bh+lXXrlVPa1HgKgLC3THPSKOgHAAK9VdM026NUUstL/S3my9eDbX3kRmGsPH5YgZVn8vxl92qaehwA/gGFyeSAtotQl3molu8wIBCgpbL8UpD18zkz3AI7jg0dvO3qMbd0dt/yh24ZD/7rKACa5FsUN43K13B4tf9QXLP0ewB2FgR3HF+QPvhhBVZp9GuIC9FjMEkeIxvkH2QAakJ3Fd2yJKO9Bv2OAPQkAtlfQP7LmeEUTH1f1f4pbg1kZAkLBDQKgDjz0L4W0wagCxvHCNN6bOl2ao9dPFf7oMc/kDpD7dIyjkJcOq0gNW/J/KfWc/kcV+VeDsC/gg2eL0ZE+YbUdF5/9ysC0HMYmvxDGHycJWgPGHaEmA5nk5WyoZXZ7W7x0lkMlqMFkPlNBMBavejihualnqgoz4bzyEovWgHLs7SClVWlu3kp30pTXLfsrgm3LD2iKK/kJ8lbvazvXp/9hgAmTxaMe0MBeZKbRy+BD3K5Jq7FT51U1/ip146lpoMVlZspU6O7f5MF4K/bF7D7g88XAgPn+l0AStNhIlWa/GQF+YHAzlD0MlroyRZh+w0BhozafE1eUDnJzdLHWYQB+gwXSJw6dcGTrWnG0vHzW4u6BEAbq5qVyXQG9WgGtvI4PQvnL30d6yS/4wWPXgIledCgyV7S5jqNtxbmuNamWaWHBCTht24SP6VpwOsbsIbTJt/i7BrupWn5q78fj7IcBUCrDJBjX0YgK5/dc8r+xu2RmPYXN88fK19C6zW4TN3noc8RwHTukKW7eKmxk0CGHTPkjRujulaGlbI3sx0VWgBRpqMAyPJpHwAVyBkCiGWNmqyKl2KR7HP2xy2Y4wAPKzq8uqXrjW/uLeuFGoPR4G7gxPvQ5ckumAs8gtAOR4kZU+uW/8Mujd84zP790unnFEIlqaczqN96UtNPvm3ZZyDvlyJeM9XM1ARdv4l8EE92wPnHOFe6b0OfIwBWtnkFjMQ+p4YuU2dENdSz7Y41TU3v4/dB5iA7ZKDerpIRa4JvK6BDkd3R6MczUU2/w81K2KUAjzBkdYfujH300ucIoGvGbgUpliz2lRIz/otjmXZmcW3jU7nq//s4Ywezax+7ZdXuOlA3gNCpyqKtM2h3ugxfhud3/BbC7v9Qo7ELXSzvS+x38LUOYVeW37g+RwCczPEh9OSXSOo5ICSNfMKJxIhpxuU4uOFxv51wSx8S1EnArF15mJJT4CCgGe16NDMroFO5VjzXLMDxLoCxaxM9qNhf9p9aDo1GMG9vxRLH/Ez8Ja06Mn32OQLweJRHQsXHAh6nwGr2siJKuEvQeDlm6OUl9csWZ9oRp3ySYuwHK6LrZRJdrmBtwnDz+HWnorKK5ybXqCacjL2PPMfgaVCcZiz1vgpN6JpOXdsPV7kuyqqCDDOT/fVb4Jbo6cWhyRNvemw1GmEjFWTfNKwzLIK94cJ09gZQn1dhXTs8+xq9lWD8xxUh8co7o95S916qnstKvVePbcll2IOPDy22H3MQSQSDH//+tLa5hYTFTutT/jsQgM8x6XMW4AaIXH/ba5K8KwRL200gyXWZLMCQsjYDJ5c5WN5/0AhgaBJuL0t/UDT5oCwaXw0WoOWynT9oBJi6YEkr7A1Pp7PJU/jA1Uw5swLmEkC9XdYPGgHMwROlP0D9wm429wAk6FMZwL01fff1B48ARXnFr0HdeiU/aC/v0scOnkhrBFnrcYpI34Ggf2v6wSMA18sh5F0DD5pVyZ46dC4tAFIAOb7FMUPl3LHbv6Don9rTUcb+aVUv1Lpm1qljjUDoTlgcy9hpnNaxDjriE1t1/cG96huaeqHKQVHk/xkEIDTA58U1cyruxLW06+Rw6H7sAs7IA3hQQNZjI/8XZNq4hDqz9XYAAAAASUVORK5CYII=';

export class AgentHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentHostContribution';

	private readonly _agentRegistrations = this._register(new DisposableMap<AgentProvider, DisposableStore>());
	/** Model providers keyed by agent provider, for pushing model updates. */
	private readonly _modelProviders = new Map<AgentProvider, AgentHostLanguageModelProvider>();

	/** Dedupes redundant `authenticate` RPCs when the resolved token hasn't changed. */
	private readonly _authTokenCache = new AgentHostAuthTokenCache();

	private readonly _isSessionsWindow: boolean;
	private readonly _enableSmokeTestDriver: boolean;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService private readonly _logService: ILogService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAgentHostFileSystemService _agentHostFileSystemService: IAgentHostFileSystemService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICustomizationHarnessService private readonly _customizationHarnessService: ICustomizationHarnessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IAgentHostActiveClientService private readonly _activeClientService: IAgentHostActiveClientService,
	) {
		super();
		this._isSessionsWindow = environmentService.isSessionsWindow;
		this._enableSmokeTestDriver = !!environmentService.enableSmokeTestDriver;

		if (!this._configurationService.getValue<boolean>(AgentHostEnabledSettingId)) {
			return;
		}

		this._register(_agentHostFileSystemService.registerAuthority('local', this._agentHostService));

		// React to root state changes (agent discovery / removal)
		this._register(this._agentHostService.rootState.onDidChange(rootState => {
			this._handleRootStateChange(rootState);
		}));

		// Clear the auth cache whenever the local agent host (re)starts so the
		// first post-restart authenticate RPC is never skipped as "unchanged".
		this._register(this._agentHostService.onAgentHostStart(() => {
			this._authTokenCache.clear();
		}));

		// Process initial root state if already available
		const initialRootState = this._agentHostService.rootState.value;
		if (initialRootState && !(initialRootState instanceof Error)) {
			this._handleRootStateChange(initialRootState);
		}

		// React to per-window preference flips for AH-vs-EH Claude. The
		// extension's `chatSessions` contribution gates the EH side declaratively
		// via its `when` clause; we mirror that on the AH side by toggling
		// registration of the `claude` provider inside this window. Flipping
		// the relevant setting unregisters / re-registers Claude live.
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			const relevantSetting = claudePreferAgentHostSettingId(this._isSessionsWindow);
			if (!e.affectsConfiguration(relevantSetting)) {
				return;
			}
			const current = this._agentHostService.rootState.value;
			if (current && !(current instanceof Error)) {
				this._handleRootStateChange(current);
			}
		}));
	}

	/**
	 * Whether this window wants the given agent registered, given the
	 * per-window AH/EH preference settings. Today only the `claude` provider
	 * has dual implementations (EH from the Copilot extension, AH from inside
	 * the agent host process) and a corresponding preference; all other
	 * providers are AH-only and unconditionally allowed.
	 *
	 * Symmetric with the EH-side gate that lives in the extension's
	 * `chatSessions` contribution `when` clause:
	 *   - Agents Window  → `chat.agents.claude.preferAgentHost`
	 *   - Editor Window  → `chat.editor.claude.preferAgentHost`
	 *
	 * If the relevant setting is `false`, the EH Claude is the one that
	 * surfaces in this window, so the AH side suppresses its own registration
	 * to avoid Claude appearing twice in the same window.
	 */
	private _shouldRegisterAgent(provider: AgentProvider): boolean {
		return shouldSurfaceLocalAgentHostProvider(provider, this._configurationService, this._isSessionsWindow);
	}

	private _handleRootStateChange(rootState: RootState): void {
		const allowed = rootState.agents.filter(a => this._shouldRegisterAgent(a.provider));
		const incoming = new Set(allowed.map(a => a.provider));

		// Remove agents that are no longer present OR no longer allowed
		for (const [provider] of this._agentRegistrations) {
			if (!incoming.has(provider)) {
				this._agentRegistrations.deleteAndDispose(provider);
				this._modelProviders.delete(provider);
			}
		}

		// Authenticate using protectedResources from agent info. Only auth the
		// allowed agents so a suppressed provider (e.g. EH-preferred Claude in
		// this window) doesn't trigger token resolution work for an
		// implementation we're not going to bridge.
		this._authenticateWithServer(allowed)
			.catch(() => { /* best-effort */ });

		// Register new agents and push model updates to existing ones
		for (const agent of allowed) {
			if (!this._agentRegistrations.has(agent.provider)) {
				this._registerAgent(agent);
			} else {
				// Push updated models to existing model provider
				const modelProvider = this._modelProviders.get(agent.provider);
				modelProvider?.updateModels(agent.models);
			}
		}
	}

	private _registerAgent(agent: AgentInfo): void {
		const store = new DisposableStore();
		this._agentRegistrations.set(agent.provider, store);
		const sessionType = `agent-host-${agent.provider}`;
		const agentId = sessionType;
		const vendor = sessionType;

		// Chat session contribution.
		// Keep the delegation picker available for local agent host sessions in
		// both VS Code and the Agents app so users can hand off (continue) their
		// conversation to any other agent host session or remote target.
		store.add(this._chatSessionsService.registerChatSessionContribution({
			type: sessionType,
			name: agentId,
			displayName: agent.displayName,
			description: agent.description,
			customAgentTarget: this._isSessionsWindow ? undefined : Target.GitHubCopilot,
			canDelegate: true,
			requiresCustomModels: true,
			supportsAutoModel: agentHostProviderSupportsAutoModel(agent.provider),
			// FORK: the local Claude providers authenticate via the user's own `claude` login
			// (no Copilot account / protected resources), so they must not be gated behind
			// GitHub Copilot sign-in. All other agent-host providers still are.
			requiresCopilotSignIn: !isLocalClaudeProvider(agent.provider),
			// FORK: give a fresh local-Claude session its own welcome — the Claude mark plus
			// copy that reflects a local, interactive agent, instead of the generic
			// "Delegate to … / forwarded to a coding agent in the background" message.
			icon: isLocalClaudeProvider(agent.provider) ? { light: CLAUDE_CLI_LOGO_DATA_URI, dark: CLAUDE_CLI_LOGO_DATA_URI } : undefined,
			welcomeTitle: isLocalClaudeProvider(agent.provider) ? localize('claudeCli.welcomeTitle', "Claude Code") : undefined,
			welcomeMessage: isLocalClaudeProvider(agent.provider) ? localize('claudeCli.welcomeMessage', "Ask Claude Code to explore, edit, and run code in your workspace, powered by your own Claude subscription.") : undefined,
			agentHostProviderId: agent.provider,
			supportsDelegation: true,
			capabilities: {
				supportsCheckpoints: true,
				supportsPromptAttachments: true,
				supportsImageAttachments: true,
			},
		}));

		const agentRegistration = store.add(this._activeClientService.registerForAgent(sessionType));
		const syncProvider = agentRegistration.syncProvider;

		const itemProvider = store.add(this._instantiationService.createInstance(AgentCustomizationItemProvider, 'local', undefined));
		// `[Agent Host]` suffix disambiguates from the extension-host Copilot CLI harness, which uses the same displayName.
		store.add(this._customizationHarnessService.registerExternalHarness({
			id: sessionType,
			label: localize('agentHostHarnessLabel.local', "{0} [Agent Host]", agent.displayName),
			icon: ThemeIcon.fromId(Codicon.server.id),
			// The Tools section is surfaced for the Copilot CLI agent host only.
			hiddenSections: agent.provider === 'copilotcli' ? [AICustomizationManagementSection.Prompts] : [AICustomizationManagementSection.Tools, AICustomizationManagementSection.Prompts],
			hideGenerateButton: true,
			syncProvider,
			itemProvider,
		}));

		// Session handler
		const sessionHandler = store.add(this._instantiationService.createInstance(AgentHostSessionHandler, {
			provider: agent.provider,
			agentId,
			sessionType,
			fullName: agent.displayName,
			description: agent.description,
			connection: this._agentHostService,
			connectionAuthority: 'local',
			resolveAuthentication: (resources) => this._resolveAuthenticationInteractively(resources),
		}));
		store.add(this._chatSessionsService.registerChatSessionContentProvider(sessionType, sessionHandler));

		// Language model provider.
		// Order matters: `updateModels` must be called after
		// `registerLanguageModelProvider` so the initial `onDidChange` is observed.
		const vendorDescriptor = { vendor, displayName: agent.displayName, configuration: undefined, managementCommand: undefined, when: undefined };
		this._languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
		store.add(toDisposable(() => this._languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor])));
		const modelProvider = store.add(new AgentHostLanguageModelProvider(sessionType, vendor));
		this._modelProviders.set(agent.provider, modelProvider);
		store.add(toDisposable(() => this._modelProviders.delete(agent.provider)));
		store.add(this._languageModelsService.registerLanguageModelProvider(vendor, modelProvider));
		modelProvider.updateModels(agent.models);

		// Re-authenticate when credentials change
		store.add(this._defaultAccountService.onDidChangeDefaultAccount(() => {
			const agents = this._getRootAgents();
			this._authenticateWithServer(agents).catch(() => { /* best-effort */ });
		}));
		store.add(this._authenticationService.onDidChangeSessions(() => {
			const agents = this._getRootAgents();
			this._authenticateWithServer(agents).catch(() => { /* best-effort */ });
		}));
	}

	private _getRootAgents(): readonly AgentInfo[] {
		const rootState = this._agentHostService.rootState.value;
		const agents = (rootState && !(rootState instanceof Error)) ? rootState.agents : [];
		return agents.filter(a => this._shouldRegisterAgent(a.provider));
	}

	/**
	 * Authenticate using protectedResources from agent info in root state.
	 * Resolves tokens via the standard VS Code authentication service.
	 */
	private async _authenticateWithServer(agents: readonly AgentInfo[]): Promise<void> {
		this._agentHostService.setAuthenticationPending(true);
		try {
			const testToken = this._getScenarioAutomationToken();
			if (testToken !== undefined) {
				await this._seedTestToken(agents, testToken);
				return;
			}
			await authenticateProtectedResources(agents, {
				authTokenCache: this._authTokenCache,
				authenticationService: this._authenticationService,
				logPrefix: '[AgentHost]',
				logService: this._logService,
				authenticate: request => this._agentHostService.authenticate(request),
			});
		} catch (err) {
			this._logService.error('[AgentHost] Failed to authenticate with server', err);
		} finally {
			this._agentHostService.setAuthenticationPending(false);
		}
	}

	/**
	 * Interactively prompt the user to authenticate when the server requires it.
	 * Uses protectedResources from root state, resolves the auth provider,
	 * creates a session (which triggers the login UI), and pushes the token
	 * to the server. Returns true if authentication succeeded.
	 */
	private async _resolveAuthenticationInteractively(protectedResources: ProtectedResourceMetadata[]): Promise<boolean> {
		const testToken = this._getScenarioAutomationToken();
		if (testToken !== undefined) {
			for (const resource of protectedResources) {
				await this._agentHostService.authenticate({ resource: resource.resource, token: testToken });
				this._authTokenCache.updateAndIsChanged(resource.resource, resource.scopes_supported, testToken);
			}
			return protectedResources.length > 0;
		}
		try {
			return await resolveAuthenticationInteractively(protectedResources, {
				authTokenCache: this._authTokenCache,
				authenticationService: this._authenticationService,
				logPrefix: '[AgentHost]',
				logService: this._logService,
				authenticate: request => this._agentHostService.authenticate(request),
			});
		} catch (err) {
			this._logService.error('[AgentHost] Interactive authentication failed', err);
		}
		return false;
	}

	private async _seedTestToken(agents: readonly AgentInfo[], token: string): Promise<void> {
		for (const agent of agents) {
			for (const resource of agent.protectedResources ?? []) {
				if (!this._authTokenCache.updateAndIsChanged(resource.resource, resource.scopes_supported, token)) {
					continue;
				}
				try {
					await this._agentHostService.authenticate({ resource: resource.resource, token });
				} catch (err) {
					this._authTokenCache.clear(resource.resource);
					throw err;
				}
			}
		}
	}

	private _getScenarioAutomationToken(): string | undefined {
		// Smoke-test escape hatch.
		if (!this._enableSmokeTestDriver) {
			return undefined;
		}
		const token = this._configurationService.getValue('chat.agentHost.unsafeTestToken');
		return typeof token === 'string' && token.length > 0 ? token : undefined;
	}
}
