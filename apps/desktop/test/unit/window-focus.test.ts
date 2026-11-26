/**
 * Chord's floating views and the keyboard (#200, #201): on macOS AppKit makes a view of the window its first responder
 * when it's shown while nothing else in the window has the focus, or as the window comes back to the front: the
 * popover's cards (with a card or not), the menu under a field. A floating view keeps the keyboard only when it owns it:
 * the cards when Chord gave it to them (focusPopover, F6) or you clicked in them; the menu when you clicked in it.
 * Otherwise it goes back to where it was. Windows and Linux never move it.
 */
import { EventEmitter } from 'node:events';
import type { WindowId } from '@chord/core';
import type { Session, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { FakeView, type FakeContents } from './fake-view';

const focus = vi.hoisted(() => ({ window: null as unknown, contents: null as unknown, platform: 'darwin', packaged: true }));

class FakeWindow extends EventEmitter {
  static getFocusedWindow = () => focus.window;
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
  webContents: { getFocusedWebContents: () => focus.contents },
  app: {
    get isPackaged() {
      return focus.packaged;
    },
  },
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
  get platform() {
    return focus.platform;
  },
  applyMaterial: vi.fn(),
  onUiScale: () => () => undefined,
  systemInfo: () => ({}),
  titleBarOverlay: () => ({}),
  trafficLightPosition: () => ({ x: 0, y: 0 }),
  uiScale: () => 1,
  windowChromeOptions: () => ({}),
}));

const { AppWindow } = await import('../../src/main/window');

function newWindow() {
  focus.platform = 'darwin';
  const w = new AppWindow({ id: 'w1' as WindowId, uiSession: {} as Session, bounds: null, sidebar: 'docked', sidebarWidth: 240, onBounds: vi.fn(), presenting: () => false });
  w.markShellPainted();
  const page = new FakeView();
  w.showTabs([page as unknown as WebContentsView], 0, null, []);
  const window = (w as unknown as { window: FakeWindow }).window;
  focus.window = window;
  const popover = w.popover as unknown as FakeView;
  const shell = w.shell as unknown as FakeView;
  // Who has the keyboard: one contents at a time, as main sees it.
  for (const c of [page.page, popover.page, shell.page]) c.isFocused = () => focus.contents === c;
  focus.contents = page.page;
  // Only what happens next counts (showing the tab focused it already).
  page.page.focus.mockClear();
  /** The OS makes `c` the first responder (its focus event; `then`, in the same native event), then a turn goes by. */
  const osFocuses = (c: FakeContents, then?: () => void) => {
    focus.contents = c;
    c.emit('focus');
    then?.();
    vi.runOnlyPendingTimers();
  };
  /** Chord goes behind, and comes back to the front with `c` made the first responder. */
  const comesBack = (c: FakeContents) => {
    window.emit('blur');
    focus.window = null;
    focus.contents = c;
    focus.window = window;
    window.emit('focus');
    vi.runOnlyPendingTimers();
  };
  const cardUp = () => w.setPopoverSize(360, 200);
  return { w, page, window, popover, shell, osFocuses, comesBack, cardUp };
}

const fake = () => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
};

describe('coming back to a window, never the keyboard on a floating view that doesn’t own it (#201, agents.spec’s “coming back to Chord”)', () => {
  it('a popover with no card: it goes to your page', () => {
    const done = fake();
    const { page, popover, comesBack } = newWindow();
    comesBack(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('a card that doesn’t own it: it goes to your page, however long after the card came', () => {
    const done = fake();
    const { page, popover, comesBack, cardUp } = newWindow();
    cardUp();
    vi.advanceTimersByTime(5_000);
    page.page.focus.mockClear();
    comesBack(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('a card Chord gave the keyboard (find, a card that asks) keeps it, shown or hidden for a moment', () => {
    const done = fake();
    const { w, page, popover, comesBack, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    page.page.focus.mockClear();
    for (const visible of [true, false]) {
      popover.setVisible(visible);
      comesBack(popover.page);
      expect(page.page.focus, String(visible)).not.toHaveBeenCalled();
    }
    done();
  });

  it('back to where the keyboard was as the window went behind: the shell (its address bar), not the page', () => {
    const done = fake();
    const { page, popover, shell, comesBack } = newWindow();
    focus.contents = shell.page;
    comesBack(popover.page);
    expect(shell.page.focus).toHaveBeenCalled();
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('only as the window comes back: parking a page never takes the focus off the popover', () => {
    const { w, page, popover } = newWindow();
    focus.contents = popover.page;
    w.keepFocusOffParked();
    expect(page.page.focus).not.toHaveBeenCalled();
  });
});

describe('a card never takes the keyboard on its own (#200)', () => {
  it('focus the OS gives a card as it appears, or any time after, goes back to the page', () => {
    const done = fake();
    const { page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    osFocuses(popover.page);
    expect(page.page.focus).toHaveBeenCalledTimes(1);
    focus.contents = page.page;
    vi.advanceTimersByTime(1_500);
    osFocuses(popover.page);
    expect(page.page.focus).toHaveBeenCalledTimes(2);
    done();
  });

  it('a click in a card that didn’t ask owns it: its focus event can come before the mouse-down (B1)', () => {
    const done = fake();
    const { page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    osFocuses(popover.page, () => popover.page.emit('before-mouse-event', {}, { type: 'mouseDown' }));
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('a card that asked keeps it, asked before or after it showed, and after a frame snapshot hid it for more than a second (B2)', () => {
    const done = fake();
    const after = newWindow();
    after.cardUp();
    after.w.focusPopover();
    after.osFocuses(after.popover.page);
    expect(after.page.page.focus).not.toHaveBeenCalled();
    const before = newWindow();
    before.w.focusPopover();
    before.cardUp();
    expect(before.popover.page.focus).toHaveBeenCalled();
    let moving = true;
    Object.defineProperty((before.w as unknown as { snapshots: object }).snapshots, 'active', { get: () => moving });
    before.cardUp();
    expect(before.popover.getVisible()).toBe(false);
    vi.advanceTimersByTime(1_500);
    moving = false;
    before.cardUp();
    before.osFocuses(before.popover.page);
    expect(before.page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('what the cards owned goes with the last card: the next one, which didn’t ask, doesn’t own it (S1)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    w.setCards(false);
    w.setPopoverSize(0, 0);
    cardUp();
    osFocuses(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('the card that asked answered, others left: they don’t own it, and it goes back (Browser: popoverDoneAsking)', () => {
    const done = fake();
    const { w, page, popover, cardUp } = newWindow();
    cardUp();
    w.focusPopover('ask');
    focus.contents = popover.page;
    w.popoverDoneAsking();
    vi.runOnlyPendingTimers();
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('F6 to the cards owns it only while they’re shown; F6 elsewhere ends it (S1, S2)', () => {
    const done = fake();
    const hidden = newWindow();
    hidden.w.focusRegion('popover');
    hidden.cardUp();
    hidden.page.page.focus.mockClear();
    hidden.osFocuses(hidden.popover.page);
    expect(hidden.page.page.focus).toHaveBeenCalled();
    const shown = newWindow();
    shown.cardUp();
    shown.w.focusRegion('popover');
    shown.osFocuses(shown.popover.page);
    expect(shown.page.page.focus).not.toHaveBeenCalled();
    shown.w.focusRegion('page');
    focus.contents = shown.page.page;
    shown.page.page.focus.mockClear();
    shown.osFocuses(shown.popover.page);
    expect(shown.page.page.focus).toHaveBeenCalled();
    done();
  });

  it('back to where the keyboard was when the card came: the shell, not the page (B3)', () => {
    const done = fake();
    const { page, popover, shell, osFocuses, cardUp } = newWindow();
    focus.contents = shell.page;
    cardUp();
    osFocuses(popover.page);
    expect(shell.page.focus).toHaveBeenCalled();
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('nothing while the window isn’t the focused one (B5), and nothing on Windows or Linux (B4)', () => {
    const done = fake();
    const behind = newWindow();
    behind.cardUp();
    focus.window = null;
    behind.osFocuses(behind.popover.page);
    expect(behind.page.page.focus).not.toHaveBeenCalled();
    for (const os of ['win32', 'linux']) {
      const other = newWindow();
      focus.platform = os;
      other.cardUp();
      other.osFocuses(other.popover.page);
      other.comesBack(other.popover.page);
      expect(other.page.page.focus, os).not.toHaveBeenCalled();
    }
    done();
  });

  it('the menu under a field never keeps the keyboard it didn’t get by a click (#200’s run: the menu had it)', () => {
    const done = fake();
    const { w, page, osFocuses } = newWindow();
    const menu = w.ensureMenuView() as unknown as FakeContents;
    menu.isFocused = () => focus.contents === menu;
    osFocuses(menu);
    expect(page.page.focus).toHaveBeenCalledTimes(1);
    focus.contents = page.page;
    osFocuses(menu, () => menu.emit('before-mouse-event', {}, { type: 'mouseDown' }));
    expect(page.page.focus).toHaveBeenCalledTimes(1);
    done();
  });
});

/** Round 3 of #245 (Neon's and Opus's reviews of 989d8aa): who owns the keyboard, and when that ends. */
describe('who owns the keyboard, and when that ends (#245, round 3)', () => {
  it('a card that asks owns it until it’s answered; one you clicked in keeps it when another card’s ask ends (B1)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    w.focusPopover('ask');
    // You click into the save card beside it (a passphrase), then the page cancels the sign-in box.
    popover.page.emit('before-mouse-event', {}, { type: 'mouseDown' });
    w.popoverDoneAsking();
    osFocuses(popover.page);
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('find (yours) is never ended by an ask being answered (B1)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    w.popoverDoneAsking();
    osFocuses(popover.page);
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('find, then Esc to the page, then coming back: the popover owns nothing any more (B2, #201)', () => {
    const done = fake();
    const { w, page, popover, comesBack, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    focus.contents = page.page;
    popover.page.emit('blur');
    vi.runOnlyPendingTimers();
    page.page.focus.mockClear();
    comesBack(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('a click in a card, then one in the page, then coming back: the card owns nothing any more (B2, #201)', () => {
    const done = fake();
    const { page, popover, osFocuses, comesBack, cardUp } = newWindow();
    cardUp();
    osFocuses(popover.page, () => popover.page.emit('before-mouse-event', {}, { type: 'mouseDown' }));
    focus.contents = page.page;
    popover.page.emit('blur');
    vi.runOnlyPendingTimers();
    page.page.focus.mockClear();
    comesBack(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('the keyboard going to the shell ends it too, without a blur (B2: blur may not come on macOS)', () => {
    const done = fake();
    const { w, page, popover, shell, comesBack, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    focus.contents = shell.page;
    shell.page.emit('focus');
    page.page.focus.mockClear();
    comesBack(popover.page);
    expect(shell.page.focus).toHaveBeenCalled();
    done();
  });

  it('not when the window went behind, nor while a frame snapshot hides the cards: they still own it (B2)', () => {
    const done = fake();
    const { w, page, popover, cardUp, comesBack } = newWindow();
    cardUp();
    w.focusPopover();
    focus.window = null;
    focus.contents = null;
    popover.page.emit('blur');
    vi.runOnlyPendingTimers();
    comesBack(popover.page);
    expect(page.page.focus).not.toHaveBeenCalled();
    let moving = true;
    Object.defineProperty((w as unknown as { snapshots: object }).snapshots, 'active', { get: () => moving });
    cardUp();
    focus.contents = page.page;
    popover.page.emit('blur');
    vi.runOnlyPendingTimers();
    moving = false;
    cardUp();
    comesBack(popover.page);
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('an old card’s late 0 × 0 never takes a new card’s ask away (B3)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    // The old card closes (Browser says so), a new one asks while the popover reports the old one gone, late.
    w.setCards(false);
    popover.setVisible(false);
    w.focusPopover('ask');
    w.setCards(true);
    w.setPopoverSize(0, 0);
    cardUp();
    expect(popover.page.focus).toHaveBeenCalled();
    osFocuses(popover.page);
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('no card left (Browser’s word): nothing owned, nothing waiting; the next card that doesn’t ask owns nothing (S1)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    cardUp();
    w.focusPopover();
    w.setCards(false);
    w.setPopoverSize(0, 0);
    cardUp();
    osFocuses(popover.page);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('a card that asks waits while the command bar covers it, and takes the keyboard as it closes (B4)', () => {
    const done = fake();
    const { w, popover, cardUp } = newWindow();
    w.markOverlayReady();
    w.openOverlay('new', '');
    cardUp();
    popover.page.focus.mockClear();
    w.focusPopover('ask');
    expect(popover.page.focus).not.toHaveBeenCalled();
    w.closeOverlay();
    expect(popover.page.focus).toHaveBeenCalled();
    done();
  });

  it('and while a page is full screen, until it leaves it (B4)', () => {
    const done = fake();
    const { w, popover, cardUp } = newWindow();
    cardUp();
    w.setPageFullScreen(true);
    popover.page.focus.mockClear();
    w.focusPopover('ask');
    expect(popover.page.focus).not.toHaveBeenCalled();
    w.setPageFullScreen(false);
    vi.runOnlyPendingTimers();
    expect(popover.page.focus).toHaveBeenCalled();
    done();
  });

  it('the command bar opening ends what the cards owned; the keyboard goes back to the command bar (S1)', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    const overlay = (w.overlay as unknown as FakeView).page;
    overlay.isFocused = () => focus.contents === overlay;
    cardUp();
    w.focusPopover();
    w.markOverlayReady();
    w.openOverlay('new', '');
    overlay.focus.mockClear();
    osFocuses(popover.page);
    expect(overlay.focus).toHaveBeenCalled();
    expect(page.page.focus).not.toHaveBeenCalled();
    done();
  });

  it('never back to another window’s contents, nor a pane that’s hidden: the page you see, then the shell (Should-fix 5)', () => {
    const done = fake();
    const { page, popover, osFocuses, cardUp } = newWindow();
    const other = new FakeView().page;
    focus.contents = other;
    cardUp();
    osFocuses(popover.page);
    expect(other.focus).not.toHaveBeenCalled();
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('never back to where it was once that’s gone from sight: not to the command bar after it closed', () => {
    const done = fake();
    const { w, page, popover, osFocuses, cardUp } = newWindow();
    const overlay = (w.overlay as unknown as FakeView).page;
    w.markOverlayReady();
    w.openOverlay('new', '');
    w.closeOverlay();
    // Nothing of this window's had it as the card came (the closing command bar's focus hasn't landed yet).
    focus.contents = null;
    cardUp();
    overlay.focus.mockClear();
    page.page.focus.mockClear();
    osFocuses(popover.page);
    expect(overlay.focus).not.toHaveBeenCalled();
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('F6 elsewhere ends the menu’s click, too (S1: keysMovedOnPurpose)', () => {
    const done = fake();
    const { w, page, osFocuses } = newWindow();
    const menu = w.ensureMenuView() as unknown as FakeContents;
    menu.isFocused = () => focus.contents === menu;
    osFocuses(menu, () => menu.emit('before-mouse-event', {}, { type: 'mouseDown' }));
    expect(page.page.focus).not.toHaveBeenCalled();
    w.focusRegion('page');
    page.page.focus.mockClear();
    osFocuses(menu);
    expect(page.page.focus).toHaveBeenCalled();
    done();
  });

  it('the popover is placed before it’s shown, never shown where it was last (B6)', () => {
    const { w, popover } = newWindow();
    popover.setBounds.mockClear();
    popover.setVisible.mockClear();
    w.setPopoverSize(360, 200);
    const placed = popover.setBounds.mock.invocationCallOrder[0]!;
    const shown = popover.setVisible.mock.invocationCallOrder.find((_, i) => popover.setVisible.mock.calls[i]![0] === true)!;
    expect(placed).toBeLessThan(shown);
  });

  it('the focus log: only with the test hooks on, in an unpackaged build', () => {
    process.env['CHORD_E2E_HOOKS'] = '1';
    try {
      focus.packaged = true;
      const packaged = newWindow();
      packaged.cardUp();
      expect(packaged.w.cardFocusForTests()).toEqual([]);
      focus.packaged = false;
      const unpackaged = newWindow();
      unpackaged.cardUp();
      expect(unpackaged.w.cardFocusForTests().length).toBeGreaterThan(0);
    } finally {
      delete process.env['CHORD_E2E_HOOKS'];
      focus.packaged = true;
    }
  });
});
