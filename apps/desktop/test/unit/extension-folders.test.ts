/**
 * #319: profiles whose ids differ only in case (`Work`, `work`) never share an extension's folder, and nothing Chord
 * does removes a folder another installed extension uses. On Windows' and macOS' file systems (and a case-insensitive
 * Linux mount) `Extensions/Work` and `Extensions/work` are one folder; these tests stand that in on any file system by
 * giving a record a path in one case while the folder on disk has the other, as such a file system lists it.
 */
import type { Command, InstalledExtension, State } from '@chord/core';
import type * as FsPromises from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BaseWindow: class {}, BrowserWindow: class {}, Menu: {}, nativeImage: {}, WebContentsView: class {} }));
vi.mock('../../src/main/ipc', () => ({ send: () => {} }));
vi.mock('../../src/main/extensions/popup', () => ({ ExtensionPopup: class {} }));
/** A copy that dies part-way (its first file written, then the disk full), while `fail.cp` says so. */
const fail = vi.hoisted(() => ({ cp: false }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof FsPromises>();
  return {
    ...real,
    cp: async (from: string, to: string, options: unknown) => {
      if (!fail.cp) return real.cp(from, to, options as never);
      await real.mkdir(to, { recursive: true });
      await real.writeFile(`${to}/half`, 'x');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  };
});

/** Every load the stand-in engine was asked for, in order, with whether launch's split was under way then. */
const loads = vi.hoisted(() => [] as string[]);
vi.mock('../../src/main/extensions/host', () => ({
  within: <T>(promise: Promise<T>) => promise,
  ExtensionHost: class {
    readonly session = { serviceWorkers: { startWorkerForScope: async () => {} } };
    async load(path: string) {
      loads.push(path);
      const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as { name: string; version: string };
      return { id: path.split(/[\\/]/).at(-2)!, name: manifest.name, version: manifest.version, manifest };
    }
    unload() {}
    get() {
      return null;
    }
    async notifyInstalled() {
      return true;
    }
    async enableStaticRulesets() {
      return true;
    }
  },
}));

const { Extensions, extensionFolder } = await import('../../src/main/extensions/index');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
let root: string;
let state: State;
beforeEach(() => {
  loads.length = 0;
  fail.cp = false;
  root = mkdtempSync(join(tmpdir(), 'chord-ext-folders-'));
  state = { extensions: {}, settings: {} } as unknown as State;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** An extension's version folder on disk, as the installer leaves it. */
function unpacked(path: string, name = 'Fixture'): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version: '1.0' }));
}
function record(profileId: string, id: string, path: string): InstalledExtension {
  const e: InstalledExtension = { id, profileId, name: 'Fixture', version: '1.0', source: 'store', path, notifiedVersion: '1.0', pinned: true, installedAt: 1, updatedAt: 1 };
  state = { ...state, extensions: { ...state.extensions, [`${profileId}:${id}`]: e } };
  return e;
}

function extensions() {
  // As browser.ts' store subscriber does: every change to what's installed reconciles the engine at once.
  let ext: InstanceType<typeof Extensions> | null = null;
  ext = new Extensions({
    state: () => state,
    dispatch: (command: Command) => {
      const all = { ...state.extensions };
      if (command.t === 'extension.record') all[`${command.extension.profileId}:${command.extension.id}`] = command.extension;
      else if (command.t === 'extension.forget') delete all[`${command.profileId}:${command.id}`];
      state = { ...state, extensions: all };
      ext?.reconcile();
    },
    profileSession: () => ({}) as never,
    root,
    preloadPath: 'unused',
    unpackWorkerPath: 'unused',
    webStore: { check: async () => [], download: async () => Buffer.alloc(0) } as never,
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
  } as never);
  return ext;
}

/** Launch: everything loads, and the folders no extension uses are cleaned up. */
async function launch(): Promise<void> {
  const ext = extensions();
  await ext.start();
  await (ext as unknown as { cleanup: Promise<void> }).cleanup;
}

describe('extension folders and profiles that differ only in case (#319)', () => {
  it('launch never removes a folder an extension uses, whatever case its record spells it in', async () => {
    // `Work` installed A, making Extensions/Work; `work` then installed B into what the file system calls the same folder.
    unpacked(join(root, 'Work', A, '1.0_0'));
    unpacked(join(root, 'Work', B, '1.0_0'));
    record('Work', A, join(root, 'Work', A, '1.0_0'));
    record('work', B, join(root, 'work', B, '1.0_0'));
    await launch();
    expect(existsSync(join(root, 'Work', B, '1.0_0', 'manifest.json'))).toBe(true);
  });

  it('a folder no extension uses still goes at launch', async () => {
    unpacked(join(root, 'Work', A, '1.0_0'));
    unpacked(join(root, 'Work', A, '0.9_0'));
    record('Work', A, join(root, 'Work', A, '1.0_0'));
    await launch();
    expect(existsSync(join(root, 'Work', A, '0.9_0'))).toBe(false);
    expect(existsSync(join(root, 'Work', A, '1.0_0'))).toBe(true);
  });

  it('twins sharing one version folder today (the same extension, the same version) each get their own at launch', async () => {
    unpacked(join(root, 'Work', A, '1.0_0'));
    record('Work', A, join(root, 'Work', A, '1.0_0'));
    record('work', A, join(root, 'work', A, '1.0_0'));
    await launch();
    const paths = [state.extensions[`Work:${A}`]!.path, state.extensions[`work:${A}`]!.path];
    expect(paths[0]!.toLowerCase()).not.toBe(paths[1]!.toLowerCase());
    for (const p of paths) expect(existsSync(join(p, 'manifest.json'))).toBe(true);
  });
});

describe('extensionFolder (#319): where an install unpacks', () => {
  it('one folder per profile, named one-to-one (`Work` and `work` apart); Chord’s own ids as before', () => {
    const none = () => false;
    expect(extensionFolder(root, 'Work', A, '1.0', none).toLowerCase()).not.toBe(extensionFolder(root, 'work', A, '1.0', none).toLowerCase());
    expect(extensionFolder(root, 'default', A, '1.0', none)).toBe(join(root, 'default', A, '1.0_0'));
    expect(extensionFolder(root, '01a21619-df80-7e66-9577-09ceec5d0a05', A, '1.0', none)).toBe(join(root, '01a21619-df80-7e66-9577-09ceec5d0a05', A, '1.0_0'));
  });

  it('never a folder that’s there already or another extension’s (an old one, or a twin’s): the next free one', () => {
    const at = extensionFolder(root, 'default', A, '1.0', () => false);
    unpacked(at);
    expect(extensionFolder(root, 'default', A, '1.0', () => false)).toBe(join(root, 'default', A, '1.0_1'));
    expect(extensionFolder(root, 'default', A, '1.0', (p) => p.toLowerCase() === join(root, 'default', A, '1.0_1').toLowerCase())).toBe(join(root, 'default', A, '1.0_2'));
  });

  it('a version with characters a folder can’t hold keeps only digits and dots, as before', () => {
    expect(extensionFolder(root, 'default', A, '1.0-beta', () => false)).toBe(join(root, 'default', A, '1.0_0'));
  });
});

describe('#334 round 1 (Neon)', () => {
  it('B1: launch splits twins before anything loads, then loads each extension once, from its final folder (a store change reconciles meanwhile)', async () => {
    for (const id of [A, B]) {
      unpacked(join(root, 'Work', id, '1.0_0'));
      record('Work', id, join(root, 'Work', id, '1.0_0'));
      record('work', id, join(root, 'work', id, '1.0_0'));
    }
    await launch();
    const final = Object.values(state.extensions).map((e) => e.path);
    expect(new Set(final.map((p) => p.toLowerCase())).size).toBe(4);
    // Each loaded exactly once, and only from its record's final path.
    expect([...loads].sort()).toEqual([...final].sort());
  });

  it('SF1: where case counts and each twin has its own folder on disk, each copies its own (never its twin’s)', async () => {
    // Only on a file system that keeps case: there, Work/ and work/ are two folders.
    mkdirSync(join(root, 'probe'));
    const caseKept = !existsSync(join(root, 'PROBE'));
    if (!caseKept) return;
    unpacked(join(root, 'Work', A, '1.0_0'), 'Work’s copy');
    unpacked(join(root, 'work', A, '1.0_0'), 'work’s copy');
    record('Work', A, join(root, 'Work', A, '1.0_0'));
    record('work', A, join(root, 'work', A, '1.0_0'));
    await launch();
    const moved = state.extensions[`work:${A}`]!.path;
    expect(JSON.parse(readFileSync(join(moved, 'manifest.json'), 'utf8')).name).toBe('work’s copy');
  });

  it('SF2 (2): a split copy that fails: the record stays where it was, the half copy goes, and both twins still load', async () => {
    // Both records naming the one folder by the same path: so on any file system, whether it keeps case or not.
    const shared = join(root, 'Work', A, '1.0_0');
    unpacked(shared);
    record('Work', A, shared);
    record('work', A, shared);
    fail.cp = true;
    await launch();
    expect(state.extensions[`work:${A}`]!.path).toBe(shared);
    // Nothing half-copied is left in a folder of its own.
    for (const dir of [join(root, 'work', A), join(root, 'Work', A)]) if (existsSync(dir)) for (const v of readdirSync(dir)) expect(existsSync(join(dir, v, 'half')), v).toBe(false);
    expect(loads.length).toBe(2);
  });

  it('SF2 (3): a launch that died mid-copy left a half folder: the next skips it (never loaded), and its cleanup removes it', async () => {
    unpacked(join(root, 'Work', A, '1.0_0'));
    record('Work', A, join(root, 'Work', A, '1.0_0'));
    record('work', A, join(root, 'work', A, '1.0_0'));
    // Where the copy would have gone first: a half folder, no extension's.
    const half = extensionFolder(root, 'work', A, '1.0', (p) => p.toLowerCase() === join(root, 'Work', A, '1.0_0').toLowerCase());
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, 'half'), 'x');
    await launch();
    expect(existsSync(half)).toBe(false);
    expect(loads.map((p) => p.toLowerCase())).not.toContain(half.toLowerCase());
    expect(state.extensions[`work:${A}`]!.path.toLowerCase()).not.toBe(half.toLowerCase());
  });

  it('SF3: a folder an extension removed (Undo still open) uses counts as taken: an install never writes there', async () => {
    const at = join(root, 'default', A, '1.0_0');
    state = { ...state, removedExtensions: [{ id: A, profileId: 'default', name: 'Fixture', version: '1.0', source: 'store', path: at, notifiedVersion: '1.0', pinned: true, installedAt: 1, updatedAt: 1 }] } as State;
    const ext = extensions();
    const taken = (ext as unknown as { usedBy(p: string): unknown }).usedBy(at);
    expect(taken).not.toBeNull();
  });
});

