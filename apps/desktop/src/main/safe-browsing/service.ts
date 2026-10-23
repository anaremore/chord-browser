/**
 * Safe Browsing in main (ARCHITECTURE.md §14.1, decision D7): Google's Safe
 * Browsing API v5 in Local List Mode. The worker thread (worker.ts) holds the
 * lists and does the hashing; this side schedules list updates, does the
 * network, and answers checks for navigations and downloads.
 *
 * - **Network:** an in-memory session of its own (no cookies, no cache, never
 *   a chord's), with the key in the `X-Goog-Api-Key` header, never the URL.
 * - **Updates:** only the lists that are due (each list's minimumWaitDuration),
 *   with exponential back-off after a failure, remembered across launches.
 * - **Checks:** local first. Only a prefix that's in a list and not in the
 *   cache is sent to hashes.search: the 4-byte prefix, never the address.
 *   Any error is SAFE.
 */
import type { SafeBrowsingStatus } from '@chord/ipc';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { session, type Session } from 'electron';
import type { Purpose, Verdict } from './database';
import type { CheckResult, DueResult, OpenResult, SearchedResult, UpdateResult, WorkerReply, WorkerRequest } from './protocol';

const SAFE: Verdict = { verdict: 'safe' };
const GOOGLE = 'https://safebrowsing.googleapis.com';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const UPDATE_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 5_000;
/** "Fetch again now" still waits this long, and a service that keeps saying so gets a minute. */
const IMMEDIATE_MS = 2_000;
/** The worker may crash this many times before Safe Browsing gives up until the next launch. */
const MAX_RESTARTS = 3;
const TIMINGS_KEPT = 500;

export interface SafeBrowsingConfig {
  /** Where the service is and the key for it; null when this build has neither (it's unavailable). */
  endpoint: { base: string; key: string | null } | null;
  /** The lists' file, under userData. */
  file: string;
  /** The worker's script, as built. */
  workerPath: string;
  /** How long after Safe Browsing turns on before the first list update (launch comes first). */
  firstUpdateMs: number;
}

/** Where the service is: Google's with a built-in key, or (development only) a test server, which never gets the key. */
export function safeBrowsingEndpoint(key: string, devServer: string | undefined): SafeBrowsingConfig['endpoint'] {
  if (devServer) return { base: devServer.replace(/\/+$/, ''), key: null };
  return key ? { base: GOOGLE, key } : null;
}

class HttpError extends Error {}

export class SafeBrowsing {
  private worker: Worker | null = null;
  private restarts = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private ses: Session | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private updateFailures = 0;
  private immediateUpdates = 0;
  private searchFailures = 0;
  private searchPausedUntil = 0;
  /** hashes.search requests in flight, by their prefixes, so two checks of one site ask once. */
  private readonly searching = new Map<string, Promise<{ body: Uint8Array; json: boolean } | null>>();
  private updatedAt: number | null = null;
  private failing = false;
  private entries = 0;
  /** How long checks took, newest last (ms): answered here, and the few that asked the service. */
  private readonly localTimes: number[] = [];
  private readonly workerTimes: number[] = [];
  private readonly searchTimes: number[] = [];

  constructor(
    private readonly config: SafeBrowsingConfig,
    /** Settings → Privacy → Safe Browsing is on, and Google-free mode is off. */
    private readonly enabled: () => boolean,
  ) {}

  /** This build can use the service (it has the key, or a test server in development). */
  get available(): boolean {
    return this.config.endpoint !== null;
  }

  /** Checking addresses: available and turned on. */
  get active(): boolean {
    return this.available && this.enabled() && this.restarts <= MAX_RESTARTS;
  }

  status(): SafeBrowsingStatus {
    return { available: this.available, active: this.active, updatedAt: this.updatedAt, failing: this.failing, entries: this.entries };
  }

  /** Development and tests: how long checks took (ms). */
  timings(): { local: number[]; worker: number[]; searched: number[] } {
    return { local: [...this.localTimes], worker: [...this.workerTimes], searched: [...this.searchTimes] };
  }

  /** Start or stop to match the setting (and Google-free mode). Turning it off makes no more requests at all. */
  sync(): void {
    if (this.active && !this.running) {
      this.running = true;
      this.updateFailures = 0;
      this.ensureWorker();
      this.scheduleUpdate(this.config.firstUpdateMs);
    } else if (!this.active && this.running) {
      this.running = false;
      clearTimeout(this.updateTimer);
      this.searching.clear();
      // The cache came from browsing; with the worker gone, so is it.
      this.stopWorker();
    }
  }

  /**
   * Whether any of these addresses is on a list, for a page or a download.
   * Never rejects: anything that goes wrong is SAFE, as the service's terms say.
   */
  async check(urls: readonly string[], purpose: Purpose): Promise<Verdict> {
    const web = urls.filter((u) => /^https?:/i.test(u));
    if (!this.active || web.length === 0) return SAFE;
    const started = performance.now();
    try {
      const step = await this.request<CheckResult>({ type: 'check', urls: web, purpose, now: Date.now() });
      if (step.verdict !== 'search') {
        this.keep(this.localTimes, performance.now() - started);
        this.keep(this.workerTimes, step.took);
        return step.verdict === 'unsafe' ? { verdict: 'unsafe', kind: step.kind, url: step.url } : SAFE;
      }
      const answer = await this.search(step.prefixes);
      const verdict = await this.request<SearchedResult>({ type: 'searched', prefixes: step.prefixes, body: answer?.body ?? null, json: answer?.json ?? false, urls: web, purpose, now: Date.now() });
      this.keep(this.searchTimes, performance.now() - started);
      return verdict;
    } catch {
      return SAFE;
    }
  }

  private keep(list: number[], value: number): void {
    list.push(value);
    if (list.length > TIMINGS_KEPT) list.shift();
  }

  /* ---------- The worker ---------- */

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.config.workerPath, { name: 'Safe Browsing' });
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
      for (const waiter of this.waiting.values()) waiter.reject(new Error('Safe Browsing stopped'));
      this.waiting.clear();
      // A crash while on: start again (a few times), lists and all.
      if (this.running && ++this.restarts <= MAX_RESTARTS) this.ensureWorker();
    };
    worker.on('error', gone);
    worker.on('exit', gone);
    this.worker = worker;
    void this.request<OpenResult>({ type: 'open', file: this.config.file }).then(
      (opened) => {
        this.entries = opened.entries;
        if (opened.entries > 0 && opened.savedAt) this.updatedAt ??= opened.savedAt;
      },
      () => {},
    );
    return worker;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = null;
    for (const waiter of this.waiting.values()) waiter.reject(new Error('Safe Browsing stopped'));
    this.waiting.clear();
    void worker?.terminate();
  }

  private request<T>(request: WorkerRequest): Promise<T> {
    if (!this.running || this.restarts > MAX_RESTARTS) return Promise.reject(new Error('Safe Browsing is off'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const transfer = 'body' in request && request.body ? [request.body.buffer as ArrayBuffer] : [];
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  /* ---------- The network ---------- */

  /** In memory, no cache, no cookies: nothing here is about you, and nothing is kept. */
  private session(): Session {
    if (!this.ses) {
      this.ses = session.fromPartition('chord-safe-browsing', { cache: false });
      this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.ses.setPermissionCheckHandler(() => false);
      this.ses.setSpellCheckerEnabled(false);
    }
    return this.ses;
  }

  private async get(path: string, params: URLSearchParams, timeoutMs: number): Promise<{ body: Uint8Array; json: boolean }> {
    const endpoint = this.config.endpoint!;
    const response = await this.session().fetch(`${endpoint.base}${path}?${params}`, {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/x-protobuf', ...(endpoint.key ? { 'x-goog-api-key': endpoint.key } : {}) },
    });
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`);
    const json = /json/i.test(response.headers.get('content-type') ?? '');
    return { body: new Uint8Array(await response.arrayBuffer()), json };
  }

  /** hashes.search for these prefixes; null when it failed (the check is then SAFE). */
  private search(prefixes: readonly number[]): Promise<{ body: Uint8Array; json: boolean } | null> {
    if (Date.now() < this.searchPausedUntil) return Promise.resolve(null);
    const key = [...prefixes].sort((a, b) => a - b).join(',');
    const pending = this.searching.get(key);
    if (pending) return pending.then((answer) => (answer ? { body: answer.body.slice(), json: answer.json } : null));
    const params = new URLSearchParams();
    for (const prefix of prefixes) {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(prefix);
      params.append('hashPrefixes', bytes.toString('base64url'));
    }
    const request = this.get('/v5/hashes:search', params, SEARCH_TIMEOUT_MS).then(
      (answer) => {
        this.searchFailures = 0;
        return answer;
      },
      () => {
        // Failing again and again: give the service a rest (up to 30 minutes), answering SAFE meanwhile.
        this.searchFailures++;
        if (this.searchFailures >= 2) this.searchPausedUntil = Date.now() + Math.min(30 * MINUTE, 30_000 * 2 ** (this.searchFailures - 2));
        return null;
      },
    );
    this.searching.set(key, request);
    void request.finally(() => this.searching.delete(key));
    return request.then((answer) => (answer ? { body: answer.body.slice(), json: answer.json } : null));
  }

  private scheduleUpdate(delayMs: number): void {
    clearTimeout(this.updateTimer);
    if (!this.running) return;
    this.updateTimer = setTimeout(() => void this.update(), Math.max(0, delayMs));
    this.updateTimer.unref?.();
  }

  private async update(): Promise<void> {
    if (!this.running) return;
    try {
      const due = await this.request<DueResult>({ type: 'due', now: Date.now() });
      if (due.lists.length === 0) {
        this.scheduleUpdate(due.nextUpdateAt - Date.now());
        return;
      }
      const params = new URLSearchParams();
      for (const list of due.lists) params.append('names', list.name);
      for (const list of due.lists) if (list.version) params.append('version', list.version);
      const answer = await this.get('/v5/hashLists:batchGet', params, UPDATE_TIMEOUT_MS);
      if (!this.running) return;
      const result = await this.request<UpdateResult>({ type: 'update', body: answer.body, json: answer.json, now: Date.now() });
      this.updateFailures = 0;
      this.failing = result.failed.length > 0;
      this.entries = result.entries;
      this.updatedAt = Date.now();
      const wait = result.nextUpdateAt - Date.now();
      // "Fetch again now" (a list didn't fit, or failed its checksum): soon, but never in a tight loop.
      this.immediateUpdates = wait <= IMMEDIATE_MS ? this.immediateUpdates + 1 : 0;
      this.scheduleUpdate(this.immediateUpdates > 10 ? MINUTE : Math.max(wait, IMMEDIATE_MS));
    } catch {
      if (!this.running) return;
      this.failing = true;
      this.updateFailures++;
      // Back off: 15 min × 2^(n-1) × (1 + random), at most a day; saved, so a relaunch doesn't hurry it.
      const wait = Math.min(DAY, 15 * MINUTE * 2 ** (this.updateFailures - 1) * (1 + Math.random()));
      await this.request({ type: 'defer', at: Date.now() + wait }).catch(() => {});
      this.scheduleUpdate(wait);
    }
  }
}

/** The lists' file: `<userData>/Safe Browsing/lists.bin`. */
export const listsFile = (userData: string): string => join(userData, 'Safe Browsing', 'lists.bin');
