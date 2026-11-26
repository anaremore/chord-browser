/**
 * #322's SF1 (Neon) and S2 (Opus): which pages a window shows, for the focus an action gives back: as the floating views
 * give the keyboard back (window.ts' shownHere), and the cards only while you own them. A window closed asks nothing.
 */
import { describe, expect, it } from 'vitest';
import { registerWindowShown, shownIn, unregisterWindowShown, windowShown, type ShownParts } from '../../src/main/window-shown';

type Page = { name: string; isDestroyed(): boolean };
const page = (name: string, destroyed = false): Page => ({ name, isDestroyed: () => destroyed });

function parts(over: Partial<ShownParts<Page>> = {}): ShownParts<Page> & Record<string, Page> {
  const pages = {
    shellPage: page('shell'),
    tab: page('tab'),
    hiddenPane: page('hidden pane'),
    offPane: page('pane not visible'),
    parkedPage: page('parked'),
    overlayPage: page('overlay'),
    peekPage: page('peek'),
    tools: page('docked devtools'),
    cards: page('cards'),
    menu: page('menu'),
  };
  return {
    ...pages,
    shell: pages.shellPage,
    panes: [
      { page: pages.tab, visible: true, hidden: false },
      { page: pages.hiddenPane, visible: true, hidden: true },
      { page: pages.offPane, visible: false, hidden: false },
    ],
    parked: [pages.parkedPage],
    overlay: pages.overlayPage,
    overlayOpen: true,
    peek: pages.peekPage,
    docked: [pages.tools],
    floating: [pages.cards, pages.menu],
    yours: null,
    ...over,
  } as unknown as ShownParts<Page> & Record<string, Page>;
}

describe('what a window shows (#322’s SF1)', () => {
  it('the shell, a pane on screen, the command bar while open, Peek on screen, a docked DevTools; never a hidden or parked pane', () => {
    const w = parts();
    const rows: [string, Page, boolean][] = [
      ['the shell', w.shellPage!, true],
      ['the tab you see', w.tab!, true],
      ['a hidden pane', w.hiddenPane!, false],
      ['a pane not visible', w.offPane!, false],
      ['a parked page', w.parkedPage!, false],
      ['the command bar (open)', w.overlayPage!, true],
      ['Peek on screen', w.peekPage!, true],
      ['a docked DevTools', w.tools!, true],
      ['another window’s page', page('elsewhere'), false],
      ['a page closed', page('closed', true), false],
    ];
    for (const [what, p, seen] of rows) expect(shownIn(p, w, { floating: true }), what).toBe(seen);
  });

  it('the command bar closed, and Peek off screen: not shown', () => {
    const w = parts({ overlayOpen: false, peek: null });
    expect(shownIn(w.overlayPage!, w, { floating: true })).toBe(false);
    expect(shownIn(w.peekPage!, w, { floating: true })).toBe(false);
  });

  it('the cards (the popover): shown only while you own them; the menu never', () => {
    const w = parts();
    expect(shownIn(w.cards!, w, { floating: true }), 'cards not yours').toBe(false);
    const yours = { ...w, yours: w.cards! };
    expect(shownIn(w.cards!, yours, { floating: true }), 'cards yours').toBe(true);
    expect(shownIn(w.cards!, yours), 'never where the floating views give the keyboard back (shownHere)').toBe(false);
    expect(shownIn(w.menu!, yours, { floating: true }), 'the menu').toBe(false);
  });

  it('a window closed is asked nothing again', () => {
    const win = {};
    registerWindowShown(win, { seen: () => true, page: () => null });
    expect(windowShown(win)).not.toBeNull();
    unregisterWindowShown(win);
    expect(windowShown(win)).toBeNull();
  });
});
