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
  it('reads pipe-clients’ answer: the clients, each one’s chain, and the helper’s timings', () => {
    const claude = { pid: 12, name: 'chord.exe', path: 'C:\\Chord\\chord.exe', cwd: null, ppid: 7 };
    const parent = { pid: 7, name: 'claude.exe', path: null, cwd: null, ppid: 3 };
    const answer = parsePipeClients(
      JSON.stringify({ clients: [12, 34, 12, 0, -3, 'x', 7.5], chains: { 12: [claude, parent, { pid: 'no' }, parent], 34: [parent] }, files: 24, stuck: 1, handles: 9, ms: { table: 31, total: 57, bad: 'x' } }) + '\r\n',
    );
    expect(answer!.clients).toEqual([12, 34]);
    // A chain stops at an entry that isn't one; one that doesn't start with its client isn't used.
    expect(answer!.chains.get(12)).toEqual([claude, parent]);
    expect(answer!.chains.has(34)).toBe(false);
    expect(answer!.timings).toEqual({ files: 24, stuck: 1, handles: 9, table: 31, total: 57 });
    for (const bad of ['', '12 34', '{}', '{"clients":5}', 'null']) expect(parsePipeClients(bad), bad).toBeNull();
    expect(parsePipeClients('{"clients":[]}')).toEqual({ clients: [], chains: new Map(), timings: {} });
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
    // A PID another live connection claimed first comes as no claim (-1; AgentService.claims), held by that one:
    // an idle relay's identity can't be borrowed before it's looked up.
    [[10, 20], -1, [10], 20],
    [[10, 20, 30], -1, [10], null],
    [[10], -1, [10], null],
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
    // A peer's address with spaces (and numbers) in it, on both ends.
    'u_str ESTAB 0 0 /tmp/a 1 b/s 8001 /tmp/c 2 d/s 8002 users:(("chord",pid=300,fd=41))',
    'u_str ESTAB 0 0 /tmp/c 2 d/s 8002 /tmp/a 1 b/s 8001 users:(("srv",pid=700,fd=5))   ',
    'garbage',
    'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port 9',
  ].join('\n');

  it('parses each row: its peer’s inode and who holds it, whatever spaces the addresses hold', () => {
    expect(parseSs(ss)).toEqual([
      { peer: 5002, pids: [300] },
      { peer: 5001, pids: [400] },
      { peer: 6002, pids: [500, 501] },
      { peer: 6001, pids: [] },
      { peer: 0, pids: [300] },
      { peer: 8002, pids: [300] },
      { peer: 8001, pids: [700] },
    ]);
  });

  // [Chord's socket's inode, the peer]: whoever holds the socket whose peer is Chord's.
  const cases: [number, number | null][] = [
    [5001, 400],
    [8001, 700],
    // Its peer is held by nobody we can see, or by two processes: unknown.
    [6001, null],
    [6002, null],
    // Not connected, or not there.
    [5000, null],
    [7000, null],
    [0, null],
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
    expect(await peerOf(socket, '', 5, new Set(), deps({ platform: 'win32', helper: null }))).toEqual({ pid: null });
    expect(await peerOf(socket, '', 5, new Set(), deps({ platform: 'win32', helper: 'x.exe', run: async () => '12 34' }))).toEqual({ pid: null });
    expect(await peerOf(socket, '', 5, new Set(), deps({ run: () => Promise.reject(new Error('spawn ss ENOENT')) }))).toEqual({ pid: null });
    expect(await peerOf(socket, '', 5, new Set(), deps({ readlink: () => '/dev/null' }))).toEqual({ pid: null });
    expect(await peerOf({ _handle: { fd: -1 } } as unknown as Socket, '', 5, new Set(), deps({}))).toEqual({ pid: null });
    expect(await peerOf(socket, '', 5, new Set(), deps({ platform: 'freebsd' }))).toEqual({ pid: null });
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

/**
 * The lookup's budget per OS (ms, wall clock), as the card waits on it. On Windows that's the helper started warm: the
 * first connection runs window-owner.exe's restrict-pipe (M1b), and every connection's code waits for it before the
 * card, so the helper's first start (.NET loading) is paid there, not by the lookup. The test does the same: a
 * `pipe-dacl` run first (its cold start, budgeted apart as `PEER_COLD_MS`), then the lookups.
 *
 * Measured (2026-11-22): Windows x64 here (11 Pro, about 396,000 handles in the system) 104 to 163 ms a lookup, the
 * helper's own work 57 to 85 ms of it (the table 31 to 50, its scan 2 to 3, the queries 3 to 4, the chain 21 to 28).
 * CI's Windows arm64: a lookup 582 ms warm, the helper's own work 456 ms; its first start about 3 s cold (the first
 * .NET program on a fresh runner). Before the scan read the table in place (each entry marshalled, twice), a lookup
 * took 3.6 s there. Linux: one ss (tens of ms in WSL's Ubuntu). macOS: one lsof of this user's sockets.
 */
const PEER_BUDGET_MS: Partial<Record<NodeJS.Platform, number>> = { win32: 1000, linux: 500, darwin: 1500 };
/** Windows: the helper's first start on the machine, cold (what restrict-pipe pays in M1b). A ceiling, not a target. */
const PEER_COLD_MS = 6000;

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
    // Windows: the helper's first start, as Chord's first connection pays it (restrict-pipe), measured apart.
    let cold = 0;
    if (process.platform === 'win32') {
      const coldStart = performance.now();
      await deps.run(helper, ['pipe-dacl', path]);
      cold = performance.now() - coldStart;
    }
    // The lookup, as the card waits on it.
    const started = performance.now();
    const first = await peerOf(ends[0]!, path, a.pid!, new Set(), deps);
    const lookup = performance.now() - started;
    expect(first.pid).toBe(a.pid);
    // Windows can't tell which instance is whose: the claim decides, and another's claim is refused.
    const warmStart = performance.now();
    expect((await peerOf(ends[1]!, path, b.pid!, new Set([a.pid!]), deps)).pid).toBe(b.pid);
    const warm = performance.now() - warmStart;
    if (process.platform === 'win32') {
      // The chain comes with it, from the same process: the client, then who started it (this test).
      expect(first.chain?.map((p) => p.pid).slice(0, 2)).toEqual([a.pid, process.pid]);
      expect(first.chain?.[0]?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect((await peerOf(ends[1]!, path, a.pid!, new Set([a.pid!]), deps)).pid).toBe(b.pid);
      expect((await peerOf(ends[1]!, path, 4, new Set(), deps)).pid).toBeNull();
    } else {
      // Linux and macOS know: the claim doesn't matter.
      expect((await peerOf(ends[1]!, path, a.pid!, new Set(), deps)).pid).toBe(b.pid);
    }
    // Off any call's path (it runs while the card shows), but it delays the card's *Started by*. Budgets per OS, from
    // what was measured (PEER_BUDGET_MS); the message carries what was seen.
    const seen = `${process.platform}/${process.arch}: helper's first start ${cold.toFixed(0)} ms, lookup ${lookup.toFixed(0)} ms, again ${warm.toFixed(0)} ms, helper ${JSON.stringify(first.timings ?? {})}`;
    expect(lookup, seen).toBeLessThan(PEER_BUDGET_MS[process.platform] ?? 1000);
    expect(warm, seen).toBeLessThan(PEER_BUDGET_MS[process.platform] ?? 1000);
    expect(cold, seen).toBeLessThan(PEER_COLD_MS);
  }, 30_000);
});
