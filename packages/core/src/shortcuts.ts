/**
 * The one shortcut registry (DESIGN.md §14). Everything else (the reserved-key
 * interceptor, menus, keycaps, the cheat sheet, the docs table) is generated
 * from this list, plus your changes to it (Settings → Keyboard shortcuts),
 * which `keysFor` folds in.
 *
 * Key syntax: modifiers joined with `+`. `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; `Ctrl` is always the Control key (⌃ on macOS); `Meta` is the
 * Windows or Super key (never used on macOS, where ⌘ is `Mod`).
 */

export type Platform = 'darwin' | 'win32' | 'linux';

/** Reserved: Chord gets the key even when a page has focus. Page-first: the page sees it first. */
export type ShortcutKind = 'reserved' | 'page-first';

export type ActionId =
  | 'address.edit'
  | 'address.copy'
  | 'address.copyMarkdown'
  | 'tab.new'
  | 'tab.close'
  | 'tab.reopen'
  | 'tab.recentNext'
  | 'tab.recentPrevious'
  | 'tab.next'
  | 'tab.previous'
  | 'tab.moveDown'
  | 'tab.moveUp'
  | 'tab.pin'
  | 'tab.mute'
  | 'tab.favorite'
  | 'folder.new'
  | 'today.clear'
  | 'split.with'
  | 'split.focusNext'
  | 'split.focusPrevious'
  | 'split.separate'
  | 'nav.back'
  | 'nav.forward'
  | 'nav.reload'
  | 'nav.hardReload'
  | 'nav.stop'
  | `chord.goto${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'chord.next'
  | 'chord.previous'
  | 'chord.delete'
  | 'chord.separateSignIns'
  | 'duet.toggle'
  | 'window.new'
  | 'window.newPrivate'
  | 'window.close'
  | 'view.toggleSidebar'
  | 'view.find'
  | 'view.findNext'
  | 'view.findPrevious'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'view.fullscreen'
  | 'view.focusNextRegion'
  | 'view.focusPreviousRegion'
  | 'view.reader'
  | 'page.print'
  | 'page.screenshot'
  | 'page.save'
  | 'page.viewSource'
  | 'app.settings'
  | 'app.history'
  | 'app.downloads'
  | 'app.shortcuts'
  | 'app.devtools'
  | 'app.quit';

export interface Shortcut {
  id: ActionId;
  label: string;
  kind: ShortcutKind;
  mac: readonly string[];
  /** Windows and Linux. */
  other: readonly string[];
  /** Only these platforms (default: all). */
  only?: readonly Platform[];
}

const s = (id: ActionId, label: string, kind: ShortcutKind, mac: string[], other: string[] = mac, only?: Platform[]): Shortcut =>
  only ? { id, label, kind, mac, other, only } : { id, label, kind, mac, other };

const chordKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export const SHORTCUTS: readonly Shortcut[] = [
  // Address and search
  s('address.edit', 'Edit the address or search', 'reserved', ['Mod+L'], ['Mod+L', 'Alt+D']),
  s('tab.new', 'New tab', 'reserved', ['Mod+T']),
  s('address.copy', 'Copy page address', 'page-first', ['Mod+Shift+C']),
  s('address.copyMarkdown', 'Copy as Markdown link', 'page-first', ['Mod+Alt+Shift+C']),
  // Navigate
  s('nav.back', 'Back', 'page-first', ['Mod+[', 'Mod+ArrowLeft'], ['Alt+ArrowLeft']),
  s('nav.forward', 'Forward', 'page-first', ['Mod+]', 'Mod+ArrowRight'], ['Alt+ArrowRight']),
  s('nav.reload', 'Reload', 'reserved', ['Mod+R'], ['Mod+R', 'F5']),
  s('nav.hardReload', 'Reload, skipping the cache', 'reserved', ['Mod+Shift+R'], ['Mod+Shift+R', 'Mod+F5']),
  s('nav.stop', 'Stop loading', 'page-first', ['Escape']),
  // Tabs
  s('tab.close', 'Close tab', 'reserved', ['Mod+W'], ['Mod+W', 'Mod+F4']),
  s('tab.reopen', 'Reopen closed tab', 'reserved', ['Mod+Shift+T']),
  s('tab.recentNext', 'Recent tabs', 'reserved', ['Ctrl+Tab']),
  s('tab.recentPrevious', 'Recent tabs, backwards', 'reserved', ['Ctrl+Shift+Tab']),
  s('tab.next', 'Next tab in the sidebar', 'reserved', ['Mod+Alt+ArrowDown'], ['Mod+PageDown']),
  s('tab.previous', 'Previous tab in the sidebar', 'reserved', ['Mod+Alt+ArrowUp'], ['Mod+PageUp']),
  s('tab.moveDown', 'Move tab down', 'reserved', ['Mod+Alt+Shift+ArrowDown'], ['Mod+Shift+PageDown']),
  s('tab.moveUp', 'Move tab up', 'reserved', ['Mod+Alt+Shift+ArrowUp'], ['Mod+Shift+PageUp']),
  s('tab.pin', 'Pin or unpin tab', 'page-first', ['Mod+D']),
  // Chrome has no key for this; Firefox and Edge use Ctrl+M (⌃M on macOS, where ⌘M minimizes the window).
  s('tab.mute', 'Mute or unmute tab', 'page-first', ['Ctrl+M'], ['Mod+M']),
  // No keys: these live in menus and the command bar (DESIGN.md §8.3).
  s('tab.favorite', 'Add this tab to Favorites', 'page-first', []),
  s('folder.new', 'New folder with this tab', 'page-first', []),
  s('today.clear', 'Clear Today', 'page-first', []),
  // Split view (DESIGN.md §8.4). The backslash reads as a divider; no Alt, so AltGr's letters (ś, ß…) stay typeable.
  s('split.with', 'Split with…', 'reserved', ['Mod+Shift+\\']),
  s('split.focusPrevious', 'Focus the pane to the left', 'reserved', ['Mod+Alt+['], ['Ctrl+Alt+[']),
  s('split.focusNext', 'Focus the pane to the right', 'reserved', ['Mod+Alt+]'], ['Ctrl+Alt+]']),
  s('split.separate', 'Separate split tabs', 'page-first', []),
  // Chords
  ...chordKeys.map((n) => s(`chord.goto${n}`, `Go to chord ${n}`, 'reserved', [`Mod+${n}`])),
  s('chord.next', 'Next chord', 'reserved', ['Mod+Alt+ArrowRight'], ['Ctrl+Alt+ArrowRight']),
  s('chord.previous', 'Previous chord', 'reserved', ['Mod+Alt+ArrowLeft'], ['Ctrl+Alt+ArrowLeft']),
  // No keys: deleting is a deliberate act, from the chord's menu or the command bar.
  s('chord.delete', 'Delete this chord', 'page-first', []),
  s('chord.separateSignIns', 'Keep sign-ins separate for this chord', 'page-first', []),
  // Duet (DESIGN.md §13.1): page-first, so web editors that use ⌘E / Ctrl+E keep it; Chrome uses these keys too.
  s('duet.toggle', 'Show or hide Duet', 'page-first', ['Mod+E']),
  // Window and view
  s('window.new', 'New window', 'reserved', ['Mod+N']),
  s('window.newPrivate', 'New private window', 'reserved', ['Mod+Shift+N']),
  s('window.close', 'Close window', 'reserved', ['Mod+Shift+W']),
  s('view.toggleSidebar', 'Show or hide the sidebar', 'page-first', ['Mod+S']),
  s('view.find', 'Find in page', 'page-first', ['Mod+F']),
  s('view.findNext', 'Find next', 'page-first', ['Mod+G'], ['F3']),
  s('view.findPrevious', 'Find previous', 'page-first', ['Mod+Shift+G'], ['Shift+F3']),
  s('view.zoomIn', 'Zoom in', 'page-first', ['Mod+='], ['Mod+=']),
  s('view.zoomOut', 'Zoom out', 'page-first', ['Mod+-']),
  s('view.zoomReset', 'Actual size', 'page-first', ['Mod+0']),
  s('view.fullscreen', 'Full screen', 'reserved', ['Ctrl+Mod+F'], ['F11']),
  s('view.focusNextRegion', 'Move focus to the next area', 'reserved', ['F6']),
  s('view.focusPreviousRegion', 'Move focus to the previous area', 'reserved', ['Shift+F6']),
  // Reader view (DESIGN.md §7.11): Firefox's keys, page-first. Safari's ⌘⇧R reloads without the cache here, and
  // Ctrl+Alt+R is AltGr+R on Windows, which types a letter on some layouts; F9 is Firefox's and Edge's there.
  s('view.reader', 'Show or hide reader view', 'page-first', ['Mod+Alt+R'], ['F9']),
  s('page.print', 'Print', 'page-first', ['Mod+P']),
  // Screenshots (DESIGN.md §7.12): Arc's key, clear of macOS's own ⌘⇧3/4/5. Chord's before the page's: sites rarely use it.
  s('page.screenshot', 'Take a screenshot', 'reserved', ['Mod+Shift+2']),
  s('page.save', 'Save page as', 'page-first', ['Mod+Shift+S']),
  s('page.viewSource', 'View page source', 'page-first', ['Mod+Alt+U'], ['Mod+U']),
  // Chord's own pages and tools
  s('app.settings', 'Settings', 'page-first', ['Mod+,']),
  s('app.history', 'History and archive', 'page-first', ['Mod+Y'], ['Mod+H']),
  s('app.downloads', 'Downloads', 'page-first', ['Mod+Shift+J'], ['Mod+J']),
  s('app.shortcuts', 'Keyboard shortcuts', 'page-first', ['Mod+Alt+/']),
  s('app.devtools', 'Developer tools', 'reserved', ['Mod+Alt+I'], ['F12', 'Mod+Shift+I']),
  s('app.quit', 'Quit Chord', 'reserved', ['Mod+Q'], ['Mod+Shift+Q'], ['darwin', 'linux']),
];

export const shortcutById = (id: ActionId): Shortcut | undefined => SHORTCUTS.find((x) => x.id === id);

/**
 * Your changes to the registry's keys (Settings → Keyboard shortcuts): an
 * action's full list of combinations, in the portable `Mod+…` form. An empty
 * list means the action has no keys. Actions not listed keep their defaults.
 */
export type ShortcutOverrides = Readonly<Partial<Record<ActionId, readonly string[]>>>;

/** The registry's own keys for an action on this platform, ignoring your changes. */
export function defaultKeysFor(shortcut: Shortcut, platform: Platform): readonly string[] {
  if (shortcut.only && !shortcut.only.includes(platform)) return [];
  return platform === 'darwin' ? shortcut.mac : shortcut.other;
}

/** The keys that work for an action: your changes if you made any, else the registry's. */
export function keysFor(shortcut: Shortcut, platform: Platform, overrides: ShortcutOverrides = {}): readonly string[] {
  if (shortcut.only && !shortcut.only.includes(platform)) return [];
  return overrides[shortcut.id] ?? defaultKeysFor(shortcut, platform);
}

/** The keycap for an action's first key on this platform ("⌘L", "Ctrl+L"), or '' if it has none. */
export function keycapFor(id: ActionId, platform: Platform, overrides: ShortcutOverrides = {}): string {
  const shortcut = shortcutById(id);
  const first = shortcut ? keysFor(shortcut, platform, overrides)[0] : undefined;
  return first ? formatKeys(first, platform) : '';
}

/** The subset of Electron's `Input` that matching needs. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

interface Combo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

function parseCombo(text: string, platform: Platform): Combo {
  const parts = text.split('+');
  // The + key itself is written `Plus`, so splitting on + is safe.
  const key = parts.pop()!;
  const combo: Combo = { key: normalizeKey(key), ctrl: false, meta: false, alt: false, shift: false };
  for (const mod of parts) {
    if (mod === 'Mod') combo[platform === 'darwin' ? 'meta' : 'ctrl'] = true;
    else if (mod === 'Ctrl') combo.ctrl = true;
    else if (mod === 'Alt') combo.alt = true;
    else if (mod === 'Shift') combo.shift = true;
    else if (mod === 'Meta') combo.meta = true;
  }
  return combo;
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Punctuation keys by position, as US keycaps name them. */
const PUNCTUATION_CODES: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Backquote: '`',
};

/**
 * The key a press names in a combination. Digit, letter and punctuation keys
 * go by position when a modifier is down, so shortcuts keep working on
 * layouts where Shift, ⌥ or AltGr changes the character.
 */
export function keyOf(input: KeyInput): string {
  if (input.code === 'Space') return 'Space';
  if (/^Digit\d$/.test(input.code)) return input.code.slice(5);
  const modified = input.control || input.meta || input.alt;
  if (/^Key[A-Z]$/.test(input.code) && modified) return input.code.slice(3);
  const punctuation = PUNCTUATION_CODES[input.code];
  if (punctuation && modified) return punctuation;
  return normalizeKey(input.key);
}

/** Whether two combinations are the same keys on this platform (`Mod+T` and `Ctrl+T` are, off macOS). */
export function sameCombo(a: string, b: string, platform: Platform): boolean {
  const x = parseCombo(a, platform);
  const y = parseCombo(b, platform);
  return x.key === y.key && x.ctrl === y.ctrl && x.meta === y.meta && x.alt === y.alt && x.shift === y.shift;
}

export function matches(input: KeyInput, text: string, platform: Platform): boolean {
  const combo = parseCombo(text, platform);
  return (
    keyOf(input) === combo.key &&
    input.control === combo.ctrl &&
    input.meta === combo.meta &&
    input.alt === combo.alt &&
    input.shift === combo.shift
  );
}

/** The shortcut this key press triggers, if any (keyDown only), with your changes applied. */
export function findShortcut(input: KeyInput, platform: Platform, kind?: ShortcutKind, overrides: ShortcutOverrides = {}): Shortcut | undefined {
  if (input.type !== 'keyDown') return undefined;
  return SHORTCUTS.find((sc) => (!kind || sc.kind === kind) && keysFor(sc, platform, overrides).some((k) => matches(input, k, platform)));
}

const MAC_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Plus: '+',
};

/** Keycap text: `⌘⇧T` on macOS, `Ctrl+Shift+T` elsewhere. */
export function formatKeys(text: string, platform: Platform): string {
  const parts = text.split('+');
  const key = parts.pop()!;
  const label = KEY_LABELS[key] ?? key;
  if (platform === 'darwin') {
    const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
    return [...mods, label].join('');
  }
  const mods = parts.map((m) => (m === 'Mod' ? 'Ctrl' : m));
  return [...new Set(mods), label].join('+');
}
