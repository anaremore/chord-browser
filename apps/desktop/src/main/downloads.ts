/**
 * Downloads (ARCHITECTURE.md §9): straight to the Downloads folder without
 * asking, as Chrome does by default, named so nothing is overwritten.
 * Progress goes into the store a few times a second, so the sidebar's
 * button and the downloads panel follow along, and the list is remembered.
 *
 * With Safe Browsing on (§14.5), a download's addresses (its redirects too)
 * are checked as it starts, and it's written as `<name>.crdownload`, as
 * Chrome does: it gets its real name only once it has finished and isn't
 * suspected. Nothing waits for the check. One that's suspected stops and
 * keeps its pending name, so it can't be opened by mistake, and the panel
 * asks you to keep or delete it. Chord never opens a download by itself. A
 * held one still undecided when Chord quits is deleted.
 */
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Command, Download, DownloadAction, State, ThreatKind, WindowId } from '@chord/core';
import { askUserTabDownload } from './control/user-watch';
import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron';
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
  /**
   * A download an outside agent's tab started (S18): refused before anything's written, and the agent told.
   * True when `contents` is such a tab (it's handled then).
   */
  refuse?(contents: WebContents, url: string, filename: string): boolean;
}

interface Entry {
  item: DownloadItem;
  session: Session;
  privateWindow: WindowId | null;
  ended: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /**
   * The assistant's click started it in a tab of yours (S18 M2e-2b): null while the chat asks, then your answer. It
   * stays under its pending name, paused, never opened or resumed, until you allow it; Don't deletes it.
   */
  asked?: boolean | null;
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
    session.on('will-download', (event, item, contents) => {
      if (contents && this.deps.refuse?.(contents, item.getURL(), item.getFilename())) {
        event.preventDefault();
        return;
      }
      // A download the assistant's click started in a tab of yours (S18 M2e-2b, A6): asked in the chat with its own
      // site (where its redirects end) and a name that can't spoof one; paused, under its pending name, until you say.
      const filename = safeFilename(item.getFilename());
      const chain = item.getURLChain();
      const asking = contents ? askUserTabDownload(contents, { filename, url: chain[chain.length - 1] ?? item.getURL() }) : null;
      if (asking) item.pause();
      const id = this.deps.newId();
      const finalPath = uniquePath(downloadsDir(), filename, (p) => existsSync(p) || this.reserved.has(p));
      const screening = this.deps.screen?.(chain) ?? null;
      const pending = Boolean(screening || asking);
      const entry: Entry = { item, session, privateWindow, ended: false, screen: pending ? { finalPath, verdict: screening ? null : false, settled: false } : null, ...(asking ? { asked: null } : {}) };
      if (pending) this.reserved.add(finalPath);
      item.setSavePath(pending ? `${finalPath}${PENDING_SUFFIX}` : finalPath);
      void asking?.then((yes) => this.answeredAsk(id, yes));
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

  /**
   * A file Chord makes itself (a screenshot you save, DESIGN.md §7.12): into
   * the Downloads folder under a name that overwrites nothing, and in the list
   * as a finished download, a private window's only there. Returns its path.
   */
  async addFile(filename: string, bytes: Uint8Array, mime: string, url: string, privateWindow: WindowId | null): Promise<string> {
    const path = uniquePath(downloadsDir(), safeFilename(filename), (p) => existsSync(p) || this.reserved.has(p));
    this.reserved.add(path);
    try {
      await writeFile(path, bytes);
    } finally {
      this.reserved.delete(path);
    }
    const now = Date.now();
    const download: Download = { id: this.deps.newId(), url, filename: basename(path), path, mime, state: 'completed', received: bytes.byteLength, total: bytes.byteLength, speed: 0, startedAt: now, endedAt: now };
    this.deps.dispatch({ t: 'download.update', download: privateWindow ? { ...download, privateWindow } : download });
    return path;
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

  /** Your answer in the chat to a download the assistant's click started: on its way, or gone (finished or not). */
  private answeredAsk(id: string, yes: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.asked !== null) return;
    entry.asked = yes;
    if (!yes) return this.dropAsked(id);
    // Held by Safe Browsing too: it stays held until you keep it there (Neon's SF2, round 2 of #150).
    if (!entry.screen?.verdict && entry.item.getState() === 'progressing' && entry.item.isPaused()) entry.item.resume();
    this.report(id);
    void this.settle(id);
  }

  /** Don't, or no answer by quit: what's on disk of it goes, and so does its row. */
  private dropAsked(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.screen) this.reserved.delete(entry.screen.finalPath);
    if (entry.item.getState() === 'progressing') entry.item.cancel();
    else void rm(entry.item.getSavePath(), { force: true }).catch(() => {});
    this.deps.dispatch({ t: 'download.remove', id });
  }

  /** A finished download that's cleared (or kept), and allowed if it was asked about, takes its real name. */
  private async settle(id: string): Promise<void> {
    const entry = this.entries.get(id);
    const screen = entry?.screen;
    if (!entry || !screen || screen.verdict !== false || screen.settled || entry.item.getState() !== 'completed') return;
    if (entry.asked === null || entry.asked === false) return;
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
    // A held one still shows as on its way until you decide, even if all its bytes are in; so does one asked about in the
    // chat (no end, no "new" dot, nothing to open: Neon's SF2, round 2 of #150).
    const held = screen?.verdict || undefined;
    const waiting = Boolean(held) || entry.asked === null;
    return {
      id,
      url: item.getURL(),
      // Its real name, even while it's written under its pending one.
      filename: screen ? basename(screen.finalPath) : path ? basename(path) : safeFilename(item.getFilename()),
      path,
      mime: item.getMimeType(),
      state: waiting && raw === 'completed' ? 'paused' : raw === 'progressing' && item.isPaused() ? 'paused' : raw,
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      speed: raw === 'progressing' && !item.isPaused() ? item.getCurrentBytesPerSecond() : 0,
      startedAt: Math.round(item.getStartTime() * 1000),
      endedAt: entry.ended && !waiting ? Date.now() : null,
      ...(held ? { threat: held } : {}),
    };
  }

  run(id: string, action: DownloadAction): void {
    const download = this.deps.state().downloads[id];
    const entry = this.entries.get(id);
    // Held by Safe Browsing, or asked about in the chat and not yet allowed: never opened, never resumed.
    const held = Boolean(entry?.screen?.verdict) || entry?.asked === null;
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
        if (entry?.asked === null) return this.dropAsked(id);
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
        if (entry?.asked === null) return this.dropAsked(id);
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
    // Asked in the chat and not yet allowed there: it waits for that too (Neon's SF2, round 2 of #150).
    if (entry.asked !== null && entry.asked !== false && entry.item.getState() === 'progressing' && entry.item.isPaused()) entry.item.resume();
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

  /** Quitting: held downloads nobody kept, and asked ones nobody allowed, are deleted, never left behind. */
  discardHeld(): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.asked === null) this.dropAsked(id);
      else if (entry.screen?.verdict) this.discard(id);
    }
  }

  openFolder(): void {
    void shell.openPath(downloadsDir());
  }
}
