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
 * budget fails too. Memory at idle and warm launches are held to what the
 * same runner measured before (perf-baseline.json, baselines.ts) instead of
 * a budget. How to run it and read the report: docs/testing/performance.md.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism, cpus, release, tmpdir, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { appendRecords, writeSnapshot, writeSyncFile, type DataRecord, type OwnSegment, type SyncFs } from '@chord/core';
import { nodeCrypto } from '@chord/data/crypto';
import { grew, launchLimit, memoryLimit, runnerKey, UPDATE_COMMAND, type Baselines, type Measured } from './baselines';
import { browserPid, busiestWindow, frameIntervals, framesOf, insideLongestTask, layoutsOf, longestTask, profile, trace, type Frame, type TraceEvent } from './frames';
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

/**
 * `no data`: nothing was measured (a headless runner may paint no frames); enforced runs count it as a miss.
 * `no baseline`: held to a baseline this runner doesn't have (perf-baseline.json), so only reported.
 */
type Status = 'pass' | 'miss' | 'needs an unlocked run' | 'needs a 120 Hz display' | 'no data' | 'no baseline';

interface Check {
  /** What's measured, e.g. "frame work". */
  label: string;
  value: number;
  /** The budget: the value is held to at most this. */
  limit: number;
  unit: 'ms' | 'late' | 'renders' | 'moves' | 'MB' | '×';
  status: Status;
  /** Held to this runner's baseline rather than a budget: what it measured before (`limit` adds the margin). */
  baseline?: number;
}

interface Row {
  group: 'launch' | 'command bar' | 'frames' | 'renders' | 'page view' | 'memory' | 'export' | 'import' | 'sync';
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

/** This runner's baseline for memory and warm launches, if it has one (baselines.ts says which runners can). */
const RUNNER = runnerKey(process.platform, process.arch, process.env, availableParallelism());
const BASELINE = RUNNER ? (JSON.parse(readFileSync(resolve(import.meta.dirname, 'perf-baseline.json'), 'utf8')) as Baselines)[RUNNER] : undefined;
/** What this run measured, in the baseline's terms: perf.json's `measured`, which `perf:baseline` takes in. */
const measured: Omit<Measured, 'runner'> = {};

/** Held to this runner's baseline plus its margin; with no baseline, reported only. */
function againstBaseline(label: string, value: number, base: number | undefined, limit: (base: number) => number, unit: Check['unit']): Check {
  if (base === undefined) return { label, value, limit: NaN, unit, status: 'no baseline' };
  const max = limit(base);
  return { label, value, limit: max, unit, status: !Number.isFinite(value) ? 'no data' : value <= max ? 'pass' : 'miss', baseline: base };
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
    if (c.baseline !== undefined) {
      const what = `${row.name} (${row.scenario}, ${RUNNER})`;
      const why = Number.isFinite(c.value)
        ? grew(what, c.value, c.baseline, c.limit, c.unit)
        : `${what}: not measured, where the baseline has ${c.baseline} ${c.unit}. If it's meant to be gone, take a new baseline: ${UPDATE_COMMAND}`;
      expect.soft(c.status, why).toBe('pass');
      continue;
    }
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
  const earlier = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { results: Row[]; environment: Environment | null; measured: Measured | null }) : null;
  if (earlier) rows.unshift(...earlier.results);
  environment ??= earlier?.environment ?? null;
  const all = { ...earlier?.measured, ...measured };
  const report = {
    version: 1,
    date: new Date().toISOString(),
    enforced: ENFORCE,
    budgets: BUDGET,
    environment,
    measured: RUNNER && (all.launch !== undefined || all.memoryMb) ? { ...all, runner: RUNNER } : null,
    results: rows,
  };
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
      `${rows.some((r) => r.locked) ? '; screen LOCKED for some (display-bound checks not held)' : ''}` +
      `; baseline ${RUNNER ? `${RUNNER}${BASELINE ? '' : ' (none yet)'}` : 'none here'}`,
  ];
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  const mark: Record<Status, string> = { pass: 'ok', miss: 'MISS', 'needs an unlocked run': 'unlocked run', 'needs a 120 Hz display': '120 Hz display', 'no data': 'no data', 'no baseline': 'no baseline' };
  for (const r of rows) {
    const checks = r.checks.map((c) => `${c.label} ${c.value}${c.status === 'no baseline' ? '' : `/${c.limit}`}${c.unit === 'ms' ? '' : ` ${c.unit}`} ${mark[c.status]}`).join('; ');
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

/**
 * Electron alone, from its process starting to one small page loaded in a
 * window (test/fixtures/bare-electron): how fast this machine launches
 * anything at that moment, so Chord's launch can be judged against it.
 */
async function bareElectronLaunch(profile: string): Promise<number> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile };
  delete env['ELECTRON_RUN_AS_NODE'];
  const app = await electron.launch({ chromiumSandbox: true, args: [resolve(appDir, 'test/fixtures/bare-electron/main.mjs')], env, cwd: appDir });
  try {
    const read = () => app.evaluate(() => (globalThis as { bareLaunch?: () => Record<string, number> }).bareLaunch?.() ?? null);
    await expect.poll(async () => (await read())?.['loaded'] ?? null, { timeout: 30_000 }).not.toBeNull();
    const marks = (await read())!;
    return marks['loaded']! - marks['processStart']!;
  } finally {
    await app.close();
  }
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

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
  test.setTimeout(300_000);
  cpuBusy = await measureCpuBusy();
  /** With `bareProfile`, bare Electron launches before each of Chord's, and the median of Chord's is held to its baseline against them. */
  const runs = async (scenario: string, profile: (() => string) | null, count: number, bareProfile?: string) => {
    const all: LaunchTimings[] = [];
    const bare: number[] = [];
    let locked: boolean | null = null;
    for (let i = 0; i < count; i++) {
      locked = screenLocked() || locked;
      // In turns, so a busy moment on the machine slows both.
      if (bareProfile) bare.push(await bareElectronLaunch(bareProfile));
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
    if (!bareProfile) return;
    // From the process starting, so what runs before main's first line counts too. Times vary from machine to
    // machine, and between CI's runners of one kind; Chord's launch against Electron's own on the same machine varies far less.
    const total = all.map((t) => t.shellReady! - t.processStart!);
    const times = Math.round((100 * median(total)) / median(bare)) / 100;
    measured.launch = times;
    record({
      group: 'launch',
      name: `Launch to sidebar ready, against bare Electron (median of ${count})`,
      scenario,
      motion: null,
      locked,
      checks: [againstBaseline('median', times, BASELINE?.launch, launchLimit, '×')],
      detail: { chordMs: total.map(round), bareElectronMs: bare.map(round), medianChordMs: round(median(total)), medianBareElectronMs: round(median(bare)) },
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
  // Warm launches: the profile, the disk cache and the OS's file cache are as a day's second launch finds them.
  const bareProfile = mkdtempSync(join(tmpdir(), 'chord-perf-'));
  await bareElectronLaunch(bareProfile);
  await runs('200 tabs restored', () => profile, 7, bareProfile);
});

/* ---------- Memory ---------- */

/**
 * Chord's own processes, held to the runner's baseline: main, the window's
 * views of Chord's UI (a renderer each), the GPU process, chord-data's
 * utility process, and the page's renderer, as Chord's scripts run in every
 * page. Chromium's other utilities (the network service and the like) are reported only.
 */
const OWN_PROCESSES = ['main', 'shell', 'command bar', 'popover', 'hover preview', 'page', 'GPU', 'chord-data'] as const;
const UI_VIEWS: Record<string, string> = { shell: 'shell', overlay: 'command bar', popover: 'popover', preview: 'hover preview' };

/**
 * Each process's private memory, MB, the way Chromium counts its own
 * footprint: on Linux its anonymous memory and swap (/proc's RssAnon and
 * VmSwap), on Windows its private bytes, on macOS (reported only) its
 * resident set. Private pages from smaps_rollup made main and the GPU process
 * jump 10–16 MB from launch to launch: a library's pages count as private
 * only while no other process on the machine maps them.
 */
async function processMemory(app: ElectronApplication): Promise<Map<string, number>> {
  const metrics = await app.evaluate(
    ({ app: electronApp, webContents }, { from, views }) => {
      const byPid = new Map<number, string>();
      for (const contents of webContents.getAllWebContents()) {
        const url = contents.getURL();
        const view = views[/^chord:\/\/([a-z]+)\//.exec(url)?.[1] ?? ''];
        if (view || url.startsWith(from)) byPid.set(contents.getOSProcessId(), view ?? 'page');
      }
      return electronApp.getAppMetrics().map((m) => ({
        pid: m.pid,
        name: m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'GPU' : m.name === 'Chord Data' ? 'chord-data' : (byPid.get(m.pid) ?? [m.type, m.name].filter(Boolean).join(' ')),
        kb: m.memory.privateBytes ?? m.memory.workingSetSize,
      }));
    },
    { from: site.origin, views: UI_VIEWS },
  );
  const status = (pid: number, key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? NaN);
  const memory = new Map<string, number>();
  for (const { pid, name, kb } of metrics) {
    const mb = (process.platform === 'linux' ? status(pid, 'RssAnon') + status(pid, 'VmSwap') : kb) / 1024;
    memory.set(name, (memory.get(name) ?? 0) + mb);
  }
  return memory;
}

/** A full garbage collection in main and in every renderer, so what's measured is what's kept, not what's waiting to go. */
async function collectGarbage(app: ElectronApplication): Promise<void> {
  for (const page of app.windows()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.detach();
  }
  await app.evaluate(() => {
    process.getBuiltinModule('v8').setFlagsFromString('--expose-gc');
    (process.getBuiltinModule('vm').runInNewContext('gc') as () => void)();
  });
}

test("memory: Chord's own processes, idle with one window and one page", async () => {
  test.setTimeout(180_000);
  cpuBusy = await measureCpuBusy();
  const launches: Map<string, number>[] = [];
  for (let i = 0; i < 3; i++) {
    const app = await launch({});
    try {
      await launchTimings(app);
      // The page has loaded, and so have the window's four views of Chord's UI.
      const loaded = () =>
        app.evaluate(
          ({ webContents }, from) => webContents.getAllWebContents().filter((c) => (c.getURL().startsWith(from) || /^chord:\/\/(shell|overlay|popover|preview)\//.test(c.getURL())) && !c.isLoading()).length,
          site.origin,
        );
      await expect.poll(loaded, { timeout: 30_000 }).toBe(5);
      await new Promise((done) => setTimeout(done, 3000));
      // The GPU process first: attaching DevTools to collect garbage makes the views paint again, which grew it by 3.5 MB.
      const gpu = (await processMemory(app)).get('GPU') ?? NaN;
      await collectGarbage(app);
      await new Promise((done) => setTimeout(done, 1000));
      const memory = await processMemory(app);
      memory.set('GPU', gpu);
      launches.push(memory);
    } finally {
      await app.close();
    }
  }
  // The median of three launches, process by process.
  const memoryMb: Record<string, number> = {};
  for (const name of new Set(launches.flatMap((m) => [...m.keys()]))) memoryMb[name] = round(median(launches.map((m) => m.get(name) ?? NaN).filter(Number.isFinite)));
  measured.memoryMb = Object.fromEntries(OWN_PROCESSES.filter((name) => Number.isFinite(memoryMb[name])).map((name) => [name, memoryMb[name]!]));
  for (const name of OWN_PROCESSES) {
    record({
      group: 'memory',
      name: `Memory at idle: ${name}`,
      scenario: 'one window, one page',
      motion: null,
      locked: null,
      checks: [againstBaseline('private', memoryMb[name] ?? NaN, BASELINE?.memoryMb?.[name], memoryLimit, 'MB')],
      detail: { launches: launches.map((m) => round(m.get(name) ?? NaN)) },
    });
  }
  const others = Object.entries(memoryMb).filter(([name]) => !(OWN_PROCESSES as readonly string[]).includes(name));
  record({ group: 'memory', name: 'Memory at idle: other processes (reported only)', scenario: 'one window, one page', motion: null, locked: null, checks: [], detail: Object.fromEntries(others) });
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
  const layoutReads = new Map<string, number>();
  let locked: boolean | null = null;
  for (const step of steps) {
    await step.setup?.();
    locked = screenLocked() || locked;
    const act = () => trace(s.cdp, async () => void intervals.push(...(await frameIntervals(s.shell, step.act))));
    // The profiler starts and stops outside the trace: starting it blocks the renderer for tens of milliseconds,
    // which would count as a frame of the interaction's own (it read as a 40 ms frame of Undo Clear Today).
    let events: TraceEvent[] = [];
    if (PROFILE) {
      const self = await profile(s.cdp, async () => void (events = await act()), layoutReads);
      for (const [fn, ms] of self) selfTime.set(fn, (selfTime.get(fn) ?? 0) + ms);
    } else events = await act();
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
        // Where the forced layouts came from: each layout-reading DOM call by its callers.
        layoutReads: [...layoutReads]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([key, ms]) => `${key} ${round(ms)} ms`),
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
  await recordTyping(s, label, locked);
}

/** The keystrokes typed since their measures were last taken, against the keystroke budgets. */
async function recordTyping(s: Session, label: string, locked: boolean | null): Promise<void> {
  const { overlay } = s;
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

/* ---------- Your data's export ---------- */

/** S15's profile: 50,000 visits on 15,000 pages, and a sidebar's worth of Today tabs. */
const EXPORT = { visits: 50_000, pages: 15_000, tabs: 60 } as const;
/** The words typed while the export runs: long enough to cover it, every keystroke searching history. */
const EXPORT_TYPING = 'harmony cadence melody tempo chorus';

/**
 * Main while `run` runs: how late its 5 ms timer fires at worst (its event
 * loop's delay), and the CPU time its process used, which tells main's own
 * work from waiting for a CPU the other processes are using.
 */
async function mainLoad(app: ElectronApplication, run: () => Promise<void>): Promise<{ lag: number; cpuMs: number; wallMs: number }> {
  await app.evaluate(() => {
    const probe = { worst: 0, on: true, cpu: process.cpuUsage(), at: performance.now() };
    (globalThis as { chordLag?: typeof probe }).chordLag = probe;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      probe.worst = Math.max(probe.worst, now - last - 5);
      last = now;
      if (probe.on) setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  });
  await run();
  return app.evaluate(() => {
    const probe = (globalThis as { chordLag?: { worst: number; on: boolean; cpu: NodeJS.CpuUsage; at: number } }).chordLag!;
    probe.on = false;
    const cpu = process.cpuUsage(probe.cpu);
    return { lag: probe.worst, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: performance.now() - probe.at };
  });
}

/**
 * Typing in the command bar while Your data's work runs (an export, an
 * import): `typing` types EXPORT_TYPING with the command bar open while
 * `during` runs (until it's told typing is done), records the keystrokes, and
 * says what main did meanwhile, read from the same trace.
 */
async function typingSession(app: ElectronApplication, shell: Page, overlay: Page) {
  const renderers = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .map((c) => ({ pid: c.getOSProcessId(), name: /shell/.test(c.getURL()) ? 'shell' : /overlay/.test(c.getURL()) ? 'command bar' : '' }))
      .filter((r) => r.name),
  );
  const cdp = await shell.context().newCDPSession(shell);
  const s: Session = { app, shell, overlay, cdp, renderers, scenario: '50,000 visits', motion: 'on' };
  const typing = async (when: string, during?: (typed: () => boolean) => Promise<void>) => {
    await openCommandBar(shell, overlay);
    await takeMeasures(overlay, 'chord:keystroke');
    await takeMeasures(overlay, 'chord:keystroke-history');
    const locked = screenLocked();
    let typed = false;
    const act = async () => void (await Promise.all([during?.(() => typed), typeSlowly(overlay, EXPORT_TYPING).then(() => (typed = true))]));
    // Main's own work, from the same trace: its longest task, what was in it, and its busiest 30 ms.
    let task = NaN;
    let inside: string[] = [];
    let busiest = { ms: NaN, tasks: [] as number[] };
    const main = await mainLoad(app, () =>
      interaction(s, `Type in the command bar, ${when}`, [{ act }], (events) => {
        const pid = browserPid(events);
        if (pid === undefined) return;
        task = longestTask(events, pid, 'CrBrowserMain').ms;
        inside = insideLongestTask(events, pid, 'CrBrowserMain');
        busiest = busiestWindow(events, pid, 'CrBrowserMain', 30);
      }),
    );
    await recordTyping(s, when, locked);
    await closeCommandBar(overlay);
    return { ...main, task, inside, busiest, locked };
  };
  return { s, typing };
}

/**
 * Exporting 50,000 visits while typing in the command bar (S15 §7), exports
 * one after another so every keystroke lands during one: the export reads the
 * database in a process of its own, so the keystroke budgets hold (history's
 * searches go to chord-data, which the export never waits on), the shell's and
 * command bar's frames stay in budget, and main's own work, read from the same
 * trace, stays under a frame. Then the same profile once more, encrypted.
 */
test('export: 50,000 visits while typing in the command bar', async () => {
  test.setTimeout(300_000);
  cpuBusy = await measureCpuBusy();
  const out = mkdtempSync(join(tmpdir(), 'chord-perf-export-'));
  const app = await launch({ CHORD_PERF_TABS: String(EXPORT.tabs), CHORD_PERF_VISITS: String(EXPORT.visits), CHORD_PERF_PAGES: String(EXPORT.pages) });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
    await settings.getByRole('button', { name: 'Export…' }).click();
    // Counted once every visit is written: the seeded pages, and the home page.
    await expect(settings.getByText('15,001 pages', { exact: true })).toBeVisible({ timeout: 60_000 });
    const target = join(out, 'export.jsonl');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, target);

    await bringToFront(app, shell);
    await setMotion(app, shell, overlay, true);
    environment ??= await readEnvironment(app, shell);
    const { s, typing } = await typingSession(app, shell, overlay);
    /** One export, from Settings' button as a click would: its wall time there, to *Saved*, and its size. */
    const exportOnce = () =>
      settings.evaluate(
        () =>
          new Promise<{ ms: number; bytes: number; phase: string }>((resolve) => {
            const api = (window as unknown as { chord: { exports: { onProgress(l: (p: { phase: string; bytes?: number }) => void): () => void } } }).chord.exports;
            const button = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Choose where to save…');
            const start = () => {
              // The last export's Saved has rendered, and the button is back.
              if (!button() || button()!.disabled) return void requestAnimationFrame(start);
              const t0 = performance.now();
              const off = api.onProgress((p) => {
                if (p.phase !== 'done' && p.phase !== 'failed') return;
                off();
                resolve({ ms: performance.now() - t0, bytes: p.bytes ?? 0, phase: p.phase });
              });
              button()!.click();
            };
            start();
          }),
      );

    // A first pass warms the command bar up; then typing alone, what main does without an export.
    await openCommandBar(shell, overlay);
    await typeSlowly(overlay, 'warm up');
    await closeCommandBar(overlay);
    const alone = await typing('before an export');
    // Then the same words while exports run one after another, so every keystroke lands during one.
    const runs: { ms: number; bytes: number; phase: string }[] = [];
    const during = await typing('during exports', async (typed) => {
      while (!typed()) runs.push(await exportOnce());
    });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.phase === 'done')).toBe(true);
    const text = readFileSync(target, 'utf8');
    const pages = text.split('\n').filter((line) => line.startsWith('{"type":"page"')).length;
    expect(pages).toBe(EXPORT.pages + 1);
    const walls = runs.map((r) => r.ms);
    record({
      group: 'export',
      name: 'Export: 50,000 visits, plain',
      scenario: s.scenario,
      motion: null,
      locked: during.locked,
      checks: [
        // Main's own work while exports run, from the trace: no task past a frame, and room to spare in any 30 ms (rule 1).
        check('main task', during.task, BUDGET.frameMs, { locked: during.locked }),
        check('main busiest 30 ms', during.busiest.ms, BUDGET.frameMs, { locked: during.locked }),
        check('wall time', median(walls), 10_000, { locked: during.locked }),
      ],
      detail: {
        mainTaskMs: { alone: round(alone.task), during: round(during.task), inside: during.inside },
        mainBusiest30Ms: { alone: alone.busiest, during: during.busiest },
        // How late a 5 ms timer in main fired at worst: reported, not held, since it varies run to run (typing alone too).
        mainLagMs: { alone: round(alone.lag), during: round(during.lag) },
        // Main's process CPU time (every thread, IPC and launching processes included): what each export costs it.
        mainCpuMs: { alone: round(alone.cpuMs), during: round(during.cpuMs), perExport: round((during.cpuMs - alone.cpuMs * (during.wallMs / alone.wallMs)) / runs.length) },
        exports: runs.length,
        wallMs: { median: round(median(walls)), worst: round(max(walls)), runs: walls.map(round) },
        bytes: runs.at(-1)?.bytes ?? 0,
        pages,
        typedMs: round(EXPORT_TYPING.length * 120 + 300),
      },
    });

    // The same profile encrypted: scrypt's half second, then deflate and AES-GCM, all in the export's process.
    await settings.getByRole('switch', { name: 'Encrypt with a passphrase' }).click();
    await settings.getByRole('button', { name: 'Suggest one' }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, join(out, 'export.chorddata'));
    const sealed = await exportOnce();
    expect(sealed.phase).toBe('done');
    record({
      group: 'export',
      name: 'Export: 50,000 visits, encrypted',
      scenario: s.scenario,
      motion: null,
      locked: screenLocked(),
      checks: [check('wall time', sealed.ms, 10_000, { locked: null })],
      detail: { wallMs: round(sealed.ms), bytes: sealed.bytes, plainBytes: runs.at(-1)?.bytes ?? 0 },
    });
  } finally {
    await app.close();
  }
});

/* ---------- Your data's import ---------- */

/** One import from Settings' API, as its buttons do: the file read and counted, imported, then undone. */
interface ImportRun {
  phase: string;
  readMs: number;
  importMs: number;
  undoMs: number;
  pages: number;
  /** The preview said it was a new profile: a restore. */
  newProfile: boolean;
}

/** S15's profile, each launch a fresh one: 50,000 visits on 15,000 pages and a sidebar's worth of Today tabs. */
const SEEDED = { CHORD_PERF_TABS: String(EXPORT.tabs), CHORD_PERF_VISITS: String(EXPORT.visits), CHORD_PERF_PAGES: String(EXPORT.pages) };
/**
 * A new profile: first run's one tab, and no more history than a clearly fresh
 * Chord has (core's FRESH_PAGES, the home page's with these): enough to search
 * as you type, though most of what's found arrives with the import.
 */
const FRESH = { CHORD_PERF_TABS: '0', CHORD_PERF_VISITS: '15', CHORD_PERF_PAGES: '15' };

/** Settings → Your data, once every seeded visit is written (the Export card counts them). */
async function yourData(app: ElectronApplication, pages = '15,001 pages'): Promise<{ shell: Page; settings: Page }> {
  const shell = await pageWhere(app, isShell);
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
  await settings.getByRole('button', { name: 'Export…' }).click();
  await expect(settings.getByText(pages, { exact: true })).toBeVisible({ timeout: 60_000 });
  return { shell, settings };
}

/** The file the import checks bring in: S15's profile, exported once. */
let importFile: Promise<string> | null = null;
const fileToImport = () => (importFile ??= exportForImport());
async function exportForImport(): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), 'chord-perf-import-')), 'import.jsonl');
  const from = await launch(SEEDED);
  try {
    const { settings } = await yourData(from);
    await from.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, file);
    await settings.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(settings.getByText(/^Saved import\.jsonl, /)).toBeVisible({ timeout: 60_000 });
    return file;
  } finally {
    await from.close();
  }
}

/**
 * Importing a Chord file of 50,000 visits on 15,000 pages while typing in the
 * command bar (S15 §7, §9): S15's profile exported, then imported into another
 * with the same pages visited at other times, so every page is weighed against
 * its own visits; each import is undone and the next begins, so every
 * keystroke lands during one (reading, setup, history or Undo). Into a profile
 * with data (something pinned), and into a new one, where the file's chord
 * takes the first-run chord's place and the window goes to it (a restore). The
 * import process reads and plans; history goes to chord-data in batches that
 * fit between two keystrokes' searches, and Undo gives it back in slices; main
 * applies setup a part at a time. The keystroke budgets hold, the shell's and
 * command bar's frames stay in budget, and main's own work, read from the same
 * trace, stays under a frame.
 */
for (const into of ['a profile with data', 'a new profile'] as const) {
  test(`import: 50,000 visits into ${into} while typing in the command bar`, async () => {
    test.setTimeout(400_000);
    const file = await fileToImport();
    cpuBusy = await measureCpuBusy();
    const fresh = into === 'a new profile';
    const app = await launch(fresh ? FRESH : SEEDED);
    try {
      const overlay = await pageWhere(app, isOverlay);
      const { shell, settings } = await yourData(app, fresh ? '16 pages' : '15,001 pages');
      if (into === 'a profile with data') {
        // Something pinned: the profile keeps its chord, and the file's comes in beside it.
        const tab = await shell.evaluate(async () => {
          const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { nodes: Record<string, { id: string; kind: string; section: string }> } }> } } }).chord.state.snapshot();
          return Object.values(state.nodes).find((n) => n.kind === 'tab' && n.section === 'today')!.id;
        });
        await shell.evaluate((nodeId) => (window as unknown as { chord: { state: { dispatch(c: unknown): Promise<void> } } }).chord.state.dispatch({ t: 'tab.pin', nodeId }), tab);
      }
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, file);
      await bringToFront(app, shell);
      await setMotion(app, shell, overlay, true);
      environment ??= await readEnvironment(app, shell);
      const { s, typing } = await typingSession(app, shell, overlay);
      const importOnce = () =>
        settings.evaluate(async (): Promise<ImportRun> => {
          type Progress = { importId: string; phase: string; counts: { pages: number } };
          const api = (
            window as unknown as {
              chord: {
                files: {
                  choose(): Promise<{ ok: boolean; fileId?: string }>;
                  open(fileId: string, passphrase: null): Promise<{ ok: true; preview: { newProfile: boolean } } | { ok: false }>;
                  run(fileId: string, choices: Record<string, boolean>): Promise<{ ok: boolean; importId?: string }>;
                  undo(importId: string): Promise<void>;
                  onProgress(listener: (p: Progress) => void): () => void;
                };
              };
            }
          ).chord.files;
          const next = (phases: string[]) =>
            new Promise<Progress>((resolve) => {
              const off = api.onProgress((p) => {
                if (!phases.includes(p.phase)) return;
                off();
                resolve(p);
              });
            });
          const t0 = performance.now();
          const chosen = await api.choose();
          const opened = chosen.ok ? await api.open(chosen.fileId!, null) : { ok: false as const };
          if (!opened.ok) return { phase: 'unread', readMs: 0, importMs: 0, undoMs: 0, pages: 0, newProfile: false };
          const t1 = performance.now();
          const finished = next(['done', 'failed']);
          const run = await api.run(chosen.fileId!, { history: true, duet: true, effects: true, settings: false });
          if (!run.ok) return { phase: 'refused', readMs: t1 - t0, importMs: 0, undoMs: 0, pages: 0, newProfile: opened.preview.newProfile };
          const done = await finished;
          const t2 = performance.now();
          const undone = next(['undone']);
          await api.undo(run.importId!);
          await undone;
          return { phase: done.phase, readMs: t1 - t0, importMs: t2 - t1, undoMs: performance.now() - t2, pages: done.counts.pages, newProfile: opened.preview.newProfile };
        });

      // A first pass warms the command bar up; then typing alone, what main does without an import.
      await openCommandBar(shell, overlay);
      await typeSlowly(overlay, 'warm up');
      await closeCommandBar(overlay);
      const alone = await typing('before an import');
      // Then the same words while imports run one after another, so every keystroke lands during one.
      const runs: ImportRun[] = [];
      const during = await typing('during imports', async (typed) => {
        while (!typed()) runs.push(await importOnce());
      });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((r) => r.phase === 'done')).toBe(true);
      // A restore only into a clearly fresh Chord: every import, since each is undone before the next.
      expect(runs.map((r) => r.newProfile)).toEqual(runs.map(() => fresh));
      // Every page was here, visited at other times: each one's visits came in.
      expect(runs.map((r) => r.pages)).toEqual(runs.map(() => EXPORT.pages + 1));
      const imports = runs.map((r) => r.importMs);
      record({
        group: 'import',
        name: `Import: 50,000 visits into ${into}`,
        scenario: s.scenario,
        motion: null,
        locked: during.locked,
        checks: [
          // Main's own work while imports run, from the trace: no task past a frame, and room to spare in any 30 ms (rule 1).
          check('main task', during.task, BUDGET.frameMs, { locked: during.locked }),
          check('main busiest 30 ms', during.busiest.ms, BUDGET.frameMs, { locked: during.locked }),
          check('wall time', median(imports), 10_000, { locked: during.locked }),
        ],
        detail: {
          mainTaskMs: { alone: round(alone.task), during: round(during.task), inside: during.inside },
          mainBusiest30Ms: { alone: alone.busiest, during: during.busiest },
          // How late a 5 ms timer in main fired at worst: reported, not held, since it varies run to run (typing alone too).
          mainLagMs: { alone: round(alone.lag), during: round(during.lag) },
          // Main's process CPU time (every thread, IPC and launching processes included): what each import and its Undo cost it.
          mainCpuMs: { alone: round(alone.cpuMs), during: round(during.cpuMs), perImport: round((during.cpuMs - alone.cpuMs * (during.wallMs / alone.wallMs)) / runs.length) },
          imports: runs.length,
          // Reading the file and counting it against what's here; importing (setup, then history); and its Undo.
          readMs: { median: round(median(runs.map((r) => r.readMs))), worst: round(max(runs.map((r) => r.readMs))) },
          importMs: { median: round(median(imports)), worst: round(max(imports)), runs: imports.map(round) },
          undoMs: { median: round(median(runs.map((r) => r.undoMs))), worst: round(max(runs.map((r) => r.undoMs))) },
          pages: runs[0]!.pages,
        },
      });
    } finally {
      await app.close();
    }
  });
}

/* ---------- Your data's sync ---------- */

/** Sync's costs as chord-data measures them (main's test hook): writes with sync on and off, the stamping hook, frames, merged slices. */
interface SyncTimings {
  write: number[];
  writeOff: number[];
  stamp: number[];
  frame: number[];
  frameBytes: number[];
  merge: number[];
  plan: number[];
  /** Pages of a snapshot, read for the worker as it writes them. */
  page: number[];
  /** Sync's other steps on chord-data's thread, by name. */
  steps: { what: string; ms: number }[];
}
/** The slowest of sync's other steps on chord-data's thread: what they were, and how long. */
const slowest = (steps: { what: string; ms: number }[], n = 3) => [...steps].sort((a, b) => b.ms - a.ms).slice(0, n).map((s) => `${s.what} ${round(s.ms)}`);
const syncHook = <T>(app: ElectronApplication, name: string) => app.evaluate((_electron, hook) => (globalThis as unknown as { chordTestHooks: Record<string, () => Promise<unknown>> }).chordTestHooks[hook]!(), name) as Promise<T>;
const SYNC_PASSPHRASE = 'harbor lantern quietly orbit maple';
/** scrypt at its smallest for a folder the test writes itself: the cost measured is sync's, not the key's. */
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

/** A folder on the disk, as sync's worker sees one (the test writes another computer's log into it with core's protocol). */
function diskFolder(root: string): SyncFs {
  const at = (path: string) => (path ? join(root, ...path.split('/')) : root);
  return {
    list: async (path) => (existsSync(at(path)) ? readdirSync(at(path)) : null),
    stat: async (path) => {
      const s = statSync(at(path), { throwIfNoEntry: false });
      return s?.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
    },
    read: async (path, position, length) => {
      const fd = openSync(at(path), 'r');
      try {
        const buffer = Buffer.alloc(length);
        return new Uint8Array(buffer.subarray(0, readSync(fd, buffer, 0, length, position)));
      } finally {
        closeSync(fd);
      }
    },
    create: async (path, bytes, exclusive) => writeFileSync(at(path), bytes, { flag: exclusive ? 'wx' : 'w' }),
    append: async (path, bytes) => appendFileSync(at(path), bytes),
    rename: async (from, to) => renameSync(at(from), at(to)),
    mkdir: async (path) => void mkdirSync(at(path), { recursive: true }),
    remove: async (path) => rmSync(at(path), { recursive: true, force: true }),
    cutBack: async (path, to, expect) => {
      const bytes = readFileSync(at(path));
      if (bytes.length !== to + expect.length || !bytes.subarray(to).equals(Buffer.from(expect))) return false;
      truncateSync(at(path), to);
      return true;
    },
  };
}

/** Turns sync on in Settings' own way (its API), the folder picker answered in main: a new folder, or one to join with *Keep both*. */
async function turnOnSync(app: ElectronApplication, shell: Page, folder: string): Promise<Page> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, folder);
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
  const settings = await pageWhere(app, isSettings);
  const state = await settings.evaluate(async (passphrase) => {
    const sync = (
      window as unknown as {
        chord: {
          sync: {
            chooseFolder(): Promise<{ ok: boolean; folderId?: string; inspection?: { state: string } }>;
            setup(id: string, p: string): Promise<{ ok: boolean; view?: { state: string } }>;
            join(id: string, p: string): Promise<{ ok: boolean; view?: { state: string } }>;
            choose(mode: string): Promise<{ ok: boolean; view?: { state: string } }>;
          };
        };
      }
    ).chord.sync;
    const folder = await sync.chooseFolder();
    if (!folder.ok) return 'no folder';
    if (folder.inspection?.state === 'new') return (await sync.setup(folder.folderId!, passphrase)).view?.state ?? 'failed';
    const joined = await sync.join(folder.folderId!, passphrase);
    if (joined.view?.state === 'choosing') return (await sync.choose('both')).view?.state ?? 'failed';
    return joined.view?.state ?? 'failed';
  }, SYNC_PASSPHRASE);
  expect(state).toBe('on');
  return settings;
}

/** chord-data's private memory (MB): its worker thread, when there is one, is in the same process. */
async function chordDataMemory(app: ElectronApplication): Promise<number> {
  await new Promise((done) => setTimeout(done, 2000));
  return round((await processMemory(app)).get('chord-data') ?? NaN);
}

/**
 * One change, from its stamp to its frame (S15 §7): a chord renamed, then
 * written to the folder at once (not 3 s later), each time; with a sidebar's
 * worth of tabs. Before: the same writes with sync off. After: the stamping
 * hook inside write(), the whole write, and the worker's frame from asking to
 * answer, with the frame's size. And chord-data's memory with sync off, with
 * its worker on, and off again.
 */
test('sync: one change, stamp to frame; chord-data’s memory with the sync worker on and off', async () => {
  test.setTimeout(240_000);
  cpuBusy = await measureCpuBusy();
  const folder = mkdtempSync(join(tmpdir(), 'chord-perf-sync-'));
  const app = await launch({ CHORD_PERF_TABS: String(EXPORT.tabs) });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tree', { name: 'Today' })).toBeVisible();
    const chordId = await shell.evaluate(async () => {
      const { state, windowId } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string }> } }> } } }).chord.state.snapshot();
      return state.windows[windowId]!.activeChordId;
    });
    // Two of its Today tabs pinned, so the chord has synced tabs as well as a name.
    await shell.evaluate(async () => {
      const chord = (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { nodes: Record<string, { id: string; kind: string; section: string }> } }>; dispatch(c: unknown): Promise<void> } } }).chord.state;
      const { state } = await chord.snapshot();
      for (const node of Object.values(state.nodes).filter((n) => n.kind === 'tab' && n.section === 'today').slice(0, 2)) await chord.dispatch({ t: 'tab.pin', nodeId: node.id });
    });
    const CHANGES = 30;
    const rename = async (i: number) => {
      await shell.evaluate(({ chordId, name }) => (window as unknown as { chord: { state: { dispatch(c: unknown): Promise<void> } } }).chord.state.dispatch({ t: 'chord.update', chordId, name }), { chordId, name: `Chord ${i}` });
      const t0 = Date.now();
      await syncHook(app, 'syncWrite');
      return Date.now() - t0;
    };
    const memoryOff = await chordDataMemory(app);
    for (let i = 0; i < CHANGES; i++) await rename(i);
    const before = await syncHook<SyncTimings>(app, 'syncTimings');

    await turnOnSync(app, shell, folder);
    const memoryOn = await chordDataMemory(app);
    const ends: number[] = [];
    for (let i = 0; i < CHANGES; i++) ends.push(await rename(CHANGES + i));
    const after = await syncHook<SyncTimings>(app, 'syncTimings');
    await syncHook(app, 'syncOff');
    const memoryAfter = await chordDataMemory(app);

    const writesOff = before.writeOff.slice(-CHANGES);
    const writesOn = after.write.slice(-CHANGES);
    const stamps = after.stamp.slice(-CHANGES);
    const frames = after.frame.slice(-CHANGES);
    expect(frames.length).toBe(CHANGES);
    record({
      group: 'sync',
      name: 'Sync: one change, stamp to frame',
      scenario: `${EXPORT.tabs} Today tabs`,
      motion: null,
      locked: screenLocked(),
      checks: [
        // chord-data's thread answers the command bar's searches: the hook and the write it's in stay far under a frame.
        check('write with sync on', max(writesOn), BUDGET.fastFrameMs, { locked: null }),
        check('stamping hook', max(stamps), BUDGET.fastFrameMs, { locked: null }),
        // The frame: the worker seals and appends it, off chord-data's thread.
        check('frame', median(frames), 100, { locked: null }),
      ],
      detail: {
        writeOffMs: { median: round(median(writesOff)), worst: round(max(writesOff)) },
        writeOnMs: { median: round(median(writesOn)), worst: round(max(writesOn)) },
        stampMs: { median: round(median(stamps) * 100) / 100, worst: round(max(stamps) * 100) / 100 },
        frameMs: { median: round(median(frames)), worst: round(max(frames)) },
        frameBytes: { median: median(after.frameBytes.slice(-CHANGES)), worst: max(after.frameBytes.slice(-CHANGES)) },
        // From the test asking for the write to the frame being in the folder: main, chord-data and the worker, round trip.
        changeToFrameMs: { median: round(median(ends)), worst: round(max(ends)) },
        changes: CHANGES,
      },
    });
    record({
      group: 'sync',
      name: 'Sync: chord-data’s memory, worker on and off',
      scenario: 'one window',
      motion: null,
      locked: null,
      // Reported: the worker thread's own heap, and what turning sync off gives back.
      checks: [],
      detail: { offMb: memoryOff, onMb: memoryOn, offAgainMb: memoryAfter, workerMb: round(memoryOn - memoryOff) },
    });
  } finally {
    await app.close();
  }
});

/**
 * Keystrokes during a large merge (S15 §7): S15's realistic setup (12 chords,
 * 260 pinned tabs in 40 folders, 200 icons, 24 Favorites, 30 routes, Effects
 * on 40 sites) is another computer's log in the folder, which this Chord, with
 * 50,000 visits of history, joins while the command bar types: about 1,500
 * records merged and 600 things applied. Then, typing again, that computer
 * renames every folder and tab, a frame of 300 records a few times a second
 * (its own writes come 3 s apart at most), each merged by chord-data in slices
 * between the searches and applied by main a part at a time. The keystroke
 * budgets hold, and main's own work stays under a frame.
 */
test('sync: keystrokes during a large merge', async () => {
  test.setTimeout(400_000);
  cpuBusy = await measureCpuBusy();
  const folder = mkdtempSync(join(tmpdir(), 'chord-perf-sync-merge-'));
  // Another computer's log, written as its worker would, with core's own protocol.
  const fs = diskFolder(join(folder, 'Chord sync'));
  await fs.mkdir('');
  const root = await writeSyncFile(fs, 1, SYNC_PASSPHRASE, 'f00df00df00df00d', nodeCrypto, FAST_KDF);
  const OTHER = 'f00df00df00df00d';
  let clock = Date.now() - 60_000;
  const stamp = (): [number, number, string] => [++clock, 0, OTHER];
  const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' };
  const icons = Array.from({ length: 200 }, (_, i) => {
    const bytes = Buffer.from(`icon ${i} `.repeat(40));
    return { id: `sha256-${createHash('sha256').update(bytes).digest('hex')}`, mime: 'image/png', data: bytes.toString('base64') };
  });
  const setup: DataRecord[] = [
    { type: 'device', id: OTHER, at: stamp(), set: { name: 'Perf desk', os: 'Linux', app: '0.5.0' } },
    ...icons.map((icon): DataRecord => ({ type: 'icon', id: icon.id, set: { mime: icon.mime, data: icon.data } })),
    ...Array.from({ length: 12 }, (_, c): DataRecord => ({ type: 'chord', id: `c${c}`, at: stamp(), set: { name: `Chord ${c}`, icon: 'C', theme: THEME, rank: `a${String(c).padStart(2, '0')}`, profile: 'default', created: 1 } })),
    ...Array.from({ length: 40 }, (_, f): DataRecord => ({ type: 'folder', id: `f${f}`, at: stamp(), set: { pos: { chord: `c${f % 12}`, section: 'pinned', parent: null, rank: `b${String(f).padStart(3, '0')}` }, title: `Folder ${f}`, collapsed: true, created: 1 } })),
    ...Array.from({ length: 260 }, (_, t): DataRecord => {
      const inFolder = t < 200;
      const chord = inFolder ? `c${(t % 40) % 12}` : `c${t % 12}`;
      return {
        type: 'tab',
        id: `t${t}`,
        at: stamp(),
        set: { pos: { chord, section: 'pinned', parent: inFolder ? `f${t % 40}` : null, rank: `c${String(t).padStart(3, '0')}` }, pinnedUrl: `${site.origin}/perf/${t}`, title: `Page ${t}`, customTitle: null, icon: icons[t % 200]!.id, muted: false, created: 1 },
      };
    }),
    ...Array.from({ length: 24 }, (_, i): DataRecord => ({ type: 'favorite', id: `fav${i}`, at: stamp(), set: { url: `https://fav${i}.test/`, title: `Favorite ${i}`, icon: icons[i]!.id, rank: `a${String(i).padStart(2, '0')}`, created: 1 } })),
    ...Array.from({ length: 30 }, (_, i): DataRecord => ({ type: 'route', id: `route${i}.test`, at: stamp(), set: { chord: `c${i % 12}`, created: 1 } })),
    ...Array.from({ length: 40 }, (_, i): DataRecord => ({ type: 'effects', id: `fx${i}.test`, at: stamp(), set: { wet: true, css: `h1 { color: rgb(${i}, 0, 0) }`, cssOn: true, hidden: [], presets: [], duet: [] } })),
  ];
  let own: OwnSegment = await writeSnapshot(fs, { generation: 1, device: OTHER }, [setup], root, { app: '0.5.0', device: [setup[0]!] }, nodeCrypto);
  let generation = 0;
  /** That computer renames every folder and tab: one frame of 300 records. */
  const renameAll = async () => {
    generation++;
    const records: DataRecord[] = [
      ...Array.from({ length: 40 }, (_, f): DataRecord => ({ type: 'folder', id: `f${f}`, at: stamp(), set: { title: `Folder ${f} · ${generation}` } })),
      ...Array.from({ length: 260 }, (_, t): DataRecord => ({ type: 'tab', id: `t${t}`, at: stamp(), set: { customTitle: `Page ${t} · ${generation}` } })),
    ];
    const appended = await appendRecords(fs, own, records, root, { app: '0.5.0', device: [] }, nodeCrypto);
    if (!appended.ok) throw new Error(appended.problem);
    own = appended.own;
  };

  const app = await launch(SEEDED);
  try {
    const overlay = await pageWhere(app, isOverlay);
    const { shell, settings } = await yourData(app);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, folder);
    /** Pinned folders and tabs, and how many are named with `suffix`: read in main by a development hook, so the check costs main next to nothing. */
    const pinned = (suffix = '') => app.evaluate((_electron, end) => (globalThis as unknown as { chordTestHooks: { pinnedNames(s: string): { count: number; named: number } } }).chordTestHooks.pinnedNames(end), suffix);
    /** Joining, as Settings' card does it (*Keep both*: this profile has 50,000 visits of its own), and the whole setup in the sidebar. */
    const join = async (): Promise<number> => {
      const t0 = performance.now();
      const state = await settings.evaluate(async (passphrase) => {
        const sync = (
          window as unknown as {
            chord: { sync: { chooseFolder(): Promise<{ ok: boolean; folderId?: string }>; join(id: string, p: string): Promise<{ ok: boolean; view?: { state: string } }>; choose(mode: string): Promise<{ ok: boolean; view?: { state: string } }> } };
          }
        ).chord.sync;
        const folder = await sync.chooseFolder();
        const joined = await sync.join(folder.folderId!, passphrase);
        return joined.view?.state === 'choosing' ? ((await sync.choose('both')).view?.state ?? 'failed') : (joined.view?.state ?? 'failed');
      }, SYNC_PASSPHRASE);
      expect(state).toBe('on');
      await expect.poll(async () => (await pinned()).count, { timeout: 30_000, intervals: [100] }).toBe(300);
      return performance.now() - t0;
    };
    /** One frame from that computer: written, chord-data told to look, and every tab's new name on screen. */
    const roundOnce = async (): Promise<number> => {
      const t0 = performance.now();
      await renameAll();
      await syncHook(app, 'syncRead');
      const name = `· ${generation}`;
      await expect.poll(async () => (await pinned(name)).named, { timeout: 20_000, intervals: [100] }).toBe(300);
      return performance.now() - t0;
    };

    await bringToFront(app, shell);
    await setMotion(app, shell, overlay, true);
    environment ??= await readEnvironment(app, shell);
    const { s, typing } = await typingSession(app, shell, overlay);
    await openCommandBar(shell, overlay);
    await typeSlowly(overlay, 'warm up');
    await closeCommandBar(overlay);
    const alone = await typing('before a merge');
    // The large merge: joining, while typing. Its 1,500 records merged, and 600 things applied.
    let joinMs = NaN;
    const joining = await typing('while joining', async () => {
      joinMs = await join();
    });
    const before = await syncHook<SyncTimings>(app, 'syncTimings');
    // Then frames of 300 changes from that computer, one after another, a few times a second (its own writes come 3 s apart at most).
    const rounds: number[] = [];
    const during = await typing('during frames of 300 changes', async (typed) => {
      while (!typed()) {
        rounds.push(await roundOnce());
        await new Promise((done) => setTimeout(done, 400));
      }
    });
    expect(rounds.length).toBeGreaterThan(0);
    const after = await syncHook<SyncTimings>(app, 'syncTimings');
    const joinMerges = before.merge;
    const merges = after.merge.slice(before.merge.length);
    for (const [label, main, extra] of [
      ['while joining', joining, { joinMs: round(joinMs), mergeSliceMs: { median: round(median(joinMerges)), worst: round(max(joinMerges)), slices: joinMerges.length }, planMs: { worst: round(max(before.plan)) }, writeMs: { worst: round(max(before.write)) }, snapshotPageMs: { worst: round(max(before.page)), pages: before.page.length }, otherStepsMs: slowest(before.steps) }],
      [
        'during frames of 300 changes',
        during,
        {
          rounds: rounds.length,
          // From the other computer writing its frame to every tab's new name in the sidebar.
          roundMs: { median: round(median(rounds)), worst: round(max(rounds)) },
          mergeSliceMs: { median: round(median(merges)), worst: round(max(merges)), slices: merges.length },
          // chord-data's other work for each frame: what changed, read back for main (its pushes); main's writes of what it applied.
          planMs: { median: round(median(after.plan.slice(before.plan.length))), worst: round(max(after.plan.slice(before.plan.length))) },
          writeMs: { median: round(median(after.write.slice(before.write.length))), worst: round(max(after.write.slice(before.write.length))) },
          otherStepsMs: slowest(after.steps.slice(before.steps.length)),
        },
      ],
    ] as const) {
      const slices = label === 'while joining' ? joinMerges : merges;
      record({
        group: 'sync',
        name: `Sync: a large merge, ${label}`,
        scenario: s.scenario,
        motion: null,
        locked: main.locked,
        checks: [
          // Main's own work while changes are applied, from the trace: no task past a frame, and room to spare in any 30 ms (rule 1).
          check('main task', main.task, BUDGET.frameMs, { locked: main.locked }),
          check('main busiest 30 ms', main.busiest.ms, BUDGET.frameMs, { locked: main.locked }),
          // chord-data's thread answers the command bar's searches between merged slices: none past a keystroke's budget.
          check('merge slice', max(slices), BUDGET.historyKeystrokeMs, { locked: null }),
        ],
        detail: {
          mainTaskMs: { alone: round(alone.task), during: round(main.task), inside: main.inside },
          mainBusiest30Ms: { alone: alone.busiest, during: main.busiest },
          mainLagMs: { alone: round(alone.lag), during: round(main.lag) },
          ...extra,
        },
      });
    }
  } finally {
    await app.close();
  }
});
/**
 * Keystrokes while joining with a large setup of this computer's own (S15
 * §13): 500 pinned tabs here, each with an icon of its own, and Effects at
 * their largest on 40 sites, join a small synced setup (*Keep both*) while the
 * command bar types. What's here is read into the copy a page at a time, by
 * bytes, and added in slices of about 128 KB; then, typing again, `local` is
 * checked against the rows (the idle reconcile's drift check), a page at a
 * time. The keystroke budgets hold, and none of sync's steps on chord-data's
 * thread passes a keystroke's.
 */
test('sync: keystrokes while joining with 500 pinned tabs and 40 large Effects here', async () => {
  test.setTimeout(400_000);
  cpuBusy = await measureCpuBusy();
  const folder = mkdtempSync(join(tmpdir(), 'chord-perf-sync-join-'));
  const fs = diskFolder(join(folder, 'Chord sync'));
  await fs.mkdir('');
  const OTHER = 'f00df00df00df00e';
  const root = await writeSyncFile(fs, 1, SYNC_PASSPHRASE, OTHER, nodeCrypto, FAST_KDF);
  const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' };
  const setup: DataRecord[] = [
    { type: 'device', id: OTHER, at: [Date.now() - 60_000, 0, OTHER], set: { name: 'Perf laptop', os: 'Linux', app: '0.5.0' } },
    { type: 'chord', id: 'synced', at: [Date.now() - 60_000, 1, OTHER], set: { name: 'Synced', icon: 'S', theme: THEME, rank: 'z0', profile: 'default', created: 1 } },
  ];
  await writeSnapshot(fs, { generation: 1, device: OTHER }, [setup], root, { app: '0.5.0', device: [setup[0]!] }, nodeCrypto);

  const app = await launch({ ...SEEDED, CHORD_PERF_PINNED: '500', CHORD_PERF_EFFECTS: '40' });
  try {
    const overlay = await pageWhere(app, isOverlay);
    const { shell, settings } = await yourData(app);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, folder);
    const pinned = () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: { pinnedNames(s: string): { count: number } } }).chordTestHooks.pinnedNames('').count);
    await expect.poll(pinned, { timeout: 30_000 }).toBe(500);

    await bringToFront(app, shell);
    await setMotion(app, shell, overlay, true);
    environment ??= await readEnvironment(app, shell);
    const { s, typing } = await typingSession(app, shell, overlay);
    await openCommandBar(shell, overlay);
    await typeSlowly(overlay, 'warm up');
    await closeCommandBar(overlay);
    const alone = await typing('before joining with a large setup here');
    const start = await syncHook<SyncTimings>(app, 'syncTimings');
    let joinMs = NaN;
    const joining = await typing('while joining with a large setup here', async () => {
      const t0 = performance.now();
      const state = await settings.evaluate(async (passphrase) => {
        const sync = (
          window as unknown as {
            chord: { sync: { chooseFolder(): Promise<{ ok: boolean; folderId?: string }>; join(id: string, p: string): Promise<{ ok: boolean; view?: { state: string } }>; choose(mode: string): Promise<{ ok: boolean; view?: { state: string } }> } };
          }
        ).chord.sync;
        const folder = await sync.chooseFolder();
        const joined = await sync.join(folder.folderId!, passphrase);
        return joined.view?.state === 'choosing' ? ((await sync.choose('both')).view?.state ?? 'failed') : (joined.view?.state ?? 'failed');
      }, SYNC_PASSPHRASE);
      expect(state).toBe('on');
      joinMs = performance.now() - t0;
    });
    const joined = await syncHook<SyncTimings>(app, 'syncTimings');
    const checking = await typing('while local is checked against the rows', async () => {
      await syncHook(app, 'syncDrift');
    });
    const after = await syncHook<SyncTimings>(app, 'syncTimings');
    // A part's steps: those since the part before (chord-data keeps the last 500; past that, all it keeps).
    const since = (from: SyncTimings, to: SyncTimings) => (to.steps.length < 500 ? to.steps.slice(from.steps.length) : to.steps);
    const joinSteps = since(start, joined);
    const driftSteps = since(joined, after).filter((step) => step.what === 'drift');
    expect(driftSteps.length).toBeGreaterThan(1);
    const worstOf = (what: string) => round(max(joinSteps.filter((step) => step.what === what).map((step) => step.ms)));
    for (const [label, main, steps, extra] of [
      ['while joining', joining, joinSteps, { joinMs: round(joinMs), readPageMs: { worst: worstOf('local') }, addSliceMs: { worst: worstOf('add') }, joinEndMs: worstOf('joined') }],
      ['while local is checked against the rows', checking, driftSteps, { pages: driftSteps.length }],
    ] as const) {
      record({
        group: 'sync',
        name: `Sync: a large setup here, ${label}`,
        scenario: `${s.scenario}, 500 pinned tabs with icons, 40 large Effects`,
        motion: null,
        locked: main.locked,
        checks: [
          check('main task', main.task, BUDGET.frameMs, { locked: main.locked }),
          // chord-data's thread answers the command bar's searches between sync's steps: none past a keystroke's budget.
          check('sync step', max(steps.map((step) => step.ms)), BUDGET.historyKeystrokeMs, { locked: null }),
        ],
        detail: { mainTaskMs: { alone: round(alone.task), during: round(main.task), inside: main.inside }, slowestStepsMs: slowest([...steps]), ...extra },
      });
    }
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
