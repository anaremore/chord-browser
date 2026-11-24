/**
 * Who's calling (S18 M2a, agents/peer.ts): the process at the other end of an agent's connection, as the OS says.
 * The parsers and the choice as tables; then a real lookup on the OS the test runs on (every CI OS runs this file; its
 * times are agent-peer.perf.test.ts):
 * Windows through window-owner.exe's pipe-clients, Linux through ss, macOS through lsof, against clients in
 * processes of their own.
 */
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { choosePeer, linuxPeer, macPeer, parseLsof, parsePipeClients, parseSs, peerOf, type PeerDeps } from '../../src/main/agents/peer';
import { canLookUp, completeList, lookUp } from './agent-peer-live';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('Windows: which of the pipe’s clients is this connection’s', () => {
  it('reads pipe-clients’ answer: the clients, each one’s chain, and the helper’s timings', () => {
    const claude = { pid: 12, name: 'chord.exe', path: 'C:\\Chord\\chord.exe', cwd: null, ppid: 7 };
    const parent = { pid: 7, name: 'claude.exe', path: null, cwd: null, ppid: 3 };
    const answer = parsePipeClients(
      JSON.stringify({ clients: [12, 34, 12, 0, -3, 'x', 7.5], chains: { 12: [claude, parent, { pid: 'no' }, parent], 34: [parent] }, files: 24, stuck: 1, truncated: 0, skipped: 0, handles: 9, ms: { table: 31, total: 57, bad: 'x' } }) + '\r\n',
    );
    expect(answer!.clients).toEqual([12, 34]);
    // A query was left behind: a client may be missing.
    expect(answer!.complete).toBe(false);
    expect(parsePipeClients('{"clients":[],"stuck":0,"truncated":0,"skipped":0}')!.complete).toBe(true);
    for (const counts of ['"stuck":0,"truncated":2,"skipped":0', '"stuck":0,"truncated":0,"skipped":1', '"stuck":0,"truncated":0']) expect(parsePipeClients(`{"clients":[],${counts}}`)!.complete, counts).toBe(false);
    // A chain stops at an entry that isn't one; one that doesn't start with its client isn't used.
    expect(answer!.chains.get(12)).toEqual([claude, parent]);
    expect(answer!.chains.has(34)).toBe(false);
    expect(answer!.timings).toEqual({ files: 24, stuck: 1, truncated: 0, skipped: 0, handles: 9, table: 31, total: 57 });
    for (const bad of ['', '12 34', '{}', '{"clients":5}', 'null']) expect(parsePipeClients(bad), bad).toBeNull();
    // Not said to be complete: it isn't.
    expect(parsePipeClients('{"clients":[]}')).toEqual({ clients: [], complete: false, chains: new Map(), timings: {} });
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
  it.each(cases)('clients %j, claimed %i, held %j: %s', (clients, claimed, held, peer) => expect(choosePeer(clients, claimed, new Set(held), true)).toBe(peer));

  // A list that may miss a client (stuck, truncated or skipped): a verified claim still names the peer, the fallback never does.
  // R connected but hasn't said hello; X claims an unused PID and is missing from the list: the list is [R], and X must
  // not get R. [clients, claimed, held, the peer]
  const incomplete: [number[], number, number[], number | null][] = [
    [[10], 10, [], 10],
    [[10, 20], 20, [10], 20],
    [[10], 99, [], null],
    [[10, 20], -1, [10], null],
    [[10, 20], 99, [10], null],
  ];
  it.each(incomplete)('an incomplete list: clients %j, claimed %i, held %j: %s', (clients, claimed, held, peer) => expect(choosePeer(clients, claimed, new Set(held), false)).toBe(peer));
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

describe('Windows: the helper’s answer, wired through peerOf (stood in for, so no live timing decides it)', () => {
  const socket = { _handle: { fd: -1 } } as unknown as Socket;
  const windows = (answer: string): PeerDeps => ({ platform: 'win32', self: 1, helper: 'window-owner.exe', run: async () => answer, readlink: () => '' });
  // [the helper's answer, the claim, held, the peer]: a claim that isn't a client, so only the fallback could name one.
  const rows: [string, number, number[], number | null][] = [
    ['{"clients":[10],"stuck":1,"truncated":0,"skipped":0}', 99, [], null],
    ['{"clients":[10],"stuck":0,"truncated":1,"skipped":0}', 99, [], null],
    ['{"clients":[10],"stuck":0,"truncated":0,"skipped":1}', 99, [], null],
    ['{"clients":[10],"stuck":1,"truncated":0}', 99, [], null],
    ['{"clients":[10],"stuck":0,"truncated":0,"skipped":0}', 99, [], 10],
    ['{"clients":[10,20],"stuck":0,"truncated":0,"skipped":0}', 99, [10], 20],
    // A verified claim names its peer, complete or not.
    ['{"clients":[10,20],"stuck":3,"truncated":0,"skipped":0}', 20, [10], 20],
  ];
  it.each(rows)('%s, claiming %i, held %j: %s', async (answer, claimed, held, peer) => expect((await peerOf(socket, '', claimed, new Set(held), windows(answer))).pid).toBe(peer));
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

/* ---------- A real lookup on this OS (its budgets: agent-peer.perf.test.ts) ---------- */

describe.runIf(canLookUp)(`A real lookup (${process.platform})`, () => {
  it('names each connection’s own client process', async () => {
    const { a, b, ends, path, deps, first, second } = await lookUp(cleanup);
    // Never the wrong process. With a list that may miss a client (a stuck query on CI's Windows arm64, issue #107), an
    // answer of nobody is right too; with a complete one, it must be the client.
    const oneOf = (got: number | null, right: number, timings: Record<string, number> | undefined) =>
      expect(completeList(timings) ? [right] : [right, null], JSON.stringify(timings)).toContain(got);
    oneOf(first.pid, a.pid!, first.timings);
    // Windows can't tell which instance is whose: the claim decides, and another's claim is refused.
    oneOf(second.pid, b.pid!, second.timings);
    if (process.platform === 'win32' && first.pid !== null) {
      // The chain comes with it, from the same process: the client, then who started it (this test).
      expect(first.chain?.map((p) => p.pid).slice(0, 2)).toEqual([a.pid, process.pid]);
      expect(first.chain?.[0]?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
    }
    if (process.platform === 'win32') {
      // The only free client, by a claim that's taken: given only when the helper looked at every file and each answered.
      const fallback = await peerOf(ends[1]!, path, a.pid!, new Set([a.pid!]), deps);
      expect(fallback.pid, JSON.stringify(fallback.timings)).toBe(completeList(fallback.timings) ? b.pid : null);
      expect((await peerOf(ends[1]!, path, 4, new Set(), deps)).pid).toBeNull();
    } else {
      // Linux and macOS know: the claim doesn't matter.
      expect((await peerOf(ends[1]!, path, a.pid!, new Set(), deps)).pid).toBe(b.pid);
    }
  }, 60_000);
});

/* ---------- A real lookup on this OS (its times: agent-peer.perf.test.ts) ---------- */

describe.runIf(canLookUp)(`A real lookup (${process.platform})`, () => {
  it('names each connection’s own client process', async () => {
    const { a, b, ends, path, deps, first, second } = await lookUp(cleanup);
    // Never the wrong process. With a list that may miss a client (a stuck query on CI's Windows arm64, issue #107), an
    // answer of nobody is right too; with a complete one, it must be the client.
    const oneOf = (got: number | null, right: number, timings: Record<string, number> | undefined) =>
      expect(completeList(timings) ? [right] : [right, null], JSON.stringify(timings)).toContain(got);
    oneOf(first.pid, a.pid!, first.timings);
    // Windows can't tell which instance is whose: the claim decides, and another's claim is refused.
    oneOf(second.pid, b.pid!, second.timings);
    if (process.platform === 'win32' && first.pid !== null) {
      // The chain comes with it, from the same process: the client, then who started it (this test).
      expect(first.chain?.map((p) => p.pid).slice(0, 2)).toEqual([a.pid, process.pid]);
      expect(first.chain?.[0]?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
    }
    if (process.platform === 'win32') {
      // The only free client, by a claim that's taken: given only when the helper looked at every file and each answered.
      const fallback = await peerOf(ends[1]!, path, a.pid!, new Set([a.pid!]), deps);
      expect(fallback.pid, JSON.stringify(fallback.timings)).toBe(completeList(fallback.timings) ? b.pid : null);
      expect((await peerOf(ends[1]!, path, 4, new Set(), deps)).pid).toBeNull();
    } else {
      // Linux and macOS know: the claim doesn't matter.
      expect((await peerOf(ends[1]!, path, a.pid!, new Set(), deps)).pid).toBe(b.pid);
    }
  }, 60_000);
});
