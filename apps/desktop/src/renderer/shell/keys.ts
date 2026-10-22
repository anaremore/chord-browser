import { formatKeys, shortcutById, type ActionId } from '@chord/core';
import type { SystemInfo } from '@chord/ipc';

/** The keycap for an action on this platform: "⌘L", "Ctrl+L". */
export function keycap(id: ActionId, info: SystemInfo): string {
  const keys = shortcutById(id);
  const first = keys ? (info.platform === 'darwin' ? keys.mac : keys.other)[0] : undefined;
  return first ? formatKeys(first, info.platform) : '';
}

/** A label with its shortcut, for tooltips: "Reload  Ctrl+R". */
export function withKeys(label: string, id: ActionId, info: SystemInfo): string {
  const keys = keycap(id, info);
  return keys ? `${label}  ${keys}` : label;
}
