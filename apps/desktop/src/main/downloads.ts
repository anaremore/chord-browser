/**
 * Downloads (ARCHITECTURE.md §9): straight to the Downloads folder without
 * asking, as Chrome does by default, named so nothing is overwritten.
 * Progress goes into the store a few times a second, so the sidebar's
 * button and the downloads panel follow along, and the list is remembered.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command, Download, DownloadAction, State, WindowId } from '@chord/core';
import { app, shell, type DownloadItem, type Session } from 'electron';
import { safeFilename, uniquePath } from './files';

/** At most this often per download while it's progressing. */
const REPORT_MS = 250;

/** The Downloads folder. Development builds can point it elsewhere so tests never touch the real one. */
function downloadsDir(): string {
  const override = process.env['CHORD_DOWNLOADS_DIR'];
  return !app.isPackaged && override ? override : app.getPath('downloads');
}

export interface DownloadDeps {
  state(): State;
  dispatch(command: Command): void;
  newId(): string;
  /** For retrying a download from an earlier session, which has no live item. */
  defaultSession(): Session;
}

export class DownloadManager {
  private readonly items = new Map<string, { item: DownloadItem; session: Session }>();

  constructor(private readonly deps: DownloadDeps) {}

  /** `privateWindow`: the session is that private window's, so its downloads are listed only there and never saved. */
  attach(session: Session, privateWindow: WindowId | null = null): void {
    session.on('will-download', (_event, item) => {
      const id = this.deps.newId();
      item.setSavePath(uniquePath(downloadsDir(), safeFilename(item.getFilename()), existsSync));
      this.items.set(id, { item, session });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const report = (ended = false) => {
        clearTimeout(timer);
        timer = undefined;
        const download = this.snapshot(id, item, ended);
        this.deps.dispatch({ t: 'download.update', download: privateWindow ? { ...download, privateWindow } : download });
      };
      item.on('updated', () => {
        timer ??= setTimeout(() => report(), REPORT_MS);
      });
      item.once('done', () => {
        report(true);
        this.items.delete(id);
      });
      report();
    });
  }

  private snapshot(id: string, item: DownloadItem, ended: boolean): Download {
    const raw = item.getState();
    const path = item.getSavePath();
    return {
      id,
      url: item.getURL(),
      filename: path ? basename(path) : safeFilename(item.getFilename()),
      path,
      mime: item.getMimeType(),
      state: raw === 'progressing' && item.isPaused() ? 'paused' : raw,
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      speed: raw === 'progressing' ? item.getCurrentBytesPerSecond() : 0,
      startedAt: Math.round(item.getStartTime() * 1000),
      endedAt: ended ? Date.now() : null,
    };
  }

  run(id: string, action: DownloadAction): void {
    const download = this.deps.state().downloads[id];
    const live = this.items.get(id);
    switch (action) {
      case 'open':
        if (download?.state === 'completed' && existsSync(download.path)) void shell.openPath(download.path);
        return;
      case 'show':
        if (download?.path && existsSync(download.path)) shell.showItemInFolder(download.path);
        else void shell.openPath(downloadsDir());
        return;
      case 'pause':
        live?.item.pause();
        return;
      case 'resume':
        if (live?.item.canResume()) live.item.resume();
        return;
      case 'cancel':
        live?.item.cancel();
        return;
      case 'retry':
        if (!download) return;
        this.deps.dispatch({ t: 'download.remove', id });
        (live?.session ?? this.deps.defaultSession()).downloadURL(download.url);
        return;
      case 'remove':
        live?.item.cancel();
        this.deps.dispatch({ t: 'download.remove', id });
        return;
    }
  }

  openFolder(): void {
    void shell.openPath(downloadsDir());
  }
}
