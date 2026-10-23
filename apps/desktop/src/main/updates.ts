/**
 * The notify-only update check (ARCHITECTURE.md §14.4, ROADMAP M1.6). An
 * installed Chord asks GitHub Releases shortly after launch and then once a
 * day whether a newer version is out, and says so in a toast with a link to
 * the release. Nothing downloads or installs: that needs signed builds.
 *
 * Unauthenticated GitHub API calls are limited to 60 an hour per address, so
 * this asks rarely, backs off after a failure, and never retries in a loop.
 * Failures are silent; Settings → About shows the last answer.
 */
import type { UpdateStatus } from '@chord/ipc';
import { app, session, type Session } from 'electron';
import { newerRelease, type Release } from './releases';

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
  /** A newer version, found by a scheduled check; each version is announced once per run. */
  onAvailable(release: Release): void;
}

export class UpdateChecker {
  /** Development and E2E only: a local feed, checked a second after launch. */
  private readonly feed = app.isPackaged ? FEED : process.env['CHORD_UPDATE_FEED'];
  private last: UpdateStatus = this.feed ? { state: 'idle' } : { state: 'unavailable' };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private readonly announced = new Set<string>();
  private ses: Session | null = null;

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
    if ('checkedAt' in this.last && Date.now() - this.last.checkedAt < MANUAL_REPEAT_MS) return this.last;
    return this.check();
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scheduled(), delay);
  }

  private async scheduled(): Promise<void> {
    if (this.options.enabled()) {
      const status = await this.check();
      if (status.state === 'available' && !this.announced.has(status.version)) {
        this.announced.add(status.version);
        this.options.onAvailable({ version: status.version, name: `Chord ${status.version}`, url: status.url });
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
