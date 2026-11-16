/**
 * The menu under a sign-in field, and the keyboard (S17 §9; M0 §3, ported from the spike's
 * `probes/keys.mjs`). Focus never leaves the page's field: while the menu is open, main sees
 * each key first (`before-input-event`) and this says what it does. A key the menu takes is
 * stopped there, so the page never sees it; any other goes to the page as usual.
 *
 * Pure, so every key is unit-tested: Playwright's key presses never reach `before-input-event`
 * (E2E presses them with `webContents.sendInputEvent`, which does).
 */

/** The open menu: its highlighted row, and how many rows it has. */
export interface MenuKeys {
  readonly index: number;
  readonly rows: number;
}

/** The parts of Electron's `Input` the routing reads. */
export interface MenuKeyInput {
  readonly type: string;
  readonly key: string;
  readonly control?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

/**
 * What a key does with the menu: `take` (stop it before the page sees it), the menu after it
 * (null: closed), and `choose`, the row Enter picked.
 */
export interface MenuKeyResult {
  readonly take: boolean;
  readonly menu: MenuKeys | null;
  readonly choose?: number;
}

export function routeMenuKey(menu: MenuKeys | null, input: MenuKeyInput): MenuKeyResult {
  if (!menu || input.type !== 'keyDown') return { take: false, menu };
  // A shortcut with a modifier is the app's or the page's, never the menu's.
  if (input.control || input.meta || input.alt) return { take: false, menu };
  switch (input.key) {
    case 'ArrowDown':
      return { take: true, menu: { ...menu, index: Math.min(menu.rows - 1, menu.index + 1) } };
    case 'ArrowUp':
      return { take: true, menu: { ...menu, index: Math.max(0, menu.index - 1) } };
    case 'Enter':
      return { take: true, menu: null, choose: menu.index };
    case 'Escape':
      return { take: true, menu: null };
    // Tab (and Shift+Tab) moves on in the page and closes the menu; typing goes to the page and leaves it open.
    case 'Tab':
      return { take: false, menu: null };
    default:
      return { take: false, menu };
  }
}
