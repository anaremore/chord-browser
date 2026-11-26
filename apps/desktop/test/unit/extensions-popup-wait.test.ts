/**
 * #277 (from #272's round 2): an extension's pop-out window (`windows.create({type: 'popup'})`) loads once its
 * profile's session is ready, as a tab's page does: asked again when a wait ends, since another may have begun (its
 * proxy set again), and never into a window closed meanwhile.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = [];
  destroyed = false;
  readonly webContents = { session: {}, setWindowOpenHandler: vi.fn() };
  readonly loadURL = vi.fn(async () => undefined);
  constructor() {
    super();
    FakeWindow.made.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
}

// Electron as far as this module and what it imports touch it at load: anything else answers itself.
vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({ BrowserWindow: FakeWindow } as Record<string | symbol, unknown>, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : any), has: () => true });
});

const { Extensions } = await import('../../src/main/extensions/index');

function held() {
  const wait = { over: false, promise: Promise.resolve(), resolve: () => {} };
  wait.promise = new Promise<void>((r) => (wait.resolve = () => ((wait.over = true), r())));
  return wait;
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A pop-out opened while its session waits on `waits`, in order: proxyReady answers the first not over, else null. */
function popOut(waits: Array<ReturnType<typeof held>>) {
  FakeWindow.made.length = 0;
  const extensions = new Extensions({ profileSession: () => ({}), proxyReady: () => waits.find((w) => !w.over)?.promise ?? null } as never);
  (extensions as unknown as { openPopupWindow(p: string, u: string, d: object): unknown }).openPopupWindow('default', 'chrome-extension://x/popup.html', {});
  return FakeWindow.made[0]!;
}

describe('an extension’s pop-out waits for its session (#277)', () => {
  it('ready: loads at once', () => {
    expect(popOut([]).loadURL).toHaveBeenCalledWith('chrome-extension://x/popup.html');
  });

  it('one wait, then another begun meanwhile: loads only after both', async () => {
    const rules = held();
    const proxy = held();
    const win = popOut([rules, proxy]);
    expect(win.loadURL).not.toHaveBeenCalled();
    rules.resolve();
    await tick();
    expect(win.loadURL).not.toHaveBeenCalled();
    proxy.resolve();
    await tick();
    expect(win.loadURL).toHaveBeenCalledOnce();
  });

  it('closed during the wait: never loaded', async () => {
    const rules = held();
    const win = popOut([rules]);
    win.destroyed = true;
    rules.resolve();
    await tick();
    expect(win.loadURL).not.toHaveBeenCalled();
  });
});
