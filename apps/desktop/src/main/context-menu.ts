/**
 * Right-click menus (ARCHITECTURE.md §9): native, built from what was clicked.
 * Web pages always offer Inspect. Chord's own UI gets editing items only, plus
 * Inspect in development builds.
 */
import { searchEngine, searchUrl, type ActionId, type Platform, type SearchEngineId } from '@chord/core';
import { clipboard, Menu, type BaseWindow, type ContextMenuParams, type MenuItem, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { acceleratorFor } from './menu';
import { platform } from './platform';

export interface ContextMenuDeps {
  /** `web` for pages, `ui` for Chord's shell and command bar, `reader` for a reader view (its article's links and text). */
  surface: 'web' | 'ui' | 'reader';
  /** Offer Inspect (always for pages; development builds only for Chord's UI). */
  inspect: boolean;
  /** The engine for "Search … for" on selected text. */
  searchEngine(): SearchEngineId;
  openTab(url: string, background: boolean): void;
  /** "Open link in Peek" (DESIGN.md §8.5): offered while the page is a tab shown in a window. */
  peek?: { available(): boolean; open(url: string, at: { x: number; y: number }): void };
  /** The window showing this contents, and the view's offset in it, to place the menu where the click was. */
  placement(): { window: BaseWindow; x: number; y: number } | undefined;
  /** Items extensions added for what was clicked (ARCHITECTURE.md §12). */
  extensionItems?(params: ContextMenuParams): MenuItem[];
  /**
   * "Block ads on this site" (ARCHITECTURE.md §9): whether blocking is on for
   * the page (null leaves the item out: blocking is off, or it isn't a web
   * page), and turning it off or on again.
   */
  adBlocking?: { on(url: string): boolean | null; set(url: string, on: boolean): void };
}

type Item = MenuItemConstructorOptions | MenuItem;

const MAX_SEARCH_PREVIEW = 32;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_SEARCH_PREVIEW ? `${oneLine.slice(0, MAX_SEARCH_PREVIEW)}…` : oneLine;
}

const accel = (id: ActionId, p: Platform = platform) => acceleratorFor(id, p);

export function buildContextMenu(contents: WebContents, params: ContextMenuParams, deps: ContextMenuDeps): Item[] {
  const items: Item[] = [];
  const section = (...entries: Item[]) => {
    if (entries.length === 0) return;
    if (items.length > 0) items.push({ type: 'separator' });
    items.push(...entries);
  };
  const history = contents.navigationHistory;
  const web = deps.surface === 'web';
  const isWebLink = deps.surface !== 'ui' && /^https?:/i.test(params.linkURL);

  // Spelling first, where the user is looking.
  if (params.misspelledWord) {
    section(
      ...params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
      { label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
    );
  }

  if (isWebLink) {
    section(
      { label: 'Open link in new tab', click: () => deps.openTab(params.linkURL, false) },
      { label: 'Open link in background tab', click: () => deps.openTab(params.linkURL, true) },
      ...(deps.peek?.available() ? [{ label: 'Open link in Peek', click: () => deps.peek!.open(params.linkURL, { x: params.x, y: params.y }) }] : []),
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
    );
  }

  if (web && params.mediaType === 'image' && params.srcURL) {
    section(
      { label: 'Open image in new tab', click: () => deps.openTab(params.srcURL, false) },
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image as…', click: () => contents.downloadURL(params.srcURL) },
    );
  }

  if (params.isEditable) {
    const f = params.editFlags;
    section(
      { label: 'Undo', role: 'undo', enabled: f.canUndo },
      { label: 'Redo', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: f.canCut },
      { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste },
      { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste },
      { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    section(
      { label: 'Copy', role: 'copy' },
      {
        label: `Search ${searchEngine(deps.searchEngine()).name} for “${preview(params.selectionText)}”`,
        click: () => deps.openTab(searchUrl(params.selectionText.trim(), deps.searchEngine()), false),
      },
    );
  }

  if (web && !isWebLink && params.mediaType === 'none' && !params.isEditable && !params.selectionText.trim()) {
    const blocking = deps.adBlocking?.on(params.pageURL) ?? null;
    section(
      { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', accelerator: accel('nav.reload'), click: () => contents.reload() },
      { type: 'separator' },
      { label: 'Print…', accelerator: accel('page.print'), click: () => contents.print() },
      { label: 'View page source', accelerator: accel('page.viewSource'), click: () => deps.openTab(`view-source:${params.pageURL}`, false) },
      ...(blocking === null
        ? []
        : [{ type: 'separator' as const }, { label: 'Block ads on this site', type: 'checkbox' as const, checked: blocking, click: () => deps.adBlocking!.set(params.pageURL, !blocking) }]),
    );
  }

  // Extensions' own items, as Chrome places them: after the page's, before Inspect.
  if (web) section(...(deps.extensionItems?.(params) ?? []));

  if (deps.inspect) {
    section({
      label: web ? 'Inspect' : 'Inspect Chord UI',
      ...(web ? { accelerator: accel('app.devtools') } : {}),
      click: () => {
        // Chord's UI views fill the window, so docked devtools would have nowhere to go.
        if (!web && !contents.isDevToolsOpened()) contents.openDevTools({ mode: 'detach' });
        contents.inspectElement(params.x, params.y);
        if (contents.isDevToolsOpened()) contents.devToolsWebContents?.focus();
      },
    });
  }
  return items;
}

/**
 * End-to-end tests only (index.ts sets it behind CHORD_E2E_HOOKS): sees each
 * menu's labels instead of a native menu opening on the screen.
 */
/** A menu item as tests see it: its label, and what choosing it does. */
export interface ObservedItem {
  label: string;
  choose(): void;
}

let observeForTests: ((contents: WebContents, items: ObservedItem[]) => void) | null = null;
export function observeContextMenusForTests(observer: (contents: WebContents, items: ObservedItem[]) => void): void {
  observeForTests = observer;
}

export function attachContextMenu(contents: WebContents, deps: ContextMenuDeps): void {
  contents.on('context-menu', (_event, params) => {
    const items = buildContextMenu(contents, params, deps);
    if (items.length === 0) return;
    if (observeForTests) {
      observeForTests(
        contents,
        items
          .filter((item) => item.type !== 'separator')
          .map((item) => ({ label: item.label ?? '', choose: () => (item.click as (() => void) | undefined)?.() })),
      );
      return;
    }
    // At the click (or the focused element, from the keyboard), not wherever the pointer is.
    const place = deps.placement();
    Menu.buildFromTemplate(items).popup({
      ...(place ? { window: place.window, x: Math.round(place.x + params.x), y: Math.round(place.y + params.y) } : {}),
      frame: params.frame ?? undefined,
      sourceType: params.menuSourceType,
    });
  });
}
