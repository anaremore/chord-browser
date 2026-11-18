/**
 * Peek asked for before the window's overlay listens (a link followed just after
 * launch, before the command bar has said overlay:ready): it waited for nothing
 * and was dropped, while its page loaded out of sight, and the sign-in box a 401
 * there asks for had no Peek to sit over. Now it opens once the overlay listens,
 * as the command bar's own opening does.
 */
import { EventEmitter } from 'node:events';
import type { WindowId } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeView } from './fake-view';

/** What AppWindow asks of a BaseWindow: on screen, 1280 × 820. */
class FakeWindow extends EventEmitter {
  readonly contentView = {
    children: [] as unknown[],
    addChildView: vi.fn((view: unknown, index?: number) => {
      const c = this.contentView.children;
      if (index === undefined) c.push(view);
      else c.splice(index, 0, view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const c = this.contentView.children;
      if (c.includes(view)) c.splice(c.indexOf(view), 1);
    }),
  };
  getContentBounds = () => ({ x: 0, y: 0, width: 1280, height: 820 });
  getBounds = () => this.getContentBounds();
  isDestroyed = () => false;
  isVisible = () => true;
  isMinimized = () => false;
  isMaximized = () => false;
  isFullScreen = () => false;
  maximize = vi.fn();
  show = vi.fn();
  setTitleBarOverlay = vi.fn();
  setWindowButtonPosition = vi.fn();
}

vi.mock('electron', async () => ({
  WebContentsView: (await import('./fake-view')).FakeView,
  BaseWindow: FakeWindow,
  MessageChannelMain: class {},
  nativeTheme: { on: vi.fn(), off: vi.fn(), shouldUseDarkColors: false },
  screen: {},
  systemPreferences: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../src/main/ipc', () => ({ registerCaller: vi.fn(), send: vi.fn() }));
vi.mock('../../src/main/security', () => ({ lockToOrigins: vi.fn() }));
vi.mock('../../src/main/perf', () => ({ epochNow: () => 0, markLaunch: vi.fn() }));
vi.mock('../../src/main/platform', () => ({
  platform: 'darwin',
  applyMaterial: vi.fn(),
  onUiScale: () => () => undefined,
  systemInfo: () => ({}),
  titleBarOverlay: () => ({}),
  trafficLightPosition: () => ({ x: 0, y: 0 }),
  uiScale: () => 1,
  windowChromeOptions: () => ({}),
}));

const { AppWindow } = await import('../../src/main/window');

const { send } = await import('../../src/main/ipc');

const info = { url: 'http://localhost/staff', host: 'localhost', title: '', origin: null };

function newWindow() {
  const w = new AppWindow({ id: 'w1' as WindowId, uiSession: {} as Session, bounds: null, sidebar: 'docked', sidebarWidth: 240, onBounds: vi.fn(), presenting: () => false });
  w.markShellPainted();
  const page = new FakeView();
  w.showTabs([page as unknown as WebContentsView], 0, null, []);
  const peek = new FakeView();
  const window = (w as unknown as { window: FakeWindow }).window;
  return { w, peek, view: peek as unknown as WebContentsView, window, overlay: w.overlay as unknown as FakeView };
}

/** What main sent the overlay: its channels, in order. */
const toOverlay = (overlay: FakeView) =>
  vi
    .mocked(send)
    .mock.calls.filter(([contents]) => (contents as unknown) === overlay.page)
    .map(([, channel, payload]) => ({ channel, payload: payload as Record<string, unknown> }));

describe('Peek before the overlay listens', () => {
  beforeEach(() => {
    vi.mocked(send).mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('opens once the overlay says it’s ready, with its page in the card', () => {
    const { w, peek, view, window, overlay } = newWindow();
    w.openPeek(view, info, 0);
    expect(toOverlay(overlay).some((m) => m.channel === 'overlay:open')).toBe(false);
    w.markOverlayReady();
    const open = toOverlay(overlay).find((m) => m.channel === 'overlay:open');
    expect(open?.payload).toMatchObject({ mode: 'peek', url: info.url });
    expect(w.peekOverlaySeq).toBe(open?.payload['seq']);
    // The command bar isn't warmed over it: the overlay is Peek's.
    expect(toOverlay(overlay).some((m) => m.channel === 'overlay:warm')).toBe(false);
    vi.runAllTimers();
    expect(window.contentView.children).toContain(peek);
    expect(w.peekContents as unknown).toBe(peek.page);
  });

  it('follows its page meanwhile, and replaces a command bar opening that waited too', () => {
    const { w, view, overlay } = newWindow();
    w.openOverlay('new', '');
    w.openPeek(view, info, 0);
    w.updatePeek({ title: 'Staff page' });
    w.markOverlayReady();
    const opens = toOverlay(overlay).filter((m) => m.channel === 'overlay:open');
    expect(opens).toHaveLength(1);
    expect(opens[0]!.payload).toMatchObject({ mode: 'peek', peek: { title: 'Staff page' } });
  });

  it('closed before then, it never opens', () => {
    const { w, peek, view, window, overlay } = newWindow();
    w.openPeek(view, info, 0);
    w.closePeek();
    w.markOverlayReady();
    vi.runAllTimers();
    expect(toOverlay(overlay).some((m) => m.channel === 'overlay:open')).toBe(false);
    expect(window.contentView.children).not.toContain(peek);
    expect(w.peekOverlaySeq).toBeNull();
  });
});

/**
 * #50: while a Peek waits for the overlay (a brand-new window's, or one reloading after a crash), it's still the page
 * in front. Browser's page actions (⌘W, reload, back), find and the fill menu go by `peekContents`, and the popover
 * follows once it opens (`markOverlayReady` says so). An open Peek whose overlay reloads waits again, and comes back.
 */
describe('Peek in front while it waits for the overlay', () => {
  beforeEach(() => {
    vi.mocked(send).mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  type Setup = ReturnType<typeof newWindow>;
  const reload = ({ overlay }: Setup) => overlay.page.emit('did-start-loading');
  it.each<[string, (s: Setup) => void, { front: boolean; chrome: boolean }]>([
    ['none asked for', () => undefined, { front: false, chrome: false }],
    ['waiting for a new window’s overlay', ({ w, view }) => w.openPeek(view, info, 0), { front: true, chrome: false }],
    ['open', ({ w, view }) => (w.markOverlayReady(), w.openPeek(view, info, 0)), { front: true, chrome: true }],
    ['open, its overlay reloading (a crash)', (s) => (s.w.markOverlayReady(), s.w.openPeek(s.view, info, 0), reload(s)), { front: true, chrome: false }],
    ['closed while its overlay reloads', (s) => (s.w.markOverlayReady(), s.w.openPeek(s.view, info, 0), reload(s), s.w.closePeek()), { front: false, chrome: false }],
  ])('%s', (_name, setUp, expected) => {
    const s = newWindow();
    setUp(s);
    expect((s.w.peekContents as unknown) === s.peek.page).toBe(expected.front);
    expect(s.w.peekOverlaySeq !== null).toBe(expected.chrome);
  });

  it('says when a waiting Peek opens, so the popover follows; not for the command bar’s own start', () => {
    const fresh = newWindow();
    expect(fresh.w.markOverlayReady()).toBe(false);
    const waiting = newWindow();
    waiting.w.openPeek(waiting.view, info, 0);
    expect(waiting.w.markOverlayReady()).toBe(true);
    expect(waiting.w.peekOverlaySeq).not.toBeNull();
  });

  it('an open Peek whose overlay reloads opens again once it listens, with what its page shows now, its page kept', () => {
    const s = newWindow();
    s.w.markOverlayReady();
    s.w.openPeek(s.view, info, 0);
    vi.runAllTimers();
    const before = s.w.peekOverlaySeq;
    reload(s);
    s.w.updatePeek({ title: 'Staff page' });
    vi.mocked(send).mockClear();
    expect(s.w.markOverlayReady()).toBe(true);
    const opens = toOverlay(s.overlay).filter((m) => m.channel === 'overlay:open');
    expect(opens).toHaveLength(1);
    expect(opens[0]!.payload).toMatchObject({ mode: 'peek', peek: { title: 'Staff page' } });
    expect(s.w.peekOverlaySeq).not.toBe(before);
    vi.runAllTimers();
    expect(s.window.contentView.children.filter((c) => c === s.peek)).toHaveLength(1);
  });

  it('the window closing forgets a waiting Peek', () => {
    const s = newWindow();
    s.w.openPeek(s.view, info, 0);
    s.window.emit('closed');
    expect(s.w.peekContents).toBeNull();
  });
});
