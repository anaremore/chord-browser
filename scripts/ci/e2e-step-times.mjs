// Where E2E's time goes, by platform: each shard's step times (apps/desktop/test/e2e/step-times-reporter.ts: launching
// the app, finding its windows, clicks, waits, closing it, hooks, fixtures), summed across a CI run's shards, from the
// e2e-report-* artifacts each shard uploads (ci.yml, `Upload the E2E report`).
//
//   node scripts/ci/e2e-step-times.mjs <run-id> [platform …]      (needs gh, signed in)
//
// Platforms are the artifacts' names without the shard, e.g. macos-26 and ubuntu-24.04-x11. Prints each platform's
// total and its costliest kinds of step; with two or more, the kinds whose time differs most from the first's.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The platform an artifact (e2e-report-<os>[-display]-<shard>of<shards>) came from. */
export const platformOf = (artifact) => artifact.replace(/^e2e-report-/, '').replace(/-[^-]+of\d+$/, '');

/** Adds one shard's step-times.json into a platform's totals. */
export function add(into, shard) {
  into.tests += shard.tests;
  into.seconds += shard.seconds;
  for (const [kind, { seconds, count }] of Object.entries(shard.steps)) {
    const entry = (into.steps[kind] ??= { seconds: 0, count: 0 });
    entry.seconds += seconds;
    entry.count += count;
  }
  return into;
}

/** Kinds of step by how much more time they took on `other` than on `base`, most first. */
export function differences(base, other) {
  const kinds = new Set([...Object.keys(base.steps), ...Object.keys(other.steps)]);
  return [...kinds]
    .map((kind) => {
      const a = base.steps[kind] ?? { seconds: 0, count: 0 };
      const b = other.steps[kind] ?? { seconds: 0, count: 0 };
      return { kind, extra: b.seconds - a.seconds, base: a, other: b };
    })
    .sort((x, y) => y.extra - x.extra);
}

const each = (e) => (e.count ? `${(e.seconds / e.count).toFixed(2)} s each` : '');

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [run, ...only] = process.argv.slice(2);
  if (!/^\d+$/.test(run ?? '')) {
    console.error('Usage: node scripts/ci/e2e-step-times.mjs <run-id> [platform …]');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'chord-e2e-steps-'));
  try {
    if (spawnSync('gh', ['run', 'download', run, '--pattern', 'e2e-report-*', '--dir', dir], { stdio: 'inherit' }).status !== 0) {
      console.error(`Couldn't download run ${run}'s e2e-report-* artifacts`);
      process.exit(1);
    }
    const byPlatform = {};
    for (const artifact of readdirSync(dir).sort()) {
      const platform = platformOf(artifact);
      const file = join(dir, artifact, 'step-times.json');
      if ((only.length && !only.includes(platform)) || !existsSync(file)) continue;
      add((byPlatform[platform] ??= { tests: 0, seconds: 0, steps: {} }), JSON.parse(readFileSync(file, 'utf8')));
    }
    const platforms = Object.keys(byPlatform);
    for (const p of platforms) {
      const { tests, seconds, steps } = byPlatform[p];
      console.log(`\n${p}: ${tests} test runs, ${Math.round(seconds)} s (${(seconds / tests).toFixed(1)} s each)`);
      for (const [kind, e] of Object.entries(steps).sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 12)) {
        console.log(`  ${e.seconds.toFixed(0).padStart(6)} s  ×${String(e.count).padEnd(5)} ${each(e).padEnd(14)} ${kind}`);
      }
    }
    for (const p of platforms.slice(1)) {
      const base = platforms[0];
      console.log(`\n${p} against ${base}: ${Math.round(byPlatform[p].seconds - byPlatform[base].seconds)} s more in all; where:`);
      for (const d of differences(byPlatform[base], byPlatform[p]).slice(0, 12)) {
        console.log(`  ${(d.extra >= 0 ? '+' : '') + d.extra.toFixed(0).padStart(5)} s  ${each(d.base).padEnd(14)} → ${each(d.other).padEnd(14)} ${d.kind}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
