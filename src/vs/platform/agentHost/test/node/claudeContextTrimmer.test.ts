/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	capText,
	createPostToolUseTrimHook,
	IClaudeContextTrimConfig,
	ReadDedupeState,
	trimToolResult,
} from '../../node/claude/claudeContextTrimmer.js';

const CONFIG_CAP_ONLY: IClaudeContextTrimConfig = { enabled: true, maxChars: 100, dedupeReads: false };
const CONFIG_ALL: IClaudeContextTrimConfig = { enabled: true, maxChars: 100, dedupeReads: true };
const CONFIG_OFF: IClaudeContextTrimConfig = { enabled: false, maxChars: 100, dedupeReads: false };

suite('claudeContextTrimmer / capText', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('short text passes through unchanged; long text keeps head + tail around a marker', () => {
		const long = 'A'.repeat(300) + 'MIDDLE' + 'Z'.repeat(300);
		const capped = capText(long, 100);
		assert.deepStrictEqual({
			short: capText('hello', 100),
			exact: capText('x'.repeat(100), 100),
			cappedStartsWithHead: capped.startsWith('A'.repeat(60)),
			cappedEndsWithTail: capped.endsWith('Z'.repeat(40)),
			cappedHasMarker: capped.includes('characters elided'),
			middleGone: !capped.includes('MIDDLE'),
		}, {
			short: 'hello',
			exact: 'x'.repeat(100),
			cappedStartsWithHead: true,
			cappedEndsWithTail: true,
			cappedHasMarker: true,
			middleGone: true,
		});
	});
});

suite('claudeContextTrimmer / trimToolResult', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function args(toolName: string, toolResponse: unknown, filePath?: string) {
		return {
			toolName,
			toolInput: filePath !== undefined ? { file_path: filePath } : {},
			toolResponse,
			stateKeyPrefix: 's1\0',
		};
	}

	test('caps oversized string output and preserves small output', () => {
		const state: ReadDedupeState = new Map();
		const big = trimToolResult(args('Bash', 'y'.repeat(500)), CONFIG_CAP_ONLY, state);
		const small = trimToolResult(args('Bash', 'tiny'), CONFIG_CAP_ONLY, state);
		assert.deepStrictEqual({
			bigChanged: big.changed,
			bigReason: big.reason,
			bigHasMarker: typeof big.output === 'string' && big.output.includes('characters elided'),
			smallChanged: small.changed,
			smallOutput: small.output,
		}, {
			bigChanged: true,
			bigReason: 'cap',
			bigHasMarker: true,
			smallChanged: false,
			smallOutput: 'tiny',
		});
	});

	test('caps text inside block-array responses and passes structured payloads through', () => {
		const state: ReadDedupeState = new Map();
		const blocks = trimToolResult(args('Read', [{ type: 'text', text: 'q'.repeat(500) }]), CONFIG_CAP_ONLY, state);
		const structured = trimToolResult(args('Bash', { exitCode: 0, big: 'w'.repeat(500) }), CONFIG_CAP_ONLY, state);
		const blockText = Array.isArray(blocks.output) ? (blocks.output[0] as { text: string }).text : '';
		assert.deepStrictEqual({
			blocksChanged: blocks.changed,
			blockTextHasMarker: blockText.includes('characters elided'),
			blockTextShorter: blockText.length < 500,
			structuredChanged: structured.changed,
		}, {
			blocksChanged: true,
			blockTextHasMarker: true,
			blockTextShorter: true,
			structuredChanged: false,
		});
	});

	test('dedupes a byte-identical re-read; changed content and other files are untouched', () => {
		const state: ReadDedupeState = new Map();
		const first = trimToolResult(args('Read', 'file content', '/a.ts'), CONFIG_ALL, state);
		const repeat = trimToolResult(args('Read', 'file content', '/a.ts'), CONFIG_ALL, state);
		const otherFile = trimToolResult(args('Read', 'file content', '/b.ts'), CONFIG_ALL, state);
		const changedContent = trimToolResult(args('Read', 'file content v2', '/a.ts'), CONFIG_ALL, state);
		assert.deepStrictEqual({
			first: first.changed,
			repeat: repeat.reason,
			repeatPointsBack: typeof repeat.output === 'string' && repeat.output.includes('/a.ts'),
			otherFile: otherFile.changed,
			changedContent: changedContent.changed,
		}, {
			first: false,
			repeat: 'dedupe',
			repeatPointsBack: true,
			otherFile: false,
			changedContent: false,
		});
	});

	test('dedupe ignores non-read tools and applies per state-key prefix', () => {
		const state: ReadDedupeState = new Map();
		trimToolResult(args('Grep', 'same result', '/a.ts'), CONFIG_ALL, state);
		const grepAgain = trimToolResult(args('Grep', 'same result', '/a.ts'), CONFIG_ALL, state);
		trimToolResult(args('Read', 'content', '/a.ts'), CONFIG_ALL, state);
		const otherSession = trimToolResult(
			{ toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolResponse: 'content', stateKeyPrefix: 's2\0' },
			CONFIG_ALL, state,
		);
		assert.deepStrictEqual({
			grepAgain: grepAgain.changed,
			otherSession: otherSession.changed,
		}, {
			grepAgain: false,
			otherSession: false,
		});
	});

	test('disabled config passes everything through', () => {
		const state: ReadDedupeState = new Map();
		const result = trimToolResult(args('Read', 'k'.repeat(500), '/a.ts'), CONFIG_OFF, state);
		assert.deepStrictEqual({ changed: result.changed, size: state.size }, { changed: false, size: 0 });
	});
});

suite('claudeContextTrimmer / createPostToolUseTrimHook', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function postToolUseInput(toolResponse: unknown) {
		return {
			hook_event_name: 'PostToolUse' as const,
			session_id: 's1',
			transcript_path: '/t',
			cwd: '/w',
			tool_name: 'Bash',
			tool_input: {},
			tool_response: toolResponse,
			tool_use_id: 'toolu_1',
		};
	}

	test('emits updatedToolOutput only when the output actually changed', async () => {
		const hook = createPostToolUseTrimHook(() => ({ enabled: true, maxChars: 100, dedupeReads: false }));
		const capped = await hook(postToolUseInput('m'.repeat(500)), 'toolu_1', { signal: new AbortController().signal });
		const untouched = await hook(postToolUseInput('small'), 'toolu_1', { signal: new AbortController().signal });
		const cappedOutput = ((capped as { hookSpecificOutput?: { updatedToolOutput?: unknown } }).hookSpecificOutput)?.updatedToolOutput;
		assert.deepStrictEqual({
			cappedHasMarker: typeof cappedOutput === 'string' && cappedOutput.includes('characters elided'),
			untouched,
		}, {
			cappedHasMarker: true,
			untouched: {},
		});
	});

	test('config is re-read per call (live settings changes apply)', async () => {
		let enabled = false;
		const hook = createPostToolUseTrimHook(() => ({ enabled, maxChars: 100, dedupeReads: false }));
		const whileOff = await hook(postToolUseInput('n'.repeat(500)), 'toolu_1', { signal: new AbortController().signal });
		enabled = true;
		const whileOn = await hook(postToolUseInput('n'.repeat(500)), 'toolu_1', { signal: new AbortController().signal });
		assert.deepStrictEqual({
			whileOff,
			whileOnChanged: (whileOn as { hookSpecificOutput?: unknown }).hookSpecificOutput !== undefined,
		}, {
			whileOff: {},
			whileOnChanged: true,
		});
	});
});
