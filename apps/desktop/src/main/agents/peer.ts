/**
 * Who's calling (S18 M2a; docs/decisions/S18-agent-mcp.md, "M2: settled so far"): the process at the other end of
 * an agent's connection, as the OS says, instead of the hello's word for it. The card's *Started by* and Always
 * allow's program are then looked up from there (parent.ts), never from the hello's `parentPid`.
 *
 * Node has no getsockopt and never gives a pipe's handle on Windows, so each OS is asked from outside, while the
 * connect card shows (never inside a call):
 *
 * - **Windows:** window-owner.exe's `pipe-clients` lists the PIDs of the clients connected to Chord's agent pipe.
 *   It can't say which connection is whose, so a connection's peer is the bridge PID its hello claims when that
 *   PID is among them and no other live connection holds it; else the one client no other connection holds; else
 *   unknown.
 * - **Linux:** `ss -xpn` (iproute2) gives each Unix socket's peer; Chord's end is its socket's inode
 *   (`/proc/self/fd/<fd>`). Without `ss` (a minimal system, or inside the Flatpak, which can't see the host's
 *   processes anyway), unknown.
 * - **macOS:** `lsof -U` gives each Unix socket's address and the address of its peer (`->0x…`).
 *
 * Unknown means the card names no program and Always allow isn't offered, as when M1's lookup found nothing.
 */
import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import type { Socket } from 'node:net';

/** What a lookup needs from the OS, so the units can stand in for it. */
export interface PeerDeps {
  platform: NodeJS.Platform;
  /** Chord's own PID: the pipe's server, and lsof's process. */
  self: number;
  /** window-owner.exe (Windows); null where there's none. */
  helper: string | null;
  run(file: string, args: readonly string[]): Promise<string>;
  readlink(path: string): string;
}

const TIMEOUT_MS = 10_000;

export const peerDeps = (helper: string | null): PeerDeps => ({
  platform: process.platform,
  self: process.pid,
  helper,
  run: (file, args) =>
    new Promise((done, fail) =>
      execFile(file, [...args], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => (error ? fail(error) : done(stdout))),
    ),
  readlink: (path) => readlinkSync(path),
});

/** The file descriptor under a socket (Linux and macOS; -1 on Windows), or null. */
export function socketFd(socket: Socket): number | null {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  return typeof fd === 'number' && fd >= 0 ? fd : null;
}

/* ---------- Windows ---------- */

/** pipe-clients' output: PIDs, space-separated. */
export function parsePipeClients(stdout: string): number[] {
  return [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * Which of the pipe's clients is this connection's: the bridge PID its hello claims, when it's a client and no other
 * live connection holds it; else the only client no other connection holds; else none. `held`: the peers other live
 * connections were given.
 */
export function choosePeer(clients: readonly number[], claimed: number, held: ReadonlySet<number>): number | null {
  const free = clients.filter((pid) => !held.has(pid));
  if (free.includes(claimed)) return claimed;
  return free.length === 1 ? free[0]! : null;
}

/* ---------- Linux ---------- */

/** One Unix socket from `ss -xpnH`: its inode, its peer's, and the PIDs holding it. */
export interface UnixSocketRow {
  inode: number;
  peer: number;
  pids: number[];
}

/**
 * `ss -xpnH`'s lines: `u_str ESTAB 0 0 <local> <inode> <peer address> <peer inode> users:(("name",pid=1,fd=3),…)`.
 * Addresses can hold spaces (a socket's path), so the numbers are read from around them: the inode is the last number
 * before the peer's address, found from the end.
 */
export function parseSs(stdout: string): UnixSocketRow[] {
  const rows: UnixSocketRow[] = [];
  for (const line of stdout.split('\n')) {
    const users = line.indexOf(' users:(');
    const head = (users >= 0 ? line.slice(0, users) : line).trim();
    // …<local> <inode> <peer address> <peer inode>: the peer address is * when unnamed, which is most clients'.
    const match = /\s(\d+)\s+(\S+)\s+(\d+)$/.exec(head);
    if (!match) continue;
    const pids = users >= 0 ? [...line.slice(users).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])) : [];
    rows.push({ inode: Number(match[1]), peer: Number(match[3]), pids: [...new Set(pids)] });
  }
  return rows;
}

/** The PID holding the other end of Chord's socket with this inode, or null (none, or more than one process). */
export function linuxPeer(rows: readonly UnixSocketRow[], inode: number): number | null {
  const ours = rows.find((r) => r.inode === inode);
  if (!ours || ours.peer <= 0) return null;
  const theirs = rows.find((r) => r.inode === ours.peer);
  return theirs?.pids.length === 1 ? theirs.pids[0]! : null;
}

/* ---------- macOS ---------- */

/** One process's Unix sockets from `lsof -nP -U -F pfdn`: the fd, the socket's address and its peer's. */
export interface LsofSocket {
  pid: number;
  fd: number;
  address: string;
  peer: string | null;
}

/** lsof's field output: `p<pid>`, then per file `f<fd>`, `d<address>`, `n<name>` (`->0x…` when connected). */
export function parseLsof(stdout: string): LsofSocket[] {
  const sockets: LsofSocket[] = [];
  let pid = 0;
  let current: LsofSocket | null = null;
  for (const line of stdout.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') pid = Number(value);
    else if (field === 'f') {
      current = /^\d+$/.test(value) ? { pid, fd: Number(value), address: '', peer: null } : null;
      if (current) sockets.push(current);
    } else if (field === 'd' && current) current.address = value.toLowerCase();
    else if (field === 'n' && current) current.peer = /->(0x[0-9a-f]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
  }
  return sockets;
}

/** The PID whose socket is connected to Chord's (its fd), or null. */
export function macPeer(sockets: readonly LsofSocket[], self: number, fd: number): number | null {
  const ours = sockets.find((s) => s.pid === self && s.fd === fd);
  if (!ours?.address) return null;
  const pids = new Set(sockets.filter((s) => s.pid !== self && s.peer === ours.address).map((s) => s.pid));
  if (pids.size === 1) return [...pids][0]!;
  // The bridge in Chord's own process (units): its end points at Chord's too.
  return sockets.some((s) => s.pid === self && s.fd !== fd && s.peer === ours.address) ? self : null;
}

/* ---------- The lookup ---------- */

/**
 * The PID at the other end of the connection, or null when the OS can't say. `pipe`: the endpoint's path (Windows);
 * `claimed`: the hello's bridge PID; `held`: other live connections' peers (Windows).
 */
export async function peerOf(socket: Socket, pipe: string, claimed: number, held: ReadonlySet<number>, deps: PeerDeps): Promise<number | null> {
  try {
    if (deps.platform === 'win32') {
      if (!deps.helper) return null;
      return choosePeer(parsePipeClients(await deps.run(deps.helper, ['pipe-clients', pipe, String(deps.self)])), claimed, held);
    }
    const fd = socketFd(socket);
    if (fd === null) return null;
    if (deps.platform === 'linux') {
      const inode = /^socket:\[(\d+)\]$/.exec(deps.readlink(`/proc/self/fd/${fd}`))?.[1];
      return inode ? linuxPeer(parseSs(await deps.run('ss', ['-xpnH'])), Number(inode)) : null;
    }
    if (deps.platform === 'darwin') {
      // This user's Unix sockets only: the peer is the same user's (the socket's folder is 0700).
      const uid = process.getuid?.();
      return macPeer(parseLsof(await deps.run('lsof', ['-nP', '-U', ...(uid !== undefined ? ['-a', '-u', String(uid)] : []), '-F', 'pfdn'])), deps.self, fd);
    }
    return null;
  } catch {
    return null;
  }
}
