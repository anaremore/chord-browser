/**
 * A tab's title on each new page (the owner's test of the 0.15 preview): a page with no <title> gets no
 * page-title-updated, so the last page's title stayed, and the sidebar, the assistant's cards and its activity rows
 * named the wrong page ("Read the form on “Google”" on httpbin.org). On each committed navigation the title is the new
 * entry's own: its title (kept on a reload or Back), or none when it has only its address, and the host shows instead.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type Command, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: class extends EventEmitter {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/window', async () => {
  const { FakeView: View } = await import('./fake-view');
  return { createUiView: () => new View() };
});
vi.mock('../../src/main/app-icon', () => ({ windowIcon: () => undefined }));
vi.mock('../../src/main/platform', () => ({ platform: 'linux', applyMaterial: vi.fn(), onUiScale: () => () => undefined, systemInfo: () => ({}), titleBarOverlay: () => ({}), trafficLightPosition: () => ({ x: 0, y: 0 }), windowChromeOptions: () => ({}) }));
const { TabManager } = await import('../../src/main/tabs');
const NODE = 'n1' as NodeId;

function setup() {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: 'https://www.google.com/search?q=forms', title: 'forms - Google Search', section: 'today', chordId: 'c1' } as SidebarNode]), live: {}, windows: {}, chords: { c1: { id: 'c1' } }, settings: { tabCounts: {} } } as unknown as State;
  const commands: Command[] = [];
  const manager = new TabManager({
    state: () => state,
    dispatch: (c: Command) => void commands.push(c),
    sessionFor: () => ({}) as Session,
    proxyReady: () => null,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
  } as never);
  const view = manager.ensure(NODE) as unknown as FakeView;
  const page = view.page as unknown as EventEmitter & { getTitle: () => string; getURL: () => string };
  /** The page commits `url`; Chromium's entry then shows `shown` (its title, or its address when it has none). */
  const navigate = (url: string, shown: string) => {
    page.getTitle = () => shown;
    page.getURL = () => url;
    page.emit('did-navigate', {}, url, 200, 'OK');
  };
  /** The title the tab was last given. */
  const title = () => [...commands].reverse().find((c): c is Extract<Command, { t: 'tab.updated' }> => c.t === 'tab.updated' && c.title !== undefined)?.title;
  return { navigate, title, page };
}

describe('A tab’s title on each new page (the owner’s test of the 0.15 preview)', () => {
  it('a page with no <title> has none (the host shows), never the last page’s; a reload or Back keeps the entry’s own', () => {
    // [what, the address, what Chromium's entry shows, the tab's title]
    const rows: [string, string, string, string][] = [
      ['a page with no <title>: Chromium shows its address', 'https://httpbin.org/forms/post', 'httpbin.org/forms/post', ''],
      ['the same, shown with its scheme', 'https://httpbin.org/forms/post', 'https://httpbin.org/forms/post', ''],
      ['a new page whose title hasn’t come yet', 'https://shop.example/cart', 'shop.example/cart', ''],
      ['a reload, or Back, to an entry with its title', 'https://www.google.com/search?q=forms', 'forms - Google Search', 'forms - Google Search'],
      ['a title that only looks like part of the address', 'https://shop.example/cart', 'Cart', 'Cart'],
    ];
    for (const [what, url, shown, expected] of rows) {
      const t = setup();
      t.navigate(url, shown);
      expect(t.title(), what).toBe(expected);
    }
  });

  it('the page’s own title, when it comes, is the tab’s', () => {
    const t = setup();
    t.navigate('https://shop.example/cart', 'shop.example/cart');
    t.page.emit('page-title-updated', {}, 'Your cart', true);
    expect(t.title()).toBe('Your cart');
  });
});
