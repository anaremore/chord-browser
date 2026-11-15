// node --test spikes/s17-passwords/probes/keys.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeKey } from './keys.mjs';

const open = { index: 0, rows: 3 };
const key = (k, extra = {}) => ({ type: 'keyDown', key: k, ...extra });
const cases = [
  ['closed menu takes nothing', null, key('ArrowDown'), { take: false, menu: null }],
  ['key up is never taken', open, { type: 'keyUp', key: 'ArrowDown' }, { take: false, menu: open }],
  ['down moves', open, key('ArrowDown'), { take: true, menu: { index: 1, rows: 3 } }],
  ['down stops at the last row', { index: 2, rows: 3 }, key('ArrowDown'), { take: true, menu: { index: 2, rows: 3 } }],
  ['up stops at the first row', open, key('ArrowUp'), { take: true, menu: open }],
  ['enter chooses and closes', { index: 1, rows: 3 }, key('Enter'), { take: true, menu: null, choose: 1 }],
  ['escape closes', open, key('Escape'), { take: true, menu: null }],
  ['tab closes and goes to the page', open, key('Tab'), { take: false, menu: null }],
  ['a letter goes to the page', open, key('a'), { take: false, menu: open }],
  ['ctrl+enter is not the menu’s', open, key('Enter', { control: true }), { take: false, menu: open }],
  ['cmd+down is not the menu’s', open, key('ArrowDown', { meta: true }), { take: false, menu: open }],
];
for (const [name, menu, input, expected] of cases) test(name, () => assert.deepEqual(routeKey(menu, input), expected));
