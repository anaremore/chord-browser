/**
 * Performance budgets (ARCHITECTURE.md §1 and §15.5, DESIGN.md §6.7): launch,
 * the command bar, and the shell's frames during the interactions of DESIGN.md
 * §6.5, with a typical sidebar (20 Today tabs) and a full one (200), motion on
 * and off.
 *
 * Writes test-results/perf.json and prints a table. Counts (renders in a
 * frame, page moves, late results) don't depend on the machine, so a miss
 * fails anywhere, CI included. Times only report, because CI runners are
 * noisy; with CHORD_PERF_ENFORCE=1 (on reference hardware) a time over its
 * budget fails too. How to run it and read the report: docs/testing/performance.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { frameIntervals, framesOf, layoutsOf, longestTask, profile, trace, type Frame, type TraceEvent } from './frames';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const ENFORCE = process.env['CHORD_PERF_ENFORCE'] === '1';
/** Also sample the shell's CPU during each interaction and report where its time goes (slows it a little; for finding costs). */
const PROFILE = process.env['CHORD_PERF_PROFILE'] === '1';
/** ARCHITECTURE.md §1. */
const BUDGET = { launchMs: 1500, commandBarOpenMs: 50, historyKeystrokeMs: 16, frameMs: 16, fastFrameMs: 8 } as const;
/** Long enough for the slowest functional spring (`gentle`, 417 ms) to settle. */
const SETTLE_MS = 700;
const VISITS = 2000;

/* ---------- The report ---------- */

/** `no data`: nothing was measured (a headless runner may paint no frames); enforced runs count it as a miss. */
type Status = 'pass' | 'miss' | 'needs an unlocked run' | 'needs a 120 Hz display' | 'no data';

interface Check {
  /** What's measured, e.g. "frame work". */
  label: string;
  value: number;
  /** The budget: the value is held to at most this. */
  limit: number;
  unit: 'ms' | 'late' | 'renders' | 'moves';
  status: Status;
}

interface Row {
  group: 'launch' | 'command bar' | 'frames' | 'renders' | 'page view';
  name: string;
  scenario: string;
  motion: 'on' | 'off' | null;
  /** The screen was locked when this was measured (Windows: LogonUI.exe is running), or null if unknown. */
  locked: boolean | null;
  /** How busy the machine's CPUs were just before (%, all cores, Chord idle): other work makes every number noisier. */
  cpuBusy: number;
  checks: Check[];
  detail: Record<string, unknown>;
}

interface Environment {
  os: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  electron: string;
  chromium: string;
  display: { hz: number; width: number; height: number; scale: number } | null;
  /** The median gap between frames while the shell is idle but animating nothing: what the display allows. */
  idleFrameMs: number | null;
}

const rows: Row[] = [];
let environment: Environment | null = null;

/** Whether the Windows session is locked: the logon screen covers it, and Chromium paints to a slow virtual display. */
function screenLocked(): boolean | null {
  if (process.platform !== 'win32') return null;
  try {
    return /LogonUI\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH'], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

/**
 * Budgets that don't depend on the display are always held. Ones that do
 * (time to a painted frame, a frame's work, frame rate) need the screen on: a
 * locked Windows session paints to a virtual display at about 55 Hz. The
 * 120 Hz frame budget needs a display that fast.
 */
function check(
  label: string,
  value: number,
  limit: number,
  { display = false, fast = false, locked, unit = 'ms' }: { display?: boolean; fast?: boolean; locked: boolean | null; unit?: Check['unit'] },
): Check {
  const hz = environment?.display?.hz ?? 0;
  let status: Status = value <= limit ? 'pass' : 'miss';
  if (!Number.isFinite(value)) status = 'no data';
  else if ((display || fast) && locked) status = 'needs an unlocked run';
  else if (fast && hz < 120) status = 'needs a 120 Hz display';
  return { label, value: round(value), limit, unit, status };
}

/** CPU use over `ms`, all cores, as a percentage. Taken before each test, while Chord sits idle. */
let cpuBusy = 0;
async function measureCpuBusy(ms = 1000): Promise<number> {
  const sample = () => cpus().reduce((a, { times: t }) => ({ idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.irq + t.idle }), { idle: 0, total: 0 });
  const a = sample();
  await new Promise((done) => setTimeout(done, ms));
  const b = sample();
  return round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)));
}

function record(row: Omit<Row, 'cpuBusy'>): void {
  (row as Row).cpuBusy = cpuBusy;
  rows.push(row as Row);
  for (const c of row.checks) {
    if (!ENFORCE && c.unit === 'ms') continue;
    const what = `${row.name} (${row.scenario}${row.motion ? `, motion ${row.motion}` : ''}): ${c.label} ${c.value} ${c.unit}, budget ${c.limit}`;
    expect.soft(c.status, what).not.toMatch(/^(miss|no data)$/);
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const percentile = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : NaN;
};
const max = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : NaN);

test.afterAll(() => {
  const out = resolve(appDir, 'test-results');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'perf.json');
  // A failed test restarts Playwright's worker, and this file's state with it; the measures the worker
  // before it took are already in the report (Playwright empties test-results when a run starts).
  const earlier = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { results: Row[]; environment: Environment | null }) : null;
  if (earlier) rows.unshift(...earlier.results);
  environment ??= earlier?.environment ?? null;
  const report = { version: 1, date: new Date().toISOString(), enforced: ENFORCE, budgets: BUDGET, environment, results: rows };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(table());
});

/** One line per measure: each check as `label value/budget STATUS` (ok, MISS, or what it needs). */
function table(): string {
  const env = environment;
  const busy = rows.map((r) => r.cpuBusy);
  const lines = [
    `Performance (${ENFORCE ? 'enforced' : 'report only'}): ${env?.cpu ?? '?'}; display ${env?.display?.hz ?? '?'} Hz, idle frame ${env?.idleFrameMs ?? '?'} ms` +
      `; other CPU use ${busy.length ? `${Math.min(...busy)}–${Math.max(...busy)}%` : '?'}` +
      `${rows.some((r) => r.locked) ? '; screen LOCKED for some (display-bound checks not held)' : ''}`,
  ];
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  const mark: Record<Status, string> = { pass: 'ok', miss: 'MISS', 'needs an unlocked run': 'unlocked run', 'needs a 120 Hz display': '120 Hz display', 'no data': 'no data' };
  for (const r of rows) {
    const checks = r.checks.map((c) => `${c.label} ${c.value}/${c.limit}${c.unit === 'ms' ? '' : ` ${c.unit}`} ${mark[c.status]}`).join('; ');
    lines.push(`${pad(r.name, 44)} ${pad(r.scenario, 17)} ${pad(r.motion ?? '', 3)} ${checks}${r.locked ? ' [locked]' : ''}`);
  }
  return lines.join('\n');
}

/* ---------- Launching ---------- */

/** Made-up pages for the seeded tabs (CHORD_PERF_TABS), so nothing needs the network. */
function startSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const n = /^\/perf\/(\d+)$/.exec(req.url ?? '')?.[1];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(n ? `<title>Page ${n}</title><h1>Page ${n}</h1><p>${'Words on a page. '.repeat(40)}</p>` : '<title>Home</title><p>Home</p>');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

async function launch(env: Record<string, string>, profile = mkdtempSync(join(tmpdir(), 'chord-perf-'))): Promise<ElectronApplication> {
  // A fresh profile per launch unless a run reuses one: tests never touch a developer's real data.
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: profile,
    CHORD_HOME_URL: `${site.origin}/`,
    CHORD_E2E_HOOKS: '1',
    // Duet's panel opens without looking for a real Claude Code or Codex on this machine (paths that don't exist).
    CHORD_DUET_CLAUDE: join(profile, 'no-claude'),
    CHORD_DUET_CODEX: join(profile, 'no-codex'),
    ...env,
  };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');

type LaunchTimings = Partial<Record<'processStart' | 'mainEntry' | 'ready' | 'restored' | 'windowCreated' | 'shellLoaded' | 'windowShown' | 'shellReady' | 'shellPainted', number>>;

/** Polls until `ready` or `ms` pass, without failing: a measure that never comes is reported as "no data". */
async function settled(ready: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !(await ready())) await new Promise((done) => setTimeout(done, 100));
}

/** Main's launch marks (src/main/perf.ts), once the shell is ready and, if it paints at all, has painted. */
async function launchTimings(app: ElectronApplication): Promise<LaunchTimings> {
  const read = () => app.evaluate(() => (globalThis as { chordTestHooks?: { launch(): LaunchTimings } }).chordTestHooks?.launch() ?? null);
  await expect.poll(async () => (await read())?.shellReady ?? null, { timeout: 30_000 }).not.toBeNull();
  await settled(async () => (await read())?.shellPainted !== undefined, 10_000);
  return (await read())!;
}

/** On screen, focused, and never throttled as a background page: frames are measured as they'd be in use. */
async function bringToFront(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(({ BaseWindow, webContents }) => {
    const w = BaseWindow.getAllWindows()[0]!;
    w.show();
    w.focus();
    w.moveTop();
    for (const c of webContents.getAllWebContents()) c.setBackgroundThrottling(false);
  });
  await expect.poll(() => shell.evaluate(() => document.visibilityState)).toBe('visible');
}

/**
 * Motion on or off, whatever the OS says: main's reduced-motion setting is
 * replaced and announced (renderers re-read it live), and the pages' own
 * `prefers-reduced-motion` follows, for Motion's `reducedMotion="user"`.
 */
async function setMotion(app: ElectronApplication, shell: Page, overlay: Page, on: boolean): Promise<void> {
  await app.evaluate(({ nativeTheme, systemPreferences }, reduced) => {
    systemPreferences.getAnimationSettings = () => ({ shouldRenderRichAnimation: !reduced, scrollAnimationsEnabledBySystem: !reduced, prefersReducedMotion: reduced });
    nativeTheme.emit('updated');
  }, !on);
  for (const page of [shell, overlay]) await page.emulateMedia({ reducedMotion: on ? 'no-preference' : 'reduce' });
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(!on);
  await expect.poll(() => shell.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(!on);
}

async function readEnvironment(app: ElectronApplication, shell: Page): Promise<Environment> {
  const info = await app.evaluate(({ BaseWindow, screen }) => {
    const d = screen.getDisplayMatching(BaseWindow.getAllWindows()[0]!.getBounds());
    return {
      display: { hz: d.displayFrequency, width: d.size.width, height: d.size.height, scale: d.scaleFactor },
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    };
  });
  const idle = await frameIntervals(shell, () => shell.waitForTimeout(1000));
  return {
    os: `${process.platform} ${release()}`,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    ...info,
    idleFrameMs: round(median(idle)),
  };
}

/* ---------- Launch ---------- */

test('launch: from main entry to a usable window', async () => {
  test.setTimeout(240_000);
  cpuBusy = await measureCpuBusy();
  const runs = async (scenario: string, profile: (() => string) | null, count: number) => {
    const all: LaunchTimings[] = [];
    let locked: boolean | null = null;
    for (let i = 0; i < count; i++) {
      locked = screenLocked() || locked;
      const app = await launch({}, profile ? profile() : undefined);
      try {
        all.push(await launchTimings(app));
      } finally {
        await app.close();
      }
    }
    const since = (mark: keyof LaunchTimings) => all.map((t) => t[mark]! - t.mainEntry!);
    const ready = since('shellReady');
    const painted = since('shellPainted');
    // Where the time goes, run by run: each milestone after main's first line.
    const stages = ['ready', 'restored', 'windowCreated', 'shellLoaded', 'windowShown', 'shellReady', 'shellPainted'] as const;
    const breakdown = Object.fromEntries(stages.map((s) => [s, since(s).map(round)]));
    const beforeMain = all.map((t) => round(t.mainEntry! - t.processStart!));
    record({
      group: 'launch',
      name: 'Launch to sidebar ready (worst run)',
      scenario,
      motion: null,
      locked,
      checks: [check('worst run', max(ready), BUDGET.launchMs, { locked })],
      detail: { runs: ready.map(round), median: round(median(ready)), sinceMainEntry: breakdown, processStartToMainEntry: beforeMain },
    });
    record({
      group: 'launch',
      name: 'Launch to usable window, painted (worst run)',
      scenario,
      motion: null,
      locked,
      checks: [check('worst run', max(painted), BUDGET.launchMs, { display: true, locked })],
      detail: { runs: painted.map(round), median: round(median(painted)) },
    });
  };

  await runs('fresh profile', null, 3);

  // A profile with 200 Today tabs and a used history, restored at launch.
  const profile = mkdtempSync(join(tmpdir(), 'chord-perf-'));
  const seeded = await launch({ CHORD_PERF_TABS: '200', CHORD_PERF_VISITS: String(VISITS) }, profile);
  try {
    const shell = await pageWhere(seeded, isShell);
    await expect(todaySize(shell.getByRole('tree', { name: 'Today' }))).toHaveAttribute('aria-setsize', '201', { timeout: 20_000 });
  } finally {
    await seeded.close();
  }
  await runs('200 tabs restored', () => profile, 3);
});

/* ---------- Interactions ---------- */

interface Session {
  app: ElectronApplication;
  shell: Page;
  overlay: Page;
  cdp: CDPSession;
  /** The renderer processes whose frames count: the shell's and the command bar's, by OS process ID. */
  renderers: { pid: number; name: string }[];
  scenario: string;
  motion: 'on' | 'off';
}

/**
 * One measured step. Only `act` is traced, and it drives Chord with raw input
 * (mouse coordinates, keys, Chord's own API): Playwright's locators run in the
 * page, so finding things and checking them happens in `setup` and `verify`.
 */
interface Step {
  setup?: () => Promise<void>;
  act: () => Promise<void>;
  verify?: () => Promise<void>;
}

/**
 * Runs `steps`, tracing each one's `act`, and records against the frame
 * budget: the longest task (anywhere), the worst frame's work at 60 Hz and
 * 120 Hz, and the slowest gap between frames (60 fps). See frames.ts.
 * `traced` sees each step's trace too (every process is in it).
 */
async function interaction(s: Session, name: string, steps: Step[], traced?: (events: TraceEvent[]) => Promise<void> | void): Promise<void> {
  const frames: (Frame & { renderer: string })[] = [];
  const tasks: { renderer: string; ms: number; calls: { name: string; ms: number }[] }[] = [];
  const intervals: number[] = [];
  const selfTime = new Map<string, number>();
  let locked: boolean | null = null;
  for (const step of steps) {
    await step.setup?.();
    locked = screenLocked() || locked;
    const events = await trace(s.cdp, async () => {
      if (!PROFILE) {
        intervals.push(...(await frameIntervals(s.shell, step.act)));
        return;
      }
      const self = await profile(s.cdp, async () => {
        intervals.push(...(await frameIntervals(s.shell, step.act)));
      });
      for (const [fn, ms] of self) selfTime.set(fn, (selfTime.get(fn) ?? 0) + ms);
    });
    for (const { pid, name: renderer } of s.renderers) {
      frames.push(...framesOf(events, pid).map((f) => ({ ...f, renderer })));
      tasks.push({ renderer, ...longestTask(events, pid) });
    }
    await traced?.(events);
    await step.verify?.();
  }
  const work = frames.map((f) => f.work);
  const worst = frames.reduce<(typeof frames)[number] | null>((w, f) => (!w || f.work > w.work ? f : w), null);
  const longest = tasks.reduce<(typeof tasks)[number] | null>((w, t) => (!w || t.ms > w.ms ? t : w), null);
  record({
    group: 'frames',
    name,
    scenario: s.scenario,
    motion: s.motion,
    locked,
    checks: [
      check('task', longest?.ms ?? 0, BUDGET.frameMs, { locked }),
      check('frame', max(work), BUDGET.frameMs, { display: true, locked }),
      check('frame@120Hz', max(work), BUDGET.fastFrameMs, { fast: true, locked }),
      // Never under 60 fps: no gap between frames over 1.2 × 16.7 ms.
      check('gap', max(intervals), 20, { display: true, locked }),
    ],
    detail: {
      longestTask: longest && { renderer: longest.renderer, ms: round(longest.ms), calls: longest.calls.map((c) => `${c.name} ${round(c.ms)} ms`) },
      frames: frames.length,
      steps: steps.length,
      p95WorkMs: round(percentile(work, 0.95)),
      over16: work.filter((w) => w > BUDGET.frameMs).length,
      over8: work.filter((w) => w > BUDGET.fastFrameMs).length,
      worstFrame: worst && {
        renderer: worst.renderer,
        work: round(worst.work),
        script: round(worst.script),
        styleLayout: round(worst.styleLayout),
        paint: round(worst.paint),
        calls: worst.calls.map((c) => `${c.name} ${round(c.ms)} ms`),
        ...(worst.kinds && { kinds: worst.kinds.map((k) => `${k.name} ${round(k.ms)} ms`) }),
      },
      medianFrameIntervalMs: round(median(intervals)),
      // CHORD_PERF_PROFILE=1: the shell's functions with the most self time, over every step.
      ...(PROFILE && {
        shellSelfTime: [...selfTime]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([fn, ms]) => `${fn} ${round(ms)} ms`),
      }),
    },
  });
}

/**
 * Today's size: above 150 rows the list is windowed (DESIGN.md §6.7), so only
 * rows near the view are in the DOM, but every row says how many there are.
 */
const todaySize = (today: Locator) => today.getByRole('treeitem').first();

/**
 * Counts what the archive arc draws (DESIGN.md §6.5), from just before a
 * Clear: rows drawn again as they leave (`[data-exit]`), favicons flying to
 * the Archive button (`[data-flight]`), and the most of both at once (§6.7:
 * under 50 nodes animating).
 */
const watchArc = (shell: Page) =>
  shell.evaluate(() => {
    const arc = { exits: 0, flights: 0, now: 0, peak: 0 };
    (window as unknown as { arc: typeof arc }).arc = arc;
    const count = (nodes: NodeList, by: number) => {
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const exits = node.matches('[data-exit]') ? 1 : node.querySelectorAll('[data-exit]').length;
        const flights = node.matches('[data-flight]') ? 1 : node.querySelectorAll('[data-flight]').length;
        if (by > 0) {
          arc.exits += exits;
          arc.flights += flights;
        }
        arc.now += by * (exits + flights);
        arc.peak = Math.max(arc.peak, arc.now);
      }
    };
    new MutationObserver((records) => {
      for (const r of records) {
        count(r.addedNodes, 1);
        count(r.removedNodes, -1);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
const arcSeen = (shell: Page) => shell.evaluate(() => (window as unknown as { arc: { exits: number; flights: number; peak: number } }).arc);

/** What a Clear drew: with motion, on-screen rows leave and up to six favicons fly; without, nothing animates. */
async function expectArc(shell: Page, motion: 'on' | 'off') {
  const arc = await arcSeen(shell);
  if (motion === 'on') {
    expect(arc.exits, 'rows that were on screen animate out').toBeGreaterThan(0);
    expect(arc.flights, 'favicons fly to the Archive button, at most six').toBeGreaterThan(0);
    expect(arc.flights).toBeLessThanOrEqual(6);
    expect(arc.peak, 'under 50 nodes animate at once').toBeLessThan(50);
  } else {
    expect(arc).toMatchObject({ exits: 0, flights: 0 });
  }
}

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

const dispatch = (shell: Page, command: Record<string, unknown>) =>
  shell.evaluate((c) => (window as unknown as { chord: { state: { dispatch(c: unknown): Promise<void> } } }).chord.state.dispatch(c), command);

/** Asks for the command bar the way the shell's own buttons do (synthetic keys can't reach Chord's shortcut router). */
const requestCommandBar = (shell: Page) =>
  shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));

async function openCommandBar(shell: Page, overlay: Page) {
  await requestCommandBar(shell);
  await expect(overlay.getByRole('dialog')).toBeVisible();
}

async function closeCommandBar(overlay: Page) {
  await overlay.keyboard.press('Escape');
  await expect(overlay.getByRole('dialog')).toBeHidden();
}

/** The middle of an element, for clicking it without Playwright looking for it again. */
async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  const b = (await target.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Drag with the mouse the way a hand does: pick up, travel, settle, let go (as in sidebar.spec.ts). */
async function drag(shell: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await shell.mouse.move(from.x, from.y);
  await shell.mouse.down();
  await shell.mouse.move(from.x, from.y + 6, { steps: 4 });
  await shell.mouse.move(to.x, to.y, { steps: 12 });
  await shell.waitForTimeout(200);
  await shell.mouse.move(to.x + 1, to.y, { steps: 2 });
  await shell.mouse.up();
}

/** The command bar's User Timing measures (src/renderer/overlay/CommandBar.tsx), cleared as they're read. */
const takeMeasures = (overlay: Page, name: string) =>
  overlay.evaluate((n) => {
    const entries = performance.getEntriesByName(n, 'measure') as PerformanceMeasure[];
    performance.clearMeasures(n);
    return entries.map((e) => ({ duration: e.duration, detail: e.detail as Record<string, number | string | boolean> }));
  }, name);

/** Types like a person, a key at a time, then waits for the last results. */
async function typeSlowly(overlay: Page, text: string) {
  for (const key of text) {
    await overlay.keyboard.type(key);
    await overlay.waitForTimeout(120);
  }
  await overlay.waitForTimeout(300);
}

/**
 * The shell's renders while `run` runs: every commit of its App leaves a
 * `chord:shell-render` mark (src/renderer/shared/perf.ts), and a
 * requestAnimationFrame loop marks where each frame begins. A frame should
 * hold at most one render, however many state patches arrive in it.
 */
async function shellRenders(shell: Page, run: () => Promise<void>): Promise<{ total: number; mostInAFrame: number }> {
  await shell.evaluate(() => {
    performance.clearMarks('chord:shell-render');
    const probe = { times: [] as number[], on: true };
    (window as unknown as { __chordRenderFrames?: typeof probe }).__chordRenderFrames = probe;
    const step = (t: number) => {
      probe.times.push(t);
      if (probe.on) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await run();
  return shell.evaluate(() => {
    const probe = (window as unknown as { __chordRenderFrames: { times: number[]; on: boolean } }).__chordRenderFrames;
    probe.on = false;
    const renders = performance.getEntriesByName('chord:shell-render', 'mark').map((m) => m.startTime);
    // Renders between one frame's start and the next's belong to the same frame.
    let most = 0;
    for (let i = 0; i < probe.times.length; i++) {
      const from = probe.times[i]!;
      const to = probe.times[i + 1] ?? Infinity;
      most = Math.max(most, renders.filter((t) => t >= from && t < to).length);
    }
    return { total: renders.length, mostInAFrame: most };
  });
}

/**
 * From now on, counts each shown page view's moves (`setBounds` calls) in
 * main: the snapshot technique moves a page at most twice per frame change
 * (ARCHITECTURE.md §5), where moving it every frame would relayout it every frame.
 */
async function watchPageMoves(app: ElectronApplication, origin: string): Promise<void> {
  await app.evaluate(({ BaseWindow }, from) => {
    interface Watched {
      setBounds(bounds: unknown): void;
      webContents?: { getURL(): string };
      chordMoves?: number;
      chordWatched?: boolean;
    }
    const views = BaseWindow.getAllWindows()[0]!.contentView.children as unknown as Watched[];
    const pages = views.filter((v) => v.webContents?.getURL().startsWith(from));
    (globalThis as { chordMoveWatch?: Watched[] }).chordMoveWatch = pages;
    for (const view of pages) {
      view.chordMoves = 0;
      if (view.chordWatched) continue;
      view.chordWatched = true;
      const setBounds = view.setBounds.bind(view);
      view.setBounds = (bounds) => {
        view.chordMoves = (view.chordMoves ?? 0) + 1;
        setBounds(bounds);
      };
    }
  }, origin);
}

/** The renderer processes of the pages shown (the site's), by OS process ID. */
const pageRenderers = (app: ElectronApplication, origin: string) =>
  app.evaluate(({ webContents }, from) => [...new Set(webContents.getAllWebContents().filter((c) => c.getURL().startsWith(from)).map((c) => c.getOSProcessId()))], origin);

/** The most any watched page view moved since `watchPageMoves`. */
const pageMoves = (app: ElectronApplication) =>
  app.evaluate(() => Math.max(0, ...((globalThis as { chordMoveWatch?: { chordMoves?: number }[] }).chordMoveWatch ?? []).map((v) => v.chordMoves ?? 0)));

/** Ten openings, the first since launch included: the open budget, to the first frame and to its paint. */
async function commandBarOpens(s: Session): Promise<void> {
  const { shell, overlay } = s;
  const locked = screenLocked();
  await takeMeasures(overlay, 'chord:command-bar-open');
  for (let i = 0; i < 10; i++) {
    await openCommandBar(shell, overlay);
    await overlay.waitForTimeout(150);
    await closeCommandBar(overlay);
  }
  await settled(async () => (await overlay.evaluate(() => performance.getEntriesByName('chord:command-bar-open').length)) >= 10, 10_000);
  const opens = await takeMeasures(overlay, 'chord:command-bar-open');
  const toFrame = opens.map((o) => Number(o.detail['frame']));
  const toPaint = opens.map((o) => o.duration);
  const base = { group: 'command bar' as const, scenario: s.scenario, motion: s.motion, locked };
  record({
    ...base,
    name: `Open to first frame (worst of ${opens.length})`,
    checks: [check('worst', max(toFrame), BUDGET.commandBarOpenMs, { locked })],
    detail: {
      first: round(toFrame[0]!),
      median: round(median(toFrame)),
      runs: toFrame.map(round),
      // Main to the command bar (IPC), and to its commit in the DOM: the rest is waiting for the frame.
      received: opens.map((o) => round(Number(o.detail['received']))),
      committed: opens.map((o) => round(Number(o.detail['committed']))),
    },
  });
  record({
    ...base,
    name: `Open to painted (worst of ${opens.length})`,
    checks: [check('worst', max(toPaint), BUDGET.commandBarOpenMs, { display: true, locked })],
    detail: { first: round(toPaint[0]!), median: round(median(toPaint)), runs: toPaint.map(round) },
  });
}

/** Typing: rows from memory in the keystroke's own frame, history and the archive within 16 ms. */
async function commandBarTyping(s: Session, label: string, typing: readonly string[]): Promise<void> {
  const { shell, overlay } = s;
  const locked = screenLocked();
  await takeMeasures(overlay, 'chord:keystroke');
  await takeMeasures(overlay, 'chord:keystroke-history');
  for (const text of typing) {
    await openCommandBar(shell, overlay);
    await typeSlowly(overlay, text);
    await closeCommandBar(overlay);
  }
  const keys = await takeMeasures(overlay, 'chord:keystroke');
  const history = await takeMeasures(overlay, 'chord:keystroke-history');
  const base = { group: 'command bar' as const, scenario: s.scenario, motion: s.motion, locked };
  const late = keys.filter((k) => k.detail['sameFrame'] !== true).length;
  record({
    ...base,
    name: `Keystroke: tabs and actions in its frame (${label})`,
    // Every keystroke's rows from memory are in the DOM before its frame begins.
    checks: [check('late', late, 0, { locked, unit: 'late' })],
    detail: {
      keystrokes: keys.length,
      committedMs: { median: round(median(keys.map((k) => Number(k.detail['committed'])))), worst: round(max(keys.map((k) => Number(k.detail['committed'])))) },
      paintedMs: { median: round(median(keys.map((k) => k.duration))), worst: round(max(keys.map((k) => k.duration))) },
    },
  });
  const committed = history.map((h) => Number(h.detail['committed']));
  record({
    ...base,
    name: `Keystroke: history and archive (${label})`,
    checks: [check('to commit', max(committed), BUDGET.historyKeystrokeMs, { locked }), check('to paint', max(history.map((h) => h.duration)), BUDGET.historyKeystrokeMs, { display: true, locked })],
    detail: {
      replies: history.length,
      committedMs: committed.map(round),
      // Keystroke → search sent, then overlay → main → chord-data → back (the query and both hops).
      sentMs: history.map((h) => round(Number(h.detail['sent']))),
      roundTripMs: history.map((h) => round(Number(h.detail['roundTrip']))),
      rows: max(history.map((h) => Number(h.detail['rows']))),
    },
  });
}

for (const tabs of [20, 200]) {
  for (const motion of ['on', 'off'] as const) {
    test(`interactions with ${tabs} Today tabs, motion ${motion}`, async () => {
      test.setTimeout(300_000);
      cpuBusy = await measureCpuBusy();
      const app = await launch({ CHORD_PERF_TABS: String(tabs), CHORD_PERF_VISITS: String(VISITS) });
      try {
        const shell = await pageWhere(app, isShell);
        const overlay = await pageWhere(app, isOverlay);
        const today = shell.getByRole('tree', { name: 'Today' });
        const pinned = shell.getByRole('tree', { name: 'Pinned' });
        const todayRows = today.locator('[data-row="tab"]');
        await expect(todaySize(today)).toHaveAttribute('aria-setsize', String(tabs + 1), { timeout: 20_000 });
        await bringToFront(app, shell);
        await setMotion(app, shell, overlay, motion === 'on');
        environment ??= await readEnvironment(app, shell);
        const renderers = await app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .map((c) => ({ pid: c.getOSProcessId(), name: /shell/.test(c.getURL()) ? 'shell' : /overlay/.test(c.getURL()) ? 'command bar' : '' }))
            .filter((r) => r.name),
        );
        const cdp = await shell.context().newCDPSession(shell);
        const s: Session = { app, shell, overlay, cdp, renderers, scenario: `${tabs} tabs`, motion };
        const settle = () => shell.waitForTimeout(SETTLE_MS);
        const repeat = (n: number, step: (i: number) => Step) => Array.from({ length: n }, (_, i) => step(i));
        let at = { x: 0, y: 0 };

        // The command bar: opening (the first since launch included), its entrance, typing.
        await commandBarOpens(s);
        await interaction(s, 'Open the command bar', repeat(3, () => ({
          act: async () => {
            await requestCommandBar(shell);
            await settle();
          },
          verify: () => closeCommandBar(overlay),
        })));
        await commandBarTyping(s, 'history', ['harmony', 'cadence 1']);
        await interaction(s, 'Type in the command bar', [
          { setup: () => openCommandBar(shell, overlay), act: () => typeSlowly(overlay, 'melody'), verify: () => closeCommandBar(overlay) },
        ]);

        // Switching tabs: the active pill glides (DESIGN.md §6.5). Each switch's state patches render the shell once a frame at most.
        const switchRenders: { total: number; mostInAFrame: number }[] = [];
        let switchLocked: boolean | null = null;
        await interaction(s, 'Switch tabs', repeat(6, (i) => ({
          setup: async () => {
            at = await centerOf(todayRows.nth(1 + i * 2));
            switchLocked = screenLocked() || switchLocked;
          },
          act: async () => {
            switchRenders.push(
              await shellRenders(shell, async () => {
                await shell.mouse.click(at.x, at.y);
                await settle();
              }),
            );
          },
          verify: () => expect(todayRows.nth(1 + i * 2)).toHaveAttribute('aria-current', 'page'),
        })));
        record({
          group: 'renders',
          name: 'Switch tabs: shell renders',
          scenario: s.scenario,
          motion: s.motion,
          locked: switchLocked,
          checks: [check('most in a frame', max(switchRenders.map((r) => r.mostInAFrame)), 1, { locked: switchLocked, unit: 'renders' })],
          detail: { perSwitch: switchRenders.map((r) => r.total), mostInAFramePerSwitch: switchRenders.map((r) => r.mostInAFrame) },
        });

        // Collapsing and docking the sidebar, and Duet's panel: the page frame changes size by the
        // snapshot technique (DESIGN.md §6.5), so each page view moves at most twice, never every frame.
        const frameChange = async (name: string, change: () => Promise<void>, ready: () => Promise<void>, done: () => Promise<void>) => {
          const moves: number[] = [];
          // The page's own cost: each resize lays it out again, so a page moved every frame relayouts every frame.
          const layouts: { count: number; ms: number }[] = [];
          let pagePids: number[] = [];
          let locked: boolean | null = null;
          await interaction(
            s,
            name,
            repeat(3, () => ({
              setup: async () => {
                await ready();
                await watchPageMoves(app, site.origin);
                pagePids = await pageRenderers(app, site.origin);
                locked = screenLocked() || locked;
              },
              act: async () => {
                await change();
                await settle();
              },
              verify: async () => {
                await done();
                moves.push(await pageMoves(app));
              },
            })),
            (events) => {
              const each = pagePids.map((pid) => layoutsOf(events, pid));
              layouts.push({ count: each.reduce((n, l) => n + l.count, 0), ms: round(each.reduce((n, l) => n + l.ms, 0)) });
            },
          );
          record({
            group: 'page view',
            name: `${name}: page view moves`,
            scenario: s.scenario,
            motion: s.motion,
            locked,
            checks: [check('most in one', max(moves), 2, { locked, unit: 'moves' })],
            detail: { moves, pageLayouts: layouts.map((l) => l.count), pageLayoutMs: layouts.map((l) => l.ms) },
          });
        };
        const hideSidebar = shell.getByRole('button', { name: 'Hide sidebar' });
        const showSidebar = shell.getByRole('button', { name: 'Show sidebar' });
        const toggleSidebar = () => runAction(shell, 'view.toggleSidebar');
        const docked = async () => {
          if (await showSidebar.isVisible()) {
            await toggleSidebar();
            await settle();
          }
          await expect(hideSidebar).toBeVisible();
        };
        const collapsed = async () => {
          if (await hideSidebar.isVisible()) {
            await toggleSidebar();
            await settle();
          }
          await expect(showSidebar).toBeVisible();
        };
        await frameChange('Collapse the sidebar', toggleSidebar, docked, () => expect(showSidebar).toBeVisible());
        await frameChange('Dock the sidebar', toggleSidebar, collapsed, () => expect(hideSidebar).toBeVisible());
        await docked();
        const duetPanel = shell.getByRole('complementary', { name: 'Duet' });
        const toggleDuet = () => runAction(shell, 'duet.toggle');
        const duetClosed = async () => {
          if (await duetPanel.isVisible()) {
            await toggleDuet();
            await settle();
          }
          await expect(duetPanel).toBeHidden();
        };
        const duetOpen = async () => {
          if (!(await duetPanel.isVisible())) {
            await toggleDuet();
            await settle();
          }
          await expect(duetPanel).toBeVisible();
        };
        await frameChange('Open Duet', toggleDuet, duetClosed, () => expect(duetPanel).toBeVisible());
        await frameChange('Close Duet', toggleDuet, duetOpen, () => expect(duetPanel).toBeHidden());
        await duetClosed();

        // Pinning: the row travels into Pinned.
        await interaction(s, 'Pin a tab', repeat(3, (i) => ({
          setup: async () => {
            await todayRows.nth(2).click();
            await expect(todayRows.nth(2)).toHaveAttribute('aria-current', 'page');
            await settle();
          },
          act: async () => {
            await runAction(shell, 'tab.pin');
            await settle();
          },
          verify: () => expect(pinned.locator('[data-row="tab"]')).toHaveCount(i + 1),
        })));

        // A folder of five tabs, folded and unfolded.
        await todayRows.nth(1).click();
        await settle();
        await runAction(shell, 'folder.new');
        const folderName = shell.getByRole('textbox', { name: 'Folder name' });
        await folderName.fill('Reading');
        await folderName.press('Enter');
        const folder = pinned.locator('[data-row="folder"]');
        const folderId = (await folder.getAttribute('data-id'))!;
        // Rows leaving Today stay in the DOM while they animate out: let them go, then read the IDs once.
        await settle();
        const inFolder = new Set(await pinned.locator(`[data-parent="${folderId}"]`).evaluateAll((els) => els.map((el) => el.getAttribute('data-id'))));
        const moving = (await todayRows.evaluateAll((els) => els.map((el) => el.getAttribute('data-id')!))).filter((id) => !inFolder.has(id)).slice(1, 5);
        for (const [i, nodeId] of moving.entries()) await dispatch(shell, { t: 'node.move', nodeId, section: 'pinned', index: i + 1, parentId: folderId });
        await expect(pinned.locator(`[data-parent="${folderId}"]`)).toHaveCount(5);
        await settle();
        await interaction(s, 'Fold and unfold a folder', repeat(4, (i) => ({
          setup: async () => {
            at = await centerOf(folder);
          },
          act: async () => {
            await shell.mouse.click(at.x, at.y);
            await settle();
          },
          verify: () => expect(folder).toHaveAttribute('aria-expanded', i % 2 === 0 ? 'false' : 'true'),
        })));

        // Reordering Today by dragging: rows make room live, then the drop settles.
        let to = { x: 0, y: 0 };
        await interaction(s, 'Drag to reorder Today', repeat(2, () => ({
          setup: async () => {
            at = await centerOf(todayRows.nth(1));
            const target = (await todayRows.nth(4).boundingBox())!;
            to = { x: target.x + target.width / 2, y: target.y + target.height - 4 };
          },
          act: async () => {
            await drag(shell, at, to);
            await settle();
          },
        })));

        // Switching chords: the sidebar slides, and the full chord's rows mount again.
        await shell.getByRole('button', { name: 'New chord' }).click();
        await shell.getByRole('textbox', { name: 'Chord name' }).fill('Work');
        await shell.getByRole('textbox', { name: 'Chord name' }).press('Enter');
        await settle();
        const chords = shell.getByRole('tablist', { name: 'Chords' });
        const chordTab = (i: number) => chords.getByRole('tab', { name: i % 2 === 0 ? 'Personal' : 'Work' });
        await interaction(s, 'Switch chords', repeat(4, (i) => ({
          setup: async () => {
            at = await centerOf(chordTab(i));
          },
          act: async () => {
            await shell.mouse.click(at.x, at.y);
            await settle();
          },
          verify: () => expect(chordTab(i)).toHaveAttribute('aria-selected', 'true'),
        })));
        await chordTab(0).click();
        await expect(chordTab(0)).toHaveAttribute('aria-selected', 'true');
        await settle();

        // Clear Today: every row goes to the archive at once, the ones on screen with the archive arc
        // (DESIGN.md §6.5); Undo brings them back.
        const count = await todaySize(today).getAttribute('aria-setsize');
        const clear = shell.getByRole('button', { name: 'Clear', exact: true });
        const clearToday = (name: string, scrolled: boolean) =>
          interaction(s, name, [
            {
              setup: async () => {
                // From the end of the list: in a windowed one, the rows on screen were never mounted at the start.
                if (scrolled) await today.evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
                await shell.getByRole('separator').first().hover();
                at = await centerOf(clear);
                await settle();
                await watchArc(shell);
              },
              act: async () => {
                await shell.mouse.click(at.x, at.y);
                await settle();
              },
              verify: async () => {
                await expect(todayRows).toHaveCount(0);
                await expectArc(shell, motion);
              },
            },
          ]);
        const undo = shell.getByRole('button', { name: 'Undo' });
        await clearToday('Clear Today', false);
        await interaction(s, 'Undo Clear Today', [
          {
            setup: async () => {
              at = await centerOf(undo);
            },
            act: async () => {
              await shell.mouse.click(at.x, at.y);
              await settle();
            },
            verify: () => expect(todaySize(today)).toHaveAttribute('aria-setsize', count!),
          },
        ]);
        await clearToday('Clear Today, scrolled to the end', true);
        await undo.click();
        await expect(todaySize(today)).toHaveAttribute('aria-setsize', count!);
        await settle();

        // History and the archive together: cleared again, so the archive holds the whole list.
        await shell.getByRole('separator').first().hover();
        await clear.click();
        await expect(todayRows).toHaveCount(0);
        await commandBarTyping(s, 'history + archive', ['harmony']);
      } finally {
        await app.close();
      }
    });
  }
}
