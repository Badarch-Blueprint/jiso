/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Heuristics for mapping a DOM element picked in the Integrated Browser back to
 * the source markup that produced it (file + line range), so the agent can be
 * handed the real code instead of (or in addition to) a runtime DOM snapshot.
 *
 * The matcher is intentionally framework-agnostic and dependency-free: it works
 * on raw template text (`*.html`, `*.component.html`, `*.vue`, `*.svelte`,
 * `*.jsx`, `*.tsx`, ...) using only the element's tag name, static class set,
 * id, and nearby visible text. Runtime-only classes (Angular `ng-*`, CDK
 * `cdk-*`, classes toggled via `[class.x]`, etc.) are filtered out so they do
 * not skew matching. Everything here is pure so it can be unit-tested without a
 * workbench.
 */

/** A single node in the picked element's ancestor chain (root → leaf, leaf inclusive). */
export interface IElementNodeSignature {
	readonly tagName: string;
	readonly id?: string;
	readonly classNames?: readonly string[];
}

/** One candidate source location, line numbers 1-based inclusive. */
export interface ISourceMatch {
	readonly startLine: number;
	readonly endLine: number;
	readonly score: number;
}

/**
 * Minimum score for a match to be considered at all. Roughly "one distinctive
 * class token" — see {@link classTokenWeight}.
 */
export const MIN_MATCH_SCORE = 4;

/**
 * A match is only treated as *confident* (and therefore good enough to replace
 * the DOM-context attachment with a source reference) when the best candidate
 * beats the runner-up by at least this margin. Ties (e.g. several identical
 * list items) stay ambiguous and the caller falls back to the DOM snapshot.
 */
export const MATCH_AMBIGUITY_MARGIN = 3;

/** Maximum number of lines an element's open→close range may span before it is clamped. */
const MAX_RANGE_LINES = 400;

/** HTML void elements never have a closing tag. */
const VOID_ELEMENTS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Common layout/utility class atoms (Tailwind and friends). They are static in
 * source so they still count, but they are weak discriminators on their own and
 * are weighted low so a shared `flex` never outvotes a distinctive `dash-card`.
 */
const COMMON_UTILITY_CLASSES = new Set([
	'flex', 'grid', 'block', 'inline', 'inline-block', 'hidden', 'contents',
	'relative', 'absolute', 'fixed', 'sticky', 'static',
	'row', 'col', 'container', 'wrapper', 'content', 'inner', 'outer',
	'items-center', 'items-start', 'items-end', 'justify-center', 'justify-between',
	'justify-start', 'justify-end', 'flex-col', 'flex-row', 'flex-wrap',
	'w-full', 'h-full', 'text-center', 'text-left', 'text-right',
	'rounded', 'rounded-full', 'border', 'p-0', 'm-0'
]);

/**
 * Returns true for classes that only exist at runtime (framework internals or
 * state toggled by bindings) and must therefore be ignored when matching source.
 */
export function isRuntimeOnlyClass(token: string): boolean {
	return /^(ng-|_ng|cdk-|p-|mat-ripple)/.test(token)
		|| token === 'ng-star-inserted'
		|| /^ng-tns-/.test(token)
		|| /^ng-trigger/.test(token);
}

/** Split a raw `class` attribute / DOM classList into filtered static tokens. */
export function staticClassTokens(classNames: readonly string[] | undefined): string[] {
	if (!classNames) {
		return [];
	}
	return classNames
		.map(c => c.trim())
		.filter(c => c.length > 0 && !isRuntimeOnlyClass(c));
}

/** Rarity weight of a class token — distinctive (hyphenated/long) tokens count for more. */
function classTokenWeight(token: string): number {
	if (COMMON_UTILITY_CLASSES.has(token)) {
		return 1;
	}
	// Custom / BEM / component classes (e.g. `dash-card`, `stat-item`) are the
	// strongest signal; bare short utilities the weakest.
	if (token.includes('-') || token.length >= 6) {
		return 4;
	}
	return 2;
}

/**
 * Pick the single most distinctive token to seed a workspace text search for a
 * node: its id if present, else its rarest static class. Returns undefined when
 * the node carries nothing distinctive enough to search for (a bare `<div>`, or
 * one whose only classes are ubiquitous utilities like `flex` that would match
 * everything and never clear {@link MIN_MATCH_SCORE} on their own).
 */
export function pickSearchToken(node: IElementNodeSignature): string | undefined {
	if (node.id) {
		return node.id;
	}
	const classes = staticClassTokens(node.classNames);
	if (classes.length === 0) {
		return undefined;
	}
	const best = classes.slice().sort((a, b) => classTokenWeight(b) - classTokenWeight(a) || b.length - a.length)[0];
	return classTokenWeight(best) >= 2 ? best : undefined;
}

/**
 * Order the nodes to attempt matching, leaf first, then climbing to ancestors
 * that are actually searchable. A plain leaf `<div>` resolves via its nearest
 * distinctive ancestor (e.g. `section.dash-card`), pointing the agent at the
 * right block rather than nothing.
 */
export function selectAnchors(ancestors: readonly IElementNodeSignature[]): IElementNodeSignature[] {
	const anchors: IElementNodeSignature[] = [];
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const node = ancestors[i];
		if (node.tagName.startsWith('::')) {
			continue; // pseudo-elements (::before/::after) have no source tag
		}
		if (i === ancestors.length - 1 || pickSearchToken(node)) {
			anchors.push(node);
		}
	}
	return anchors;
}

/** Offsets of every `\n` in the text, for O(log n) line lookups. */
function buildLineOffsets(text: string): number[] {
	const offsets: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			offsets.push(i);
		}
	}
	return offsets;
}

/** 1-based line number of a character offset (binary search over newline offsets). */
function lineNumberAt(offsets: number[], offset: number): number {
	let lo = 0;
	let hi = offsets.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid] < offset) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo + 1;
}

/** Character offset at the start of a 1-based line (clamped to text length). */
function offsetAtLine(text: string, offsets: number[], line: number): number {
	if (line <= 1) {
		return 0;
	}
	if (line - 2 < offsets.length) {
		return offsets[line - 2] + 1;
	}
	return text.length;
}

/**
 * Index of the `>` that closes the opening tag starting at `tagStart`, honoring
 * quoted attribute values (Angular bindings such as `[disabled]="a > b"` contain
 * a bare `>`). Returns -1 if not found.
 */
function indexOfOpeningTagEnd(text: string, tagStart: number): number {
	let quote: string | undefined;
	for (let i = tagStart; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '>') {
			return i;
		}
	}
	return -1;
}

/** Compute the element's [startLine, endLine] by balancing same-name tags. */
function locateRange(text: string, offsets: number[], tagStart: number, tagName: string): { startLine: number; endLine: number } {
	const startLine = lineNumberAt(offsets, tagStart);
	const openTagEnd = indexOfOpeningTagEnd(text, tagStart);
	if (openTagEnd < 0) {
		return { startLine, endLine: startLine };
	}
	const openingTag = text.slice(tagStart, openTagEnd + 1);
	if (openingTag.endsWith('/>') || VOID_ELEMENTS.has(tagName.toLowerCase())) {
		return { startLine, endLine: lineNumberAt(offsets, openTagEnd) };
	}

	const lower = tagName.toLowerCase();
	const tokenRe = new RegExp(`<(/?)${escapeRegExp(lower)}(?=[\\s/>])`, 'gi');
	tokenRe.lastIndex = openTagEnd + 1;
	let depth = 1;
	let match: RegExpExecArray | null;
	while ((match = tokenRe.exec(text))) {
		if (lineNumberAt(offsets, match.index) - startLine > MAX_RANGE_LINES) {
			break;
		}
		if (match[1] === '/') {
			depth--;
			if (depth === 0) {
				return { startLine, endLine: lineNumberAt(offsets, match.index) };
			}
		} else {
			// Ignore self-closing duplicates of the same tag.
			const innerEnd = indexOfOpeningTagEnd(text, match.index);
			if (innerEnd < 0 || !text.slice(match.index, innerEnd + 1).endsWith('/>')) {
				depth++;
			}
		}
	}
	// Unbalanced (or clamped): fall back to a single-line reference.
	return { startLine, endLine: startLine };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse the static `class="..."` tokens out of an opening-tag substring. */
function parseSourceClasses(openingTag: string): string[] {
	const m = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(openingTag);
	const raw = m?.[2] ?? m?.[3];
	if (!raw) {
		return [];
	}
	return raw.trim().split(/\s+/).filter(Boolean);
}

/** Parse the static `id="..."` value out of an opening-tag substring. */
function parseSourceId(openingTag: string): string | undefined {
	const m = /\sid\s*=\s*("([^"]*)"|'([^']*)')/i.exec(openingTag);
	return m?.[2] ?? m?.[3] ?? undefined;
}

/**
 * Score how well a source opening tag matches the anchor node. Returns 0 when it
 * is not a credible match (so the caller can skip it).
 */
function scoreOpeningTag(openingTag: string, anchor: IElementNodeSignature): number {
	let score = 0;

	if (anchor.id && parseSourceId(openingTag) === anchor.id) {
		score += 10;
	}

	const wanted = new Set(staticClassTokens(anchor.classNames));
	if (wanted.size > 0) {
		const sourceClasses = parseSourceClasses(openingTag);
		for (const token of sourceClasses) {
			if (wanted.has(token)) {
				score += classTokenWeight(token);
			}
		}
	}

	return score;
}

/**
 * Find candidate source matches for `anchor` within a single file's `text`.
 * `leafText` (the picked element's visible text, possibly interpolated) breaks
 * ties between otherwise-identical siblings via a small proximity bonus.
 * Returns matches sorted by descending score.
 */
export function findElementMatches(text: string, anchor: IElementNodeSignature, leafText?: string): ISourceMatch[] {
	const lower = anchor.tagName.toLowerCase();
	if (!lower || lower.startsWith('::')) {
		return [];
	}
	const openRe = new RegExp(`<${escapeRegExp(lower)}(?=[\\s/>])`, 'gi');
	const normalizedLeafText = normalizeText(leafText);
	const offsets = buildLineOffsets(text);
	const matches: ISourceMatch[] = [];

	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text))) {
		const openTagEnd = indexOfOpeningTagEnd(text, m.index);
		if (openTagEnd < 0) {
			continue;
		}
		const openingTag = text.slice(m.index, openTagEnd + 1);
		let score = scoreOpeningTag(openingTag, anchor);
		if (score < MIN_MATCH_SCORE) {
			continue;
		}
		const { startLine, endLine } = locateRange(text, offsets, m.index, lower);

		// Proximity bonus: the element's visible text appears inside the matched block.
		if (normalizedLeafText && normalizedLeafText.length >= 3) {
			const block = normalizeText(text.slice(m.index, offsetAtLine(text, offsets, endLine + 1)));
			if (block.includes(normalizedLeafText)) {
				score += 3;
			}
		}

		matches.push({ startLine, endLine, score });
	}

	return matches.sort((a, b) => b.score - a.score);
}

/** Lowercased, whitespace-collapsed text for tolerant substring comparison. */
function normalizeText(value: string | undefined): string {
	return value ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}
