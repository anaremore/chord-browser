// Takes new baselines for perf.spec.ts's launch and memory checks
// (test/e2e/perf-baseline.json; docs/testing/performance.md, "Baselines"):
//
//   pnpm --filter @chord/desktop perf:baseline               Linux x64, X11 then Wayland, in the container on 4 CPUs
//   pnpm --filter @chord/desktop perf:baseline --run <id>    every runner, from a CI run's perf-* artifacts
//   pnpm --filter @chord/desktop perf:baseline <perf.json>…  from reports you have (files, or folders holding them)
//
// Each report's numbers replace its runner's; other runners keep theirs. A run
// that failed because a number grew still counts: that's when you'd be here.
// Commit the file with the change that moved the numbers.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withMeasured } from '../test/e2e/baselines.ts';

const appDir = resolve(import.meta.dirname, '..');
const baselineFile = join(appDir, 'test', 'e2e', 'perf-baseline.json');
const lastReport = join(appDir, 'test-results', 'perf.json');
/** perf.spec.ts's tests that measure against a baseline, by title. */
const MEASURED_TESTS = 'launch: |memory: ';

const fail = (message) => {
  console.error(`[perf:baseline] ${message}`);
  process.exit(1);
};

/** perf.json files: the path itself, or every one in a folder (CI's artifacts are a folder per job). */
function reportsIn(path) {
  if (!existsSync(path)) fail(`${path} doesn't exist`);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true })
    .map(String)
    .filter((name) => name === 'perf.json' || name.endsWith('/perf.json') || name.endsWith('\\perf.json'))
    .map((name) => join(path, name));
}

/** What a report measured, if it measured anything with a baseline. */
function measuredIn(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.measured?.runner) return report.measured;
  console.warn(`[perf:baseline] ${path} has no measurements to take (macOS only reports, and so did runs before the baselines); skipped`);
  return null;
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const runs = [];
if (args.length === 0) {
  for (const display of ['x11', 'wayland']) {
    rmSync(lastReport, { force: true });
    // Four CPUs, as CI's runners have: Chord's launch against bare Electron's depends on how many there are.
    spawnSync(process.execPath, [join(appDir, '..', '..', 'scripts', 'e2e-linux', 'run.mjs'), `--${display}`, '--cpus', '4', 'perf.spec.ts', '-g', MEASURED_TESTS], {
      stdio: 'inherit',
    });
    const measured = existsSync(lastReport) && measuredIn(lastReport);
    if (!measured) fail(`The ${display} run wrote no measurements (see its output above)`);
    runs.push({ measured, from: 'Linux container, 4 CPUs' });
  }
} else if (args[0] === '--run') {
  const id = args[1];
  if (!/^\d+$/.test(id ?? '')) fail('--run takes a CI run ID (gh run list --workflow ci.yml)');
  const dir = mkdtempSync(join(tmpdir(), 'chord-perf-baseline-'));
  const downloaded = spawnSync('gh', ['run', 'download', id, '--pattern', 'perf-*', '--dir', dir], { stdio: 'inherit' }).status === 0;
  if (downloaded) {
    for (const path of reportsIn(dir)) {
      const measured = measuredIn(path);
      if (measured) runs.push({ measured, from: `CI run ${id}` });
    }
  }
  rmSync(dir, { recursive: true, force: true });
  if (!downloaded) fail(`Couldn't download run ${id}'s perf-* artifacts`);
} else {
  for (const arg of args) {
    for (const path of reportsIn(arg)) {
      const measured = measuredIn(path);
      if (measured) runs.push({ measured, from: `perf.json of ${String(JSON.parse(readFileSync(path, 'utf8')).date).slice(0, 10)}` });
    }
  }
}
if (runs.length === 0) fail('Nothing to take a baseline from');

const before = JSON.parse(readFileSync(baselineFile, 'utf8'));
const date = new Date().toISOString().slice(0, 10);
let after = before;
for (const { measured, from } of runs) after = withMeasured(after, measured, from, date);
writeFileSync(baselineFile, `${JSON.stringify(after, null, 2)}\n`);

// What changed, runner by runner.
for (const { measured } of runs) {
  const old = before[measured.runner] ?? {};
  const lines = [];
  if (measured.launch !== undefined) lines.push(`launch ${old.launch ?? '–'} → ${measured.launch}×`);
  for (const [name, mb] of Object.entries(measured.memoryMb ?? {})) lines.push(`${name} ${old.memoryMb?.[name] ?? '–'} → ${mb} MB`);
  console.log(`[perf:baseline] ${measured.runner}: ${lines.join(', ')}`);
}
console.log(`[perf:baseline] Wrote ${baselineFile}`);
