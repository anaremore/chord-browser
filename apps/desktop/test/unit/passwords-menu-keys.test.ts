/** The menu under a field and the keyboard (menu-keys.ts; the spike's 11 cases, M0 §3, plus Shift and Alt). */
import { describe, expect, it } from 'vitest';
import { routeMenuKey, routeTakenKey, type MenuKeyInput, type MenuKeyResult, type MenuKeys } from '../../src/main/passwords/menu-keys';

const open: MenuKeys = { index: 0, rows: 3 };
const key = (k: string, extra: Partial<MenuKeyInput> = {}): MenuKeyInput => ({ type: 'keyDown', key: k, ...extra });

describe('routing a key while the menu is open', () => {
  it.each<[string, MenuKeys | null, MenuKeyInput, MenuKeyResult]>([
    ['a closed menu takes nothing', null, key('ArrowDown'), { take: false, menu: null }],
    ['a key coming up is never taken', open, { type: 'keyUp', key: 'ArrowDown' }, { take: false, menu: open }],
    ['↓ moves', open, key('ArrowDown'), { take: true, menu: { index: 1, rows: 3 } }],
    ['↓ stops at the last row', { index: 2, rows: 3 }, key('ArrowDown'), { take: true, menu: { index: 2, rows: 3 } }],
    ['↑ stops at the first row', open, key('ArrowUp'), { take: true, menu: open }],
    ['Enter chooses and closes', { index: 1, rows: 3 }, key('Enter'), { take: true, menu: null, choose: 1 }],
    ['Escape closes', open, key('Escape'), { take: true, menu: null }],
    ['Tab closes and goes to the page', open, key('Tab'), { take: false, menu: null }],
    ['Shift+Tab too', open, key('Tab', { shift: true }), { take: false, menu: null }],
    ['a letter goes to the page', open, key('a'), { take: false, menu: open }],
    ['Ctrl+Enter isn’t the menu’s', open, key('Enter', { control: true }), { take: false, menu: open }],
    ['⌘↓ isn’t the menu’s', open, key('ArrowDown', { meta: true }), { take: false, menu: open }],
    ['Alt+↑ isn’t the menu’s', open, key('ArrowUp', { alt: true }), { take: false, menu: open }],
  ])('%s', (_name, menu, input, expected) => {
    expect(routeMenuKey(menu, input)).toEqual(expected);
  });
});

describe('the rest of a key the menu took (its keyUp, Enter’s character)', () => {
  const up = (k: string): MenuKeyInput => ({ type: 'keyUp', key: k });
  it.each<[string, string[], MenuKeyInput, { take: boolean; taken: string[] }]>([
    ['↓’s keyUp is the menu’s, and ends it', ['ArrowDown'], up('ArrowDown'), { take: true, taken: [] }],
    ['Enter’s keyUp too', ['Enter'], up('Enter'), { take: true, taken: [] }],
    ['Escape’s keyUp too', ['Escape'], up('Escape'), { take: true, taken: [] }],
    ['the carriage return Enter types', ['Enter'], { type: 'char', key: '\r' }, { take: true, taken: ['Enter'] }],
    ['a keyUp of a key it didn’t take goes to the page', ['ArrowDown'], up('a'), { take: false, taken: ['ArrowDown'] }],
    ['a keyDown is never this one’s', ['Enter'], key('Enter'), { take: false, taken: ['Enter'] }],
    ['nothing taken: nothing taken', [], up('Enter'), { take: false, taken: [] }],
    ['a character with no Enter taken goes to the page', ['ArrowDown'], { type: 'char', key: '\r' }, { take: false, taken: ['ArrowDown'] }],
    ['two keys held: one keyUp ends one', ['ArrowDown', 'ArrowUp'], up('ArrowUp'), { take: true, taken: ['ArrowDown'] }],
  ])('%s', (_name, taken, input, expected) => {
    const routed = routeTakenKey(new Set(taken), input);
    expect({ take: routed.take, taken: [...routed.taken] }).toEqual(expected);
  });
});
