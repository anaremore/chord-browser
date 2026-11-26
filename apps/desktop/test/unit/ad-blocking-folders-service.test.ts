/**
 * #283, through the real service (Neon's SF1 on #290): the folders each profile's blocker extension is written to and
 * kept in, not only the helpers that name them. A compiled set on disk; Chromium's two steps (adding the extension,
 * turning its rules on) answered at once.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, session: {}, BrowserWindow: class {}, WebContentsView: class {} }));
vi.mock('../../src/main/launch-timeline', () => ({ mark: vi.fn() }));

const { AdBlocking } = await import('../../src/main/ad-blocking/service');
const { BlockerExtension } = await import('../../src/main/ad-blocking/extension');
const { FILTER_LISTS, setVersion } = await import('../../src/main/ad-blocking/lists');
const { folderName } = await import('../../src/main/ad-blocking/folders');

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const dirs: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSIONS = Object.fromEntries(FILTER_LISTS.map((l) => [l.id, '202611260000'])) as Record<(typeof FILTER_LISTS)[number]['id'], string>;

/** A compiled set as the build makes it, `before` (what an earlier run left in the root), and the service over it. */
function service(before: (root: string) => void = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'chord-ad-folders-'));
  dirs.push(root);
  const bundledDir = join(root, 'bundled');
  mkdirSync(join(bundledDir, 'rules'), { recursive: true });
  writeFileSync(join(bundledDir, 'lists.json'), JSON.stringify({ versions: VERSIONS, refreshMs: {}, stats: {} }));
  for (const l of FILTER_LISTS) writeFileSync(join(bundledDir, 'rules', `${l.id}.json`), '[]');
  before(root);
  const blocking = new AdBlocking({ bundledDir, root, workerPath: join(root, 'none.js'), listUrl: null, firstRefreshMs: 60_000 }, { enabled: () => true, offSites: () => [] });
  return { blocking, root };
}

/** A chord's session whose extension Chromium adds at once (a fresh id per folder), and rules it turns on at once. */
function session() {
  const loaded = new Set<string>();
  let n = 0;
  return {
    extensions: {
      getExtension: (id: string) => (loaded.has(id) ? { id } : null),
      loadExtension: vi.fn(async () => {
        const id = `ext-${++n}`;
        loaded.add(id);
        return { id };
      }),
      removeExtension: (id: string) => void loaded.delete(id),
    },
    webRequest: { onBeforeRequest: () => undefined },
  } as never;
}

const extension = (root: string, name: string) => join(root, 'Extension', name);

describe('ad blocking’s folders, through the service (#283)', () => {
  it('Work and work: two profiles, two folders on disk, each with its own manifest', async () => {
    const applied = vi.spyOn(BlockerExtension.prototype, 'apply').mockResolvedValue(undefined);
    const { blocking, root } = service();
    blocking.attach('Work', session(), false);
    blocking.attach('work', session(), false);
    await blocking.settled();
    expect(folderName('Work')).not.toBe('work');
    expect(existsSync(join(extension(root, folderName('Work')), 'manifest.json'))).toBe(true);
    expect(existsSync(join(extension(root, 'work'), 'manifest.json'))).toBe(true);
    expect(applied).toHaveBeenCalledTimes(2);
  });

  it('an upgrade: Work’s old folder (Extension/Work, its state current) is no use; the rules are written and applied in its own, and the old one goes', async () => {
    const applied = vi.spyOn(BlockerExtension.prototype, 'apply').mockResolvedValue(undefined);
    const { blocking, root } = service((r) => {
      writeFileSync(join(r, 'state.json'), JSON.stringify({ profiles: { Work: { rulesVersion: setVersion(VERSIONS), offSites: [] } } }));
      mkdirSync(extension(r, 'Work'), { recursive: true });
      writeFileSync(join(extension(r, 'Work'), 'manifest.json'), '{}');
    });
    blocking.attach('Work', session(), false);
    await blocking.settled();
    expect(existsSync(join(extension(root, folderName('Work')), 'manifest.json'))).toBe(true);
    expect(applied).toHaveBeenCalledTimes(1);
    await blocking.forgetProfiles(new Set(['Work']));
    expect(existsSync(extension(root, 'Work'))).toBe(false);
    expect(existsSync(extension(root, folderName('Work')))).toBe(true);
  });

  // Opus's SF1 on #290: on Linux too (an NTFS, FAT or ciopfs mount ignores case there), so Work's old folder may be work's.
  it.each(['win32', 'darwin', 'linux'] as const)('forgetProfiles on %s, with work and Work in use: an old Work folder (Extension’s and Staging’s, #281) stays, as work’s own may be it', async (os) => {
    const { blocking, root } = service((r) => {
      mkdirSync(extension(r, 'Work'), { recursive: true });
      mkdirSync(join(r, 'Staging', 'Work'), { recursive: true });
    });
    Object.defineProperty(process, 'platform', { value: os });
    await blocking.forgetProfiles(new Set(['work', 'Work']));
    expect(existsSync(extension(root, 'Work'))).toBe(true);
    expect(existsSync(join(root, 'Staging', 'Work'))).toBe(true);
  });
});
