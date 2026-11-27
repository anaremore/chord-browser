/**
 * #331 (Opus's SF-A; with #334's launch guard): a session whose proxy began failing has its installed extensions
 * loaded again, so a worker already running stops. During launch, which loads everything itself (Neon's B1 on #334),
 * nothing is loaded a second time meanwhile; the session's restart runs once launch has loaded them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, Menu: {}, nativeImage: {}, WebContentsView: class {} }));
vi.mock('../../src/main/ipc', () => ({ send: () => {} }));
vi.mock('../../src/main/extensions/popup', () => ({ ExtensionPopup: class {} }));
vi.mock('../../src/main/extensions/host', () => ({ within: <T>(p: Promise<T>) => p, ExtensionHost: class {} }));

const { Extensions } = await import('../../src/main/extensions/index');

const ses = { id: 'failing' };

/** An Extensions with one profile's host, holding one installed extension, and launch's own loading stubbed. */
function setup() {
  const loaded = new Set(['ext']);
  const host = {
    session: ses,
    get: (id: string) => (loaded.has(id) ? {} : undefined),
    unload: vi.fn((id: string) => void loaded.delete(id)),
    load: vi.fn(async () => void loaded.add('ext')),
  };
  let finishLoading!: () => void;
  const self = Object.assign(Object.create(Extensions.prototype) as object, {
    hosts: new Map([['p1', host]]),
    deps: { state: () => ({ extensions: { 'p1:ext': { profileId: 'p1', id: 'ext', name: 'Ext', path: '/x/ext/1_0' } } }), changed: vi.fn() },
    installing: new Set(),
    updating: new Set(),
    loading: new Set(),
    unloadable: new Set(),
    starting: false,
    restartAfterStart: new Set(),
    sync: vi.fn(),
    startLoading: () => new Promise<void>((r) => (finishLoading = r)),
    finishInstall: vi.fn(async () => {}),
    scheduledUpdateCheck: async () => {},
    scheduleUpdates: () => {},
  }) as unknown as InstanceType<typeof Extensions>;
  return { self, host, finish: () => finishLoading() };
}

describe('restartIn (#331) and launch (#334)', () => {
  it('outside launch: each installed extension in the session is unloaded and loaded again', async () => {
    const { self, host } = setup();
    await self.restartIn(ses as never);
    expect(host.unload).toHaveBeenCalledWith('ext');
    expect(host.load).toHaveBeenCalledWith('/x/ext/1_0');
  });

  it('during launch: nothing loaded twice meanwhile; the restart runs once launch has loaded everything', async () => {
    const { self, host, finish } = setup();
    const started = self.start();
    await self.restartIn(ses as never);
    expect(host.unload).not.toHaveBeenCalled();
    expect(host.load).not.toHaveBeenCalled();
    finish();
    await started;
    await vi.waitFor(() => expect(host.load).toHaveBeenCalledOnce());
    expect(host.unload).toHaveBeenCalledWith('ext');
    clearTimeout((self as unknown as { updateTimer: ReturnType<typeof setTimeout> }).updateTimer);
  });
});
