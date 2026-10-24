/**
 * Errors main logged instead of showing Electron's error box
 * (src/main/index.ts). Any one fails the test that caused it, with its stack,
 * so a bug in main can't hide behind a test that otherwise passed.
 */
import { expect, test, type ElectronApplication } from '@playwright/test';

const MAIN_ERROR = /\[chord\] (Uncaught exception|Unhandled rejection) in main/;
const mainErrors: string[] = [];
/** Apps a test ended on purpose with kill(): their exit isn't a crash. */
const killed = new WeakSet<ElectronApplication>();

/** Watch a launched app's stderr for errors main caught. */
export function watchForMainErrors(app: ElectronApplication): ElectronApplication {
  let log = '';
  app.process().stderr?.on('data', (chunk: Buffer) => {
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
  const child = app.process();
  const exited = new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.once('exit', done)));
  child.kill('SIGKILL');
  await exited;
}
