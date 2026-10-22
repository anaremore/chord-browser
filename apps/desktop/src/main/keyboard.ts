/**
 * Keyboard routing (DESIGN.md §14). Reserved shortcuts are caught in
 * `before-input-event` on every WebContents, web pages and Chord's own UI
 * alike, before the page sees them. Page-first keys go to the page: in web
 * pages they reach Chord through the app menu (spike S8); in Chord's UI the
 * renderers handle them, since only they know whether a text field has focus
 * (⌘← must move the caret in the command bar, not go back).
 */
import { findShortcut, type ActionId } from '@chord/core';
import type { WebContents } from 'electron';
import { platform } from './platform';

export interface KeyboardHandlers {
  /** Run an action for this contents; return true if it was handled. */
  run(action: ActionId, contents: WebContents): boolean;
  /** Called when the Control key is released (ends the recent-tabs cycle). */
  onControlUp(contents: WebContents): void;
}

export function attachShortcuts(contents: WebContents, handlers: KeyboardHandlers): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyUp' && input.key === 'Control') {
      handlers.onControlUp(contents);
      return;
    }
    const shortcut = findShortcut(input, platform, 'reserved');
    if (shortcut && handlers.run(shortcut.id, contents)) event.preventDefault();
  });
}
