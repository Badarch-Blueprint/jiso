/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { computeActiveWindow, isIdeRequest, ITranscriptRequest, parseTranscriptLine } from '../../node/claude/claudeLocalUsage.js';

const HOUR = 60 * 60 * 1000;

function request(overrides: Partial<ITranscriptRequest> & { requestId: string; timestampMs: number }): ITranscriptRequest {
	return {
		model: 'claude-fable-5',
		entrypoint: 'sdk-ts',
		inputTokens: 100,
		outputTokens: 10,
		cacheReadTokens: 1000,
		cacheCreationTokens: 50,
		...overrides,
	};
}

suite('claudeLocalUsage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseTranscriptLine', () => {

		test('parses an assistant usage entry and rejects everything else', () => {
			const line = JSON.stringify({
				type: 'assistant',
				timestamp: '2026-07-02T06:03:58.637Z',
				requestId: 'req_1',
				entrypoint: 'sdk-ts',
				message: { model: 'claude-fable-5', usage: { input_tokens: 5168, cache_creation_input_tokens: 10518, cache_read_input_tokens: 18588, output_tokens: 371 } },
			});
			assert.deepStrictEqual(parseTranscriptLine(line), {
				requestId: 'req_1',
				timestampMs: Date.parse('2026-07-02T06:03:58.637Z'),
				model: 'claude-fable-5',
				entrypoint: 'sdk-ts',
				inputTokens: 5168,
				outputTokens: 371,
				cacheReadTokens: 18588,
				cacheCreationTokens: 10518,
			});
			assert.deepStrictEqual(
				[isIdeRequest(request({ requestId: 'a', timestampMs: 0, entrypoint: 'sdk-ts' })), isIdeRequest(request({ requestId: 'b', timestampMs: 0, entrypoint: 'sdk-cli' })), isIdeRequest(request({ requestId: 'c', timestampMs: 0, entrypoint: 'cli' }))],
				[true, true, false],
			);
			assert.deepStrictEqual([
				parseTranscriptLine(''),
				parseTranscriptLine('{"type":"mode","mode":"normal"}'),
				parseTranscriptLine('{"type":"assistant","timestamp":"2026-07-02T06:03:58.637Z","message":{"usage":{}}}'),
				parseTranscriptLine('not json "usage"'),
			], [undefined, undefined, undefined, undefined]);
		});
	});

	suite('computeActiveWindow', () => {

		test('reconstructs the active window chain, dedupes double-logged requests, and aggregates per model', () => {
			const t0 = Date.parse('2026-07-02T00:00:00Z');
			const requests: ITranscriptRequest[] = [
				// First window: t0 .. t0+5h (expired by "now").
				request({ requestId: 'a', timestampMs: t0 }),
				// Second window starts at t0+6h; "now" is inside it.
				request({ requestId: 'b', timestampMs: t0 + 6 * HOUR, inputTokens: 200 }),
				request({ requestId: 'b', timestampMs: t0 + 6 * HOUR, inputTokens: 200 }), // double-logged
				request({ requestId: 'c', timestampMs: t0 + 7 * HOUR, model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }),
			];
			const window = computeActiveWindow(requests, t0 + 8 * HOUR);
			assert.deepStrictEqual(window, {
				windowStart: new Date(t0 + 6 * HOUR).toISOString(),
				windowEnd: new Date(t0 + 11 * HOUR).toISOString(),
				requests: 2,
				models: [
					{ model: 'claude-fable-5', requests: 1, inputTokens: 200, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 50 },
					{ model: 'claude-haiku-4-5', requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
				],
			});
		});

		test('returns undefined when the most recent window has expired or there are no requests', () => {
			const t0 = Date.parse('2026-07-02T00:00:00Z');
			assert.deepStrictEqual([
				computeActiveWindow([], t0),
				computeActiveWindow([request({ requestId: 'a', timestampMs: t0 })], t0 + 6 * HOUR),
			], [undefined, undefined]);
		});
	});
});
