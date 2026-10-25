/**
 * Errors main logged instead of showing Electron's error box
 * (src/main/index.ts). Any one fails the test that caused it, with its stack,
 * so a bug in main can't hide behind a test that otherwise passed.
 */
import { expect, test, type ElectronApplication } from '@playwright/test';

const MAIN_ERROR = /\[chord\] (Uncaught exception|Unhandled rejection) in main/;
const mainErrors: string[] = [];
/** Launch timelines main printed because its first page was slow (src/main/launch-timeline.ts): shown beside a failure. */
const slowLaunches: string[] = [];
const SLOW_LAUNCH = /\[chord\] slow launch:[\s\S]*?\[chord\] end of slow launch/;
/** Apps a test ended on purpose with kill(): their exit isn't a crash. */
const killed = new WeakSet<ElectronApplication>();

/** Watch a launched app's stderr for errors main caught. */
export function watchForMainErrors(app: ElectronApplication): ElectronApplication {
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
  return app;
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
