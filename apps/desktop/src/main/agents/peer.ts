/**
 * Who's calling (S18 M2a; docs/decisions/S18-agent-mcp.md, "M2: settled so far"): the process at the other end of
 * an agent's connection, as the OS says, instead of the hello's word for it. The card's *Started by* and Always
 * allow's program are then looked up from there (parent.ts), never from the hello's `parentPid`.
 *
 * Node has no getsockopt and never gives a pipe's handle on Windows, so each OS is asked from outside, while the
 * connect card shows (never inside a call):
 *
 * - **Windows:** window-owner.exe's `pipe-clients` lists the PIDs of the clients connected to Chord's agent pipe,
 *   and each one's chain (its parent, and theirs), in one process: about 60 ms of its own work (S18 M2a).
 *   It can't say which connection is whose, so a connection's peer is the bridge PID its hello claims when that
 *   PID is among them and the claim is its own (AgentService.claims: first come, first served, from the hello on);
 *   else the one client no other connection holds or claimed; else unknown.
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
import type { ProcessInfo } from './parent';

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

/** pipe-clients' answer: the clients, each one's chain (itself first: parent.ts's ProcessInfo), and its own timings. */
export interface PipeClients {
  clients: number[];
  chains: Map<number, ProcessInfo[]>;
  /** How long each step took in the helper (ms), and what it looked at: for the units' budgets. */
  timings: Record<string, number>;
}

const isPid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** pipe-clients' line of JSON, kept to what it can be; null when it isn't that. */
export function parsePipeClients(stdout: string): PipeClients | null {
  let raw: { clients?: unknown; chains?: unknown; files?: unknown; stuck?: unknown; handles?: unknown; ms?: unknown };
  try {
    raw = JSON.parse(stdout.trim()) as typeof raw;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clients)) return null;
  const clients = [...new Set(raw.clients.filter(isPid))];
  const chains = new Map<number, ProcessInfo[]>();
  const given = raw.chains && typeof raw.chains === 'object' ? (raw.chains as Record<string, unknown>) : {};
  for (const pid of clients) {
    const chain = given[String(pid)];
    if (!Array.isArray(chain)) continue;
    const infos: ProcessInfo[] = [];
    for (const p of chain as Record<string, unknown>[]) {
      if (!p || !isPid(p['pid'])) break;
      infos.push({ pid: p['pid'], name: text(p['name']), path: text(p['path']), cwd: null, ppid: isPid(p['ppid']) ? p['ppid'] : null });
    }
    // A chain is the client's: one that doesn't start with it isn't used.
    if (infos[0]?.pid === pid) chains.set(pid, infos);
  }
  const timings: Record<string, number> = {};
  for (const [k, v] of Object.entries({ files: raw.files, stuck: raw.stuck, handles: raw.handles, ...(raw.ms && typeof raw.ms === 'object' ? raw.ms : {}) })) if (typeof v === 'number') timings[k] = v;
  return { clients, chains, timings };
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

/** One Unix socket from `ss -xpnH`: the inode of its peer, and the PIDs holding it. */
export interface UnixSocketRow {
  peer: number;
  pids: number[];
}

/**
 * `ss -xpnH`'s lines: `u_str ESTAB 0 0 <local> <inode> <peer address> <peer inode> users:(("name",pid=1,fd=3),…)`.
 * Either address can hold spaces (a socket's path), so only what can be read for sure is read: the peer's inode (the
 * last number before `users:`) and the PIDs. That's enough: the other end of Chord's socket is the row whose peer is it.
 */
export function parseSs(stdout: string): UnixSocketRow[] {
  const rows: UnixSocketRow[] = [];
  for (const line of stdout.split('\n')) {
    const users = line.indexOf(' users:(');
    const head = (users >= 0 ? line.slice(0, users) : line).trim();
    const match = /^u_\S+\s.*\s(\d+)$/.exec(head);
    if (!match) continue;
    const pids = users >= 0 ? [...line.slice(users).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])) : [];
    rows.push({ peer: Number(match[1]), pids: [...new Set(pids)] });
  }
  return rows;
}

/** The PID holding the other end of Chord's socket with this inode, or null (none, or more than one process). */
export function linuxPeer(rows: readonly UnixSocketRow[], inode: number): number | null {
  if (inode <= 0) return null;
  const pids = new Set(rows.filter((r) => r.peer === inode).flatMap((r) => r.pids));
  return pids.size === 1 ? [...pids][0]! : null;
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
 * Who's at the other end: its PID (null when the OS can't say) and, where the lookup gave it in the same step
 * (Windows' helper), its chain, so no second process is started for it; `timings`, the helper's own (units' budgets).
 */
export interface PeerLookup {
  pid: number | null;
  chain?: ProcessInfo[];
  timings?: Record<string, number>;
}

/**
 * The process at the other end of the connection. `pipe`: the endpoint's path (Windows); `claimed`: the hello's bridge
 * PID, or -1 when the claim isn't this connection's (AgentService.claims); `held`: PIDs other live connections hold
 * or claimed (Windows).
 */
export async function peerOf(socket: Socket, pipe: string, claimed: number, held: ReadonlySet<number>, deps: PeerDeps): Promise<PeerLookup> {
  try {
    if (deps.platform === 'win32') {
      if (!deps.helper) return { pid: null };
      const answer = parsePipeClients(await deps.run(deps.helper, ['pipe-clients', pipe, String(deps.self)]));
      if (!answer) return { pid: null };
      const pid = choosePeer(answer.clients, claimed, held);
      const chain = pid === null ? undefined : answer.chains.get(pid);
      return { pid, ...(chain ? { chain } : {}), timings: answer.timings };
    }
    const fd = socketFd(socket);
    if (fd === null) return { pid: null };
    if (deps.platform === 'linux') {
      const inode = /^socket:\[(\d+)\]$/.exec(deps.readlink(`/proc/self/fd/${fd}`))?.[1];
      return { pid: inode ? linuxPeer(parseSs(await deps.run('ss', ['-xpnH'])), Number(inode)) : null };
    }
    if (deps.platform === 'darwin') {
      // This user's Unix sockets only: the peer is the same user's (the socket's folder is 0700).
      const uid = process.getuid?.();
      return { pid: macPeer(parseLsof(await deps.run('lsof', ['-nP', '-U', ...(uid !== undefined ? ['-a', '-u', String(uid)] : []), '-F', 'pfdn'])), deps.self, fd) };
    }
    return { pid: null };
  } catch {
    return { pid: null };
  }
}
