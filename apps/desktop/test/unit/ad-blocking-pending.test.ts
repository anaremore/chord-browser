/**
 * #189: a page's first load in a chord's session waits until that session's ad-blocking extension has been added (its
 * first load tried), whatever launch's 3 s cap did: `pending` is what tabs.ts' whenProxied waits on, beside the proxy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));

const { AdBlocking } = await import('../../src/main/ad-blocking/service');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service() {
  const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
  dirs.push(root);
  // No compiled lists anywhere: a session's first load is tried at once (nothing to load), as it is when they fail.
  return new AdBlocking({ bundledDir: join(root, 'none'), root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000 }, { enabled: () => true, offSites: () => [] });
}

const fakeSession = () => ({ extensions: { getExtension: () => null, loadExtension: async () => ({ id: 'x' }), removeExtension: () => undefined }, webRequest: { onBeforeRequest: () => undefined } }) as never;

describe('ad blocking: what a page waits for (#189)', () => {
  it('a chord’s session: its page waits until the extension’s first load is tried, then for nothing', async () => {
    const blocking = service();
    const ses = fakeSession();
    blocking.attach('default', ses, false);
    const pending = blocking.pending(ses);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(blocking.pending(ses)).toBeNull();
  });

  it('a private window’s session (a request handler, no extension) and a session it never saw: nothing to wait for', () => {
    const blocking = service();
    const priv = fakeSession();
    blocking.attach('private-1', priv, true);
    expect(blocking.pending(priv)).toBeNull();
    expect(blocking.pending(fakeSession())).toBeNull();
  });
});
