import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDurations, weightsFrom } from '../ci/e2e-shard-weights.mjs';
import { filesFor, plan, readMap, specFiles } from '../ci/e2e-shards.mjs';

const E2E = join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'test', 'e2e');

describe('plan', () => {
  const map = { separate: ['perf.spec.ts'], weights: { 'a.spec.ts': 100, 'b.spec.ts': 60, 'c.spec.ts': 50, 'd.spec.ts': 40, 'perf.spec.ts': 500 } };

  it('gives the longest files first to the shard with the least time so far', () => {
    const shards = plan(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts'], 2, map);
    expect(shards).toEqual([
      { files: ['a.spec.ts', 'd.spec.ts'], seconds: 140 },
      { files: ['b.spec.ts', 'c.spec.ts'], seconds: 110 },
    ]);
  });

  it('deals files the map doesn’t know round-robin, and leaves out the ones it sets apart', () => {
    const shards = plan(['a.spec.ts', 'new-1.spec.ts', 'new-2.spec.ts', 'new-3.spec.ts', 'perf.spec.ts'], 2, map);
    expect(shards.map((shard) => shard.files)).toEqual([
      ['a.spec.ts', 'new-1.spec.ts', 'new-3.spec.ts'],
      ['new-2.spec.ts'],
    ]);
  });

  it('refuses a shard count that isn’t a whole number from 1', () => {
    expect(() => plan([], 0, map)).toThrow();
    expect(() => plan([], 1.5, map)).toThrow();
  });
});

describe('filesFor, on the real spec files and map', () => {
  const files = specFiles(E2E);
  const map = readMap();

  it.each([3, 6])('%i shards run every file but perf.spec.ts exactly once', (count) => {
    const all = Array.from({ length: count }, (_, i) => filesFor(`${i + 1}/${count}`, E2E, map)).flat();
    expect(all.sort()).toEqual(files.filter((file) => file !== 'perf.spec.ts'));
  });

  it('runs perf.spec.ts alone for `perf`', () => {
    expect(filesFor('perf', E2E, map)).toEqual(['perf.spec.ts']);
  });

  it('refuses anything else, so a typo never runs nothing and passes', () => {
    for (const value of ['', '0/6', '7/6', '1-6', 'all']) expect(() => filesFor(value, E2E, map)).toThrow();
  });

  it('knows almost every file: a map that knows few balances nothing (refresh it: scripts/ci/e2e-shard-weights.mjs)', () => {
    const unknown = files.filter((file) => map.weights[file] === undefined);
    expect(unknown.length).toBeLessThanOrEqual(Math.max(3, Math.ceil(files.length / 10)));
  });
});

describe('parseDurations', () => {
  it('adds up each file’s tests from the list reporter, retries too, in s, ms and m', () => {
    const log = [
      '2026-11-24T06:44:24.7253224Z   ✓    1 test/e2e/a11y.spec.ts:98:5 › light › the browser window (22.4s)',
      '2026-11-24T06:44:35.4100826Z   ✓    2 test/e2e/a11y.spec.ts:210:5 › light › the command bar (850ms)',
      '2026-11-24T06:45:00.0000000Z   ✘    3 test\\e2e\\proxies.spec.ts:383:1 › SOCKS5 sends sites’ names (1.5m)',
      '2026-11-24T06:46:00.0000000Z   ✓    4 test\\e2e\\proxies.spec.ts:383:1 › SOCKS5 sends sites’ names (retry #1) (10s)',
      '2026-11-24T05:08:49.1696284Z   -  72 test/e2e/updates.spec.ts:92:1 › a signed update downloads in the background',
      '2026-11-24T06:54:28.6025160Z   101 passed (10.5m)',
    ].join('\n');
    expect(parseDurations(log)).toEqual({ 'a11y.spec.ts': 23.25, 'proxies.spec.ts': 100 });
  });

  it('sums several shards’ logs, to a tenth of a second', () => {
    const one = '  ✓  1 test/e2e/a.spec.ts:1:1 › x (1.04s)';
    const two = '  ✓  1 test/e2e/a.spec.ts:2:1 › y (2.02s)\n  ✓  2 test/e2e/b.spec.ts:1:1 › z (3s)';
    expect(weightsFrom([one, two])).toEqual({ 'a.spec.ts': 3.1, 'b.spec.ts': 3 });
  });
});
