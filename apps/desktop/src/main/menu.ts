/**
 * Chord's menus (DESIGN.md §14): the macOS menu bar, the options menu behind
 * the ⋯ button on Windows/Linux, and the tab-row menu. Built from the shortcut
 * registry, so the keys shown are always the keys that work.
 *
 * The application menu is also how page-first shortcuts reach Chord: the page
 * sees the key first and only unhandled keys fall through to menu
 * accelerators (spike S8). Reserved keys never get that far; keyboard.ts
 * catches them in `before-input-event` and stops them there.
 */
import { keysFor, shortcutById, SHORTCUTS, type ActionId, type Platform } from '@chord/core';
import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { platform } from './platform';
import { shortcutOverrides } from './shortcut-overrides';

const ACCELERATOR_PARTS: Record<string, string> = {
  Mod: 'CmdOrCtrl',
  // The Windows or Super key (Electron's name for it).
  Meta: 'Super',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
};

const toAccelerator = (keys: string) =>
  keys
    .split('+')
    .map((part) => ACCELERATOR_PARTS[part] ?? part)
    .join('+');

/** Every key combination for an action (with your changes), as Electron accelerators (first is the primary). */
export function acceleratorsFor(id: ActionId, p: Platform = platform): string[] {
  const shortcut = shortcutById(id);
  return shortcut ? keysFor(shortcut, p, shortcutOverrides()).map(toAccelerator) : [];
}

/** The primary key combination for an action, as an Electron accelerator. */
export function acceleratorFor(id: ActionId, p: Platform = platform): string | undefined {
  return acceleratorsFor(id, p)[0];
}

const ISSUES_URL = 'https://github.com/anaremore/chord-browser/issues/new';

/** Page-first actions Chord can't do yet: they get no key here, so the page keeps it. */
const NOT_BUILT: ReadonlySet<ActionId> = new Set(['nav.stop', 'page.save', 'app.downloads']);

/** The options menu's width at 100% scale on Windows 11, measured from a capture; used to right-align it. */
export const OPTIONS_MENU_WIDTH = 230;

/** `presenting`: presenting mode is on, so its item is checked (the menu is built again when it changes). */
export function buildAppMenu(run: (action: ActionId) => void, presenting = false): Menu {
  const used: ActionId[] = [];
  const item = (label: string, action: ActionId): MenuItemConstructorOptions => {
    used.push(action);
    const accelerator = acceleratorFor(action);
    return { label, ...(accelerator ? { accelerator } : {}), click: () => run(action) };
  };
  const presentingItem = (label: string): MenuItemConstructorOptions => ({ ...item(label, 'view.presenting'), type: 'checkbox', checked: presenting });
  /** Secondary keys (⌘← for Back, F5 for Reload…) work too, from items nobody sees. */
  const alternates = (): MenuItemConstructorOptions[] =>
    used.flatMap((action) =>
      acceleratorsFor(action)
        .slice(1)
        .map((accelerator) => ({ label: action, accelerator, visible: false, click: () => run(action) })),
    );
  /**
   * Page-first actions with keys but no item of their own (Show or hide Duet,
   * History, and any key you give an action in Settings): hidden items keep
   * their keys live, since this menu is the only way page-first keys reach Chord.
   */
  const unlisted = (): MenuItemConstructorOptions[] =>
    SHORTCUTS.filter((sc) => sc.kind === 'page-first' && !used.includes(sc.id) && !NOT_BUILT.has(sc.id)).flatMap((sc) =>
      acceleratorsFor(sc.id).map((accelerator) => ({ label: sc.id, accelerator, visible: false, click: () => run(sc.id) })),
    );
  const help: MenuItemConstructorOptions = { label: 'Report an issue…', click: () => void shell.openExternal(ISSUES_URL) };

  if (platform === 'darwin') {
    const tabMenu: MenuItemConstructorOptions[] = [
      item('Edit Address', 'address.edit'),
      item('Copy Page Address', 'address.copy'),
      item('Copy as Markdown Link', 'address.copyMarkdown'),
      { type: 'separator' },
      item('Back', 'nav.back'),
      item('Forward', 'nav.forward'),
      { type: 'separator' },
      item('Next Tab', 'tab.next'),
      item('Previous Tab', 'tab.previous'),
      { type: 'separator' },
      item('Pin or Unpin Tab', 'tab.pin'),
      item('Mute or Unmute Tab', 'tab.mute'),
    ];
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Chord',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          item('Settings…', 'app.settings'),
          item('Keyboard Shortcuts', 'app.shortcuts'),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          item('New Tab', 'tab.new'),
          item('New Window', 'window.new'),
          item('New Private Window', 'window.newPrivate'),
          item('Reopen Closed Tab', 'tab.reopen'),
          { type: 'separator' },
          item('Close Tab', 'tab.close'),
          item('Close Window', 'window.close'),
          { type: 'separator' },
          item('Take a Screenshot', 'page.screenshot'),
          item('Print…', 'page.print'),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'selectAll' },
          { type: 'separator' },
          item('Find…', 'view.find'),
          item('Find Next', 'view.findNext'),
          item('Find Previous', 'view.findPrevious'),
        ],
      },
      {
        label: 'View',
        submenu: [
          item('Toggle Sidebar', 'view.toggleSidebar'),
          presentingItem('Presenting Mode'),
          item('Toggle Reader View', 'view.reader'),
          { type: 'separator' },
          item('Effects for This Site…', 'effects.open'),
          item('Effects on This Site: Dry or Wet', 'effects.site'),
          item('Effects Everywhere: Dry or Wet', 'effects.everywhere'),
          item('Hide an Element…', 'effects.hide'),
          { type: 'separator' },
          item('Reload', 'nav.reload'),
          item('Reload, Skipping Cache', 'nav.hardReload'),
          { type: 'separator' },
          item('Actual Size', 'view.zoomReset'),
          item('Zoom In', 'view.zoomIn'),
          item('Zoom Out', 'view.zoomOut'),
          { type: 'separator' },
          item('Toggle Full Screen', 'view.fullscreen'),
        ],
      },
      { label: 'Tab', submenu: tabMenu },
      {
        label: 'Developer',
        submenu: [item('Developer Tools', 'app.devtools'), item('View Page Source', 'page.viewSource')],
      },
      { role: 'windowMenu' },
      { role: 'help', submenu: [help] },
    ];
    // Hidden items in a visible menu: `acceleratorWorksWhenHidden` (default true) keeps their keys live.
    tabMenu.push(...alternates(), ...unlisted());
    return Menu.buildFromTemplate(template);
  }

  // Windows/Linux: the ⋯ options menu, also installed as the application menu
  // (never shown as a bar) so its accelerators work.
  const template: MenuItemConstructorOptions[] = [
    item('New tab', 'tab.new'),
    item('New window', 'window.new'),
    item('New private window', 'window.newPrivate'),
    item('Reopen closed tab', 'tab.reopen'),
    { type: 'separator' },
    item('Show or hide sidebar', 'view.toggleSidebar'),
    presentingItem('Presenting mode'),
    item('Edit address', 'address.edit'),
    item('Copy page address', 'address.copy'),
    item('Pin or unpin tab', 'tab.pin'),
    { type: 'separator' },
    {
      label: 'Zoom',
      submenu: [item('Zoom in', 'view.zoomIn'), item('Zoom out', 'view.zoomOut'), item('Actual size', 'view.zoomReset')],
    },
    item('Find in page…', 'view.find'),
    item('Take a screenshot', 'page.screenshot'),
    item('Reader view', 'view.reader'),
    {
      label: 'Effects',
      submenu: [
        item('Effects for this site…', 'effects.open'),
        item('Dry or wet on this site', 'effects.site'),
        item('Dry or wet everywhere', 'effects.everywhere'),
        item('Hide an element…', 'effects.hide'),
      ],
    },
    item('Full screen', 'view.fullscreen'),
    item('Print…', 'page.print'),
    { type: 'separator' },
    {
      label: 'More tools',
      submenu: [
        item('Developer tools', 'app.devtools'),
        item('View page source', 'page.viewSource'),
        item('Copy as Markdown link', 'address.copyMarkdown'),
        { type: 'separator' },
        item('Back', 'nav.back'),
        item('Forward', 'nav.forward'),
        item('Reload', 'nav.reload'),
        item('Reload, skipping the cache', 'nav.hardReload'),
        item('Next tab', 'tab.next'),
        item('Previous tab', 'tab.previous'),
        item('Find next', 'view.findNext'),
        item('Find previous', 'view.findPrevious'),
      ],
    },
    { type: 'separator' },
    item('Settings', 'app.settings'),
    item('Keyboard shortcuts', 'app.shortcuts'),
    help,
    { type: 'separator' },
    item('Close window', 'window.close'),
    ...(platform === 'linux' ? [item('Quit Chord', 'app.quit')] : []),
  ];
  template.push(...alternates(), ...unlisted());
  return Menu.buildFromTemplate(template);
}

export interface ChordMenuActions {
  rename(): void;
  changeIcon(): void;
  editColors(): void;
  /** Whether the chord keeps its own sign-ins (a profile of its own). */
  separateSignIns: boolean;
  toggleSeparateSignIns(): void;
  /** Its own proxy in a few words (core's proxyLabel); null when it uses the proxy for every chord. */
  ownProxy: string | null;
  sameProxyAsAll(): void;
  /** Settings → Privacy → Proxy, with this chord's own open. */
  editProxy(): void;
  /** Null when this is the only chord, which can't be deleted. */
  delete: (() => void) | null;
}

/** Right-click on a chord in the switcher. */
export function buildChordMenu(a: ChordMenuActions): Menu {
  return Menu.buildFromTemplate([
    { label: 'Rename', click: a.rename },
    { label: 'Change icon…', click: a.changeIcon },
    { label: 'Edit colors…', click: a.editColors },
    { type: 'separator' },
    { label: 'Keep sign-ins separate', type: 'checkbox', checked: a.separateSignIns, click: a.toggleSeparateSignIns },
    // Its own proxy is chosen in Settings, which says first what it means for a chord sharing sign-ins.
    {
      label: 'Proxy',
      submenu: [
        { label: 'Same as all chords', type: 'radio', checked: a.ownProxy === null, click: a.sameProxyAsAll },
        { label: a.ownProxy ? `Its own: ${a.ownProxy}…` : 'Its own…', type: 'radio', checked: a.ownProxy !== null, click: a.editProxy },
      ],
    },
    { type: 'separator' },
    { label: 'Delete chord', enabled: a.delete !== null, click: () => a.delete?.() },
  ]);
}

export interface TabMenuActions {
  url: string;
  pinned: boolean;
  /** False in a private window, where nothing pins. */
  canPin: boolean;
  togglePin(): void;
  copyLink(): void;
  copyMarkdown(): void;
  reload(): void;
  duplicate(): void;
  /** You muted it (the speaker on its row says so too). */
  muted: boolean;
  toggleMute(): void;
  /** The page gives itself a count (or its site's is hidden): show it on the tab or not. Null otherwise, and in private windows. */
  count: { shown: boolean; toggle(): void } | null;
  close(): void;
  /** Null when the page can't be a favorite (not a web page, or already one). */
  addFavorite: (() => void) | null;
  newFolder(): void;
  /** Show it beside the tab on screen (split view); null when it can't (it's that tab, or the split is full). */
  openInSplit: (() => void) | null;
  /** Take it out of its split; null when it isn't in one. */
  removeFromSplit: (() => void) | null;
  /** The other chords, for "Move to"; `signInsDiffer` notes the reload. */
  moveTargets: { id: string; label: string; signInsDiffer: boolean }[];
  moveTo(chordId: string): void;
  /**
   * What the row's own buttons do, for the keyboard (Shift+F10, the menu key):
   * null when the row doesn't show them. Stop sharing is "this tab" when a
   * page is sharing the tab itself.
   */
  stopSharing: { label: string; click(): void } | null;
  backToPinned: (() => void) | null;
  /** Reader view: offered while the page reads as an article (`on` while it shows in reader view), else null. */
  reader: { on: boolean } | null;
  toggleReader(): void;
}

/** Right-click on a tab row in the sidebar. */
export function buildTabMenu(a: TabMenuActions): Menu {
  const web = /^https?:/i.test(a.url);
  const moveTo: MenuItemConstructorOptions[] = a.moveTargets.map((c) => ({
    label: c.signInsDiffer ? `${c.label} (other sign-ins)` : c.label,
    click: () => a.moveTo(c.id),
  }));
  const rowButtons: MenuItemConstructorOptions[] = [
    ...(a.stopSharing ? [{ label: a.stopSharing.label, click: a.stopSharing.click }] : []),
    ...(a.backToPinned ? [{ label: 'Back to pinned page', click: () => a.backToPinned?.() }] : []),
  ];
  return Menu.buildFromTemplate([
    ...(rowButtons.length > 0 ? [...rowButtons, { type: 'separator' as const }] : []),
    { label: 'Copy link', enabled: web, click: a.copyLink },
    { label: 'Copy as Markdown link', enabled: web, click: a.copyMarkdown },
    { type: 'separator' },
    { label: a.pinned ? 'Unpin tab' : 'Pin tab', accelerator: acceleratorFor('tab.pin'), enabled: a.canPin, click: a.togglePin },
    { label: 'Add to Favorites', enabled: a.addFavorite !== null, click: () => a.addFavorite?.() },
    // A folder pins its tabs, so it goes where pinning does.
    { label: 'New folder with tab', enabled: a.canPin, click: a.newFolder },
    { label: 'Move to', enabled: moveTo.length > 0, submenu: moveTo.length > 0 ? moveTo : [{ label: 'No other chords', enabled: false }] },
    { type: 'separator' },
    a.removeFromSplit
      ? { label: 'Remove from split', click: () => a.removeFromSplit?.() }
      : { label: 'Open in split', enabled: a.openInSplit !== null, click: () => a.openInSplit?.() },
    { type: 'separator' },
    { label: 'Reload', click: a.reload },
    ...(a.reader ? [{ label: a.reader.on ? 'Leave reader view' : 'Show in reader view', accelerator: acceleratorFor('view.reader'), click: a.toggleReader }] : []),
    { label: 'Duplicate', click: a.duplicate },
    // Kept with the tab: a muted page stays silent after sleeping and restarts.
    { label: a.muted ? 'Unmute tab' : 'Mute tab', accelerator: acceleratorFor('tab.mute'), enabled: web, click: a.toggleMute },
    // For a site whose count isn't wanted (an inbox's unread mail): kept for the site, listed in Settings → General.
    ...(a.count ? [{ label: 'Show count on tab', type: 'checkbox' as const, checked: a.count.shown, click: a.count.toggle }] : []),
    { type: 'separator' },
    { label: a.pinned ? 'Close (stays pinned)' : 'Close tab', accelerator: acceleratorFor('tab.close'), click: a.close },
  ]);
}

/** Right-click on a folder row. */
export function buildFolderMenu(a: { collapsed: boolean; toggle(): void; rename(): void; newFolderInside(): void; delete(): void }): Menu {
  return Menu.buildFromTemplate([
    { label: a.collapsed ? 'Open folder' : 'Close folder', click: a.toggle },
    { label: 'Rename', click: a.rename },
    { label: 'New folder inside', click: a.newFolderInside },
    { type: 'separator' },
    { label: 'Delete folder', click: a.delete },
  ]);
}

/** Right-click on a split's row in the sidebar. */
export function buildSplitMenu(a: { pinned: boolean; canPin: boolean; togglePin(): void; separate(): void; close(): void }): Menu {
  return Menu.buildFromTemplate([
    { label: 'Separate tabs', accelerator: acceleratorFor('split.separate'), click: a.separate },
    { label: a.pinned ? 'Unpin split' : 'Pin split', enabled: a.canPin, click: a.togglePin },
    { type: 'separator' },
    { label: a.pinned ? 'Close tabs (stay pinned)' : 'Close split', click: a.close },
  ]);
}

/** Right-click on a favorite. */
export function buildFavoriteMenu(a: { remove(): void }): Menu {
  return Menu.buildFromTemplate([{ label: 'Remove from Favorites', click: a.remove }]);
}
