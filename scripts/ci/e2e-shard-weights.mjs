// Refreshes E2E's shard weights (scripts/ci/e2e-shards.json) from a CI run: how long each spec file took on
// Linux x64 X11, every shard of the run and the perf job added up, retries included (they take time too).
//
//   node scripts/ci/e2e-shard-weights.mjs <run-id>      (gh run list --workflow ci.yml --branch main)
//
// Take a run that passed, ideally a full one on main, then commit the new map. Needs gh, signed in.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { MAP_FILE } from './e2e-shards.mjs';

/** The jobs whose logs count: Linux x64 X11's, the platform the fast tier runs. */
export const RUNNER = 'Linux x64 · X11';

/**
 * Seconds per spec file from Playwright's `list` reporter: lines like
 * `  ✓  12 test/e2e/tabs.spec.ts:40:1 › closing a tab (3.4s)`, after the timestamp Actions puts first.
 */
export function parseDurations(log) {
  const seconds = {};
  const line = /(?:^|\s)(?:\S+\s+)?\d+\s+(?:\[[^\]]*\]\s+›\s+)?test[\\/]e2e[\\/]([\w.-]+\.spec\.ts):\d+:\d+ › .*\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
  for (const text of log.split(/\r?\n/)) {
    const match = line.exec(text);
    if (!match) continue;
    const [, file, value, unit] = match;
    const s = Number(value) * (unit === 'ms' ? 0.001 : unit === 'm' ? 60 : 1);
    seconds[file] = (seconds[file] ?? 0) + s;
  }
  return seconds;
}

/** Adds up several logs' durations, rounded to a tenth of a second and sorted by file. */
export function weightsFrom(logs) {
  const total = {};
  for (const log of logs) for (const [file, s] of Object.entries(parseDurations(log))) total[file] = (total[file] ?? 0) + s;
  return Object.fromEntries(
    Object.keys(total)
      .sort()
      .map((file) => [file, Math.round(total[file] * 10) / 10]),
  );
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const run = process.argv[2];
  if (!/^\d+$/.test(run ?? '')) {
    console.error('Usage: node scripts/ci/e2e-shard-weights.mjs <run-id>');
    process.exit(2);
  }
  const jobs = gh(['api', '--paginate', `repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`, '--jq', `.jobs[] | select(.name | contains("${RUNNER}")) | select(.name | startswith("E2E")) | "\\(.id)\\t\\(.name)"`])
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('\t'));
  if (jobs.length === 0) {
    console.error(`Run ${run} has no ${RUNNER} E2E jobs.`);
    process.exit(1);
  }
  const logs = jobs.map(([id, name]) => {
    console.log(`Reading ${name}`);
    return gh(['api', `repos/{owner}/{repo}/actions/jobs/${id}/logs`]);
  });
  const weights = weightsFrom(logs);
  const old = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
  const map = { ...old, run: Number(run), weights };
  writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  console.log(`${Object.keys(weights).length} spec files, ${Math.round(total / 60)} min in all, from run ${run}: ${MAP_FILE}`);
}
