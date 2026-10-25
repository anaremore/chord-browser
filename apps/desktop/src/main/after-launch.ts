/**
 * Work the first window doesn't need waits until launch is over (ARCHITECTURE.md
 * §1): sweeps of old data, and looking for Duet's apps. Until then main is busy
 * serving the window's views their files and starting its first page, and
 * anything alongside slows them down.
 *
 * Launch is over `settleMs` after the first window has painted and a first web
 * page has finished loading (or failed); or `capMs` after the windows opened,
 * whatever happened (a slow page, a window that never painted, a launch that
 * only opened a mini window).
 */
export class AfterLaunch {
  private painted = false;
  private loaded = false;
  private settling = false;
  private over = false;
  private tasks: (() => void)[] = [];
  private cap: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly timing: { settleMs: number; capMs: number } = { settleMs: 1000, capMs: 10_000 }) {}

  /** Run `task` once launch is over (at once, if it is). */
  run(task: () => void): void {
    if (this.over) task();
    else this.tasks.push(task);
  }

  /** The windows are open: from now, launch is over within `capMs`. */
  opened(): void {
    if (this.over || this.cap) return;
    this.cap = setTimeout(() => this.finish(), this.timing.capMs);
    this.cap.unref?.();
  }

  /** A window's shell painted a frame. */
  shellPainted(): void {
    this.painted = true;
    this.check();
  }

  /** A web page finished loading, or failed to. */
  pageLoaded(): void {
    this.loaded = true;
    this.check();
  }

  private check(): void {
    if (!this.painted || !this.loaded || this.settling || this.over) return;
    this.settling = true;
    setTimeout(() => this.finish(), this.timing.settleMs).unref?.();
  }

  private finish(): void {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.cap);
    const tasks = this.tasks;
    this.tasks = [];
    for (const task of tasks) task();
  }
}
