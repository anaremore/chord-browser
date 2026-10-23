import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ELECTRON_VOLUME, STALE_MS, STORE_VOLUME, containerName, dockerRunArgs, imageTag, parseArgs, staleRuns, tarArchive } from '../e2e-linux/run.mjs';

describe('parseArgs', () => {
  it('runs X11 by default and hands everything else to Playwright, in order', () => {
    expect(parseArgs([])).toEqual({ display: 'x11', rebuild: false, help: false, playwright: [] });
    expect(parseArgs(['launch.spec.ts', '-g', 'Peek', '--repeat-each', '3', '--workers=2'])).toEqual({
      display: 'x11',
      rebuild: false,
      help: false,
      playwright: ['launch.spec.ts', '-g', 'Peek', '--repeat-each', '3', '--workers=2'],
    });
  });

  it('takes its own options wherever they are', () => {
    expect(parseArgs(['-g', 'Peek', '--wayland', '--rebuild'])).toMatchObject({ display: 'wayland', rebuild: true, playwright: ['-g', 'Peek'] });
    expect(parseArgs(['--wayland', '--x11'])).toMatchObject({ display: 'x11' });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
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
  const args = dockerRunArgs({ name: 'chord-e2e-run-x-1', image: 'chord-e2e-runner:abc', display: 'wayland', root: '/src', startedAt: 1_700_000_000_000, playwright: ['-g', 'a b'] });
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
