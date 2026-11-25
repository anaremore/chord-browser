/**
 * What the assistant's click opens from a tab of yours (S18 M2e-2b, A6; Neon's B1 and S4 on #150): nothing. A new tab
 * would load (a download, a redirect to an address that deletes or signs out) with no lease of its own, so a window,
 * a new tab in front or behind, a pinned tab's Peek: each is refused and said in the chat. Your own click opens as ever.
 */
import { EventEmitter } from 'node:events';
import { nodesFrom, type Command, type NodeId, type SidebarNode, type State } from '@chord/core';
import type { HandlerDetails, Session, WebContentsView, WindowOpenHandlerResponse } from 'electron';
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
const assisted = vi.hoisted(() => ({ on: false, notes: [] as string[] }));
vi.mock('../../src/main/control/user-watch', () => ({
  userTabCatching: () => assisted.on,
  noteUserTab: (_c: unknown, what: string, detail: string) => void assisted.notes.push(`${what}: ${detail}`),
}));

const agentInput = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/main/control/input', () => ({ isAgentInput: () => agentInput.on }));
const { TabManager } = await import('../../src/main/tabs');
const NODE = 'n1' as NodeId;

function setup(pinned = false) {
  const state = { nodes: nodesFrom([{ kind: 'tab', id: NODE, url: 'https://shop.example/', section: pinned ? 'pinned' : 'today', chordId: 'c1' } as SidebarNode]), live: {}, windows: {}, chords: { c1: { id: 'c1' } }, settings: { tabCounts: {} } } as unknown as State;
  const commands: Command[] = [];
  const peeks: string[] = [];
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
    onPeek: (_n: NodeId, url: string) => void peeks.push(url),
  } as never);
  const view = manager.ensure(NODE) as unknown as FakeView;
  const handler = view.page.setWindowOpenHandler.mock.calls[0]![0] as (d: HandlerDetails) => WindowOpenHandlerResponse;
  const open = (details: Partial<HandlerDetails>) => handler({ url: 'https://files.example/file.zip', disposition: 'foreground-tab', features: '', frameName: '', referrer: { url: '', policy: 'default' }, postBody: undefined, ...details } as HandlerDetails);
  /** A click in the page (yours, or one Chord sends), then the page going to a link's address. */
  const clickThenNavigate = (url: string) => {
    view.page.emit('input-event', {}, { type: 'mouseUp', x: 5, y: 5 });
    const event = { isMainFrame: true, isSameDocument: false, url, preventDefault: vi.fn() };
    view.page.emit('will-navigate', event);
    return event;
  };
  return { open, commands, peeks, clickThenNavigate };
}

describe('What the assistant’s click opens from a tab of yours (S18 M2e-2b)', () => {
  it('nothing: a new tab (in front or behind), a window, another scheme; each said in the chat. Your own click opens as ever', () => {
    // [what, details, while the assistant's click is setting things off]
    const rows: [string, Partial<HandlerDetails>, boolean][] = [
      ['a link with target=_blank to a .zip', { disposition: 'foreground-tab' }, true],
      ['window.open(url) with no features', { disposition: 'foreground-tab' }, true],
      ['a background tab (⌘/Ctrl-click)', { disposition: 'background-tab' }, true],
      ['a window with features', { disposition: 'new-window', features: 'width=300' }, true],
      ['an address that signs out', { url: 'https://shop.example/logout', disposition: 'background-tab' }, true],
      ['another scheme', { url: 'mailto:ada@example.com' }, true],
    ];
    for (const [what, details, on] of rows) {
      assisted.on = on;
      assisted.notes.length = 0;
      const t = setup();
      expect(t.open(details), what).toEqual({ action: 'deny' });
      expect(t.commands.filter((c) => c.t === 'tab.open'), what).toEqual([]);
      expect(assisted.notes, what).toEqual([`popup: ${(details.url ?? 'https://files.example/file.zip').slice(0, 120)}`]);
    }
    assisted.on = false;
    const yours = setup();
    yours.open({ disposition: 'foreground-tab' });
    expect(yours.commands.filter((c) => c.t === 'tab.open')).toHaveLength(1);
  });

  it('a pinned tab’s link to another site: Peek for your click, nothing for the assistant’s', () => {
    assisted.on = true;
    const t = setup(true);
    expect(t.open({ url: 'https://news.example/a', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(t.peeks).toEqual([]);
    assisted.on = false;
  });

  it('a pinned tab’s cross-site link: your click opens Peek; a click Chord sends for the assistant leaves it to the page (Claude’s S4, round 2 of #150)', () => {
    agentInput.on = false;
    const yours = setup(true);
    expect(yours.clickThenNavigate('https://news.example/a').preventDefault).toHaveBeenCalled();
    expect(yours.peeks).toEqual(['https://news.example/a']);
    agentInput.on = true;
    const its = setup(true);
    expect(its.clickThenNavigate('https://news.example/a').preventDefault).not.toHaveBeenCalled();
    expect(its.peeks).toEqual([]);
    agentInput.on = false;
  });
});
