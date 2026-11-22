/**
 * Keyboard routing (DESIGN.md §14). Reserved shortcuts are caught in
 * `before-input-event` on every WebContents, web pages and Chord's own UI
 * alike, before the page sees them. Page-first keys go to the page: in web
 * pages they reach Chord through the app menu (spike S8); in Chord's UI the
 * renderers handle them, since only they know whether a text field has focus
 * (⌘← must move the caret in the command bar, not go back).
 */
import { agentKeyAllowed, findShortcut, type ActionId } from '@chord/core';
import type { WebContents } from 'electron';
import { isAgentInput, yourKey } from './control/input';
import { platform } from './platform';
import { shortcutOverrides } from './shortcut-overrides';

export interface KeyboardHandlers {
  /** Run an action for this contents; return true if it was handled. */
  run(action: ActionId, contents: WebContents): boolean;
  /** Called when the Control key is released (ends the recent-tabs cycle). */
  onControlUp(contents: WebContents): void;
  /** True while this contents records a shortcut (Settings): every key goes to it, none to Chord. */
  paused?(contents: WebContents): boolean;
}

export function attachShortcuts(contents: WebContents, handlers: KeyboardHandlers): void {
  contents.on('before-input-event', (event, input) => {
    // Keys Chord sends a page for an agent (control/input.ts) are never Chord's shortcuts. One of press_key's goes to the
    // page as it is (an agent's Escape closes the page's dialog, though plain Escape is *Stop loading* too), and the
    // menu's accelerators are off while it's on its way (control/input.ts). Any other key (control/input.ts never sends
    // one: this is the second lock) is stopped here, so neither the page nor, unhandled, the ⋯ menu sees it.
    if (isAgentInput(contents)) {
      if (!agentKeyAllowed(input)) event.preventDefault();
      return;
    }
    // Your key: the menu's accelerators are yours again, before the page or the menu sees it.
    if (input.type === 'keyDown') yourKey(contents);
    if (handlers.paused?.(contents)) return;
    if (input.type === 'keyUp' && input.key === 'Control') {
      handlers.onControlUp(contents);
      return;
    }
    // Your changes from Settings → Keyboard shortcuts apply here, live.
    const shortcut = findShortcut(input, platform, 'reserved', shortcutOverrides());
    if (shortcut && handlers.run(shortcut.id, contents)) event.preventDefault();
  });
}
