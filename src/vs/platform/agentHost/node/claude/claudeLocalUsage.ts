/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*---------------------------------------------------------------------------------------------
 *  FORK: local 5-hour-window usage, computed from `~/.claude` transcripts.
 *
 *  Anthropic does not expose the subscription's 5-hour rate-limit window for
 *  every plan (team plans get `rate_limits: null`), and never exposes the
 *  underlying limit. But every request the `claude` binary makes — terminal
 *  CLI and IDE sessions alike — is recorded in the local transcript store
 *  with per-request token usage and a timestamp. This module reconstructs
 *  the CURRENT 5-hour window from those records: when it started, when it
 *  resets, and how many requests/tokens were consumed inside it, per model.
 *
 *  Window semantics mirror Anthropic's documented behavior: a window starts
 *  with the first request after the previous window expired and lasts
 *  exactly five hours. The reconstruction walks the last day of request
 *  timestamps and simulates consecutive windows.
 *
 *  Entirely local file reads — no API calls, no wire changes. Same-machine
 *  scope only (like the SDK's own `/usage` behaviors analytics): requests
 *  from other devices are invisible, so treat the result as a lower bound.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import type { IClaudeLocalWindowModelUsage, IClaudeLocalWindowUsage } from '../../common/state/protocol/commands.js';

/** Length of an Anthropic subscription usage window. */
const WINDOW_MS = 5 * 60 * 60 * 1000;

/** How far back to read transcripts when reconstructing windows. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** One deduplicated API request parsed from a transcript. */
export interface ITranscriptRequest {
	readonly requestId: string;
	readonly timestampMs: number;
	readonly model: string;
	/** Transcript `entrypoint`: `cli` (terminal), `sdk-ts` / `sdk-cli` (this IDE's agent host). */
	readonly entrypoint: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
}

/**
 * Whether a request came from THIS IDE's agent host rather than the terminal
 * CLI. Rate-limit windows are per account server-side, and a request may
 * predate the CLI-login-only auth model (or the user may export a different
 * credential in their shell), so the
 * IDE's usage dialog reconstructs the window from IDE requests only —
 * otherwise terminal activity from another account pollutes the window
 * anchor and totals (observed: local estimate disagreed with the terminal's
 * official `/usage` precisely because the chains were merged).
 */
export function isIdeRequest(request: ITranscriptRequest): boolean {
	return request.entrypoint.startsWith('sdk');
}

/**
 * Parse one transcript JSONL line into a request record, or undefined for
 * non-request lines (mode markers, snapshots, user messages, entries without
 * usage). Tolerant of shape drift: any missing field disqualifies the line
 * rather than throwing.
 */
export function parseTranscriptLine(line: string): ITranscriptRequest | undefined {
	if (line.length === 0 || !line.includes('"usage"')) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const entry = parsed as { type?: unknown; timestamp?: unknown; requestId?: unknown; entrypoint?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
	if (entry.type !== 'assistant' || typeof entry.timestamp !== 'string' || typeof entry.requestId !== 'string') {
		return undefined;
	}
	const usage = entry.message?.usage;
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	const timestampMs = Date.parse(entry.timestamp);
	if (!Number.isFinite(timestampMs)) {
		return undefined;
	}
	const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
	return {
		requestId: entry.requestId,
		timestampMs,
		model: typeof entry.message?.model === 'string' ? entry.message.model : 'unknown',
		entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : 'unknown',
		inputTokens: num(usage.input_tokens),
		outputTokens: num(usage.output_tokens),
		cacheReadTokens: num(usage.cache_read_input_tokens),
		cacheCreationTokens: num(usage.cache_creation_input_tokens),
	};
}

/**
 * Reconstruct the ACTIVE 5-hour window at `nowMs` from request records and
 * aggregate consumption inside it. Pure — exported for unit testing.
 *
 * Requests are deduplicated by `requestId` first: the transcript store
 * double-logs assistant entries (same request appears in more than one file
 * and sometimes twice in one file) but the API bills once.
 *
 * Returns undefined when no window is active (no request within the last
 * five hours of simulated window chains).
 */
export function computeActiveWindow(requests: readonly ITranscriptRequest[], nowMs: number): IClaudeLocalWindowUsage | undefined {
	const byId = new Map<string, ITranscriptRequest>();
	for (const request of requests) {
		if (!byId.has(request.requestId)) {
			byId.set(request.requestId, request);
		}
	}
	const sorted = [...byId.values()].sort((a, b) => a.timestampMs - b.timestampMs);
	if (sorted.length === 0) {
		return undefined;
	}

	// Simulate consecutive windows: each starts at the first request after the
	// previous window expired and lasts WINDOW_MS.
	let windowStart: number | undefined;
	let windowEnd = -Infinity;
	for (const request of sorted) {
		if (request.timestampMs >= windowEnd) {
			windowStart = request.timestampMs;
			windowEnd = windowStart + WINDOW_MS;
		}
	}
	if (windowStart === undefined || nowMs >= windowEnd) {
		// The most recent window already expired — nothing active right now.
		return undefined;
	}

	const models = new Map<string, { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>();
	let totalRequests = 0;
	for (const request of sorted) {
		if (request.timestampMs < windowStart || request.timestampMs >= windowEnd) {
			continue;
		}
		totalRequests++;
		let m = models.get(request.model);
		if (!m) {
			m = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
			models.set(request.model, m);
		}
		m.requests++;
		m.inputTokens += request.inputTokens;
		m.outputTokens += request.outputTokens;
		m.cacheReadTokens += request.cacheReadTokens;
		m.cacheCreationTokens += request.cacheCreationTokens;
	}

	const modelUsage: IClaudeLocalWindowModelUsage[] = [...models.entries()]
		.map(([model, m]) => ({ model, ...m }))
		.sort((a, b) => (b.inputTokens + b.outputTokens + b.cacheCreationTokens) - (a.inputTokens + a.outputTokens + a.cacheCreationTokens));

	return {
		windowStart: new Date(windowStart).toISOString(),
		windowEnd: new Date(windowEnd).toISOString(),
		requests: totalRequests,
		models: modelUsage,
	};
}

/** Resolve the Claude home directory (transcript store root). */
function claudeHome(): string {
	return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Scan the local transcript store and compute the active 5-hour window.
 * Only files modified within the lookback horizon are read (a window can
 * start at most 5h ago, but reconstructing its START needs the prior chain).
 * Any filesystem error degrades to `undefined` — the caller renders the
 * report without the local-window section.
 */
export async function computeLocalWindowUsage(nowMs: number = Date.now()): Promise<IClaudeLocalWindowUsage | undefined> {
	try {
		const projectsDir = join(claudeHome(), 'projects');
		const cutoffMs = nowMs - LOOKBACK_MS;
		const requests: ITranscriptRequest[] = [];
		const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
		for (const project of projectEntries) {
			if (!project.isDirectory()) {
				continue;
			}
			const dir = join(projectsDir, project.name);
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith('.jsonl')) {
					continue;
				}
				const path = join(dir, file);
				try {
					const stat = await fs.stat(path);
					if (stat.mtimeMs < cutoffMs) {
						continue;
					}
					const content = await fs.readFile(path, 'utf8');
					for (const line of content.split('\n')) {
						const request = parseTranscriptLine(line);
						// IDE requests only — see {@link isIdeRequest}.
						if (request && request.timestampMs >= cutoffMs && isIdeRequest(request)) {
							requests.push(request);
						}
					}
				} catch {
					// Unreadable file (being written, permissions) — skip it.
				}
			}
		}
		return computeActiveWindow(requests, nowMs);
	} catch {
		return undefined;
	}
}
