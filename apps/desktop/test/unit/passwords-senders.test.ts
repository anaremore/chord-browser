/** Which popover page may use which password channel (main/passwords/senders.ts; the general review, round 2). */
import { describe, expect, it } from 'vitest';
import { popoverSender } from '../../src/main/passwords/senders';

const windows = [
  { id: 'w1', cards: 'w1-popover', menu: 'w1-menu' },
  { id: 'w2', cards: 'w2-popover', menu: undefined },
];

describe('the save card answers only its window’s cards page; the menu only its menu view', () => {
  it.each<[string, string, 'cards' | 'menu', string | null]>([
    ['the cards page, on a save-card channel', 'w1-popover', 'cards', 'w1'],
    ['the menu view, on a save-card channel (`passwords:saveCard`, `:saveCardReveal`): refused', 'w1-menu', 'cards', null],
    ['the menu view, choosing a row', 'w1-menu', 'menu', 'w1'],
    ['the cards page, choosing a row: refused', 'w1-popover', 'menu', null],
    ['another window’s cards page answers for that window only', 'w2-popover', 'cards', 'w2'],
    ['a window with no menu view yet: nothing chooses there', 'w2-popover', 'menu', null],
    ['a page that’s no popover (a tab)', 'some-tab', 'cards', null],
  ])('%s', (_name, sender, view, expected) => {
    expect(popoverSender(windows, sender, view)).toBe(expected);
  });

  it('a sender that is undefined never matches a window without a menu view', () => {
    expect(popoverSender(windows, undefined as unknown as string, 'menu')).toBeNull();
  });
});
