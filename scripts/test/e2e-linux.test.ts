import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ELECTRON_VOLUME, RESERVED_CPUS, SLOW_CPUS, STALE_MS, STORE_VOLUME, containerName, cpusetCpus, dockerRunArgs, imageTag, parseArgs, pickCpuset, slowDefaults, staleRuns, tarArchive } from '../e2e-linux/run.mjs';

describe('parseArgs', () => {
  it('runs X11 by default and hands everything else to Playwright, in order', () => {
    expect(parseArgs([])).toEqual({ display: 'x11', rebuild: false, help: false, cpus: null, share: null, slow: false, throttle: null, playwright: [] });
    expect(parseArgs(['launch.spec.ts', '-g', 'Peek', '--repeat-each', '3', '--workers=2'])).toEqual({
      display: 'x11',
      rebuild: false,
      help: false,
      cpus: null,
      share: null,
      slow: false,
      throttle: null,
      playwright: ['launch.spec.ts', '-g', 'Peek', '--repeat-each', '3', '--workers=2'],
    });
  });

  it('takes its own options wherever they are', () => {
    expect(parseArgs(['-g', 'Peek', '--wayland', '--rebuild'])).toMatchObject({ display: 'wayland', rebuild: true, playwright: ['-g', 'Peek'] });
    expect(parseArgs(['--wayland', '--x11'])).toMatchObject({ display: 'x11' });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
    expect(parseArgs(['perf.spec.ts', '--cpus', '4', '-g', 'memory'])).toMatchObject({ cpus: 4, playwright: ['perf.spec.ts', '-g', 'memory'] });
    expect(parseArgs(['--cpus=2'])).toMatchObject({ cpus: 2, playwright: [] });
    expect(parseArgs(['--cpus', 'four']).cpus).toBeNaN();
    expect(parseArgs(['--cpus', '0.35']).cpus).toBe(0.35);
    expect(parseArgs(['--cpus=all']).cpus).toBe('all');
    expect(parseArgs(['--slow', '--throttle', '4', '-g', 'game'])).toMatchObject({ slow: true, throttle: 4, playwright: ['-g', 'game'] });
    expect(parseArgs(['--throttle=6']).throttle).toBe(6);
    expect(parseArgs(['--share', 'Z:\\Temp\\x', '-c', 'a.ts'])).toMatchObject({ share: 'Z:\\Temp\\x', playwright: ['-c', 'a.ts'] });
    expect(parseArgs(['--share=/tmp/x'])).toMatchObject({ share: '/tmp/x', playwright: [] });
  });

  it('drops the -- pnpm passes along', () => {
    expect(parseArgs(['--', '-g', 'Peek']).playwright).toEqual(['-g', 'Peek']);
  });

  it('turns Windows separators in a spec path into slashes, and leaves other arguments alone', () => {
    expect(parseArgs(['test\\e2e\\launch.spec.ts:12']).playwright).toEqual(['test/e2e/launch.spec.ts:12']);
    expect(parseArgs(['-g', 'a\\(b\\)', 'x\\y']).playwright).toEqual(['-g', 'a\\(b\\)', 'x\\y']);
  });
});

describe('names', () => {
  it('tags the image by the Dockerfile and the pnpm version', () => {
    const tag = imageTag('FROM ubuntu\n', '10.33.0');
    expect(tag).toMatch(/^chord-e2e-runner:[0-9a-f]{12}$/);
    expect(imageTag('FROM ubuntu\n', '10.33.0')).toBe(tag);
    expect(imageTag('FROM ubuntu:noble\n', '10.33.0')).not.toBe(tag);
    expect(imageTag('FROM ubuntu\n', '10.34.0')).not.toBe(tag);
  });

  it('gives each run a container of its own, named for its worktree', () => {
    const name = containerName('/home/me/Projects/Chord Browser (copy)', 'a1b2c3');
    expect(name).toBe('chord-e2e-run-chord-browser-copy--a1b2c3');
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    expect(containerName('/x/agent-a27a56a2ea384d960')).not.toBe(containerName('/x/agent-a27a56a2ea384d960'));
  });
});

describe('staleRuns', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const never = '0001-01-01T00:00:00Z';
  const line = (name: string, status: string, finished: string, created = ago(3_600_000)) => `/${name}|${status}|${finished}|${created}`;

  it('takes containers stopped long enough ago that no run is copying out of them', () => {
    const inspected = [
      line('chord-e2e-run-a-111111', 'exited', ago(STALE_MS + 1_000)),
      line('chord-e2e-run-b-222222', 'dead', ago(2 * STALE_MS)),
      line('chord-e2e-run-c-333333', 'exited', ago(30_000)),
    ].join('\r\n');
    expect(staleRuns(inspected, now)).toEqual(['chord-e2e-run-a-111111', 'chord-e2e-run-b-222222']);
  });

  it('leaves running ones alone, and goes by creation for one that never started', () => {
    const inspected = [
      line('chord-e2e-run-a-111111', 'running', never),
      line('chord-e2e-run-b-222222', 'running', ago(2 * STALE_MS)),
      line('chord-e2e-run-c-333333', 'created', never, ago(2 * STALE_MS)),
      line('chord-e2e-run-d-444444', 'created', never, ago(1_000)),
    ].join('\n');
    expect(staleRuns(inspected, now)).toEqual(['chord-e2e-run-c-333333']);
    expect(staleRuns('', now)).toEqual([]);
  });
});

describe('dockerRunArgs', () => {
  const base = { name: 'chord-e2e-run-x-1', image: 'chord-e2e-runner:abc', display: 'wayland', root: '/src', startedAt: 1_700_000_000_000, playwright: ['-g', 'a b'] };
  const args = dockerRunArgs(base);
  const after = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

  it('keeps the sandbox possible: an unprivileged user with no capabilities, namespaces allowed', () => {
    expect(after('--user')).toEqual(['chord']);
    expect(after('--cap-drop')).toEqual(['ALL']);
    expect(after('--security-opt')).toEqual(['no-new-privileges', 'seccomp=unconfined']);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--cap-add');
    expect(args.join(' ')).not.toContain('no-sandbox');
  });

  it('turns core dumps off: 1, not 0, which a piped core_pattern (WSL 2’s) ignores', () => {
    expect(after('--ulimit')).toEqual(['core=1:1']);
  });

  it('names everything chord-e2e-* and caches the store and Electron in volumes', () => {
    expect(after('--name')).toEqual(['chord-e2e-run-x-1']);
    expect(after('--volume')).toEqual([`${STORE_VOLUME}:/home/chord/.cache/pnpm-store`, `${ELECTRON_VOLUME}:/home/chord/.cache/electron`]);
    expect([STORE_VOLUME, ELECTRON_VOLUME].every((v) => v.startsWith('chord-e2e-'))).toBe(true);
    expect(after('--env')).toEqual(['CHORD_E2E_DISPLAY=wayland', 'CHORD_E2E_STARTED=1700000000']);
  });

  it('mounts a shared folder at /share only when one is given', () => {
    const shared = dockerRunArgs({ ...base, share: '/mnt/z/Temp/sweep' });
    const of = (flag: string) => shared.flatMap((a, i) => (a === flag ? [shared[i + 1]] : []));
    expect(of('--volume')).toContain('/mnt/z/Temp/sweep:/share');
    expect(of('--env')).toContain('CHORD_E2E_SHARE=/share');
    expect(args.join(' ')).not.toContain('/share');
  });

  it('passes CHORD_NO_MINIFY, CHORD_PERF_ENFORCE and CHORD_E2E_SCREEN in when they’re set, and nothing else from the environment', () => {
    const withEnv = dockerRunArgs({ ...base, env: { CHORD_NO_MINIFY: '1', CHORD_PERF_ENFORCE: '', CHORD_E2E_SCREEN: '3200x2000x24', HOME: '/home/me', CHORD_USER_DATA: '/tmp/x' } });
    const envs = withEnv.flatMap((a, i) => (withEnv[i - 1] === '--env' ? [a] : []));
    expect(envs).toEqual(['CHORD_E2E_DISPLAY=wayland', 'CHORD_E2E_STARTED=1700000000', 'CHORD_NO_MINIFY=1', 'CHORD_E2E_SCREEN=3200x2000x24']);
  });

  it('runs on the CPUs it was given (labeled with them, for the next run to see), with a quota when asked', () => {
    expect(args).not.toContain('--cpuset-cpus');
    const pinned = dockerRunArgs({ ...base, cpuset: '8-11' });
    expect(pinned[pinned.indexOf('--cpuset-cpus') + 1]).toBe('8-11');
    expect(pinned).toContain('chord-e2e.cpus=8-11');
    expect(pinned).not.toContain('--cpus');
    expect(pinned.indexOf('--cpuset-cpus')).toBeLessThan(pinned.indexOf('chord-e2e-runner:abc'));
    const slow = dockerRunArgs({ ...base, cpuset: '5', quota: 0.35 });
    expect(slow[slow.indexOf('--cpus') + 1]).toBe('0.35');
  });

  it('passes CHORD_E2E_CPU_THROTTLE in, for --throttle', () => {
    const throttled = dockerRunArgs({ ...base, env: { CHORD_E2E_CPU_THROTTLE: '4' } });
    expect(throttled).toContain('CHORD_E2E_CPU_THROTTLE=4');
  });

  it('ends with the image, the container script and Playwright’s arguments, untouched', () => {
    const at = args.indexOf('chord-e2e-runner:abc');
    expect(args.slice(at + 1, at + 3)).toEqual(['bash', '-c']);
    expect(args.slice(-3)).toEqual(['bash', '-g', 'a b']);
  });
});

/** Reads a tar archive back: every header's checksum checked, pax paths applied. */
function readTar(tar: Buffer) {
  const entries: { path: string; type: string; mode: number; uid: number; body: Buffer; link: string }[] = [];
  let paxPath: string | null = null;
  let at = 0;
  while (tar.subarray(at, at + 512).some((b) => b !== 0)) {
    const field = (offset: number, length: number) => tar.toString('utf8', at + offset, at + offset + length).replace(/\0.*$/s, '');
    const number = (offset: number, length: number) => Number.parseInt(field(offset, length), 8);
    const sum = tar.subarray(at, at + 512).reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    expect(number(148, 8)).toBe(sum);
    expect(field(257, 6)).toBe('ustar');
    const [type, size, prefix, name] = [field(156, 1), number(124, 12), field(345, 155), field(0, 100)];
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'x') paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))![1]!;
    else {
      entries.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), type, mode: number(100, 8), uid: number(108, 8), body, link: field(157, 100) });
      paxPath = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  // Two zero blocks end it, and nothing follows.
  expect(tar.length).toBe(at + 1024);
  return entries;
}

describe('tarArchive', () => {
  // Over 100 bytes, so split into a prefix and a name; and one whose name alone is over 100, so pax.
  const long = `${'a'.repeat(110)}/${'b'.repeat(20)}/file.txt`;
  const longer = `dir/${'d'.repeat(120)}.txt`;
  const files = [
    { path: 'package.json', body: Buffer.from('{}\n'), mtime: 1_700_000_000 },
    { path: 'scripts/run.sh', body: Buffer.from('#!/bin/sh\necho hi\n'), mode: 0o755 },
    { path: 'empty.txt', body: Buffer.alloc(0) },
    { path: 'apps/desktop/ünïcødé ’.md', body: Buffer.from('x'.repeat(513)) },
    { path: long, body: Buffer.from('prefix and name\n') },
    { path: longer, body: Buffer.from('pax\n') },
  ];

  it('writes ustar entries owned by uid 1000, with their modes, splitting or pax-ing long paths', () => {
    const entries = readTar(tarArchive([...files, { path: 'link', link: 'package.json' }]));
    expect(entries.map((e) => e.path)).toEqual([...files.map((f) => f.path), 'link']);
    for (const [i, file] of files.entries()) {
      expect(entries[i]!.body.equals(file.body)).toBe(true);
      expect(entries[i]!.mode).toBe(file.mode ?? 0o644);
      expect(entries[i]!.uid).toBe(1000);
    }
    expect(entries.at(-1)).toMatchObject({ type: '2', link: 'package.json' });
  });

  const tar = spawnSync('tar', ['--version']).status === 0;
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!tar)('unpacks with the system tar', () => {
    dir = mkdtempSync(join(tmpdir(), 'chord-tar-'));
    const out = join(dir, 'out');
    mkdirSync(out);
    // From stdin, into the working directory: GNU tar on Windows takes "C:" in a path for a remote host.
    const result = spawnSync('tar', ['-xf', '-'], { input: tarArchive(files), cwd: out, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    for (const file of files) expect(readFileSync(join(out, file.path)).equals(file.body)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(out, 'scripts/run.sh')).mode & 0o777).toBe(0o755);
  });
});

describe('CPU slots', () => {
  it('reads a cpuset', () => {
    expect([...cpusetCpus('4-7,10')]).toEqual([4, 5, 6, 7, 10]);
    expect([...cpusetCpus('')]).toEqual([]);
    expect([...cpusetCpus('3')]).toEqual([3]);
  });

  // 24 CPUs, 0-3 left for you: five slots of 4 (4-7, 8-11, 12-15, 16-19, 20-23).
  const first = () => 0;
  it.each([
    [{ total: 24, size: 4, taken: [] }, { cpuset: '4-7', shared: false }],
    [{ total: 24, size: 4, taken: ['4-7'] }, { cpuset: '8-11', shared: false }],
    [{ total: 24, size: 4, taken: ['4-7', '8-11', '', '12-15'] }, { cpuset: '16-19', shared: false }],
    // One CPU, for --slow's quota: the first that's free.
    [{ total: 24, size: 1, taken: ['4-7'] }, { cpuset: '8', shared: false }],
    // Bigger than what's left: all but yours.
    [{ total: 24, size: 32, taken: [] }, { cpuset: '4-23', shared: false }],
    // Every slot taken: the least shared, and said so.
    [{ total: 12, size: 4, taken: ['4-7', '8-11', '8-11'] }, { cpuset: '4-7', shared: true }],
    // An old run on every CPU (--cpus all) shares with everything.
    [{ total: 12, size: 4, taken: ['0-11'] }, { cpuset: '4-7', shared: true }],
    // A small machine: never fewer than one CPU, even if it's one of yours.
    [{ total: 2, size: 4, taken: [] }, { cpuset: '1', shared: false }],
  ])('%j', (input, out) => {
    expect(pickCpuset({ ...input, random: first })).toEqual(out);
  });

  it('never gives a run the CPUs left for you, and picks among free slots at random', () => {
    const seen = new Set<string>();
    for (const random of [0, 0.25, 0.5, 0.75, 0.99]) seen.add(pickCpuset({ total: 24, size: 4, taken: ['8-11'], random: () => random }).cpuset);
    expect([...seen].sort()).toEqual(['12-15', '16-19', '20-23', '4-7']);
    for (const cpuset of seen) expect([...cpusetCpus(cpuset)].every((cpu) => cpu >= RESERVED_CPUS)).toBe(true);
  });
});

describe('--slow', () => {
  const parsed = (argv: string[]) => slowDefaults(parseArgs(argv));
  it('a share of one CPU, every try counted, five times over', () => {
    expect(parsed(['--slow', 'agents.spec.ts'])).toMatchObject({ cpus: SLOW_CPUS, playwright: ['agents.spec.ts', '--retries', '0', '--repeat-each', '5'] });
  });
  it('what you said yourself wins', () => {
    expect(parsed(['--slow', '--cpus', '0.5', '--repeat-each', '20', '--retries=1'])).toMatchObject({ cpus: 0.5, playwright: ['--repeat-each', '20', '--retries=1'] });
  });
  it('nothing without it', () => {
    expect(parsed(['agents.spec.ts'])).toMatchObject({ cpus: null, playwright: ['agents.spec.ts'] });
  });
});
