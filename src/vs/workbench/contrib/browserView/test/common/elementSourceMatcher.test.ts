/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findElementMatches, pickSearchToken, selectAnchors, staticClassTokens } from '../../common/elementSourceMatcher.js';

// A representative Angular-style dashboard template. Line numbers are 1-based.
const TEMPLATE = [
	/*  1 */ '<section class="dash-card col-span-12 flex flex-col">',
	/*  2 */ '  <div class="header">',
	/*  3 */ '    <h2 class="title">{{ title }}</h2>',
	/*  4 */ '  </div>',
	/*  5 */ '  <div class="flex items-center justify-center">',
	/*  6 */ '    <div class="relative">',
	/*  7 */ '      <div echarts [options]="chartOption" class="w-64 h-64"></div>',
	/*  8 */ '      <div class="absolute inset-0 flex items-center justify-center">',
	/*  9 */ '        <div class="text-center">',
	/* 10 */ '          <div class="value">{{ data.present }}</div>',
	/* 11 */ '        </div>',
	/* 12 */ '      </div>',
	/* 13 */ '    </div>',
	/* 14 */ '  </div>',
	/* 15 */ '</section>',
].join('\n');

suite('elementSourceMatcher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('staticClassTokens drops runtime-only classes', () => {
		assert.deepStrictEqual(
			staticClassTokens(['dash-card', 'ng-star-inserted', 'flex', 'ng-tns-c12-3', '_nghost-abc', 'cdk-focused']),
			['dash-card', 'flex']
		);
	});

	test('pickSearchToken prefers id, then a distinctive class, else nothing', () => {
		assert.deepStrictEqual(
			[
				pickSearchToken({ tagName: 'section', id: 'main', classNames: ['flex'] }),
				pickSearchToken({ tagName: 'div', classNames: ['flex', 'dash-card'] }),
				pickSearchToken({ tagName: 'div', classNames: ['flex'] }), // ubiquitous utility only
				pickSearchToken({ tagName: 'div', classNames: ['ng-star-inserted'] }),
				pickSearchToken({ tagName: 'div' }),
			],
			['main', 'dash-card', undefined, undefined, undefined]
		);
	});

	test('selectAnchors lists the leaf first then climbs to searchable ancestors', () => {
		assert.deepStrictEqual(
			selectAnchors([
				{ tagName: 'section', classNames: ['dash-card'] },
				{ tagName: 'div', classNames: ['flex'] }, // not distinctive — skipped as an anchor
				{ tagName: 'span' },                       // plain leaf — kept (first)
			]),
			[
				{ tagName: 'span' },
				{ tagName: 'section', classNames: ['dash-card'] },
			]
		);
	});

	test('a distinctive element resolves to its full open→close range', () => {
		assert.deepStrictEqual(
			findElementMatches(TEMPLATE, { tagName: 'section', classNames: ['dash-card', 'col-span-12', 'flex', 'flex-col'] }),
			[{ startLine: 1, endLine: 15, score: 10 }]
		);
	});

	test('nested same-tag elements are balanced to the correct close tag', () => {
		assert.deepStrictEqual(
			findElementMatches(TEMPLATE, { tagName: 'div', classNames: ['absolute', 'inset-0', 'flex', 'items-center', 'justify-center'] }),
			[{ startLine: 8, endLine: 12, score: 8 }]
		);
	});

	test('void / self-closing elements span a single line', () => {
		assert.deepStrictEqual(
			findElementMatches('<input class="form-control" />', { tagName: 'input', classNames: ['form-control'] }),
			[{ startLine: 1, endLine: 1, score: 4 }]
		);
	});

	test('visible text breaks ties between otherwise-identical siblings', () => {
		const list = [
			'<ul>',
			'  <li class="stat-item">Present</li>',
			'  <li class="stat-item">Absent</li>',
			'</ul>',
		].join('\n');
		assert.deepStrictEqual(
			findElementMatches(list, { tagName: 'li', classNames: ['stat-item'] }, 'Absent'),
			[{ startLine: 3, endLine: 3, score: 7 }, { startLine: 2, endLine: 2, score: 4 }]
		);
	});
});
