/**
 * Errors main logged instead of showing Electron's error box
 * (src/main/index.ts). Any one fails the test that caused it, with its stack,
 * so a bug in main can't hide behind a test that otherwise passed.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

const MAIN_ERROR = /\[chord\] (Uncaught exception|Unhandled rejection) in main/;
const mainErrors: string[] = [];
/** Launch timelines main printed because its first page was slow (src/main/launch-timeline.ts): shown beside a failure. */
const slowLaunches: string[] = [];
const SLOW_LAUNCH = /\[chord\] slow launch:[\s\S]*?\[chord\] end of slow launch/;
/** Apps a test ended on purpose with kill(): their exit isn't a crash. */
const killed = new WeakSet<ElectronApplication>();

/**
 * How long launch may take before its chords can load their first pages: their ad-blocking rules on, or past the
 * product's own RULES_WAIT_MS (15 s) that holds them (#321). Longer is a real failure, never one to hide.
 */
const FIRST_PAGES_WITHIN_MS = 20_000;

/**
 * Watch a launched app's stderr for errors main caught; and resolve once its chords can load their first pages
 * (#321): Chord holds a chord's first page until its ad-blocking rules are on (#272's gate, up to 15 s), which on a
 * busy Windows runner's fresh profile has taken 14 s. A test starts from there, so no assertion races that wait.
 */
export async function watchForMainErrors(app: ElectronApplication): Promise<ElectronApplication> {
  let log = '';
  let slow = '';
  app.process().stderr?.on('data', (chunk: Buffer) => {
    slow = (slow + chunk.toString()).slice(-8000);
    const timeline = SLOW_LAUNCH.exec(slow);
    if (timeline) {
      slowLaunches.push(timeline[0]);
      slow = '';
    }
    log += chunk.toString();
    const at = log.search(MAIN_ERROR);
    if (at < 0) {
      log = log.slice(-200);
      return;
    }
    // Keep the message and its stack together, then start over.
    mainErrors.push(log.slice(at, at + 2000));
    log = '';
  });
  // A crash (rather than a quit) says so, instead of only "Target page, context or browser has been closed".
  app.process().once('exit', (code, signal) => {
    if ((code !== 0 || signal) && !killed.has(app)) mainErrors.push(`Chord's main process exited with code ${code}, signal ${signal}. Its last output:\n${log}`);
  });
  throttlePages(app);
  await firstPagesCanLoad(app);
  return app;
}

/**
 * Main's own signal (src/main/index.ts' chordFirstPagesGate, development and test builds): no polling for a title.
 * Past FIRST_PAGES_WITHIN_MS the test fails; its launch timeline (main's slow-launch block) prints beside it.
 */
async function firstPagesCanLoad(app: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), FIRST_PAGES_WITHIN_MS)));
  const opened = app
    .evaluate(() => (globalThis as { chordFirstPagesGate?: Promise<void> }).chordFirstPagesGate)
    .then(
      () => 'open' as const,
      // Main ended first (a launch its test ends on purpose, or one that fails, which its test reports): nothing to wait for.
      () => 'ended' as const,
    );
  const how = await Promise.race([opened, late]).finally(() => clearTimeout(timer));
  if (how === 'late') {
    // Closed here, as its test never gets it to close; at quit main prints the timeline (the first page never loaded).
    await app.close().catch(() => {});
    throw new Error(
      `Chord's chords couldn't load their first pages ${FIRST_PAGES_WITHIN_MS / 1000} s after launch: past the product's own 15 s wait for ad-blocking rules (#321). Its launch timeline prints beside this failure.`,
    );
  }
}

/**
 * `pnpm test:e2e:linux --throttle <rate>` (CHORD_E2E_CPU_THROTTLE): every web page's renderer runs that many times
 * slower (CDP's Emulation.setCPUThrottlingRate, through a session of Playwright's own, so Chord's own debugger clients
 * are untouched). Chord's own views (chord://) keep their speed: the page is what's slow, as on a busy machine's
 * heavy site. Here, beside the error watch, because every spec's launch goes through watchForMainErrors.
 */
function throttlePages(app: ElectronApplication): void {
  const rate = Number(process.env['CHORD_E2E_CPU_THROTTLE'] ?? '');
  if (!(rate > 1)) return;
  const throttle = async (page: Page) => {
    if (page.url().startsWith('chord://')) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    } catch {
      // A page closed before it could be slowed: nothing to slow.
    }
  };
  for (const page of app.windows()) void throttle(page);
  app.on('window', (page) => void throttle(page));
}

/** Call once per spec file: each test fails if its run logged an error in main. */
export function failOnMainErrors(): void {
  test.afterEach(() => {
    const slow = slowLaunches.splice(0);
    const info = test.info();
    if (slow.length > 0 && info.status !== info.expectedStatus) console.log(slow.join('\n'));
    const errors = mainErrors.splice(0);
    expect(errors, errors.join('\n---\n')).toEqual([]);
  });
}

/**
 * End Chord the way a crash, a power cut or a force-quit does: SIGKILL, so
 * nothing is flushed on the way out. Resolves once the process has exited.
 */
export async function kill(app: ElectronApplication): Promise<void> {
  killed.add(app);
  // Chromium's other processes (GPU, renderers, utilities) notice on their own and exit a moment later; on
  // Windows they hold the profile until then, and a Chord launched on it at once can't start.
  const processes = await app
    .evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, what: [m.type, m.serviceName, m.name].filter(Boolean).join(' ') })),
    )
    .catch(() => [] as { pid: number; type: string; what: string }[]);
  // Chord's own browser process, by its id: on Windows the process Playwright holds isn't it (killing that one
  // left every Chord process running), so a crash is the browser process ending.
  const browser = processes.find((p) => p.type === 'Browser');
  if (browser) process.kill(browser.pid, 'SIGKILL');
  const child = app.process();
  const exited = new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.once('exit', done)));
  child.kill('SIGKILL');
  await exited;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Windows won't let us open a sandboxed Chromium process (EPERM): it's still there.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  for (const deadline = Date.now() + 15_000; processes.some((p) => alive(p.pid)) && Date.now() < deadline; ) await new Promise((done) => setTimeout(done, 100));
  // Chord's own processes must not outlive its main one: they'd hold the profile, and Chord couldn't start again.
  const left = processes.filter((p) => alive(p.pid));
  expect(left, `still running 15 s after main was killed: ${left.map((p) => `${p.what} (pid ${p.pid})`).join(', ')}`).toEqual([]);
}
