/**
 * #324 (Neon's SF2, round 1 of #337): the Public Suffix List failing to load fails closed: a tab of yours' icon, even
 * its own site's, is fetched without cookies, nothing is thrown, and the next icon tries the list again.
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
vi.mock('@chord/core/password-sites', () => {
  throw new Error('the list didn’t load');
});
const { TabManager } = await import('../../src/main/tabs');

const NODE = 'n1' as NodeId;
const PAGE = 'https://shop.test/a';

/** A tab and its page; an agent's unless `agent` is false (its kind is the page's from the start: wire()'s latch). */
function setup(agent = true) {
  const kind = { agent };
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

describe('the Public Suffix List not loading (#324, Neon’s SF2 on #337)', () => {
  it('a tab of yours’ icon, its own site’s too: no cookies, nothing thrown', async () => {
    const t = setup(false);
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', note);
    try {
      t.view.page.emit('page-favicon-updated', {}, ['https://shop.test/favicon.ico']);
      await vi.waitFor(() => expect(t.fetch).toHaveBeenCalled());
      expect(t.fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });
});
