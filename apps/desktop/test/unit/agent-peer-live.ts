/**
 * A real lookup of who's calling (S18 M2a, agents/peer.ts) on the OS the test runs on, against clients in processes of
 * their own: Windows through window-owner.exe's pipe-clients, Linux through ss, macOS through lsof. agent-peer.test.ts
 * checks its answers; agent-peer.perf.test.ts holds its times. Every CI OS runs both.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { endpointPath } from '../../src/main/agents/endpoint';
import { peerDeps, peerOf } from '../../src/main/agents/peer';

const helper = resolve(import.meta.dirname, '../../out/window-owner/window-owner.exe');
const hasSs = process.platform === 'linux' && spawnSync('ss', ['-V']).status === 0;
export const canLookUp = process.platform === 'win32' || hasSs || process.platform === 'darwin';

/** The helper looked at every file and each answered: otherwise a client may be missing, and unknown is a right answer. */
export const completeList = (timings: Record<string, number> | undefined) => !timings || (timings['stuck'] === 0 && timings['truncated'] === 0 && timings['skipped'] === 0);

/** What's undone after the test, last first. */
type Cleanup = (() => unknown)[];

/** A server like Chord's endpoint, and the server's ends of its connections, in order. */
async function endpoint(cleanup: Cleanup): Promise<{ path: string; ends: Socket[]; server: Server }> {
  const dir = mkdtempSync(join(tmpdir(), 'chord-peer-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = process.platform === 'win32' ? endpointPath('win32', process.env) : join(dir, 's');
  const ends: Socket[] = [];
  const server = createServer((socket) => void ends.push(socket));
  await new Promise<void>((done) => server.listen(path, done));
  cleanup.push(() => new Promise((done) => server.close(done)));
  cleanup.push(() => ends.forEach((s) => s.destroy()));
  return { path, ends, server };
}

/** A client in a process of its own, connected and staying so. */
function client(path: string, cleanup: Cleanup): ChildProcess {
  const child = spawn(process.execPath, ['-e', `require('net').connect(${JSON.stringify(path)}).on('error',()=>{});setTimeout(()=>{},30000)`], { stdio: 'ignore', windowsHide: true });
  cleanup.push(() => child.kill());
  return child;
}

/**
 * Two clients on an endpoint, and the lookups the card waits on, timed (ms, wall clock): on Windows the helper's first
 * start first (`cold`, as restrict-pipe pays it at the first connection, M1b), then the first client's lookup
 * (`lookup`), then the second's with the first's claim held (`warm`).
 */
export async function lookUp(cleanup: Cleanup) {
  if (process.platform === 'win32') {
    if (!existsSync(helper)) spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/build-window-owner.mjs')], { stdio: 'inherit' });
    expect(existsSync(helper)).toBe(true);
  }
  const { path, ends } = await endpoint(cleanup);
  const a = client(path, cleanup);
  await expect.poll(() => ends.length, { timeout: 10_000 }).toBe(1);
  const b = client(path, cleanup);
  await expect.poll(() => ends.length, { timeout: 10_000 }).toBe(2);
  const deps = peerDeps(process.platform === 'win32' ? helper : null);
  let cold = 0;
  if (process.platform === 'win32') {
    const coldStart = performance.now();
    await deps.run(helper, ['pipe-dacl', path]);
    cold = performance.now() - coldStart;
  }
  const started = performance.now();
  const first = await peerOf(ends[0]!, path, a.pid!, new Set(), deps);
  const lookup = performance.now() - started;
  const warmStart = performance.now();
  const second = await peerOf(ends[1]!, path, b.pid!, new Set([a.pid!]), deps);
  const warm = performance.now() - warmStart;
  return { path, ends, a, b, deps, first, second, cold, lookup, warm };
}
