/**
 * The update check (ARCHITECTURE.md §14.4). An installed Chord asks GitHub
 * Releases shortly after launch and then once a day whether a newer version
 * is out. Where it can install updates itself (update-installer.ts: Windows'
 * installer and the AppImage, with a signed manifest), it downloads the new
 * version in the background and offers "Restart to update". Elsewhere it
 * says the version is out, with a link to the release.
 *
 * Unauthenticated GitHub API calls are limited to 60 an hour per address, so
 * this asks rarely, backs off after a failure, and never retries in a loop.
 * Failures are silent; Settings → About shows the last answer.
 */
import type { UpdateStatus } from '@chord/ipc';
import { app, session, type Session } from 'electron';
import { inFlatpak } from './identity';
import { newerRelease, type Release } from './releases';

/** What updates.ts needs from update-installer.ts (an interface, so tests can stand in for it). */
export interface Installer {
  readonly supported: boolean;
  prepare(release: Release, onProgress: (percent: number) => void): Promise<void>;
  restart(): void;
}

const FEED = 'https://api.github.com/repos/anaremore/chord-browser/releases?per_page=20';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Let launch settle before the first check. */
const FIRST_CHECK_MS = 30_000;
const TIMEOUT_MS = 15_000;
/** "Check now" pressed again within this long gets the answer it just had. */
const MANUAL_REPEAT_MS = 30_000;

export interface UpdateCheckerOptions {
  /** Settings → About → "Check for updates automatically". */
  enabled(): boolean;
  /** A newer version this copy can't install itself, found by a scheduled check; each version is announced once per run. */
  onAvailable(release: Release): void;
  /** A newer version downloaded and verified, waiting for a restart. */
  onReady(release: Release): void;
  installer?: Installer;
}

export class UpdateChecker {
  /** Development and E2E only: a local feed, checked a second after launch. A Flatpak doesn't check at all. */
  private readonly feed = inFlatpak ? undefined : app.isPackaged ? FEED : process.env['CHORD_UPDATE_FEED'];
  private last: UpdateStatus = this.feed ? { state: 'idle' } : { state: inFlatpak ? 'managed' : 'unavailable' };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private readonly announced = new Set<string>();
  private ses: Session | null = null;
  /** The release the last check found, with its tag. */
  private release: Release | null = null;
  /** The release being downloaded or ready, so a second check doesn't start it again. */
  private preparing: string | null = null;

  constructor(private readonly options: UpdateCheckerOptions) {}

  start(): void {
    if (this.feed) this.schedule(app.isPackaged ? FIRST_CHECK_MS : 1000);
  }

  status(): UpdateStatus {
    return this.last;
  }

  /** Settings → About → "Check now": works with automatic checks off, and doesn't toast (the answer is on screen). */
  async checkNow(): Promise<UpdateStatus> {
    if (!this.feed) return this.last;
    if (this.last.state === 'downloading' || this.last.state === 'ready') return this.last;
    if ('checkedAt' in this.last && Date.now() - this.last.checkedAt < MANUAL_REPEAT_MS) return this.last;
    const status = await this.check();
    if (status.state === 'available' && this.release) this.install(this.release, false);
    return this.last;
  }

  /** Settings → About and the toast's "Restart to update". */
  restart(): void {
    if (this.last.state === 'ready') this.options.installer?.restart();
  }

  /** Download a release in the background where this copy can install it; otherwise just say it's out. */
  private install(release: Release, announce: boolean): void {
    const installer = this.options.installer;
    if (!installer?.supported) {
      if (announce) this.options.onAvailable(release);
      return;
    }
    if (this.preparing === release.version) return;
    this.preparing = release.version;
    const checkedAt = 'checkedAt' in this.last ? this.last.checkedAt : Date.now();
    this.last = { state: 'downloading', checkedAt, version: release.version, url: release.url, percent: 0 };
    installer
      .prepare(release, (percent) => {
        if (this.last.state === 'downloading') this.last = { ...this.last, percent };
      })
      .then(() => {
        this.last = { state: 'ready', checkedAt, version: release.version, url: release.url };
        this.options.onReady(release);
      })
      .catch(() => {
        // Not signed, not reachable, or not for this build: fall back to saying it's out.
        this.preparing = null;
        this.last = { state: 'available', checkedAt, version: release.version, url: release.url };
        if (announce) this.options.onAvailable(release);
      });
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scheduled(), delay);
  }

  private async scheduled(): Promise<void> {
    if (this.options.enabled() && this.last.state !== 'downloading' && this.last.state !== 'ready') {
      const status = await this.check();
      if (status.state === 'available' && this.release && !this.announced.has(status.version)) {
        this.announced.add(status.version);
        this.install(this.release, true);
      }
    }
    // After a failure: an hour, then two, then four, then back to daily.
    this.schedule(this.last.state === 'failed' ? Math.min(DAY_MS, HOUR_MS * 2 ** (this.failures - 1)) : DAY_MS);
  }

  private async check(): Promise<UpdateStatus> {
    this.last = { state: 'checking' };
    try {
      const response = await this.session().fetch(this.feed!, {
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = newerRelease(await response.json(), app.getVersion());
      this.release = release;
      this.failures = 0;
      this.last = release
        ? { state: 'available', checkedAt: Date.now(), version: release.version, url: release.url }
        : { state: 'current', checkedAt: Date.now() };
    } catch {
      this.failures++;
      this.last = { state: 'failed', checkedAt: Date.now() };
    }
    return this.last;
  }

  /** In memory: the check keeps nothing between runs. */
  private session(): Session {
    this.ses ??= session.fromPartition('chord-updates', { cache: false });
    return this.ses;
  }
}
