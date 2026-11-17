/**
 * The menu under a sign-in field, and the keyboard (S17 §9; M0 §3, ported from the spike's
 * `probes/keys.mjs`). Focus never leaves the page's field: while the menu is open, main sees
 * each key first (`before-input-event`) and this says what it does. A key the menu takes is
 * stopped there, so the page never sees it; any other goes to the page as usual.
 *
 * Pure, so every key is unit-tested: Playwright's key presses never reach `before-input-event`
 * (E2E presses them with `webContents.sendInputEvent`, which does).
 */

import { matches, PASSWORD_REGENERATE_KEYS, type Platform } from '@chord/core';

/** The open menu: its highlighted row, how many rows it has, and whether it has a generated password ↻ can change. */
export interface MenuKeys {
  readonly index: number;
  readonly rows: number;
  readonly regenerate?: boolean;
}

/** The parts of Electron's `Input` the routing reads. */
export interface MenuKeyInput {
  readonly type: string;
  readonly key: string;
  /** The physical key (`KeyA`, `Enter`, `NumpadEnter`): what a keyUp is matched to its keyDown by, where Electron gives it. */
  readonly code?: string;
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
  /** ↻ by key (`PASSWORD_REGENERATE_KEYS`): another generated password, the menu left as it is. */
  readonly regenerate?: true;
}

export function routeMenuKey(menu: MenuKeys | null, input: MenuKeyInput, platform: Platform = process.platform as Platform): MenuKeyResult {
  if (!menu || input.type !== 'keyDown') return { take: false, menu };
  const key = { code: '', control: false, meta: false, alt: false, shift: false, ...input };
  if (menu.regenerate && matches(key, PASSWORD_REGENERATE_KEYS, platform)) return { take: true, menu, regenerate: true };
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

/** Which key an event is: its physical key where Electron says (a keyUp's `key` can differ, with Shift), else its `key`. */
export const keyIdOf = (input: MenuKeyInput): string => input.code || input.key;

/** How many other events a closed menu's listener waits through for a taken key's keyUp, which may never come (focus left the window). */
export const TAKEN_KEY_PATIENCE = 10;

/**
 * After the menu took a key's keyDown, the rest of that key is the menu's too: its keyUp, and
 * the character Enter makes. Otherwise the page would see half a key. A form that submits on
 * Enter's keyup would submit before the fill, and a site's own suggestion list moves on ↓'s
 * keyup. This is asked for every event that isn't a keyDown the open menu routes, while the
 * menu is open and once it closes. `taken` holds each key by `keyIdOf`, so another key pressed
 * in between doesn't let a taken key's keyUp through. Once the menu has closed, the listener goes
 * when nothing is `taken`, or after `TAKEN_KEY_PATIENCE` events this doesn't take.
 */
export function routeTakenKey(taken: ReadonlySet<string>, input: MenuKeyInput): { take: boolean; taken: ReadonlySet<string> } {
  const id = keyIdOf(input);
  if (input.type === 'keyUp' && taken.has(id)) {
    const rest = new Set(taken);
    rest.delete(id);
    return { take: true, taken: rest };
  }
  // The character a taken key types (Enter's carriage return) goes with it; its keyUp still ends it.
  const enter = taken.has('Enter') || taken.has('NumpadEnter');
  if (input.type === 'char' && (taken.has(id) || (enter && (input.key === '\r' || input.key === '\n')))) return { take: true, taken };
  return { take: false, taken };
}
