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

/** The interface size (the overlay's zoom), which a test may change. */
const ui = vi.hoisted(() => ({ scale: 1 }));

/** What AppWindow asks of a BaseWindow: on screen, 1280 × 820 unless a test resizes it. */
class FakeWindow extends EventEmitter {
  content = { x: 0, y: 0, width: 1280, height: 820 };
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
  getContentBounds = () => ({ ...this.content });
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
  uiScale: () => ui.scale,
  windowChromeOptions: () => ({}),
}));

const { AppWindow, toWindowRect } = await import('../../src/main/window');
const { PEEK_MIN } = await import('@chord/core');

const { send } = await import('../../src/main/ipc');

const info = { url: 'http://localhost/staff', host: 'localhost', title: '', origin: null };

function newWindow() {
  const w = new AppWindow({ id: 'w1' as WindowId, uiSession: {} as Session, bounds: null, sidebar: 'docked', sidebarWidth: 240, onBounds: vi.fn(), presenting: () => false });
  w.markShellPainted();
  const page = new FakeView();
  w.showTabs([page as unknown as WebContentsView], 0, null, []);
  const peek = new FakeView();
  const window = (w as unknown as { window: FakeWindow }).window;
  return { w, tab: page, peek, view: peek as unknown as WebContentsView, window, overlay: w.overlay as unknown as FakeView };
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

  it.each<[string, (s: Setup) => void, 'peek' | 'tab' | null]>([
    ['no Peek: the tab', () => undefined, 'tab'],
    ['waiting for a new window’s overlay: nothing, not the tab under it', ({ w, view }) => w.openPeek(view, info, 0), null],
    ['open: Peek’s page', (s) => (s.w.markOverlayReady(), s.w.openPeek(s.view, info, 0), vi.runAllTimers()), 'peek'],
    ['its overlay reloading: Peek’s page still', (s) => (s.w.markOverlayReady(), s.w.openPeek(s.view, info, 0), vi.runAllTimers(), reload(s)), 'peek'],
  ])('a screenshot takes what ⌘W would act on: %s', (_name, setUp, expected) => {
    const s = newWindow();
    setUp(s);
    const target = s.w.captureTarget()?.contents as unknown;
    expect(target === undefined ? null : target === s.peek.page ? 'peek' : 'tab').toBe(expected);
  });

  it('its overlay reloading, Peek’s page and the popover stay at its card', () => {
    const s = newWindow();
    s.w.markOverlayReady();
    s.w.openPeek(s.view, info, 0);
    vi.runAllTimers();
    const popover = s.w.popover as unknown as FakeView;
    const at = { page: s.peek.getBounds(), popover: popover.getBounds() };
    reload(s);
    vi.mocked(send).mockClear();
    (s.w as unknown as { layout(): void }).layout();
    expect({ page: s.peek.getBounds(), popover: popover.getBounds() }).toEqual(at);
    // Its chrome isn't told anything until the overlay listens again.
    expect(toOverlay(s.overlay).some((m) => m.channel === 'peek:state')).toBe(false);
  });

  it('the window closing forgets a waiting Peek', () => {
    const s = newWindow();
    s.w.openPeek(s.view, info, 0);
    s.window.emit('closed');
    expect(s.w.peekContents).toBeNull();
  });
});

/**
 * Moving and resizing Peek's card (DESIGN.md §8.5): main keeps it inside the window's page area, places Peek's page
 * (and the popover) under it and nothing else, and remembers it for the window's next Peek, in memory, per window.
 * The overlay draws the card from what main says (`card`, `home`, `area`).
 */
describe('Peek moved and resized', () => {
  beforeEach(() => {
    vi.mocked(send).mockClear();
    vi.useFakeTimers();
    ui.scale = 1;
  });
  afterEach(() => {
    vi.useRealTimers();
    ui.scale = 1;
  });

  type Setup = ReturnType<typeof newWindow>;
  type Box = { x: number; y: number; width: number; height: number };
  /** The overlay is ready and a Peek opens, its page in the card. */
  const open = (s: Setup, view: WebContentsView = s.view) => {
    s.w.markOverlayReady();
    s.w.openPeek(view, info, 0);
    vi.runAllTimers();
  };
  /** What the overlay was last told about the card: an opening's, or a later peek:state. */
  const told = (s: Setup) => {
    const last = toOverlay(s.overlay)
      .filter((m) => m.channel === 'peek:state' || m.channel === 'overlay:open')
      .at(-1)!;
    return (last.channel === 'overlay:open' ? last.payload['peek'] : last.payload) as { card: Box; home: Box; area: Box };
  };
  const inside = (b: Box, a: Box) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
  const pageIn = (card: Box) => ({ x: card.x, y: card.y + 40, width: card.width, height: card.height - 40 });
  /** Peek's page sits in the card below its header, and main told the overlay that card, inside the page area. */
  const expectPlaced = (s: Setup, card: Box, moved = false) => {
    const state = told(s);
    // A box the overlay sent isn't sent back to it: it drew it already.
    if (!moved) expect(state.card).toEqual(card);
    expect(inside(card, state.area)).toBe(true);
    expect(s.peek.getBounds()).toEqual(toWindowRect(pageIn(card), ui.scale));
    expect(s.w.captureTarget()?.rect).toEqual(pageIn(card));
  };
  const resize = (s: Setup, width: number, height: number, x = 0) => {
    s.window.content = { x, y: 0, width, height };
    s.window.emit('resize');
  };

  it('a moved card: its page and the popover follow, and nothing else is laid out or sent', () => {
    const s = newWindow();
    open(s);
    const popover = s.w.popover as unknown as FakeView;
    const tabMoves = s.tab.setBounds.mock.calls.length;
    vi.mocked(send).mockClear();
    const placed = s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 });
    expect(placed).toEqual({ x: 300, y: 100, width: 500, height: 400 });
    expect(s.peek.getBounds()).toEqual({ x: 300, y: 140, width: 500, height: 360 });
    expect(popover.getBounds().y).toBe(140);
    expect(popover.getBounds().x).toBeGreaterThanOrEqual(300);
    // The tab underneath stays where it is, and the overlay isn't told what it drew itself.
    expect(s.tab.setBounds.mock.calls.length).toBe(tabMoves);
    expect(toOverlay(s.overlay)).toEqual([]);
  });

  it('with no Peek open, a move does nothing', () => {
    const s = newWindow();
    s.w.markOverlayReady();
    expect(s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 })).toBeNull();
    expect(s.peek.setBounds).not.toHaveBeenCalled();
    open(s);
    expect(told(s).card).toEqual(told(s).home);
  });

  // Each case starts with the card left near the bottom-right corner at 500 × 400.
  it.each<[string, (s: Setup) => Box | null]>([
    ['dragged past the left edge', (s) => s.w.movePeek({ x: -500, y: 100, width: 500, height: 400 })],
    ['dragged past the right edge', (s) => s.w.movePeek({ x: 5000, y: 100, width: 500, height: 400 })],
    ['dragged past the top edge', (s) => s.w.movePeek({ x: 300, y: -500, width: 500, height: 400 })],
    ['dragged past the bottom edge', (s) => s.w.movePeek({ x: 300, y: 5000, width: 500, height: 400 })],
    ['resized below the minimum', (s) => s.w.movePeek({ x: 300, y: 100, width: 10, height: 10 })],
    ['resized past the whole area', (s) => s.w.movePeek({ x: 0, y: 0, width: 9000, height: 9000 })],
    ['the window shrinks', (s) => (resize(s, 900, 600), null)],
    ['the window shrinks smaller than the minimum', (s) => (resize(s, 500, 260), null)],
    ['the sidebar collapses', (s) => (s.w.setSidebar('collapsed', 240), null)],
    ['the sidebar collapses, then docks again wider', (s) => (s.w.setSidebar('collapsed', 240), s.w.setSidebar('docked', 480), null)],
    ['the window goes to a monitor at another scale, a little smaller', (s) => ((ui.scale = 1.5), resize(s, 1100, 700, 1280), null)],
    ['and back to the first monitor', (s) => ((ui.scale = 1.5), resize(s, 1100, 700, 1280), (ui.scale = 1), resize(s, 1280, 820), null)],
    ['the interface size grows to 125%', (s) => ((ui.scale = 1.25), s.window.emit('resize'), null)],
  ])('%s: the card stays wholly inside the page area', (_name, act) => {
    const s = newWindow();
    open(s);
    s.w.movePeek({ x: 760, y: 400, width: 500, height: 400 });
    const placed = act(s);
    const { area } = told(s);
    const card = placed ?? told(s).card;
    expect(inside(card, area)).toBe(true);
    expect(card.width).toBeGreaterThanOrEqual(Math.min(PEEK_MIN.width, area.width));
    expect(card.height).toBeGreaterThanOrEqual(Math.min(PEEK_MIN.height, area.height));
    expectPlaced(s, card, placed !== null);
  });

  it('the window shrinks and grows back: the card is where it was left', () => {
    const s = newWindow();
    open(s);
    const left = s.w.movePeek({ x: 760, y: 400, width: 500, height: 400 })!;
    resize(s, 900, 600);
    expect(told(s).card).not.toEqual(left);
    resize(s, 1280, 820);
    expectPlaced(s, left);
  });

  it('the next Peek in the window opens where the last was left; another window’s doesn’t', () => {
    const s = newWindow();
    open(s);
    const home = told(s).home;
    const left = s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 })!;
    s.w.closePeek();
    const next = new FakeView();
    open(s, next as unknown as WebContentsView);
    expect(told(s).card).toEqual(left);
    expect(next.getBounds()).toEqual(toWindowRect(pageIn(left)));

    const other = newWindow();
    open(other);
    expect(told(other).card).toEqual(home);
  });

  it('back home (a double-click on the header): the default box, for this Peek and the next', () => {
    const s = newWindow();
    open(s);
    const home = told(s).home;
    s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 });
    expect(s.w.movePeek(null)).toEqual(home);
    expect(s.peek.getBounds()).toEqual(toWindowRect(pageIn(home)));
    s.w.closePeek();
    open(s, new FakeView() as unknown as WebContentsView);
    expect(told(s).card).toEqual(home);
    // At home it follows the frame as before: centered again after the window resizes.
    resize(s, 1000, 700);
    expect(told(s).card).toEqual(told(s).home);
    expect(told(s).home).not.toEqual(home);
  });

  it('Chord starting again: a new window’s Peek opens at home (it was kept in memory only)', () => {
    const first = newWindow();
    open(first);
    first.w.movePeek({ x: 300, y: 100, width: 500, height: 400 });
    first.window.emit('closed');
    const again = newWindow();
    open(again);
    expect(told(again).card).toEqual(told(again).home);
  });

  it('Open as tab grows the page from where the card is', () => {
    const s = newWindow();
    open(s);
    const left = s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 })!;
    s.peek.setBounds.mockClear();
    let done = false;
    s.w.growPeekToFrame(true, () => (done = true));
    vi.advanceTimersByTime(17);
    const first = s.peek.setBounds.mock.calls[0]![0] as Box;
    // Its first frame is still about the card's page.
    expect(Math.abs(first.x - pageIn(left).x)).toBeLessThan(40);
    expect(Math.abs(first.y - pageIn(left).y)).toBeLessThan(40);
    vi.runAllTimers();
    expect(done).toBe(true);
  });

  // #78's review: a glide home still running, or a drag, when Open as tab starts would move the page mid-grow.
  it.each<[string, Box | null]>([
    ['a late box from a glide home or a drag', { x: 600, y: 300, width: 400, height: 300 }],
    ['the glide’s last word, home', null],
  ])('while Open as tab grows the page, a move is ignored: %s', (_name, late) => {
    const s = newWindow();
    open(s);
    const left = s.w.movePeek({ x: 300, y: 100, width: 500, height: 400 })!;
    const popover = s.w.popover as unknown as FakeView;
    const popoverAt = popover.getBounds();
    s.w.growPeekToFrame(true, () => s.w.closePeek());
    vi.advanceTimersByTime(17);
    const growing = s.peek.setBounds.mock.calls.length;
    expect(s.w.movePeek(late)).toBeNull();
    // Nothing placed by the move, and a layout meanwhile leaves the page to the glide too.
    (s.w as unknown as { layout(): void }).layout();
    expect(s.peek.setBounds.mock.calls.length).toBe(growing);
    expect(popover.getBounds()).toEqual(popoverAt);
    vi.runAllTimers();
    // The next Peek opens where the card was when Open as tab began, not at the late box.
    open(s, new FakeView() as unknown as WebContentsView);
    expect(told(s).card).toEqual(left);
    expect(s.w.movePeek({ x: 320, y: 120, width: 500, height: 400 })).toEqual({ x: 320, y: 120, width: 500, height: 400 });
  });
});
