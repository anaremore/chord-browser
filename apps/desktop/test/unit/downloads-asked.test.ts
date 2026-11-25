/**
 * A download the assistant's click started in a tab of yours (S18 M2e-2b, A6; Neon's B5 and S1 on #150): asked about in
 * the chat with its own site and a name that can't spoof one, written under its pending name until you say, never
 * opened or resumed meanwhile, deleted on Don't (finished or not), and discarded at quit if nobody answered.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptyState, type Command } from '@chord/core';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' }, shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() } }));
const asked = vi.hoisted(() => ({ calls: [] as { filename: string; url: string }[], answer: null as null | ((yes: boolean) => void) }));
vi.mock('../../src/main/control/user-watch', () => ({
  askUserTabDownload: (_contents: unknown, download: { filename: string; url: string }) => {
    asked.calls.push(download);
    return new Promise<boolean>((done) => (asked.answer = done));
  },
}));
/** How many renames fail first, as a file Windows' scan still holds does (EPERM), then go. */
const renames = vi.hoisted(() => ({ failing: 0, tries: 0 }));
vi.mock('node:fs/promises', async (actual) => {
  const real = await actual<typeof FsPromises>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renames.tries++;
      if (renames.failing > 0) {
        renames.failing--;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return real.rename(from, to);
    },
  };
});
const { DownloadManager, PENDING_SUFFIX } = await import('../../src/main/downloads');
const { shell } = await import('electron');

const dirs: string[] = [];
afterEach(() => {
  asked.calls.length = 0;
  asked.answer = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env['CHORD_DOWNLOADS_DIR'];
});

function setup(threat: 'malware' | null | undefined = undefined, pendingList?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'chord-dl-'));
  dirs.push(dir);
  process.env['CHORD_DOWNLOADS_DIR'] = dir;
  const session = new EventEmitter();
  const commands: Command[] = [];
  const downloads = new DownloadManager({
    // The list as the rows Chord reported make it (what the panel's Open reads).
    state: () => ({ ...emptyState(), downloads: Object.fromEntries(commands.flatMap((c) => (c.t === 'download.update' ? [[c.download.id, c.download]] : []))) }),
    ...(pendingList ? { pendingList } : {}),
    dispatch: (c) => void commands.push(c),
    newId: () => 'd1',
    defaultSession: () => session as never,
    ...(threat !== undefined ? { screen: () => Promise.resolve(threat) } : {}),
  });
  downloads.attach(session as never);
  let state: 'progressing' | 'completed' | 'cancelled' = 'progressing';
  let paused = false;
  let path = '';
  const item = Object.assign(new EventEmitter(), {
    getURL: () => 'https://shop.example/get?f=1',
    // Redirected on to a file host: the card names where it really comes from.
    getURLChain: () => ['https://shop.example/get?f=1', 'https://files.example/real/invoice.zip'],
    // Right-to-left override: "invoice‮piz.exe" reads as "invoiceexe.zip".
    getFilename: () => 'invoice‮piz.exe',
    getMimeType: () => 'application/zip',
    getStartTime: () => Date.now() / 1000,
    getReceivedBytes: () => 2,
    getTotalBytes: () => 2,
    getCurrentBytesPerSecond: () => 0,
    getState: () => state,
    isPaused: () => paused,
    canResume: () => true,
    pause: vi.fn(() => void (paused = true)),
    resume: vi.fn(() => void (paused = false)),
    cancel: vi.fn(() => {
      state = 'cancelled';
      item.emit('done', {}, 'cancelled');
    }),
    setSavePath: (p: string) => void (path = p),
    getSavePath: () => path,
  });
  const page = {};
  /** The bytes all in: the file on disk under the name it was given, and done. */
  const finish = () => {
    writeFileSync(path, 'PK');
    state = 'completed';
    item.emit('done', {}, 'completed');
  };
  session.emit('will-download', { preventDefault: vi.fn() }, item, page);
  /** The row the list shows now. */
  const row = () => [...commands].reverse().find((c) => c.t === 'download.update') as { download: { state: string; endedAt: number | null } } | undefined;
  return { dir, downloads, item, finish, commands, row, path: () => path, files: () => readdirSync(dir) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('A download the assistant’s click started (S18 M2e-2b)', () => {
  it('is asked about with its own site and a name that can’t spoof one; pending until you say; Allow saves it under its name', async () => {
    const t = setup();
    expect(asked.calls).toEqual([{ filename: 'invoicepiz.exe', url: 'https://files.example/real/invoice.zip' }]);
    expect(t.path().endsWith(PENDING_SUFFIX)).toBe(true);
    // Never paused for the question (the release check: on Windows a pause could outlast your Allow), never opened.
    expect(t.item.pause).not.toHaveBeenCalled();
    t.downloads.run('d1', 'resume');
    expect(t.item.resume).not.toHaveBeenCalled();
    asked.answer!(true);
    await tick();
    t.finish();
    await tick();
    await tick();
    expect(t.files()).toEqual(['invoicepiz.exe']);
  });

  it('Allow, just as Windows’ scan holds the finished file: its rename is tried again until it goes, never left under its pending name (main’s Windows E2E, run 45585360658)', async () => {
    const t = setup();
    asked.answer!(true);
    await tick();
    renames.failing = 3;
    renames.tries = 0;
    t.finish();
    await vi.waitFor(() => expect(t.files()).toEqual(['invoicepiz.exe']), { timeout: 5_000 });
    expect(renames.tries).toBe(4);
    // One that never lets go: it stays where it is, under its pending name, after a bounded number of tries.
    const u = setup();
    asked.answer!(true);
    await tick();
    renames.failing = 1_000;
    renames.tries = 0;
    u.finish();
    await vi.waitFor(() => expect(renames.tries).toBeGreaterThan(5), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 4_000));
    const tried = renames.tries;
    expect(tried).toBeLessThan(20);
    expect(u.files()).toEqual([`invoicepiz.exe${PENDING_SUFFIX}`]);
    renames.failing = 0;
  }, 20_000);

  it('finished before you answer: under its pending name until Allow, then its own; never paused, so never stuck paused (the release check, runs 45652920831 to 45658976992)', async () => {
    const t = setup();
    expect(t.item.pause).not.toHaveBeenCalled();
    t.finish();
    await tick();
    expect(t.files()).toEqual([`invoicepiz.exe${PENDING_SUFFIX}`]);
    asked.answer!(true);
    await vi.waitFor(() => expect(t.files()).toEqual(['invoicepiz.exe']));
  });

  it('Don’t deletes it, finished or not; nothing is left in the folder, nor in the list', async () => {
    for (const finished of [false, true]) {
      const t = setup();
      if (finished) t.finish();
      t.downloads.run('d1', 'open');
      expect(shell.openPath).not.toHaveBeenCalled();
      asked.answer!(false);
      // Its file removed (an async delete): waited for, never assumed after a tick.
      await vi.waitFor(() => expect(t.files(), `finished ${finished}`).toEqual([]));
      expect(t.commands.at(-1), `finished ${finished}`).toEqual({ t: 'download.remove', id: 'd1' });
    }
  });

  it('pending while asked, finished or not: never shown as done, never opened from its row (the owner’s release conditions)', async () => {
    const t = setup();
    t.finish();
    await tick();
    expect(t.row()?.download).toMatchObject({ state: 'paused', endedAt: null });
    t.downloads.run('d1', 'open');
    expect(shell.openPath).not.toHaveBeenCalled();
    asked.answer!(true);
    await vi.waitFor(() => expect(t.row()?.download).toMatchObject({ state: 'completed' }));
  });

  it('a crash while asked: what it left under its pending name is deleted at the next launch; one that took its name stays', async () => {
    const list = join(mkdtempSync(join(tmpdir(), 'chord-dl-list-')), 'pending-downloads.json');
    dirs.push(dirname(list));
    const t = setup(undefined, list);
    t.finish();
    await tick();
    const left = t.path();
    expect(existsSync(left)).toBe(true);
    // Chord ends here, nobody answered. The next launch:
    new DownloadManager({ state: () => emptyState(), dispatch: () => undefined, newId: () => 'd2', defaultSession: () => ({}) as never, pendingList: list });
    expect(existsSync(left)).toBe(false);
    // One allowed and named before the crash isn't touched.
    const u = setup(undefined, list);
    asked.answer!(true);
    u.finish();
    await vi.waitFor(() => expect(u.files()).toEqual(['invoicepiz.exe']));
    new DownloadManager({ state: () => emptyState(), dispatch: () => undefined, newId: () => 'd3', defaultSession: () => ({}) as never, pendingList: list });
    expect(u.files()).toEqual(['invoicepiz.exe']);
  });

  it('nobody answered by quit: discarded, nothing left behind', async () => {
    const t = setup();
    t.finish();
    await tick();
    t.downloads.discardHeld();
    await vi.waitFor(() => expect(existsSync(t.path())).toBe(false));
    expect(t.files()).toEqual([]);
  });

  it('held by Safe Browsing too: your Allow in the chat doesn’t resume it, Keep doesn’t before you’ve answered; it shows as waiting, finished or not (Neon’s SF2, round 2 of #150)', async () => {
    const t = setup('malware');
    await tick();
    // Suspected while it's asked about: Allow in the chat doesn't resume it.
    asked.answer!(true);
    await tick();
    expect(t.item.resume).not.toHaveBeenCalled();
    // Keep (Safe Browsing's) now: it resumes, as you've allowed it too.
    t.downloads.run('d1', 'keep');
    expect(t.item.resume).toHaveBeenCalled();
    // Kept before the chat's answer: no resume until you answer.
    const u = setup('malware');
    await tick();
    u.downloads.run('d1', 'keep');
    expect(u.item.resume).not.toHaveBeenCalled();
    // Waiting on the chat, its bytes all in: it shows as waiting, not done.
    const w = setup(null);
    w.finish();
    await tick();
    expect(w.row()?.download.state).toBe('paused');
    expect(w.row()?.download.endedAt).toBeNull();
  });
});
