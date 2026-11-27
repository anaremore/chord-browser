/**
 * #321: an E2E launch starts once Chord's chords can load their first pages. Chord holds a chord's first page until its
 * ad-blocking rules are on (#272's gate, at most RULES_WAIT_MS = 15 s), which on a busy Windows runner's fresh profile
 * has taken 14 s, so a test's first assertion would race it. Main's own signal (src/main/first-pages-gate.ts) says when:
 * no polling for a title.
 *
 * - `'ok'`: the rules came on. The test goes on.
 * - `'timeout'`: the product's own fallback, its pages load unblocked (Carbon's B1 on #343). The test goes on, and the
 *   launch's timeline goes out as a CI notice, the numbers #342 needs.
 * - Never settled within GUARD_MS (main hung): the test fails, the app closed, its timeline in the error.
 * - No gate in main at all: the test fails rather than go on unwaited (Carbon's B3).
 * - Main ended first (a launch its test ends on purpose): nothing to wait for.
 */

/** Past the product's own 15 s cap and a slow database open (6.7 s seen on CI) together: only a main that hung. */
const GUARD_MS = 30_000;

/** What of Playwright's ElectronApplication this needs. */
export interface Launched {
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  close(): Promise<void>;
}

type How = 'ok' | 'timeout' | 'no gate' | 'ended' | 'late';

/** The launch's timeline so far (src/main/launch-timeline.ts), or '' if main can't say. */
const timelineOf = (app: Launched) => app.evaluate(() => (globalThis as { chordLaunchTimeline?: () => string }).chordLaunchTimeline?.() ?? '').catch(() => '');

/** A GitHub Actions notice, its lines kept (workflow commands take %0A for a line break). */
export const notice = (title: string, text: string): string => `::notice title=${title}::${text.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`;

export async function firstPagesCanLoad(app: Launched, { guardMs = GUARD_MS, log = (line: string) => console.log(line) } = {}): Promise<How> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<How>((resolve) => (timer = setTimeout(() => resolve('late'), guardMs)));
  const settled = app
    .evaluate(() => (globalThis as { chordFirstPagesGate?: Promise<'ok' | 'timeout'> }).chordFirstPagesGate ?? ('no gate' as const))
    .then(
      (how): How => how,
      (): How => 'ended',
    );
  const how = await Promise.race([settled, late]).finally(() => clearTimeout(timer));
  if (how === 'timeout') log(notice('Ad-blocking rules hit their 15 s cap at launch (#342)', await timelineOf(app)));
  if (how === 'no gate') throw new Error('Chord’s main has no first-pages gate (src/main/first-pages-gate.ts): a test would start before its first pages can load (#321).');
  if (how === 'late') {
    const timeline = await timelineOf(app);
    // Closed here: its test never gets the app to close.
    await app.close().catch(() => {});
    throw new Error(`Chord’s chords couldn’t load their first pages ${guardMs / 1000} s after launch: main never settled its 15 s wait for ad-blocking rules (#321). Its launch timeline:\n${timeline}`);
  }
  return how;
}
