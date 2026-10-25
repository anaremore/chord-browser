/**
 * Installing, updating and removing Chord Player (ARCHITECTURE.md §9, §14.4).
 *
 * - **Which release:** the newest published `player-v*` release of Chord's
 *   repository (GitHub's `/releases`, unauthenticated, from an in-memory
 *   session that sends no cookies).
 * - **Trust:** its manifest for this OS and architecture must carry a valid
 *   Ed25519 signature from Chord's update key (update-signing.ts, the same key
 *   and check as Chord's own updates), and name this target and release. The
 *   zip must then match the manifest's size and SHA-512 before a single file
 *   is unpacked (unpack-worker.ts). A build without the key offers no player.
 * - **Where:** per user, no installer, nothing registered (paths.ts).
 * - **Updates:** once a day while it's installed, a newer release is
 *   downloaded and unpacked beside the running version, and starts the next
 *   time the player opens. The previous version stays until the new one has
 *   started and said hello; one that doesn't is marked bad and skipped, and
 *   the previous one runs instead.
 *
 * Main only fetches (Chromium's network stack: proxies and certificates as
 * Chord's) and writes the bytes it receives; hashing and unpacking are a
 * worker's (performance rule 1).
 */
import { compareVersions, manifestName, parseManifest, pickPlayerRelease, PROTOCOL, PROTOCOL_MIN, type PlayerManifest, type PlayerRelease, type PlayerTarget } from '@chord/player-protocol';
import type { PlayerFailure } from '@chord/ipc';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { downloadsFor, verifyManifest } from '../update-signing';
import { nextState, type InstallEvent, type InstallState, type Installed } from './install-state';
import { downloadsDir, stateFile, versionDir } from './paths';
import type { RemoveJob, UnpackJob, UnpackMessage } from './unpack-worker';

interface StateFile {
  current: Installed | null;
  /** A newer version unpacked, waiting to start for the first time. */
  pending: Installed | null;
  /** Versions that didn't start: skipped from now on. */
  bad: string[];
}

export interface InstallerDeps {
  root: string;
  /** Null where Chord Player isn't built (Linux arm64, Windows arm64), or can't run (a Flatpak). */
  target: PlayerTarget | null;
  /** GitHub's releases API, or a test server's stand-in (development only). */
  feed: string | null;
  /** Where releases' files download from, by tag. */
  downloads: string | null;
  /** Chord's update key (PEM); empty means this build can't check a manifest, so it offers no player. */
  publicKey: string;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  workerPath: string;
  /** What the notice or Settings would show changed. */
  changed(): void;
  now?(): number;
}

const TIMEOUT_MS = 15_000;
/** Progress reaches the notice at most this often. */
const PROGRESS_MS = 250;

export class PlayerInstaller {
  state: InstallState = { s: 'unknown' };
  private file: StateFile = { current: null, pending: null, bad: [] };
  private loading: Promise<void> | null = null;
  private busy: Promise<boolean> | null = null;
  private updating: Promise<void> | null = null;

  constructor(private readonly deps: InstallerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private dispatch(event: InstallEvent): void {
    const next = nextState(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.deps.changed();
  }

  /** Whether this computer can have Chord Player at all. */
  get supported(): boolean {
    return Boolean(this.deps.target && this.deps.publicKey.trim() && this.deps.feed && this.deps.downloads);
  }

  /** Reads what's installed (once). A version Chord can't speak to counts as not installed. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(stateFile(this.deps.root), 'utf8')) as Partial<StateFile>;
        const usable = (i: Installed | null | undefined) => (i && typeof i.version === 'string' && existsSync(versionDir(this.deps.root, i.version)) ? i : null);
        this.file = { current: usable(saved.current), pending: usable(saved.pending), bad: Array.isArray(saved.bad) ? saved.bad.filter((v) => typeof v === 'string') : [] };
      } catch {
        this.file = { current: null, pending: null, bad: [] };
      }
      const installed = this.installed();
      if (installed) this.dispatch({ e: 'present', installed });
    })();
    return this.loading;
  }

  private compatible(i: Installed | null): Installed | null {
    return i && i.protocol >= PROTOCOL_MIN && i.protocol <= PROTOCOL && !this.file.bad.includes(i.version) ? i : null;
  }

  /** The version that would run: one waiting to start, else the current one; null when none Chord can speak to. */
  installed(): Installed | null {
    return this.compatible(this.file.pending) ?? this.compatible(this.file.current);
  }

  /** What to try starting, in order: the version waiting to start, then the one that ran last. */
  candidates(): Installed[] {
    return [this.compatible(this.file.pending), this.compatible(this.file.current)].filter((i, n, all): i is Installed => i !== null && all.findIndex((j) => j?.version === i.version) === n);
  }

  get pendingVersion(): string | null {
    return this.compatible(this.file.pending)?.version ?? null;
  }

  /** The newest release for this target, its manifest checked: null with why when there's none to offer. */
  private async latest(): Promise<{ release: PlayerRelease; manifest: PlayerManifest } | { none: 'unsupported' | 'unsigned' | 'no-release' | 'unreachable' }> {
    const { target, feed, downloads, publicKey } = this.deps;
    if (!target || !feed || !downloads) return { none: 'unsupported' };
    if (!publicKey.trim()) return { none: 'unsigned' };
    let release: PlayerRelease | null;
    try {
      const response = await this.deps.fetch(feed, {
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (!response.ok) return { none: 'unreachable' };
      release = pickPlayerRelease(await response.json(), this.installed()?.version);
    } catch {
      return { none: 'unreachable' };
    }
    if (!release) return { none: 'no-release' };
    const base = downloadsFor(release.tag, downloads);
    const name = manifestName(target);
    try {
      const [manifest, signature] = await Promise.all(
        [name, `${name}.sig`].map(async (file) => {
          const response = await this.deps.fetch(new URL(file, base).href, { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
          const text = await response.text();
          if (text.length > 64 * 1024) throw new Error(`${file} is too big`);
          return text;
        }),
      );
      if (!verifyManifest(manifest!, signature!, publicKey)) return { none: 'unsigned' };
      const parsed = parseManifest(manifest!, { target, version: release.version });
      // A player speaking a protocol this Chord doesn't is no use to it (an older Chord meets a newer player).
      if (!parsed || parsed.protocol < PROTOCOL_MIN || parsed.protocol > PROTOCOL) return { none: 'no-release' };
      return { release, manifest: parsed };
    } catch {
      return { none: 'unreachable' };
    }
  }

  /** Finds out what the notice can offer, when Chord Player isn't installed (or is too old for this Chord). */
  async check(): Promise<void> {
    await this.load();
    if (this.state.s !== 'unknown' && this.state.s !== 'unavailable' && !(this.state.s === 'failed' && !this.state.manifest)) return;
    this.dispatch({ e: 'check', now: this.now() });
    const found = await this.latest();
    if ('none' in found) this.dispatch({ e: 'none', why: found.none });
    else this.dispatch({ e: 'found', ...found, update: Boolean(this.file.current) });
  }

  /** Installs the release the notice offered. Resolves true once it's ready to start. */
  install(): Promise<boolean> {
    if (this.busy) return this.busy;
    const state = this.state;
    if (state.s !== 'available' && !(state.s === 'failed' && state.manifest)) return Promise.resolve(this.state.s === 'installed');
    this.dispatch({ e: 'install' });
    const { release, manifest } = state as { release: PlayerRelease; manifest: PlayerManifest };
    this.busy = (async () => {
      let lastReport = 0;
      const result = await this.fetchAndUnpack(release, manifest, {
        received: (bytes) => {
          if (this.now() - lastReport < PROGRESS_MS) return;
          lastReport = this.now();
          this.dispatch({ e: 'progress', received: bytes });
        },
        downloaded: () => this.dispatch({ e: 'downloaded' }),
        verified: () => this.dispatch({ e: 'verified' }),
        unpacked: (percent) => this.dispatch({ e: 'unpacked', percent }),
      });
      if (result !== true) {
        this.dispatch({ e: 'fail', why: result });
        return false;
      }
      const installed = this.installedFrom(manifest);
      // Installing from the notice means no version this Chord can speak to was there: the new one runs at once.
      this.file = { ...this.file, current: installed, pending: null, bad: this.file.bad.filter((v) => v !== installed.version) };
      await this.save();
      await this.prune();
      this.dispatch({ e: 'done', installed });
      return true;
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private installedFrom(manifest: PlayerManifest): Installed {
    return { version: manifest.version, protocol: manifest.protocol, ecs: manifest.ecs, vmp: manifest.vmp };
  }

  /**
   * The background update: a newer release than the installed one is
   * downloaded and unpacked beside it, and waits to start the next time the
   * player opens. Quiet: failures are tried again tomorrow.
   */
  checkForUpdate(): Promise<void> {
    this.updating ??= (async () => {
      await this.load();
      const installed = this.installed();
      if (!installed || this.busy) return;
      const found = await this.latest();
      if ('none' in found || compareVersions(found.manifest.version, installed.version) <= 0 || this.file.bad.includes(found.manifest.version)) return;
      if (existsSync(versionDir(this.deps.root, found.manifest.version)) && this.file.pending?.version === found.manifest.version) return;
      const result = await this.fetchAndUnpack(found.release, found.manifest, {});
      if (result !== true) return;
      this.file = { ...this.file, pending: this.installedFrom(found.manifest) };
      await this.save();
      this.deps.changed();
    })().finally(() => {
      this.updating = null;
    });
    return this.updating;
  }

  /** A version said hello: it's the current one now, and older ones go. */
  async started(version: string): Promise<void> {
    if (this.file.pending?.version === version) {
      this.file = { ...this.file, current: this.file.pending, pending: null };
      await this.save();
      await this.prune();
      this.deps.changed();
    }
  }

  /** A version didn't start: it's skipped from now on (the previous one runs instead). */
  async failedToStart(version: string): Promise<void> {
    if (!this.file.bad.includes(version)) this.file = { ...this.file, bad: [...this.file.bad, version] };
    if (this.file.pending?.version === version) this.file = { ...this.file, pending: null };
    await this.save();
    this.deps.changed();
  }

  /** Removes Chord Player: every version, its profile (sign-ins, the CDM) and its state. The player must have quit. */
  async remove(): Promise<void> {
    await this.busy?.catch(() => false);
    await this.updating?.catch(() => undefined);
    await this.removePaths([this.deps.root]);
    this.file = { current: null, pending: null, bad: [] };
    this.dispatch({ e: 'removed' });
  }

  private async save(): Promise<void> {
    await mkdir(this.deps.root, { recursive: true });
    const file = stateFile(this.deps.root);
    const partial = `${file}.${randomBytes(4).toString('hex')}`;
    await writeFile(partial, `${JSON.stringify(this.file, null, 2)}\n`);
    await rename(partial, file);
  }

  /** Every version folder but the current and the pending one goes, with leftovers of interrupted unpacking. */
  private async prune(): Promise<void> {
    const keep = new Set([this.file.current?.version, this.file.pending?.version].filter(Boolean));
    let names: string[];
    try {
      names = await readdir(this.deps.root);
    } catch {
      return;
    }
    // A version still running (Windows keeps its files open) goes next time.
    const old = names.filter((name) => /^\d+\.\d+\.\d+/.test(name) && !keep.has(name)).map((name) => versionDir(this.deps.root, name));
    if (old.length) await this.removePaths(old);
  }

  /** Deletes folders in the worker, where Electron's file functions don't treat the player's app.asar as an archive. */
  private removePaths(paths: string[]): Promise<void> {
    return new Promise((resolve) => {
      const worker = new Worker(this.deps.workerPath, { workerData: { op: 'remove', paths } satisfies RemoveJob });
      const finish = () => {
        void worker.terminate();
        resolve();
      };
      worker.once('message', finish);
      worker.once('error', finish);
      worker.once('exit', finish);
    });
  }

  /** Downloads a release's zip and has the worker check and unpack it. True, or why it failed. */
  private async fetchAndUnpack(
    release: PlayerRelease,
    manifest: PlayerManifest,
    on: { received?(bytes: number): void; downloaded?(): void; verified?(): void; unpacked?(percent: number): void },
  ): Promise<true | PlayerFailure> {
    const dir = downloadsDir(this.deps.root);
    const zip = join(dir, `${manifest.file}.${randomBytes(4).toString('hex')}.partial`);
    try {
      await mkdir(dir, { recursive: true });
      const response = await this.deps.fetch(new URL(manifest.file, downloadsFor(release.tag, this.deps.downloads!)).href, { credentials: 'omit', signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) return 'download';
      const handle = await open(zip, 'w');
      let received = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          if (received > manifest.size) return 'verify';
          await handle.write(chunk);
          on.received?.(received);
        }
      } finally {
        await handle.close();
      }
      if (received !== manifest.size) return received < manifest.size ? 'download' : 'verify';
      on.downloaded?.();
      return await this.unpack({ op: 'unpack', zip, sha512: manifest.sha512, dest: versionDir(this.deps.root, manifest.version), maxBytes: Math.ceil(manifest.unpackedSize * 1.05) }, on);
    } catch {
      return 'download';
    } finally {
      await rm(zip, { force: true }).catch(() => {});
    }
  }

  private unpack(job: UnpackJob, on: { verified?(): void; unpacked?(percent: number): void }): Promise<true | PlayerFailure> {
    return new Promise((resolve) => {
      const worker = new Worker(this.deps.workerPath, { workerData: job });
      let settled = false;
      const finish = (result: true | PlayerFailure) => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        resolve(result);
      };
      worker.on('message', (message: UnpackMessage) => {
        if (message.t === 'verified') on.verified?.();
        else if (message.t === 'progress') on.unpacked?.(message.percent);
        else if (message.t === 'done') finish(true);
        else if (message.t === 'error') {
          console.warn(`[chord] Chord Player wasn't installed: ${message.message}`);
          finish(message.why);
        }
      });
      worker.on('error', () => finish('unpack'));
      worker.on('exit', () => finish('unpack'));
    });
  }
}
