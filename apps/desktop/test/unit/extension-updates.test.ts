/**
 * Updating Web Store extensions (main/extensions/index.ts) while the
 * unpacking happens in a worker: update checks don't overlap, and an
 * extension removed partway through its update stays removed. The packages
 * go through the real worker; Electron's extension engine is a stand-in.
 */
import type { InstalledExtension, State } from '@chord/core';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crx3, extensionIdOf, keyPair, sha256Hex, spki, zip } from '../fixtures/crx';
import { buildUnpackWorker } from '../fixtures/extension-worker';

/** What the stand-in engine has loaded (id → folder), and a hook to hold a load open. */
const engine = vi.hoisted(() => ({
  loaded: new Map<string, string>(),
  beforeLoad: null as null | ((path: string) => Promise<void>),
}));

vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, Menu: {}, nativeImage: {}, WebContentsView: class {} }));
vi.mock('../../src/main/ipc', () => ({ send: () => {} }));
vi.mock('../../src/main/extensions/popup', () => ({ ExtensionPopup: class {} }));
vi.mock('../../src/main/extensions/host', () => ({
  within: <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]),
  ExtensionHost: class {
    readonly session = { serviceWorkers: { startWorkerForScope: async () => {} } };
    async load(path: string) {
      await engine.beforeLoad?.(path);
      const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { name: string; version: string };
      const id = path.split(/[\\/]/).at(-2)!;
      engine.loaded.set(id, path);
      return { id, name: manifest.name, version: manifest.version, manifest };
    }
    unload(id: string) {
      engine.loaded.delete(id);
    }
    get(id: string) {
      const path = engine.loaded.get(id);
      return path ? { id, manifest: {} } : null;
    }
    async notifyInstalled() {
      return true;
    }
    async enableStaticRulesets() {
      return true;
    }
  },
}));

const { Extensions } = await import('../../src/main/extensions/index');

const developer = keyPair('rsa');
const publisher = keyPair('ec');
const publisherKeyHash = sha256Hex(spki(publisher.publicKey));
const id = extensionIdOf(developer.publicKey);
const pkg = (version: string) => crx3(zip({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Fixture', version }), 'a.js': `/* ${version} */` }), developer, [developer, publisher]);
const v1 = pkg('1.0');
const v2 = pkg('2.0');

let dir: string;
let workerPath: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chord-ext-updates-'));
  workerPath = await buildUnpackWorker(dir);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

let n = 0;
let root: string;
let state: State;
let downloads: number;
/** Resolves a download that's waiting (when a test holds it). */
let release: (() => void) | null;
let holdDownload: boolean;
let announced: string;

function setup({ updateDeadlineMs = 30_000 } = {}) {
  const extensions = new Extensions({
    state: () => state,
    tabMoves: { whenProxied: (_contents, load) => load(), reload: vi.fn(), go: vi.fn() },
    dispatch: (command) => {
      const extensions = { ...state.extensions };
      if (command.t === 'extension.record') extensions[`${command.extension.profileId}:${command.extension.id}`] = command.extension;
      else if (command.t === 'extension.forget') delete extensions[`${command.profileId}:${command.id}`];
      state = { ...state, extensions };
    },
    profileSession: () => ({}) as never,
    root,
    preloadPath: 'unused',
    unpackWorkerPath: workerPath,
    publisherKeyHash,
    updateDeadlineMs,
    webStore: {
      check: async () => [{ id, status: 'ok', version: '2.0', codebase: 'https://example.com/a.crx', sha256: announced }],
      download: async () => {
        downloads++;
        if (holdDownload) await new Promise<void>((resolve) => (release = resolve));
        return Buffer.from(v2);
      },
    } as never,
    windows: () => [],
    windowById: () => undefined,
    lastWindow: () => undefined,
    windowOfNode: () => undefined,
    nodeFor: () => undefined,
    liveTabs: () => [],
    ensureTab: () => undefined,
    toast: () => {},
    openSettings: () => {},
    changed: () => {},
  });
  // The profile's engine, with version 1.0 loaded, as after launch.
  extensions.reconcile();
  return extensions;
}

const record = () => state.extensions[`default:${id}`];
const folder = (version: string) => join(root, 'default', id, `${version}_0`);

beforeEach(async () => {
  root = join(dir, `root-${n++}`);
  downloads = 0;
  release = null;
  holdDownload = false;
  announced = sha256Hex(v2);
  engine.loaded.clear();
  engine.beforeLoad = null;
  // Version 1.0, installed and loaded, as the installer leaves it.
  const { unpackInWorker } = await import('../../src/main/extensions/unpack');
  await unpackInWorker(workerPath, { crx: Buffer.from(v1), id, version: '1.0', dest: folder('1.0'), publisherKeyHash });
  engine.loaded.set(id, folder('1.0'));
  const installed: InstalledExtension = { id, profileId: 'default', name: 'Fixture', version: '1.0', source: 'store', path: folder('1.0'), notifiedVersion: '1.0', pinned: true, installedAt: 1, updatedAt: 1 };
  state = { extensions: { [`default:${id}`]: installed }, settings: {} } as unknown as State;
});

/** Wait until the update has asked for its download. */
const downloading = () => vi.waitFor(() => expect(release).not.toBeNull());

describe('updating extensions with the unpacking in a worker', () => {
  it('updates, and removes the old version’s folder', async () => {
    expect(await setup().checkForUpdates()).toBe(1);
    expect(record()).toMatchObject({ version: '2.0', path: folder('2.0'), notifiedVersion: '2.0' });
    expect(engine.loaded.get(id)).toBe(folder('2.0'));
    expect(existsSync(folder('1.0'))).toBe(false);
  });

  it('runs one check at a time: a second check while one runs gets the same one', async () => {
    holdDownload = true;
    const extensions = setup();
    const scheduled = extensions.checkForUpdates();
    await downloading();
    const fromSettings = extensions.checkForUpdates();
    expect(fromSettings).toBe(scheduled);
    release!();
    expect(await Promise.all([scheduled, fromSettings])).toEqual([1, 1]);
    expect(downloads).toBe(1);
    expect(record()).toMatchObject({ version: '2.0', path: folder('2.0') });
    expect(JSON.parse(readFileSync(join(folder('2.0'), 'manifest.json'), 'utf8')).version).toBe('2.0');
    // Once it's done, the next check is a new one (and finds nothing newer).
    expect(await extensions.checkForUpdates()).toBe(0);
  });

  it('keeps the version that works when the download doesn’t match the announced hash', async () => {
    announced = sha256Hex('something else');
    expect(await setup().checkForUpdates()).toBe(0);
    expect(record()).toMatchObject({ version: '1.0', path: folder('1.0') });
    expect(engine.loaded.get(id)).toBe(folder('1.0'));
    expect(existsSync(folder('2.0'))).toBe(false);
  });

  it('an extension removed while its update downloads and unpacks stays removed', async () => {
    holdDownload = true;
    const extensions = setup();
    const check = extensions.checkForUpdates();
    await downloading();
    extensions.remove('default', id);
    release!();
    expect(await check).toBe(0);
    expect(record()).toBeUndefined();
    expect(engine.loaded.has(id)).toBe(false);
    expect(existsSync(folder('2.0'))).toBe(false);
    // The old folder stays until next launch, so Undo can bring it back.
    expect(existsSync(folder('1.0'))).toBe(true);
  });

  it('an extension removed while its new version loads stays removed', async () => {
    const extensions = setup();
    engine.beforeLoad = async (path) => {
      if (path === folder('2.0')) extensions.remove('default', id);
    };
    expect(await extensions.checkForUpdates()).toBe(0);
    expect(record()).toBeUndefined();
    expect(engine.loaded.has(id)).toBe(false);
    expect(existsSync(folder('2.0'))).toBe(false);
  });

  it('Remove, then Undo, while it updates: the update goes ahead', async () => {
    holdDownload = true;
    const extensions = setup();
    const check = extensions.checkForUpdates();
    await downloading();
    const before = record()!;
    extensions.remove('default', id);
    expect(record()).toBeUndefined();
    // Undo puts the same record back (extension.restore).
    state = { ...state, extensions: { ...state.extensions, [`default:${id}`]: before } };
    release!();
    expect(await check).toBe(1);
    expect(record()).toMatchObject({ version: '2.0', path: folder('2.0'), notifiedVersion: '2.0' });
    expect(engine.loaded.get(id)).toBe(folder('2.0'));
    expect(existsSync(folder('1.0'))).toBe(false);
  });

  it('a step that never settles fails that extension’s update at its deadline, and the check still finishes', async () => {
    const extensions = setup({ updateDeadlineMs: 500 });
    engine.beforeLoad = (path) => (path === folder('2.0') ? new Promise<void>(() => {}) : Promise.resolve());
    const started = Date.now();
    expect(await extensions.checkForUpdates()).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(record()).toMatchObject({ version: '1.0', path: folder('1.0') });
    // The next check is a new one, and leaves the stuck update alone instead of unpacking beside it.
    expect(await extensions.checkForUpdates()).toBe(0);
    expect(downloads).toBe(1);
  });

  it('adding the extension again while its old update finishes waits for it, then installs', async () => {
    holdDownload = true;
    const extensions = setup();
    const check = extensions.checkForUpdates();
    await downloading();
    extensions.remove('default', id);
    holdDownload = false;
    const install = extensions.install('default', id);
    release!();
    expect(await check).toBe(0);
    expect(await install).toEqual({ ok: true, name: 'Fixture' });
    expect(record()).toMatchObject({ version: '2.0', path: folder('2.0') });
    expect(engine.loaded.get(id)).toBe(folder('2.0'));
  });
});
