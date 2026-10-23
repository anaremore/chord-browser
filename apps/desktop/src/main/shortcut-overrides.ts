/**
 * Your shortcut changes as main applies them (Settings → Keyboard shortcuts,
 * DESIGN.md §14): the reserved-key router (keyboard.ts) and every menu
 * accelerator (menu.ts) read them from here. Browser keeps this in step with
 * settings and rebuilds the menus when it changes.
 */
import type { ShortcutOverrides } from '@chord/core';

let current: ShortcutOverrides = {};

export const shortcutOverrides = (): ShortcutOverrides => current;

export function setShortcutOverrides(next: ShortcutOverrides): void {
  current = next;
}
