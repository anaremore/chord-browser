/**
 * A download the assistant's click started in a tab of yours (S18 M2e-2b, A6; Neon's B5 and S1 on #150): asked about in
 * the chat with its own site and a name that can't spoof one, written under its pending name until you say, never
 * opened or resumed meanwhile, deleted on Don't (finished or not), and discarded at quit if nobody answered.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, type Command } from '@chord/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' }, shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() } }));
const asked = vi.hoisted(() => ({ calls: [] as { filename: string; url: string }[], answer: null as null | ((yes: boolean) => void) }));
vi.mock('../../src/main/control/user-watch', () => ({
  askUserTabDownload: (_contents: unknown, download: { filename: string; url: string }) => {
    asked.calls.push(download);
    return new Promise<boolean>((done) => (asked.answer = done));
  },
}));
const { DownloadManager, PENDING_SUFFIX } = await import('../../src/main/downloads');
const { shell } = await import('electron');

const dirs: string[] = [];
afterEach(() => {
  asked.calls.length = 0;
  asked.answer = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env['CHORD_DOWNLOADS_DIR'];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'chord-dl-'));
  dirs.push(dir);
  process.env['CHORD_DOWNLOADS_DIR'] = dir;
  const session = new EventEmitter();
  const commands: Command[] = [];
  const downloads = new DownloadManager({ state: () => emptyState(), dispatch: (c) => void commands.push(c), newId: () => 'd1', defaultSession: () => session as never });
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
  return { dir, downloads, item, finish, commands, path: () => path, files: () => readdirSync(dir) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('A download the assistant’s click started (S18 M2e-2b)', () => {
  it('is asked about with its own site and a name that can’t spoof one; pending until you say; Allow saves it under its name', async () => {
    const t = setup();
    expect(asked.calls).toEqual([{ filename: 'invoice_piz.exe', url: 'https://files.example/real/invoice.zip' }]);
    expect(t.path().endsWith(PENDING_SUFFIX)).toBe(true);
    expect(t.item.pause).toHaveBeenCalled();
    // Never resumed or opened while it's asked about.
    t.downloads.run('d1', 'resume');
    expect(t.item.resume).not.toHaveBeenCalled();
    asked.answer!(true);
    await tick();
    expect(t.item.resume).toHaveBeenCalled();
    t.finish();
    await tick();
    await tick();
    expect(t.files()).toEqual(['invoice_piz.exe']);
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

  it('nobody answered by quit: discarded, nothing left behind', async () => {
    const t = setup();
    t.finish();
    await tick();
    t.downloads.discardHeld();
    await vi.waitFor(() => expect(existsSync(t.path())).toBe(false));
    expect(t.files()).toEqual([]);
  });
});
