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
import { keysFor, shortcutById, type ActionId, type Platform } from '@chord/core';
import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { platform } from './platform';

const ACCELERATOR_PARTS: Record<string, string> = {
  Mod: 'CmdOrCtrl',
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

/** Every key combination for an action, as Electron accelerators (first is the primary). */
export function acceleratorsFor(id: ActionId, p: Platform = platform): string[] {
  const shortcut = shortcutById(id);
  return shortcut ? keysFor(shortcut, p).map(toAccelerator) : [];
}

/** The primary key combination for an action, as an Electron accelerator. */
export function acceleratorFor(id: ActionId, p: Platform = platform): string | undefined {
  return acceleratorsFor(id, p)[0];
}

const ISSUES_URL = 'https://github.com/anaremore/chord-browser/issues/new';

/** The options menu's width at 100% scale on Windows 11, measured from a capture; used to right-align it. */
export const OPTIONS_MENU_WIDTH = 230;

export function buildAppMenu(run: (action: ActionId) => void): Menu {
  const used: ActionId[] = [];
  const item = (label: string, action: ActionId): MenuItemConstructorOptions => {
    used.push(action);
    const accelerator = acceleratorFor(action);
    return { label, ...(accelerator ? { accelerator } : {}), click: () => run(action) };
  };
  /** Secondary keys (⌘← for Back, F5 for Reload…) work too, from items nobody sees. */
  const alternates = (): MenuItemConstructorOptions[] =>
    used.flatMap((action) =>
      acceleratorsFor(action)
        .slice(1)
        .map((accelerator) => ({ label: action, accelerator, visible: false, click: () => run(action) })),
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
          item('Reopen Closed Tab', 'tab.reopen'),
          { type: 'separator' },
          item('Close Tab', 'tab.close'),
          item('Close Window', 'window.close'),
          { type: 'separator' },
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
    tabMenu.push(...alternates());
    return Menu.buildFromTemplate(template);
  }

  // Windows/Linux: the ⋯ options menu, also installed as the application menu
  // (never shown as a bar) so its accelerators work.
  const template: MenuItemConstructorOptions[] = [
    item('New tab', 'tab.new'),
    item('Reopen closed tab', 'tab.reopen'),
    { type: 'separator' },
    item('Show or hide sidebar', 'view.toggleSidebar'),
    item('Edit address', 'address.edit'),
    item('Copy page address', 'address.copy'),
    item('Pin or unpin tab', 'tab.pin'),
    { type: 'separator' },
    {
      label: 'Zoom',
      submenu: [item('Zoom in', 'view.zoomIn'), item('Zoom out', 'view.zoomOut'), item('Actual size', 'view.zoomReset')],
    },
    item('Find in page…', 'view.find'),
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
  template.push(...alternates());
  return Menu.buildFromTemplate(template);
}

export interface ChordMenuActions {
  rename(): void;
  changeIcon(): void;
  editColors(): void;
  /** Whether the chord keeps its own sign-ins (a profile of its own). */
  separateSignIns: boolean;
  toggleSeparateSignIns(): void;
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
    { type: 'separator' },
    { label: 'Delete chord', enabled: a.delete !== null, click: () => a.delete?.() },
  ]);
}

export interface TabMenuActions {
  url: string;
  pinned: boolean;
  togglePin(): void;
  copyLink(): void;
  copyMarkdown(): void;
  reload(): void;
  duplicate(): void;
  close(): void;
  /** Null when the page can't be a favorite (not a web page, or already one). */
  addFavorite: (() => void) | null;
  newFolder(): void;
  /** The other chords, for "Move to"; `signInsDiffer` notes the reload. */
  moveTargets: { id: string; label: string; signInsDiffer: boolean }[];
  moveTo(chordId: string): void;
}

/** Right-click on a tab row in the sidebar. */
export function buildTabMenu(a: TabMenuActions): Menu {
  const web = /^https?:/i.test(a.url);
  const moveTo: MenuItemConstructorOptions[] = a.moveTargets.map((c) => ({
    label: c.signInsDiffer ? `${c.label} (other sign-ins)` : c.label,
    click: () => a.moveTo(c.id),
  }));
  return Menu.buildFromTemplate([
    { label: 'Copy link', enabled: web, click: a.copyLink },
    { label: 'Copy as Markdown link', enabled: web, click: a.copyMarkdown },
    { type: 'separator' },
    { label: a.pinned ? 'Unpin tab' : 'Pin tab', accelerator: acceleratorFor('tab.pin'), click: a.togglePin },
    { label: 'Add to Favorites', enabled: a.addFavorite !== null, click: () => a.addFavorite?.() },
    { label: 'New folder with tab', click: a.newFolder },
    { label: 'Move to', enabled: moveTo.length > 0, submenu: moveTo.length > 0 ? moveTo : [{ label: 'No other chords', enabled: false }] },
    { type: 'separator' },
    { label: 'Reload', click: a.reload },
    { label: 'Duplicate', click: a.duplicate },
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

/** Right-click on a favorite. */
export function buildFavoriteMenu(a: { remove(): void }): Menu {
  return Menu.buildFromTemplate([{ label: 'Remove from Favorites', click: a.remove }]);
}
