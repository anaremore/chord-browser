/**
 * Which of a window's two popover pages may use which password channel (S17 §8: every handler
 * checks its sender). The popover's own page has the cards (save, update, unlock), so only it
 * answers them and sees a card's password for its eye; the menu's view (the popover's page at
 * `#menu`) shows the menu under a field, so only it chooses a row. Neither can stand in for the
 * other. Pure, so the rule is unit-tested.
 */

/** A window as far as this needs it: its id, its popover's page, and its menu's page once made. */
export interface PopoverPages<C> {
  readonly id: string;
  readonly cards: C;
  readonly menu: C | undefined;
}

/** The window whose `view` page sent this, or null: a sender that's another window's, or the other page, gets nothing. */
export function popoverSender<C>(windows: Iterable<PopoverPages<C>>, sender: C, view: 'cards' | 'menu'): string | null {
  for (const w of windows) {
    const page = view === 'cards' ? w.cards : w.menu;
    if (page !== undefined && page === sender) return w.id;
  }
  return null;
}
