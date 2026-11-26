/**
 * #322's B2 and SF2: a favicon for an agent's tab is decided by the page's latched kind (wire()'s agentPage), never a
 * fresh look at the tab's (kept, or closing: no longer an agent's); a page no longer the tab's fetches nothing; a page
 * closed, or on a Never site, by the time its icon comes back keeps none.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type NodeId, type SidebarNode } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

vi.mock('electron', async () => ({
  WebContentsView: FakeView,
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
// An agent's page's hold (the debugger) isn't what's tested here.
vi.mock('../../src/main/agents/pickers', async (actual) => ({ ...(await actual<Record<string, unknown>>()), holdFilePickers: vi.fn(() => null) }));
const { TabManager } = await import('../../src/main/tabs');

const NODE = 'n1' as NodeId;
const PAGE = 'https://shop.test/a';
const NEVER = 'https://bank.test/';

function setup() {
  const kind = { agent: true };
  const state = {
    nodes: nodesFrom([{ kind: 'tab', id: NODE, url: PAGE, title: '', section: 'today', chordId: 'c1' } as SidebarNode]),
    live: {},
    windows: {},
    chords: { c1: { id: 'c1' } },
    settings: { assistant: { neverSites: ['bank.test'] } },
  };
  const dispatch = vi.fn();
  const manager = new TabManager({
    state: () => state,
    dispatch,
    sessionFor: () => ({}) as Session,
    proxyReady: () => null,
    createInternalView: () => new FakeView() as unknown as WebContentsView,
    windowFor: () => 'w1',
    onContentsCreated: vi.fn(),
    onVisit: vi.fn(),
    onTitle: vi.fn(),
    onPopupCreated: vi.fn(),
    onPeek: vi.fn(),
    agentTab: () => kind.agent,
  } as never);
  const view = manager.ensure(NODE) as unknown as FakeView;
  let url = PAGE;
  view.page.getURL = () => url;
  let answer: (r: Response) => void = () => undefined;
  const fetch = vi.fn((_u: string, _i?: RequestInit) => new Promise<Response>((r) => (answer = r)));
  Object.assign(view.page.session, { fetch });
  const remember = vi.spyOn(manager as unknown as { rememberIcon: () => void }, 'rememberIcon');
  const icon = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { kind, view, fetch, answer: (r: Response) => answer(r), icon, remember, dispatch, settle, go: (u: string) => (url = u) };
}

describe('an agent’s tab’s favicon (#322)', () => {
  it('B2: decided by the page’s latched kind: a tab no longer counted an agent’s (kept, closing) still fetches as one', async () => {
    const t = setup();
    t.kind.agent = false;
    t.view.page.emit('page-favicon-updated', {}, ['https://cdn.other.test/icon.png']);
    await t.settle();
    expect(t.fetch, 'another origin’s icon, never fetched for an agent’s page').not.toHaveBeenCalled();
    t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/icon.png']);
    await t.settle();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it('B2: a page no longer the tab’s fetches nothing; one replaced during the fetch dispatches nothing', async () => {
    const t = setup();
    t.view.page.destroyed = true;
    t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/icon.png']);
    await t.settle();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('SF2: a page closed by the time its icon comes back keeps none', async () => {
    const t = setup();
    t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/icon.png']);
    await t.settle();
    t.view.page.destroyed = true;
    t.answer(t.icon());
    await t.settle();
    await t.settle();
    expect(t.remember).not.toHaveBeenCalled();
    expect(t.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'tab.updated' }));
  });

  it('SF2: a page gone on to a Never site by then keeps none', async () => {
    const t = setup();
    t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/icon.png']);
    await t.settle();
    t.go(NEVER);
    t.answer(t.icon());
    await t.settle();
    await t.settle();
    expect(t.remember).not.toHaveBeenCalled();
  });

  it('a live agent page’s own icon is kept and shown (the path runs)', async () => {
    const t = setup();
    t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/icon.png']);
    await t.settle();
    t.answer(t.icon());
    await t.settle();
    await t.settle();
    expect(t.remember).toHaveBeenCalledTimes(1);
    expect(t.dispatch).toHaveBeenCalledWith(expect.objectContaining({ t: 'tab.updated', favicon: expect.stringMatching(/^data:image\/png;base64,/) }));
  });
});
