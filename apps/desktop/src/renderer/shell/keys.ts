import { keycapFor, type ActionId, type ShortcutOverrides } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';
import { createContext, useContext } from 'react';

/** Your shortcut changes (Settings → Keyboard shortcuts), provided once at the top of the shell. */
const Shortcuts = createContext<ShortcutOverrides>({});
export const ShortcutsProvider = Shortcuts.Provider;

/**
 * Keycaps that follow your shortcut changes: `keycap('tab.new')` is "⌘T" or
 * "Ctrl+T" (or whatever you set it to), and `withKeys` adds it to a tooltip
 * ("Reload  Ctrl+R").
 */
export function useKeys(info: SystemInfo): { keycap(id: ActionId): string; withKeys(label: string, id: ActionId): string } {
  const overrides = useContext(Shortcuts);
  const keycap = (id: ActionId) => keycapFor(id, info.platform, overrides);
  return {
    keycap,
    withKeys: (label, id) => {
      const keys = keycap(id);
      return keys ? `${label}  ${keys}` : label;
    },
  };
}
