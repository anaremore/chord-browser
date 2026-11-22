/**
 * Who's calling (S18 M2a, agents/peer.ts): the process at the other end of an agent's connection, as the OS says.
 * The parsers and the choice as tables; then a real lookup on the OS the test runs on (every CI OS runs this file):
 * Windows through window-owner.exe's pipe-clients, Linux through ss, macOS through lsof, against clients in
 * processes of their own.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endpointPath } from '../../src/main/agents/endpoint';
import { choosePeer, linuxPeer, macPeer, parseLsof, parsePipeClients, parseSs, peerDeps, peerOf, type PeerDeps } from '../../src/main/agents/peer';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('Windows: which of the pipe’s clients is this connection’s', () => {
  it('reads pipe-clients’ output', () => {
    expect(parsePipeClients('12 34 12\r\n')).toEqual([12, 34]);
    expect(parsePipeClients('\r\n')).toEqual([]);
    expect(parsePipeClients('12 x -3 0 7.5')).toEqual([12]);
  });

  // [clients, the hello's bridge PID, other connections' peers, the peer]
  const cases: [number[], number, number[], number | null][] = [
    [[10], 10, [], 10],
    [[10, 20], 20, [], 20],
    // A claim that isn't a client: the one free client, if there's exactly one.
    [[10], 99, [], 10],
    [[10, 20], 99, [], null],
    [[10, 20], 99, [10], 20],
    // A claim another connection holds is never this one's: a peer can't borrow another's identity.
    [[10, 20], 10, [10], 20],
    [[10], 10, [10], null],
    [[], 10, [], null],
  ];
  it.each(cases)('clients %j, claimed %i, held %j: %s', (clients, claimed, held, peer) => expect(choosePeer(clients, claimed, new Set(held))).toBe(peer));
});

describe('Linux: ss’s Unix sockets', () => {
  const ss = [
    'u_str ESTAB 0      0      /run/user/1000/chord-agent-0123456789abcdef/s 5001 * 5002 users:(("chord",pid=300,fd=40))',
    'u_str ESTAB 0      0      * 5002 * 5001 users:(("chord",pid=400,fd=19))',
    'u_str ESTAB 0      0      /tmp/with a space/s 6001 * 6002 users:(("x",pid=500,fd=3),("x",pid=501,fd=3))',
    'u_str ESTAB 0      0      * 6002 * 6001',
    'u_str LISTEN 0 4096 /run/user/1000/chord-agent-0123456789abcdef/s 5000 * 0 users:(("chord",pid=300,fd=39))',
    'garbage',
  ].join('\n');

  it('parses each row: its inode, its peer’s and who holds it', () => {
    expect(parseSs(ss)).toEqual([
      { inode: 5001, peer: 5002, pids: [300] },
      { inode: 5002, peer: 5001, pids: [400] },
      { inode: 6001, peer: 6002, pids: [500, 501] },
      { inode: 6002, peer: 6001, pids: [] },
      { inode: 5000, peer: 0, pids: [300] },
    ]);
  });

  // [Chord's socket's inode, the peer]
  const cases: [number, number | null][] = [
    [5001, 400],
    // Its peer is held by nobody we can see, or by two processes: unknown.
    [6001, null],
    [6002, null],
    // Not connected, or not there.
    [5000, null],
    [7000, null],
  ];
  it.each(cases)('inode %i: %s', (inode, peer) => expect(linuxPeer(parseSs(ss), inode)).toBe(peer));
});

describe('macOS: lsof’s Unix sockets', () => {
  const lsof = ['p300', 'f40', 'd0xAAA1', 'n/var/folders/x/chord-agent-0123456789abcdef/s', 'f41', 'd0xaaa2', 'n->0xbbb2', 'p400', 'f19', 'd0xbbb1', 'n->0xaaa1', 'p500', 'fcwd', 'n/', 'f3', 'd0xccc1', 'n->0xaaa2'].join('\n');

  it('parses each socket: its fd, address and peer', () => {
    expect(parseLsof(lsof)).toEqual([
      { pid: 300, fd: 40, address: '0xaaa1', peer: null },
      { pid: 300, fd: 41, address: '0xaaa2', peer: '0xbbb2' },
      { pid: 400, fd: 19, address: '0xbbb1', peer: '0xaaa1' },
      { pid: 500, fd: 3, address: '0xccc1', peer: '0xaaa2' },
    ]);
  });

  // [Chord's fd, the peer]: whoever's socket points at Chord's.
  const cases: [number, number | null][] = [
    [40, 400],
    [41, 500],
    [99, null],
  ];
  it.each(cases)('fd %i: %s', (fd, peer) => expect(macPeer(parseLsof(lsof), 300, fd)).toBe(peer));
});

describe('The lookup, when the OS can’t say', () => {
  const socket = { _handle: { fd: 7 } } as unknown as Socket;
  const deps = (over: Partial<PeerDeps>): PeerDeps => ({ platform: 'linux', self: 1, helper: null, run: async () => '', readlink: () => 'socket:[1]', ...over });

  it('is null, never a guess', async () => {
    expect(await peerOf(socket, '', 5, new Set(), deps({ platform: 'win32', helper: null }))).toBeNull();
    expect(await peerOf(socket, '', 5, new Set(), deps({ run: () => Promise.reject(new Error('spawn ss ENOENT')) }))).toBeNull();
    expect(await peerOf(socket, '', 5, new Set(), deps({ readlink: () => '/dev/null' }))).toBeNull();
    expect(await peerOf({ _handle: { fd: -1 } } as unknown as Socket, '', 5, new Set(), deps({}))).toBeNull();
    expect(await peerOf(socket, '', 5, new Set(), deps({ platform: 'freebsd' }))).toBeNull();
  });
});

/* ---------- A real lookup on this OS ---------- */

const helper = resolve(import.meta.dirname, '../../out/window-owner/window-owner.exe');
const hasSs = process.platform === 'linux' && spawnSync('ss', ['-V']).status === 0;
const canLookUp = process.platform === 'win32' || hasSs || process.platform === 'darwin';

/** A server like Chord's endpoint, and the server's ends of its connections, in order. */
async function endpoint(): Promise<{ path: string; ends: Socket[]; server: Server }> {
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
function client(path: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', `require('net').connect(${JSON.stringify(path)}).on('error',()=>{});setTimeout(()=>{},30000)`], { stdio: 'ignore', windowsHide: true });
  cleanup.push(() => child.kill());
  return child;
}

describe.runIf(canLookUp)(`A real lookup (${process.platform})`, () => {
  it('names each connection’s own client process', async () => {
    if (process.platform === 'win32') {
      if (!existsSync(helper)) spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/build-window-owner.mjs')], { stdio: 'inherit' });
      expect(existsSync(helper)).toBe(true);
    }
    const { path, ends } = await endpoint();
    const a = client(path);
    await expect.poll(() => ends.length, { timeout: 10_000 }).toBe(1);
    const b = client(path);
    await expect.poll(() => ends.length, { timeout: 10_000 }).toBe(2);
    const deps = peerDeps(process.platform === 'win32' ? helper : null);
    const started = performance.now();
    const first = await peerOf(ends[0]!, path, a.pid!, new Set(), deps);
    const ms = performance.now() - started;
    expect(first).toBe(a.pid);
    // Windows can't tell which instance is whose: the claim decides, and another's claim is refused.
    expect(await peerOf(ends[1]!, path, b.pid!, new Set([a.pid!]), deps)).toBe(b.pid);
    if (process.platform === 'win32') {
      expect(await peerOf(ends[1]!, path, a.pid!, new Set([a.pid!]), deps)).toBe(b.pid);
      expect(await peerOf(ends[1]!, path, 4, new Set(), deps)).toBeNull();
    } else {
      // Linux and macOS know: the claim doesn't matter.
      expect(await peerOf(ends[1]!, path, a.pid!, new Set(), deps)).toBe(b.pid);
    }
    // Off any call's path (it runs while the card shows), but kept small: the plan's budget.
    console.log(`[perf] peer lookup (${process.platform}): ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(process.platform === 'win32' ? 1500 : 1000);
  }, 30_000);
});
