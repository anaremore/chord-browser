/**
 * Ad and tracker blocking in main (ARCHITECTURE.md §9, decision D5,
 * docs/decisions/S11-ad-blocking.md). EasyList and EasyPrivacy, on by
 * default, in every chord and private window:
 *
 * - **Chords' sessions:** the lists as declarativeNetRequest rules in Chord's
 *   blocker extension (extension.ts). Chromium matches every request itself;
 *   main runs no code per request, and other extensions keep working.
 * - **Private windows:** Electron loads no extension into an in-memory
 *   session, so their requests go through the session's request dispatcher
 *   (requests.ts) to Ghostery's engine, which lives in a worker thread.
 * - **Element hiding:** for every page, the engine's `display: none` rules
 *   for its site, applied by main with `insertCSS`. No script in any page.
 * - **The lists:** a compiled set is bundled at build time and the newest set
 *   is used. They're refreshed from their own host when they say they expire
 *   (4 days) and compiled in a worker of its own, never through a Chord server.
 *
 * A site turned off is off in all three: an allow rule for pages on it, and
 * the dispatcher and element hiding skip it.
 */
import { isBlockingOff } from '@chord/core';
import type { AdBlockingStatus } from '@chord/ipc';
import { session as electronSession, type OnBeforeRequestListenerDetails, type Session, type WebContents } from 'electron';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { requestDispatcher } from '../requests';
import { BlockerExtension } from './extension';
import { backoffMs, DEFAULT_REFRESH_MS, FILTER_LISTS, isNewer, setVersion, type CompiledInfo, type ListId } from './lists';
import type { CompileResult, WorkerReply, WorkerRequest } from './protocol';

const MINUTE = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
/** Chromium can lose a change made just before a crash (it saves its prefs every few seconds): each profile is checked once a launch, this long after it starts. */
const VERIFY_AFTER_MS = 30_000;
/** The worker may crash this many times before blocking gives up on it until the next launch. */
const MAX_RESTARTS = 3;
/** Every request a private window makes, websockets included. */
const WEB_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

export interface AdBlockingConfig {
  /** The compiled set built into this copy of Chord (out/main/ad-blocking). */
  bundledDir: string;
  /** `<userData>/Ad Blocking`: refreshed lists, each profile's extension, what was applied. */
  root: string;
  /** The worker's script, as built. */
  workerPath: string;
  /** Where each list comes from: its own host, or (development) a test server; null never refreshes. */
  listUrl: ((id: ListId) => string) | null;
  /** How long after launch before the first refresh check. */
  firstRefreshMs: number;
}

export interface AdBlockingDeps {
  /** Settings → Privacy → Block ads and trackers. */
  enabled(): boolean;
  /** Sites blocking is off for in a profile: Settings' list, and in a private window its own additions. */
  offSites(profileId: string): readonly string[];
}

/** What `state.json` keeps: each list's refresh bookkeeping, and what each profile's extension has. */
interface Saved {
  lists: Partial<Record<ListId, { etag: string | null; lastModified: string | null; checkedAt: number }>>;
  failures: number;
  /** Not before this (after failures), even across a relaunch. */
  notBefore: number;
  profiles: Record<string, { rulesVersion: string; offSites: string[] }>;
}

const emptySaved = (): Saved => ({ lists: {}, failures: 0, notBefore: 0, profiles: {} });
/** Whether a file is there (main never checks synchronously). */
const exists = (path: string) => access(path).then(() => true, () => false);
const sameSites = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
const folderName = (profileId: string) => profileId.replace(/[^\w-]/g, '_');

interface Profile {
  session: Session;
  /** A chord's session has the extension; a private window's, a handler in its request dispatcher. */
  blocker: BlockerExtension | null;
  removeHandler: (() => void) | null;
  /** Changes to one profile's extension run one at a time. */
  chain: Promise<void>;
  /** The extension was loaded once this run: loading it again (blocking back on) applies, to know when its rules are in. */
  loadedOnce: boolean;
  /** Its rules and sites are known to be in Chromium this run (applied, or checked). */
  ready: boolean;
  verified: boolean;
  /** Resolves once the extension's first load has been tried (pages wait for it at launch). */
  firstLoad: Promise<void>;
  loadTried: () => void;
}

interface Page {
  contents: WebContents;
  profileId: string;
  /** The page's address as it last committed. */
  url: string | null;
  /** Blocking is off on this page (its site is): a private window's dispatcher lets its requests through. */
  off: boolean;
  /** The element hiding inserted into the current document, to take out again. */
  cssKey: string | null;
}

export class AdBlocking {
  private saved: Saved = emptySaved();
  private saving: Promise<void> = Promise.resolve();
  /** The newest compiled set: the bundled one or a refreshed one. */
  private current: { dir: string; info: CompiledInfo } | null = null;
  private readonly ready: Promise<void>;
  private readonly profiles = new Map<string, Profile>();
  private readonly pages = new Map<number, Page>();
  private worker: Worker | null = null;
  /** Resolves once the worker has been handed its engine: requests go after it, so none is answered without one. */
  private opened: Promise<void> = Promise.resolve();
  private restarts = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | null = null;
  private failing = false;
  private ses: Session | null = null;
  private active = false;
  /** Chord is quitting: nothing new starts (no control page may be open as Electron tears down). */
  private stopping = false;
  private compiler: Worker | null = null;

  constructor(
    private readonly config: AdBlockingConfig,
    private readonly deps: AdBlockingDeps,
  ) {
    this.ready = this.open().catch((error: unknown) => console.error('Ad blocking couldn’t read its lists:', error));
  }

  /** The newest compiled set, and what was saved last time. */
  private async open(): Promise<void> {
    const read = async <T>(file: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
      } catch {
        return null;
      }
    };
    this.saved = { ...emptySaved(), ...(await read<Saved>(join(this.config.root, 'state.json'))) };
    const bundled = await read<CompiledInfo>(join(this.config.bundledDir, 'lists.json'));
    const refreshedDir = join(this.config.root, 'Lists');
    const refreshed = await read<CompiledInfo>(join(refreshedDir, 'lists.json'));
    if (refreshed && (!bundled || !isNewer(bundled.versions, refreshed.versions))) this.current = { dir: refreshedDir, info: refreshed };
    else if (bundled) this.current = { dir: this.config.bundledDir, info: bundled };
  }

  /** Saves run one at a time, each written beside the old file and swapped in. */
  private save(): void {
    const file = join(this.config.root, 'state.json');
    const body = JSON.stringify(this.saved);
    this.saving = this.saving
      .then(() => mkdir(this.config.root, { recursive: true }))
      .then(() => writeFile(`${file}.tmp`, body))
      .then(() => rename(`${file}.tmp`, file))
      .catch(() => {
        // Not saved: the next launch applies the rules again. Nothing depends on it.
      });
  }

  status(): AdBlockingStatus {
    return {
      active: this.deps.enabled(),
      lists: FILTER_LISTS.map((l) => ({ id: l.id, name: l.name, version: this.current?.info.versions[l.id] ?? null, checkedAt: this.saved.lists[l.id]?.checkedAt ?? null })),
      failing: this.failing,
    };
  }

  /** Development and tests: what each session has (`applied`: the newest rules and the sites are in Chromium). */
  inspect(): { profiles: Record<string, { extension: boolean; applied: boolean; dispatcher: boolean }>; worker: boolean; dir: string | null } {
    const version = this.current ? setVersion(this.current.info.versions) : null;
    const profiles = Object.fromEntries(
      [...this.profiles].map(([id, p]) => {
        const saved = this.saved.profiles[id];
        const current = saved?.rulesVersion === version && sameSites(saved.offSites, this.deps.offSites(id));
        return [id, { extension: Boolean(p.blocker?.loaded), applied: Boolean(p.blocker?.loaded) && p.ready && current, dispatcher: p.removeHandler !== null }];
      }),
    );
    return { profiles, worker: this.worker !== null, dir: this.current?.dir ?? null };
  }

  /** Once every change asked for so far is in Chromium (a page reloaded to show one waits for this). */
  async settled(): Promise<void> {
    await Promise.all([...this.profiles.values()].map((p) => p.chain));
  }

  /* ---------- Sessions ---------- */

  /** A profile's session was made: a chord's gets the blocker extension; a private window's, a request handler. */
  attach(profileId: string, session: Session, isPrivate: boolean): void {
    if (this.profiles.has(profileId)) return;
    const blocker = isPrivate ? null : new BlockerExtension(session, join(this.config.root, 'Extension', folderName(profileId)));
    let loadTried = () => {};
    const firstLoad = new Promise<void>((resolve) => (loadTried = resolve));
    this.profiles.set(profileId, { session, blocker, removeHandler: null, chain: Promise.resolve(), loadedOnce: false, ready: false, verified: false, firstLoad, loadTried });
    this.syncProfile(profileId);
  }

  /**
   * Once every attached chord's extension has loaded (or failed to), for at
   * most `capMs`. Launch waits for this before any page loads, as it does for
   * other extensions: the rules then apply to restored tabs' first requests,
   * and no navigation starts while the extension is still being added.
   */
  async loaded(capMs = 3000): Promise<void> {
    const loads = [...this.profiles.values()].filter((p) => p.blocker).map((p) => p.firstLoad);
    await Promise.race([Promise.all(loads), new Promise<void>((resolve) => setTimeout(resolve, capMs).unref?.())]);
  }

  /** A private window closed: its session is going, and nothing was kept for it. */
  detach(profileId: string): void {
    this.profiles.get(profileId)?.removeHandler?.();
    this.profiles.delete(profileId);
  }

  /** Profiles no chord uses any more (their sign-ins were deleted): their extension folders go too. */
  async forgetProfiles(inUse: ReadonlySet<string>): Promise<void> {
    await this.ready;
    const keep = new Set([...inUse].map(folderName));
    const dir = join(this.config.root, 'Extension');
    for (const folder of await readdir(dir).catch(() => [])) if (!keep.has(folder)) await rm(join(dir, folder), { recursive: true, force: true }).catch(() => {});
    for (const profileId of Object.keys(this.saved.profiles)) if (!inUse.has(profileId)) delete this.saved.profiles[profileId];
    this.save();
  }

  /** Settings changed (the switch, or the sites it's off for): every session and page follows. */
  sync(): void {
    if (this.stopping) return;
    const on = this.deps.enabled();
    for (const profileId of this.profiles.keys()) this.syncProfile(profileId);
    for (const page of this.pages.values()) this.syncPage(page);
    if (on && !this.active) {
      this.active = true;
      this.scheduleRefresh(this.config.firstRefreshMs);
    } else if (!on && this.active) {
      this.active = false;
      clearTimeout(this.refreshTimer);
      this.stopWorker();
    }
  }

  /** Bring one session in line with the settings and the newest lists. */
  private syncProfile(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) return;
    const on = this.deps.enabled();
    if (!profile.blocker) {
      if (on && !profile.removeHandler) profile.removeHandler = requestDispatcher(profile.session).add({ urls: WEB_URLS, handle: (details) => this.checkPrivate(details) });
      else if (!on && profile.removeHandler) {
        profile.removeHandler();
        profile.removeHandler = null;
      }
      return;
    }
    const blocker = profile.blocker;
    profile.chain = profile.chain
      .then(async () => {
        if (this.stopping) return;
        if (!this.deps.enabled()) {
          blocker.unload();
          profile.ready = false;
          return;
        }
        await this.ready;
        if (!this.current || !this.deps.enabled() || this.stopping) return;
        const version = setVersion(this.current.info.versions);
        const offSites = [...this.deps.offSites(profileId)];
        const applied = this.saved.profiles[profileId];
        const stale = applied?.rulesVersion !== version || !(await exists(join(blocker.folder, 'manifest.json')));
        if (stale) {
          profile.ready = false;
          await this.writeRules(blocker);
        }
        // At launch the rules just load; turned back on, applying again says when they're in.
        const reloaded = (await blocker.load()) && profile.loadedOnce;
        profile.loadedOnce = true;
        profile.loadTried();
        if (stale || reloaded || !sameSites(applied.offSites, offSites)) {
          await blocker.apply(offSites);
          profile.ready = true;
          this.saved.profiles[profileId] = { rulesVersion: version, offSites };
          this.save();
        }
        if (!profile.verified) {
          profile.verified = true;
          setTimeout(() => this.verify(profileId), VERIFY_AFTER_MS).unref?.();
        }
      })
      .catch((error: unknown) => console.error(`Ad blocking couldn’t update profile ${profileId}:`, error))
      // Off, quitting, or failed: nothing to wait for either.
      .finally(() => profile.loadTried());
  }

  /** The newest set's rules into a profile's extension (read here, so a bundled set inside the asar works too). */
  private async writeRules(blocker: BlockerExtension): Promise<void> {
    const set = this.current!;
    if (set.dir !== this.config.bundledDir) return await blocker.write(set.dir);
    const staging = join(this.config.root, 'Staging');
    await mkdir(join(staging, 'rules'), { recursive: true });
    for (const list of FILTER_LISTS) await writeFile(join(staging, 'rules', `${list.id}.json`), await readFile(join(set.dir, 'rules', `${list.id}.json`)));
    await blocker.write(staging);
    await rm(staging, { recursive: true, force: true });
  }

  /** Once a launch: Chromium has what Chord last applied, or it's applied again. */
  private verify(profileId: string): void {
    const profile = this.profiles.get(profileId);
    const blocker = profile?.blocker;
    if (!profile || !blocker) return;
    profile.chain = profile.chain
      .then(async () => {
        if (!this.deps.enabled() || !blocker.loaded || this.stopping) return;
        const offSites = [...this.deps.offSites(profileId)];
        const has = await blocker.read();
        if (!FILTER_LISTS.every((l) => has.enabled.includes(l.id)) || !sameSites(has.offSites, offSites)) await blocker.apply(offSites);
        profile.ready = true;
      })
      .catch(() => {});
  }

  /** A private window's request: through on a site blocking is off for, else whatever the engine says. */
  private checkPrivate(details: OnBeforeRequestListenerDetails): Promise<'cancel' | undefined> | undefined {
    const page = details.webContentsId === undefined ? undefined : this.pages.get(details.webContentsId);
    const off = details.resourceType === 'mainFrame' ? page !== undefined && isBlockingOff(details.url, this.deps.offSites(page.profileId)) : page?.off;
    if (off) return undefined;
    const sourceUrl = details.referrer || page?.url || '';
    return this.request<boolean>({ type: 'match', url: details.url, sourceUrl, resourceType: details.resourceType }).then(
      (blocked) => (blocked ? 'cancel' : undefined),
      () => undefined,
    );
  }

  /* ---------- Pages: element hiding ---------- */

  /** The profile a page's session belongs to. */
  profileOf(contents: WebContents): string | undefined {
    for (const [profileId, profile] of this.profiles) if (profile.session === contents.session) return profileId;
    return undefined;
  }

  /** Wire a page (a tab, Peek, a mini window, a popup): element hiding on each new document, and what a private window's requests need. */
  attachPage(contents: WebContents): void {
    const profileId = this.profileOf(contents);
    if (!profileId) return;
    const page: Page = { contents, profileId, url: null, off: false, cssKey: null };
    this.pages.set(contents.id, page);
    // Whether blocking is off follows the page before it commits, so the new document's first requests see it.
    const heading = (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) page.off = isBlockingOff(details.url, this.deps.offSites(profileId));
    };
    contents.on('did-start-navigation', heading);
    contents.on('did-redirect-navigation', heading);
    contents.on('did-navigate', (_event, url) => {
      page.url = url;
      page.cssKey = null;
      this.syncPage(page, true);
    });
    contents.once('destroyed', () => this.pages.delete(contents.id));
  }

  /** After a navigation (`fresh`) or a change of settings: blocking off on the page or not, its element hiding in or out. */
  private syncPage(page: Page, fresh = false): void {
    const { contents, url } = page;
    if (!url || contents.isDestroyed()) return;
    page.off = isBlockingOff(url, this.deps.offSites(page.profileId));
    const wanted = this.deps.enabled() && !page.off && /^https?:/i.test(url);
    if (!wanted && page.cssKey) {
      void contents.removeInsertedCSS(page.cssKey).catch(() => {});
      page.cssKey = null;
    }
    if (!wanted || !fresh) return;
    void this.request<string>({ type: 'css', url })
      .then(async (css) => {
        // Only into the document it was asked for: the page may have moved on meanwhile.
        if (!css || contents.isDestroyed() || page.url !== url || page.cssKey) return;
        page.cssKey = await contents.insertCSS(css, { cssOrigin: 'user' });
      })
      .catch(() => {});
  }

  /* ---------- The worker ---------- */

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.config.workerPath, { name: 'Ad blocking' });
    // It never keeps Chord running by itself.
    worker.unref();
    worker.on('message', (reply: WorkerReply) => {
      const waiter = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      if (!waiter) return;
      if (reply.ok) waiter.resolve(reply.result);
      else waiter.reject(new Error(reply.error));
    });
    const gone = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const waiter of this.waiting.values()) waiter.reject(new Error('Ad blocking stopped'));
      this.waiting.clear();
      this.restarts++;
    };
    worker.on('error', gone);
    worker.on('exit', gone);
    this.worker = worker;
    // The engine is read here (a bundled set is inside the asar) and handed over without a copy; the worker
    // answers in order, so everything sent after it waits for it there.
    const id = this.nextId++;
    this.opened = this.ready
      .then(() => (this.current ? readFile(join(this.current.dir, 'engine.bin')) : null))
      .then(
        (bytes) => {
          if (!bytes || this.worker !== worker) return;
          const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          worker.postMessage({ type: 'open', bytes: view, id } satisfies WorkerRequest & { id: number }, [view.buffer as ArrayBuffer]);
        },
        () => {},
      );
    return worker;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    for (const waiter of this.waiting.values()) waiter.reject(new Error('Ad blocking stopped'));
    this.waiting.clear();
    void worker?.terminate();
  }

  private request<T>(request: WorkerRequest): Promise<T> {
    if (!this.deps.enabled() || this.restarts > MAX_RESTARTS || this.stopping) return Promise.reject(new Error('Ad blocking is off'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      void this.opened.then(() => {
        if (this.worker === worker) worker.postMessage({ ...request, id });
      });
    });
  }

  /* ---------- Refreshing the lists ---------- */

  private scheduleRefresh(delayMs: number): void {
    clearTimeout(this.refreshTimer);
    if (!this.active || !this.config.listUrl) return;
    this.refreshTimer = setTimeout(() => void this.refresh(), Math.max(delayMs, this.saved.notBefore - Date.now(), 0));
    this.refreshTimer.unref?.();
  }

  /** Check the lists that are due now (the timer, and tests). Resolves when it's done. */
  refresh(): Promise<void> {
    this.refreshing ??= this.refreshDue().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refreshDue(): Promise<void> {
    await this.ready;
    const listUrl = this.config.listUrl;
    if (!this.active || !listUrl || this.stopping) return;
    const refreshMs = (id: ListId) => this.current?.info.refreshMs[id] ?? DEFAULT_REFRESH_MS;
    const now = Date.now();
    const due = FILTER_LISTS.filter((l) => now >= (this.saved.lists[l.id]?.checkedAt ?? 0) + refreshMs(l.id));
    try {
      if (due.length > 0) {
        const refreshedDir = join(this.config.root, 'Lists');
        const answers = await Promise.all(due.map(async (l) => this.fetchList(l.id, listUrl(l.id), await exists(join(refreshedDir, `${l.id}.txt`)))));
        if (answers.some((a) => a.bytes)) {
          // A list that didn't change comes from the last refreshed set: only one Chord has a copy of may come back unchanged.
          const lists = Object.fromEntries(FILTER_LISTS.map((l) => [l.id, answers.find((a) => a.id === l.id)?.bytes ?? null])) as Record<ListId, Uint8Array | null>;
          const result = await this.compile(lists, refreshedDir);
          if (!this.active || this.stopping) return;
          this.current = { dir: refreshedDir, info: result.info };
          // The engine reloads with the new set, and every chord's extension gets the new rules.
          this.stopWorker();
          for (const profileId of this.profiles.keys()) this.syncProfile(profileId);
        }
        for (const answer of answers) this.saved.lists[answer.id] = { etag: answer.etag, lastModified: answer.lastModified, checkedAt: Date.now() };
      }
      this.failing = false;
      this.saved.failures = 0;
      this.saved.notBefore = 0;
    } catch (error) {
      this.failing = true;
      this.saved.failures++;
      this.saved.notBefore = Date.now() + backoffMs(this.saved.failures);
      console.error('Refreshing the ad-blocking lists failed:', error instanceof Error ? error.message : error);
    }
    this.save();
    const next = Math.min(...FILTER_LISTS.map((l) => (this.saved.lists[l.id]?.checkedAt ?? 0) + refreshMs(l.id))) - Date.now();
    this.scheduleRefresh(Math.max(next, MINUTE));
  }

  /** In memory, no cache, no cookies: the lists' host sees an address and a time, nothing else of yours. */
  private session(): Session {
    if (!this.ses) {
      this.ses = electronSession.fromPartition('chord-ad-blocking', { cache: false });
      this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.ses.setPermissionCheckHandler(() => false);
      this.ses.setSpellCheckerEnabled(false);
    }
    return this.ses;
  }

  /** One list, asked for only if it changed since the copy Chord has. `bytes` is null when it didn't. */
  private async fetchList(id: ListId, url: string, haveCopy: boolean): Promise<{ id: ListId; bytes: Uint8Array | null; etag: string | null; lastModified: string | null }> {
    const known = haveCopy ? this.saved.lists[id] : undefined;
    const headers: Record<string, string> = { accept: 'text/plain' };
    if (known?.etag) headers['if-none-match'] = known.etag;
    if (known?.lastModified) headers['if-modified-since'] = known.lastModified;
    const response = await this.session().fetch(url, { credentials: 'omit', cache: 'no-store', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 304 && known) return { id, bytes: null, etag: known.etag, lastModified: known.lastModified };
    if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
    return { id, bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
  }

  /** Compile in a worker of its own, which ends when it's done: the engine's worker keeps answering pages meanwhile. */
  private compile(lists: Record<ListId, Uint8Array | null>, out: string): Promise<CompileResult> {
    const worker = new Worker(this.config.workerPath, { name: 'Ad blocking lists' });
    worker.unref();
    this.compiler = worker;
    return new Promise<CompileResult>((resolve, reject) => {
      worker.once('message', (reply: WorkerReply) => (reply.ok ? resolve(reply.result as CompileResult) : reject(new Error(reply.error))));
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('The lists’ worker stopped')));
      const transfer = Object.values(lists)
        .filter((bytes): bytes is Uint8Array => bytes !== null)
        .map((bytes) => bytes.buffer as ArrayBuffer);
      worker.postMessage({ type: 'compile', lists, from: [out], out, id: 1 } satisfies WorkerRequest & { id: number }, transfer);
    }).finally(() => {
      if (this.compiler === worker) this.compiler = null;
      void worker.terminate();
    });
  }

  /**
   * Quitting: the workers end, nothing new starts, and what's under way (a
   * control page) finishes first, for at most two seconds. Sets are swapped
   * in whole, so nothing is left half-written.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.refreshTimer);
    const compiler = this.compiler;
    this.compiler = null;
    this.stopWorker();
    await Promise.all([
      compiler?.terminate(),
      Promise.race([this.settled(), new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())]),
    ]);
  }
}
