/**
 * #274: profiles whose rules are stale (a first launch, or a list update, with several chords) each copy the bundled
 * rules through a staging folder before writing them into their own extension. Their updates run side by side; with
 * one shared folder, one profile removed it while another was still copying out of it (Windows: EPERM rmdir), and that
 * profile had no blocking until the next launch. Here all three are inside their write at once, then go on one by one.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));

const { AdBlocking } = await import('../../src/main/ad-blocking/service');
const { BlockerExtension } = await import('../../src/main/ad-blocking/extension');
const { FILTER_LISTS } = await import('../../src/main/ad-blocking/lists');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROFILES = ['default', 'work', 'home'];

function fakeSession() {
  const loaded = new Set<string>();
  let n = 0;
  return {
    extensions: {
      getExtension: (id: string) => (loaded.has(id) ? { id } : null),
      loadExtension: async () => {
        const id = `ext-${++n}`;
        loaded.add(id);
        return { id };
      },
      removeExtension: (id: string) => void loaded.delete(id),
    },
    webRequest: { onBeforeRequest: () => undefined },
  } as never;
}

describe('ad blocking: stale profiles’ rules written side by side (#274)', () => {
  it('three profiles inside their write at once: each gets every list’s rules, none fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
    dirs.push(root);
    const bundledDir = join(root, 'bundled');
    mkdirSync(join(bundledDir, 'rules'), { recursive: true });
    writeFileSync(join(bundledDir, 'lists.json'), JSON.stringify({ versions: Object.fromEntries(FILTER_LISTS.map((l) => [l.id, '202611260000'])), refreshMs: {}, stats: {} }));
    for (const l of FILTER_LISTS) writeFileSync(join(bundledDir, 'rules', `${l.id}.json`), `[{"id":1,"list":"${l.id}"}]`);

    // Every profile waits inside its write until all three are there; then they go on one at a time.
    const write = BlockerExtension.prototype.write;
    const entered: Array<() => void> = [];
    let allIn = () => {};
    const together = new Promise<void>((resolve) => (allIn = resolve));
    vi.spyOn(BlockerExtension.prototype, 'write').mockImplementation(async function (this: InstanceType<typeof BlockerExtension>, setDir: string) {
      await new Promise<void>((resolve) => {
        entered.push(resolve);
        if (entered.length === PROFILES.length) allIn();
      });
      return await write.call(this, setDir);
    });
    vi.spyOn(BlockerExtension.prototype, 'apply').mockResolvedValue(undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const blocking = new AdBlocking({ bundledDir, root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000 }, { enabled: () => true, offSites: () => [] });
    for (const id of PROFILES) blocking.attach(id, fakeSession(), false);
    await together;
    for (const go of entered) {
      go();
      // Its write, and its staging folder's removal, done before the next goes on.
      await new Promise((r) => setTimeout(r, 50));
    }
    await blocking.settled();

    expect(errors).not.toHaveBeenCalled();
    for (const id of PROFILES) for (const l of FILTER_LISTS) expect(existsSync(join(root, 'Extension', id, 'rules', `${l.id}.json`)), `${id} ${l.id}`).toBe(true);
  });
});
