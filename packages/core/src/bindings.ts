/**
 * Changing shortcuts (Settings → Keyboard shortcuts, DESIGN.md §14): turning a
 * key press into a combination, checking it's one Chord can use, finding what
 * else already uses it, and cleaning what was saved.
 */
import {
  SHORTCUTS,
  defaultKeysFor,
  formatKeys,
  keyOf,
  keysFor,
  sameCombo,
  type ActionId,
  type KeyInput,
  type Platform,
  type Shortcut,
  type ShortcutOverrides,
} from './shortcuts';

/** Most keys one action can have. */
export const MAX_KEYS_PER_ACTION = 4;

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'CapsLock', 'Symbol']);
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const NAMED_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Escape',
  'Tab',
  'Space',
  'Enter',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Plus',
]);
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;

/**
 * A key press as a portable combination ("Mod+Shift+T"), or null while only
 * modifiers are down or the key has no name Chord can use. ⌘ is `Mod` on
 * macOS and ⌃ is `Ctrl`; elsewhere Ctrl is `Mod` and the Windows/Super key is
 * `Meta`.
 */
export function comboFromInput(input: KeyInput, platform: Platform): string | null {
  if (MODIFIER_KEYS.has(input.key) || ['Unidentified', 'Dead', 'Process'].includes(input.key)) return null;
  const key = keyOf(input);
  if (!knownKey(key)) return null;
  const mods: string[] = [];
  if (platform === 'darwin') {
    if (input.meta) mods.push('Mod');
    if (input.control) mods.push('Ctrl');
  } else if (input.control) mods.push('Mod');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (platform !== 'darwin' && input.meta) mods.push('Meta');
  return [...mods, key].join('+');
}

function knownKey(key: string): boolean {
  if (key.length === 1) return key.trim() !== '' && key !== '+';
  return FUNCTION_KEY.test(key) || NAMED_KEYS.has(key);
}

/** The combination's modifiers and key, or null if it isn't written the way Chord writes them. */
function parts(combo: string): { mods: string[]; key: string } | null {
  if (typeof combo !== 'string' || combo.length === 0 || combo.length > 48) return null;
  const all = combo.split('+');
  const key = all.pop()!;
  const mods = all;
  if (!knownKey(key)) return null;
  if (mods.some((m) => !(MODIFIERS as readonly string[]).includes(m)) || new Set(mods).size !== mods.length) return null;
  return { mods, key };
}

/** Shortcuts the OS (or text editing) keeps for itself, with what each does there. */
const KEPT: Record<Platform, { combo: string; what: string }[]> = {
  // support.apple.com/102650 (Mac keyboard shortcuts), October 2026.
  darwin: [
    { combo: 'Mod+Space', what: 'macOS uses ⌘Space for Spotlight.' },
    { combo: 'Ctrl+Mod+Space', what: 'macOS uses ⌃⌘Space for the Character Viewer.' },
    { combo: 'Ctrl+Space', what: 'macOS uses ⌃Space to switch input sources.' },
    { combo: 'Ctrl+Alt+Space', what: 'macOS uses ⌃⌥Space to switch input sources.' },
    { combo: 'Mod+Tab', what: 'macOS uses ⌘Tab to switch apps.' },
    { combo: 'Mod+Shift+Tab', what: 'macOS uses ⇧⌘Tab to switch apps.' },
    { combo: 'Mod+Alt+Escape', what: 'macOS uses ⌥⌘Esc for Force Quit.' },
    { combo: 'Ctrl+Mod+Q', what: 'macOS uses ⌃⌘Q to lock your Mac.' },
    { combo: 'Mod+Shift+3', what: 'macOS uses ⇧⌘3 for screenshots.' },
    { combo: 'Mod+Shift+4', what: 'macOS uses ⇧⌘4 for screenshots.' },
    { combo: 'Mod+Shift+5', what: 'macOS uses ⇧⌘5 for screenshots.' },
    { combo: 'Mod+H', what: 'macOS uses ⌘H to hide the app.' },
    { combo: 'Mod+M', what: 'macOS uses ⌘M to minimize the window.' },
  ],
  // support.microsoft.com, "Keyboard shortcuts in Windows", October 2026.
  win32: [
    { combo: 'Alt+Tab', what: 'Windows uses Alt+Tab to switch windows.' },
    { combo: 'Alt+Shift+Tab', what: 'Windows uses Alt+Shift+Tab to switch windows.' },
    { combo: 'Alt+F4', what: 'Windows uses Alt+F4 to close the window.' },
    { combo: 'Mod+Escape', what: 'Windows uses Ctrl+Esc to open Start.' },
    { combo: 'Alt+Escape', what: 'Windows uses Alt+Esc to cycle through windows.' },
    { combo: 'Mod+Shift+Escape', what: 'Windows uses Ctrl+Shift+Esc for Task Manager.' },
    { combo: 'Alt+Space', what: 'Windows uses Alt+Space for the window menu.' },
    { combo: 'Mod+Alt+Delete', what: 'Windows keeps Ctrl+Alt+Delete for itself.' },
  ],
  // help.gnome.org, "Useful keyboard shortcuts", October 2026.
  linux: [
    { combo: 'Alt+Tab', what: 'Your desktop uses Alt+Tab to switch windows.' },
    { combo: 'Alt+Shift+Tab', what: 'Your desktop uses Alt+Shift+Tab to switch windows.' },
    { combo: 'Alt+F2', what: 'Your desktop uses Alt+F2 to run commands.' },
    { combo: 'Alt+F4', what: 'Your desktop uses Alt+F4 to close the window.' },
    { combo: 'Mod+Alt+Delete', what: 'Your desktop keeps Ctrl+Alt+Delete for itself.' },
  ],
};

/** Text editing everywhere in Chord and on the web. */
const EDITING = [
  { combo: 'Mod+C', what: 'copying' },
  { combo: 'Mod+X', what: 'cutting' },
  { combo: 'Mod+V', what: 'pasting' },
  { combo: 'Mod+A', what: 'selecting everything' },
  { combo: 'Mod+Z', what: 'undo' },
  { combo: 'Mod+Shift+Z', what: 'redo' },
] as const;

/**
 * Why a combination can't be a shortcut on this platform, as a plain
 * sentence, or null if it can. Without a platform, only the rules that hold
 * everywhere are checked (for saved settings read before the platform is known).
 */
export function checkCombo(combo: string, platform?: Platform): string | null {
  const p = parts(combo);
  if (!p) return 'Chord can’t use that key in a shortcut.';
  const { mods, key } = p;
  const hasModifier = mods.some((m) => m === 'Mod' || m === 'Ctrl' || m === 'Alt' || m === 'Meta');
  if (!hasModifier && !FUNCTION_KEY.test(key)) {
    return platform === 'darwin' ? 'Add ⌘, ⌃ or ⌥, so typing never sets it off.' : 'Add Ctrl or Alt, so typing never sets it off.';
  }
  if (!platform) return null;
  if (mods.includes('Meta')) {
    if (platform === 'win32') return 'Windows keeps Windows-key shortcuts for itself.';
    if (platform === 'linux') return 'Your desktop keeps Super-key shortcuts for itself.';
  }
  const kept = KEPT[platform].find((k) => sameCombo(k.combo, combo, platform));
  if (kept) return kept.what;
  const editing = [...EDITING, ...(platform === 'darwin' ? [] : [{ combo: 'Mod+Y', what: 'redo' }])].find((e) => sameCombo(e.combo, combo, platform));
  if (editing) return `Chord keeps ${formatKeys(editing.combo, platform)} for ${editing.what}.`;
  return null;
}

/** The action, other than `except`, that already uses this combination. */
export function shortcutUsing(combo: string, platform: Platform, overrides: ShortcutOverrides, except?: ActionId): Shortcut | undefined {
  return SHORTCUTS.find((sc) => sc.id !== except && keysFor(sc, platform, overrides).some((k) => sameCombo(k, combo, platform)));
}

/** Whether two lists name the same keys in the same order. */
export function sameKeys(a: readonly string[], b: readonly string[], platform: Platform): boolean {
  return a.length === b.length && a.every((k, i) => sameCombo(k, b[i]!, platform));
}

/**
 * An action's keys after a change, as the override to save: null when they're
 * the registry's own again (so ↺ disappears), else the list.
 */
export function overrideFor(id: ActionId, keys: readonly string[], platform: Platform): readonly string[] | null {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  return shortcut && sameKeys(keys, defaultKeysFor(shortcut, platform), platform) ? null : keys;
}

/**
 * Saved shortcut changes that still make sense: known actions only, and
 * combinations that pass `checkCombo` (with the platform, when known), at
 * most four per action, no repeats.
 */
export function cleanOverrides(raw: unknown, platform?: Platform): ShortcutOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<ActionId, readonly string[]>> = {};
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!SHORTCUTS.some((s) => s.id === id) || !Array.isArray(list)) continue;
    out[id as ActionId] = cleanKeys(id as ActionId, list, platform);
  }
  return out;
}

/**
 * One action's combinations, kept only if usable, without repeats. The
 * registry's own keys for the action always pass, even ones a person couldn't
 * record (Esc for Stop loading), so adding a key never loses a default.
 */
export function cleanKeys(id: ActionId, list: readonly unknown[], platform?: Platform): string[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  const defaults = shortcut ? [...shortcut.mac, ...shortcut.other] : [];
  const keys: string[] = [];
  for (const combo of list) {
    if (typeof combo !== 'string') continue;
    if (!defaults.includes(combo) && checkCombo(combo, platform)) continue;
    // Repeats are judged on macOS's terms, where Ctrl and ⌘ differ; that keeps both if they could.
    if (keys.some((k) => sameCombo(k, combo, platform ?? 'darwin'))) continue;
    keys.push(combo);
    if (keys.length === MAX_KEYS_PER_ACTION) break;
  }
  return keys;
}
