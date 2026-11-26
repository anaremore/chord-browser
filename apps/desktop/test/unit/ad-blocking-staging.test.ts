/**
 * #274: profiles whose rules are stale (a first launch, or a list update, with several chords) each copy the bundled
 * rules through a staging folder before writing them into their own extension. Their updates run side by side; with
 * one shared folder, one profile removed it while another was still copying out of it (Windows: EPERM rmdir), and that
 * profile had no blocking until the next launch. Here all three are inside their write at once, then go on one by one.
 *
 * And (Neon's round 1 of #281): a staging folder that can't be removed (a scanner holding a handle) never leaves a
 * profile without blocking; a failed write leaves no staging folder behind; staging folders of profiles no chord uses
 * go with their extension folders; and an extension's folder has its manifest only once its rules are all in.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FsPromisesModule from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

type FsPromises = typeof FsPromisesModule;

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));
/** Removing a staging folder fails while this is set (EBUSY: Defender or the indexer holding a handle). */
const held = { staging: false };
vi.mock('node:fs/promises', async (actual) => {
  const fs = await actual<FsPromises>();
  const rm: typeof fs.rm = async (path, options) => {
    if (held.staging && String(path).includes('Staging')) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(path)}'`), { code: 'EBUSY' });
    return await fs.rm(path, options);
  };
  return { ...fs, default: { ...fs, rm }, rm };
});

const { AdBlocking } = await import('../../src/main/ad-blocking/service');
const { BlockerExtension } = await import('../../src/main/ad-blocking/extension');
const { FILTER_LISTS } = await import('../../src/main/ad-blocking/lists');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  held.staging = false;
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

/** A root with a bundled compiled set, and the service over it (apply, the control page, answered at once). */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
  dirs.push(root);
  const bundledDir = join(root, 'bundled');
  mkdirSync(join(bundledDir, 'rules'), { recursive: true });
  writeFileSync(join(bundledDir, 'lists.json'), JSON.stringify({ versions: Object.fromEntries(FILTER_LISTS.map((l) => [l.id, '202611260000'])), refreshMs: {}, stats: {} }));
  for (const l of FILTER_LISTS) writeFileSync(join(bundledDir, 'rules', `${l.id}.json`), `[{"id":1,"list":"${l.id}"}]`);
  vi.spyOn(BlockerExtension.prototype, 'apply').mockResolvedValue(undefined);
  const blocking = new AdBlocking({ bundledDir, root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000 }, { enabled: () => true, offSites: () => [] });
  return { root, blocking };
}
const hasRules = (root: string, id: string) => FILTER_LISTS.every((l) => existsSync(join(root, 'Extension', id, 'rules', `${l.id}.json`)));

// Real files, several profiles: slow on a busy Windows machine (a full `pnpm test`), never a leftover chain in the next test.
describe('ad blocking: stale profiles’ rules written side by side (#274)', { timeout: 30_000 }, () => {
  it('three profiles inside their write at once: each gets every list’s rules, none fails, no staging left', async () => {
    const { root, blocking } = setup();
    // Every profile waits inside its write until all three are there; then they go on one at a time.
    const write = BlockerExtension.prototype.write;
    const entered: Array<{ folder: string; go: () => void }> = [];
    let allIn = () => {};
    const together = new Promise<void>((resolve) => (allIn = resolve));
    vi.spyOn(BlockerExtension.prototype, 'write').mockImplementation(async function (this: InstanceType<typeof BlockerExtension>, setDir: string) {
      await new Promise<void>((go) => {
        entered.push({ folder: this.folder, go });
        if (entered.length === PROFILES.length) allIn();
      });
      return await write.call(this, setDir);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessions = new Map(PROFILES.map((id) => [id, fakeSession()]));
    for (const id of PROFILES) blocking.attach(id, sessions.get(id)!, false);
    await together;
    for (const { folder, go } of entered) {
      go();
      // Its write, its staging folder's removal, its load and apply: done (its rules on) before the next goes on.
      const id = PROFILES.find((p) => folder.endsWith(p))!;
      await blocking.pending(sessions.get(id)!);
    }
    await blocking.settled();

    expect(errors).not.toHaveBeenCalled();
    for (const id of PROFILES) {
      expect(hasRules(root, id), id).toBe(true);
      expect(blocking.inspect().profiles[id]?.applied, id).toBe(true);
    }
    expect(readdirSync(join(root, 'Staging'))).toEqual([]);
  });

  it('a staging folder that can’t be removed (EBUSY): the rules are still on', async () => {
    const { root, blocking } = setup();
    held.staging = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ses = fakeSession();
    blocking.attach('default', ses, false);
    await blocking.pending(ses);
    await blocking.settled();
    expect(errors).not.toHaveBeenCalled();
    expect(hasRules(root, 'default')).toBe(true);
    expect(blocking.inspect().profiles['default']?.applied).toBe(true);
  });

  it('a write that fails: its staging folder goes anyway', async () => {
    const { root, blocking } = setup();
    vi.spyOn(BlockerExtension.prototype, 'write').mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ses = fakeSession();
    blocking.attach('default', ses, false);
    await blocking.pending(ses);
    await blocking.settled();
    expect(existsSync(join(root, 'Staging', 'default'))).toBe(false);
  });

  it('profiles no chord uses: their staging folders go with their extension folders, the old shared one too', async () => {
    const { root, blocking } = setup();
    for (const folder of ['default', 'gone', 'rules']) mkdirSync(join(root, 'Staging', folder, 'rules'), { recursive: true });
    for (const folder of ['default', 'gone']) mkdirSync(join(root, 'Extension', folder), { recursive: true });
    await blocking.forgetProfiles(new Set(['default']));
    expect(readdirSync(join(root, 'Staging'))).toEqual(['default']);
    expect(readdirSync(join(root, 'Extension'))).toEqual(['default']);
  });
});

describe('an extension’s folder: its manifest only once its rules are in (Neon’s nit on #281)', () => {
  it('a copy that fails leaves no manifest, so the next launch writes the rules again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chord-ad-blocking-'));
    dirs.push(root);
    // A set missing its second list's rules.
    mkdirSync(join(root, 'set', 'rules'), { recursive: true });
    writeFileSync(join(root, 'set', 'rules', `${FILTER_LISTS[0]!.id}.json`), '[]');
    const blocker = new BlockerExtension(fakeSession(), join(root, 'Extension', 'default'));
    await expect(blocker.write(join(root, 'set'))).rejects.toThrow();
    expect(existsSync(join(root, 'Extension', 'default', 'manifest.json'))).toBe(false);
  });
});
