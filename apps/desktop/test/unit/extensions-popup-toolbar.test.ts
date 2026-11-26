/**
 * #287: the toolbar's extension popup (extensions/popup.ts) loads once its profile's session is ready, as a tab's page
 * and an extension's pop-out window do (#272, #282): asked again as each wait ends, and never into a popup closed
 * meanwhile.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FakeContents, FakeView } from './fake-view';

vi.mock('electron', async () => ({ WebContentsView: (await import('./fake-view')).FakeView }));

const { ExtensionPopup } = await import('../../src/main/extensions/popup');

function held() {
  const wait = { over: false, promise: Promise.resolve(), resolve: () => {} };
  wait.promise = new Promise<void>((r) => (wait.resolve = () => ((wait.over = true), r())));
  return wait;
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A popup opened while its session waits on `waits`, in order: proxyReady answers the first not over, else null. */
function open(waits: Array<ReturnType<typeof held>>) {
  const session = {};
  const asked: object[] = [];
  const host = { showFloating: vi.fn(), hideFloating: vi.fn(), releaseFloating: vi.fn(), window: { isDestroyed: () => false, isFocused: () => true }, frameBounds: { x: 0, y: 0, width: 800, height: 600 } };
  const popup = new ExtensionPopup(host as never, {
    extensionId: 'x',
    session: session as never,
    url: 'chrome-extension://x/popup.html',
    anchor: null,
    openTab: vi.fn(),
    onClosed: vi.fn(),
    proxyReady: (s: object) => (asked.push(s), waits.find((w) => !w.over)?.promise ?? null),
  } as never);
  const page = (popup.view as unknown as FakeView).page as FakeContents;
  return { popup, page, asked, session };
}

describe('the toolbar’s extension popup waits for its session (#287)', () => {
  it('ready: loads at once, its own session asked', () => {
    const t = open([]);
    expect(t.page.loadURL).toHaveBeenCalledWith('chrome-extension://x/popup.html');
    expect(t.asked).toEqual([t.session]);
  });

  it('one wait, then another begun meanwhile: loads only after both', async () => {
    const rules = held();
    const proxy = held();
    const t = open([rules, proxy]);
    expect(t.page.loadURL).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(t.page.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(t.page.loadURL).toHaveBeenCalledOnce();
  });

  it('closed during the wait: never loaded', async () => {
    const rules = held();
    const t = open([rules]);
    t.popup.close();
    rules.resolve();
    await tick();
    expect(t.page.loadURL).not.toHaveBeenCalled();
  });
});
