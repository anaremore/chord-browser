/**
 * Downloads (ARCHITECTURE.md §9): straight to the Downloads folder without
 * asking, as Chrome does by default, named so nothing is overwritten.
 * Progress goes into the store a few times a second, so the sidebar's
 * button and the downloads panel follow along, and the list is remembered.
 *
 * With Safe Browsing on (§14.1), a download's addresses (its redirects too)
 * are checked as it starts, and it's written as `<name>.crdownload`, as
 * Chrome does: it gets its real name only once it has finished and isn't
 * suspected. Nothing waits for the check. One that's suspected stops and
 * keeps its pending name, so it can't be opened by mistake, and the panel
 * asks you to keep or delete it. Chord never opens a download by itself. A
 * held one still undecided when Chord quits is deleted.
 */
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command, Download, DownloadAction, State, ThreatKind, WindowId } from '@chord/core';
import { app, shell, type DownloadItem, type Session } from 'electron';
import { safeFilename, uniquePath } from './files';

/** At most this often per download while it's progressing. */
const REPORT_MS = 250;
/** What a checked download is called until it's finished and cleared, as in Chrome. */
export const PENDING_SUFFIX = '.crdownload';

/** The Downloads folder. Development builds can point it elsewhere so tests never touch the real one. */
export function downloadsDir(): string {
  const override = process.env['CHORD_DOWNLOADS_DIR'];
  return !app.isPackaged && override ? override : app.getPath('downloads');
}

export interface DownloadDeps {
  state(): State;
  dispatch(command: Command): void;
  newId(): string;
  /** For retrying a download from an earlier session, which has no live item. */
  defaultSession(): Session;
  /** Safe Browsing: what the download's addresses are suspected of (null: nothing). Null instead of a promise when it's off. */
  screen?(urls: string[]): Promise<ThreatKind | null> | null;
  /** A download is held: show it where it started (`privateWindow`, or the window used last). */
  onHeld?(download: Download): void;
}

interface Entry {
  item: DownloadItem;
  session: Session;
  privateWindow: WindowId | null;
  ended: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** Checked by Safe Browsing: written as `<finalPath>.crdownload` until it's finished and cleared. */
  screen: {
    finalPath: string;
    /** null while being checked; the threat while held; false once cleared or kept. */
    verdict: ThreatKind | false | null;
    /** Renamed to its final path. */
    settled: boolean;
  } | null;
}

export class DownloadManager {
  private readonly entries = new Map<string, Entry>();
  /** Final names promised to downloads still under their pending names, so two never take the same one. */
  private readonly reserved = new Set<string>();

  constructor(private readonly deps: DownloadDeps) {}

  /** `privateWindow`: the session is that private window's, so its downloads are listed only there and never saved. */
  attach(session: Session, privateWindow: WindowId | null = null): void {
    session.on('will-download', (_event, item) => {
      const id = this.deps.newId();
      const finalPath = uniquePath(downloadsDir(), safeFilename(item.getFilename()), (p) => existsSync(p) || this.reserved.has(p));
      const screening = this.deps.screen?.(item.getURLChain()) ?? null;
      const entry: Entry = { item, session, privateWindow, ended: false, screen: screening ? { finalPath, verdict: null, settled: false } : null };
      if (screening) this.reserved.add(finalPath);
      item.setSavePath(screening ? `${finalPath}${PENDING_SUFFIX}` : finalPath);
      this.entries.set(id, entry);
      item.on('updated', () => {
        entry.timer ??= setTimeout(() => this.report(id), REPORT_MS);
      });
      item.once('done', (_event, state) => {
        entry.ended = true;
        if (state === 'completed') void this.settle(id);
        else this.release(id);
        this.report(id);
      });
      void screening?.then(
        (threat) => this.answered(id, threat),
        () => this.answered(id, null),
      );
      this.report(id);
    });
  }

  private report(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const download = this.snapshot(id, entry);
    this.deps.dispatch({ t: 'download.update', download: entry.privateWindow ? { ...download, privateWindow: entry.privateWindow } : download });
    // Finished and nothing left to decide: it's an ordinary row of the list from now on.
    if (entry.ended && (!entry.screen || entry.screen.settled || entry.item.getState() !== 'completed')) this.entries.delete(id);
  }

  /** Safe Browsing's answer. Suspected: it stops and waits for you; cleared: it takes its name once it's done. */
  private answered(id: string, threat: ThreatKind | null): void {
    const entry = this.entries.get(id);
    if (!entry?.screen) return;
    entry.screen.verdict = threat ?? false;
    if (!threat) {
      void this.settle(id);
      return;
    }
    if (entry.item.getState() === 'progressing') entry.item.pause();
    this.report(id);
    const download = this.deps.state().downloads[id];
    if (download) this.deps.onHeld?.(download);
  }

  /** A finished download that's cleared (or kept) takes its real name. */
  private async settle(id: string): Promise<void> {
    const entry = this.entries.get(id);
    const screen = entry?.screen;
    if (!entry || !screen || screen.verdict !== false || screen.settled || entry.item.getState() !== 'completed') return;
    screen.settled = true;
    const from = entry.item.getSavePath();
    this.reserved.delete(screen.finalPath);
    // Someone may have made a file with that name meanwhile: then the next free one.
    const to = existsSync(screen.finalPath) ? uniquePath(downloadsDir(), basename(screen.finalPath), existsSync) : screen.finalPath;
    try {
      await rename(from, to);
      screen.finalPath = to;
    } catch {
      // Couldn't rename: it stays where it is, and its row says so.
      screen.finalPath = from;
    }
    this.report(id);
  }

  /** Done without finishing (canceled, failed): its name is free again. */
  private release(id: string): void {
    const screen = this.entries.get(id)?.screen;
    if (screen) this.reserved.delete(screen.finalPath);
  }

  private snapshot(id: string, entry: Entry): Download {
    const { item, screen } = entry;
    const raw = item.getState();
    const path = screen?.settled ? screen.finalPath : item.getSavePath();
    // A held one still shows as on its way until you decide, even if all its bytes are in.
    const held = screen?.verdict || undefined;
    return {
      id,
      url: item.getURL(),
      // Its real name, even while it's written under its pending one.
      filename: screen ? basename(screen.finalPath) : path ? basename(path) : safeFilename(item.getFilename()),
      path,
      mime: item.getMimeType(),
      state: held && raw === 'completed' ? 'paused' : raw === 'progressing' && item.isPaused() ? 'paused' : raw,
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      speed: raw === 'progressing' && !item.isPaused() ? item.getCurrentBytesPerSecond() : 0,
      startedAt: Math.round(item.getStartTime() * 1000),
      endedAt: entry.ended && !held ? Date.now() : null,
      ...(held ? { threat: held } : {}),
    };
  }

  run(id: string, action: DownloadAction): void {
    const download = this.deps.state().downloads[id];
    const entry = this.entries.get(id);
    const held = Boolean(entry?.screen?.verdict);
    switch (action) {
      case 'open':
        // A held file is never opened, by Chord or from its row; nor one that isn't cleared yet.
        if (!held && download?.state === 'completed' && !download.path.endsWith(PENDING_SUFFIX) && existsSync(download.path)) void shell.openPath(download.path);
        return;
      case 'show':
        if (download?.path && existsSync(download.path)) shell.showItemInFolder(download.path);
        else void shell.openPath(downloadsDir());
        return;
      case 'pause':
        if (entry?.item.getState() === 'progressing') entry.item.pause();
        return;
      case 'resume':
        if (!held && entry?.item.canResume()) entry.item.resume();
        return;
      case 'cancel':
        if (held) return this.discard(id);
        if (entry?.item.getState() === 'progressing') entry.item.cancel();
        return;
      case 'retry':
        if (!download) return;
        this.entries.delete(id);
        this.deps.dispatch({ t: 'download.remove', id });
        (entry?.session ?? this.deps.defaultSession()).downloadURL(download.url);
        return;
      case 'remove':
        if (held) return this.discard(id);
        if (entry?.item.getState() === 'progressing') entry.item.cancel();
        this.entries.delete(id);
        this.deps.dispatch({ t: 'download.remove', id });
        return;
      case 'keep':
        return this.keep(id);
      case 'discard':
        return this.discard(id);
    }
  }

  /** "Keep anyway": it carries on, if it hadn't finished, and takes its real name once it has. */
  private keep(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.screen?.verdict) return;
    entry.screen.verdict = false;
    if (entry.item.getState() === 'progressing' && entry.item.isPaused()) entry.item.resume();
    this.report(id);
    void this.settle(id);
  }

  /** Delete a held download: what's on disk of it goes (unfinished or not), and so does its row. */
  private discard(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.screen?.verdict) return;
    this.entries.delete(id);
    this.reserved.delete(entry.screen.finalPath);
    if (entry.item.getState() === 'progressing') entry.item.cancel();
    else void rm(entry.item.getSavePath(), { force: true }).catch(() => {});
    this.deps.dispatch({ t: 'download.remove', id });
  }

  /** Quitting: held downloads nobody kept are deleted, never left behind in the Downloads folder. */
  discardHeld(): void {
    for (const [id, entry] of [...this.entries]) if (entry.screen?.verdict) this.discard(id);
  }

  openFolder(): void {
    void shell.openPath(downloadsDir());
  }
}
