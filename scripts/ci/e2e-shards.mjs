// E2E's shards, balanced by how long each spec file takes (scripts/ci/e2e-shards.json), instead of
// Playwright's --shard, which splits by test count: one shard once took 17 minutes and another 7.
//
// CI sets CHORD_E2E_SHARD to `<index>/<count>` (1-based) and playwright.config.ts runs that shard's files,
// or to `perf`, which runs perf.spec.ts alone (its own CI job). A file keeps all its tests together and in order.
//
// The plan: files in the map go, longest first, to whichever shard has the least time so far; files not in
// the map yet (a new spec) are dealt round-robin after them, so a new file always runs somewhere. Files the
// map sets apart (perf.spec.ts) never go in a shard. Refresh the weights from a CI run:
//   node scripts/ci/e2e-shard-weights.mjs <run-id>
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_FILE = join(dirname(fileURLToPath(import.meta.url)), 'e2e-shards.json');

/** The map: `{ separate: string[], weights: { [file]: seconds } }`. */
export function readMap(file = MAP_FILE) {
  const map = JSON.parse(readFileSync(file, 'utf8'));
  return { separate: map.separate ?? [], weights: map.weights ?? {} };
}

/** Every spec file in the E2E folder, by name. */
export function specFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

/**
 * `count` shards of `files`: each `{ files, seconds }`, where seconds is what the map expects (files it doesn't
 * know count 0). Deterministic: the same files and map always give the same plan, so every shard's job agrees.
 */
export function plan(files, count, map) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`A shard count must be a whole number from 1: ${count}`);
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const run = files.filter((file) => !map.separate.includes(file));
  const known = run.filter((file) => typeof map.weights[file] === 'number');
  const unknown = run.filter((file) => typeof map.weights[file] !== 'number').sort();
  known.sort((a, b) => map.weights[b] - map.weights[a] || (a < b ? -1 : 1));
  for (const file of known) {
    let least = shards[0];
    for (const shard of shards) if (shard.seconds < least.seconds) least = shard;
    least.files.push(file);
    least.seconds += map.weights[file];
  }
  unknown.forEach((file, i) => shards[i % count].files.push(file));
  for (const shard of shards) shard.files.sort();
  return shards;
}

/**
 * The files CHORD_E2E_SHARD picks: `perf` gives the files the map sets apart, `<index>/<count>` that shard's,
 * and anything else is refused (a typo mustn't run nothing and pass).
 */
export function filesFor(value, dir, map = readMap()) {
  const files = specFiles(dir);
  if (value === 'perf') return map.separate.filter((file) => files.includes(file));
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`CHORD_E2E_SHARD must be <index>/<count> or perf: ${value}`);
  const [index, count] = [Number(match[1]), Number(match[2])];
  if (index < 1 || index > count) throw new Error(`CHORD_E2E_SHARD ${value}: no such shard`);
  return plan(files, count, map)[index - 1].files;
}

// `node scripts/ci/e2e-shards.mjs <count>`: the plan, for a look before changing the shard counts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = Number(process.argv[2] ?? 6);
  const dir = join(dirname(MAP_FILE), '..', '..', 'apps', 'desktop', 'test', 'e2e');
  const map = readMap();
  plan(specFiles(dir), count, map).forEach((shard, i) => {
    console.log(`${i + 1}/${count}: ${Math.round(shard.seconds)} s expected, ${shard.files.length} files: ${shard.files.join(' ')}`);
  });
  console.log(`Run apart: ${map.separate.join(' ') || 'none'}`);
}
