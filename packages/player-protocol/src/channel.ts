/**
 * The control channel between Chord (the host, which listens) and Chord
 * Player (which connects), from spike S14 (§4): newline-delimited JSON over a
 * named pipe with a random name (Windows) or a Unix socket in a new 0700
 * folder (macOS, Linux).
 *
 * Both ends prove they hold the per-launch secret without sending it. Chord
 * sends a nonce and the protocol versions it accepts; the player answers with
 * its own nonce, its version, and an HMAC over both nonces and the version;
 * Chord answers with an HMAC the other way round, or refuses a version it
 * doesn't speak. Nothing else is read before that. The first message has 3 s
 * to arrive, a line is at most 512 KB (artwork is the biggest thing sent),
 * and Chord takes one player at a time.
 *
 * The secret reaches the player on its stdin on macOS and Linux, and in its
 * environment on Windows, where an Electron app's main process has no stdin;
 * the player removes it from its environment before Chromium starts any child
 * process. Never on the command line, which any local process can read on
 * Linux.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export const MAX_LINE = 512 * 1024;
const HANDSHAKE_MS = 3000;

/** A fresh address: a random pipe name, or a socket in a new private folder (removed by cleanup). */
export function newAddress(platform: NodeJS.Platform = process.platform, base?: string): { path: string; cleanup(): void } {
  if (platform === 'win32') return { path: `\\\\.\\pipe\\chord-player-${randomBytes(16).toString('hex')}`, cleanup() {} };
  // XDG_RUNTIME_DIR is per-user and 0700 already; mkdtemp makes the folder 0700 either way.
  const dir = mkdtempSync(join(base ?? (process.env['XDG_RUNTIME_DIR'] || tmpdir()), 'chord-player-'));
  return { path: join(dir, 's'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 256 random bits, as hex. */
export const newSecret = (): string => randomBytes(32).toString('hex');

const hmac = (secret: string, ...parts: string[]) => createHmac('sha256', Buffer.from(secret, 'hex')).update(parts.join('\0')).digest('hex');
const same = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isNonce = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

/** What the player says about itself in the handshake. */
export interface Hello {
  /** The protocol version it speaks (messages.ts). */
  protocol: number;
  /** Its own version (`0.1.0`) and the ECS build it runs on (`44.9.3+wvcus`). */
  app: string;
  ecs: string;
  pid: number;
}

type Handler = (message: Record<string, unknown>) => unknown;

/**
 * One end of the channel. Emits `open` (with the other side's Hello on the
 * host, the agreed version on the player) once authenticated, `refused` on
 * the player when Chord doesn't speak its version, `message` for a message no
 * handler took, and `close` when the connection is gone.
 */
export class Peer extends EventEmitter {
  readonly #socket: net.Socket;
  readonly #secret: string;
  #state: 'await-hello' | 'await-challenge' | 'await-welcome' | 'open' | 'closed';
  readonly #nonce = randomBytes(16).toString('hex');
  #peerNonce = '';
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, { t: string; resolve(v: unknown): void; reject(e: Error): void }>();
  readonly #handlers = new Map<string, Handler>();
  readonly #timer: ReturnType<typeof setTimeout>;
  /** Host: the versions it accepts. Player: its Hello. */
  readonly #versions: readonly [number, number];
  readonly #hello: Hello | null;
  /** The protocol version both ends agreed on (0 until open). */
  protocol = 0;
  /** Host: what the player said about itself. */
  peerHello: Hello | null = null;

  constructor(socket: net.Socket, role: 'host', secret: string, versions: readonly [number, number]);
  constructor(socket: net.Socket, role: 'player', secret: string, hello: Hello);
  constructor(socket: net.Socket, role: 'host' | 'player', secret: string, info: readonly [number, number] | Hello) {
    super();
    this.#socket = socket;
    this.#secret = secret;
    this.#versions = role === 'host' ? (info as readonly [number, number]) : [0, 0];
    this.#hello = role === 'player' ? (info as Hello) : null;
    this.#state = role === 'host' ? 'await-hello' : 'await-challenge';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#data(chunk));
    socket.on('close', () => {
      clearTimeout(this.#timer);
      this.#state = 'closed';
      for (const { t, reject } of this.#pending.values()) reject(new Error(`${t}: channel closed`));
      this.#pending.clear();
      this.emit('close');
    });
    socket.on('error', () => {});
    this.#timer = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    if (role === 'host') this.#write({ t: 'challenge', n: this.#nonce, v: this.#versions });
  }

  get open(): boolean {
    return this.#state === 'open';
  }

  /** Sends a message that wants no answer (dropped unless the channel is open). */
  send(t: string, body: Record<string, unknown> = {}): void {
    if (this.open) this.#write({ ...body, t });
  }

  /** Sends a request and resolves with the other end's answer. */
  request<T = unknown>(t: string, body: Record<string, unknown> = {}, timeout = 5000): Promise<T> {
    if (!this.open) return Promise.reject(new Error('channel not open'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${t}: no answer in ${timeout} ms`));
      }, timeout);
      this.#pending.set(id, {
        t,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#write({ ...body, t, id });
    });
  }

  /** Handles a message type; what `fn` returns (or resolves to) answers a request. */
  handle(t: string, fn: Handler): this {
    this.#handlers.set(t, fn);
    return this;
  }

  close(): void {
    this.#socket.end();
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #write(message: Record<string, unknown>): void {
    if (!this.#socket.destroyed) this.#socket.write(`${JSON.stringify(message)}\n`);
  }

  #data(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE && !this.#buffer.includes('\n')) return void this.#socket.destroy();
    let at: number;
    while ((at = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.length > MAX_LINE) return void this.#socket.destroy();
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return void this.#socket.destroy();
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return void this.#socket.destroy();
      const m = message as Record<string, unknown>;
      const valid = typeof m['t'] === 'string' || (this.open && Number.isInteger(m['re']));
      if (!valid) return void this.#socket.destroy();
      this.#message(m);
      if (this.#socket.destroyed) return;
    }
  }

  #message(m: Record<string, unknown>): void {
    switch (this.#state) {
      case 'await-challenge': {
        const v = m['v'];
        if (m['t'] !== 'challenge' || !isNonce(m['n']) || !Array.isArray(v) || v.length !== 2 || !v.every(Number.isInteger)) return void this.#socket.destroy();
        this.#peerNonce = m['n'];
        const hello = this.#hello!;
        this.#write({ t: 'hello', n: this.#nonce, ...hello, mac: hmac(this.#secret, 'player', this.#peerNonce, this.#nonce, String(hello.protocol), hello.app) });
        this.#state = 'await-welcome';
        return;
      }
      case 'await-hello': {
        const protocol = m['protocol'];
        const app = m['app'];
        if (m['t'] !== 'hello' || !isNonce(m['n']) || !Number.isInteger(protocol) || typeof app !== 'string' || app.length > 64) return void this.#socket.destroy();
        if (!same(m['mac'], hmac(this.#secret, 'player', this.#nonce, m['n'], String(protocol), app))) return void this.#socket.destroy();
        clearTimeout(this.#timer);
        this.peerHello = { protocol: protocol as number, app, ecs: typeof m['ecs'] === 'string' ? m['ecs'].slice(0, 64) : '', pid: Number.isInteger(m['pid']) ? (m['pid'] as number) : 0 };
        const [min, max] = this.#versions;
        if ((protocol as number) < min || (protocol as number) > max) {
          // Authenticated, but a version Chord doesn't speak: say so (Chord updates or offers to), then hang up.
          this.#write({ t: 'refused', why: 'protocol', v: this.#versions });
          this.#state = 'closed';
          this.emit('refused', this.peerHello);
          this.#socket.end();
          return;
        }
        this.protocol = protocol as number;
        this.#write({ t: 'welcome', v: this.protocol, mac: hmac(this.#secret, 'host', m['n'], this.#nonce, String(this.protocol)) });
        return this.#opened(this.peerHello);
      }
      case 'await-welcome': {
        if (m['t'] === 'refused') {
          this.#state = 'closed';
          this.emit('refused', m['v']);
          return void this.#socket.end();
        }
        const v = m['v'];
        if (m['t'] !== 'welcome' || !Number.isInteger(v) || !same(m['mac'], hmac(this.#secret, 'host', this.#nonce, this.#peerNonce, String(v)))) return void this.#socket.destroy();
        clearTimeout(this.#timer);
        this.protocol = v as number;
        return this.#opened(this.protocol);
      }
      case 'open':
        return void this.#dispatch(m);
      default:
        return void this.#socket.destroy();
    }
  }

  #opened(info: unknown): void {
    this.#state = 'open';
    this.emit('open', info);
  }

  async #dispatch(m: Record<string, unknown>): Promise<void> {
    if (m['re'] !== undefined) {
      const pending = this.#pending.get(m['re'] as number);
      this.#pending.delete(m['re'] as number);
      if (!pending) return;
      if (m['ok'] === true) pending.resolve(m['value']);
      else pending.reject(new Error(typeof m['error'] === 'string' ? m['error'].slice(0, 300) : 'failed'));
      return;
    }
    const t = m['t'] as string;
    const fn = this.#handlers.get(t);
    const id = m['id'];
    if (id === undefined) {
      if (fn) Promise.resolve().then(() => fn(m)).catch((e: unknown) => this.emit('error', e));
      else this.emit('message', m);
      return;
    }
    if (!Number.isInteger(id)) return void this.#socket.destroy();
    if (!fn) return this.#write({ re: id, ok: false, error: `unknown: ${t.slice(0, 40)}` });
    try {
      this.#write({ re: id, ok: true, value: (await fn(m)) ?? null });
    } catch (error) {
      this.#write({ re: id, ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) });
    }
  }
}

/**
 * Chord's end: listens at `address` and hands over one authenticated player
 * at a time. A connection that fails the handshake is dropped without a word;
 * one that speaks a version outside `versions` is told so and dropped
 * (`onRefused`).
 */
export function listen(
  address: { path: string },
  secret: string,
  versions: readonly [number, number],
  onPeer: (peer: Peer, hello: Hello) => void,
  onRefused?: (hello: Hello) => void,
): Promise<net.Server> {
  let current: Peer | null = null;
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    if (current) return void socket.destroy();
    const peer = new Peer(socket, 'host', secret, versions);
    peer.once('refused', (hello: Hello) => onRefused?.(hello));
    peer.once('open', (hello: Hello) => {
      if (current) return peer.destroy();
      current = peer;
      peer.once('close', () => {
        if (current === peer) current = null;
      });
      onPeer(peer, hello);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.path, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The player's end: connects and resolves once both sides have proved the secret. */
export function connect(address: { path: string }, secret: string, hello: Hello): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address.path);
    const peer = new Peer(socket, 'player', secret, hello);
    peer.once('open', () => resolve(peer));
    peer.once('refused', (v: unknown) => reject(new Error(`Chord speaks protocol ${JSON.stringify(v)}, not ${hello.protocol}`)));
    peer.once('close', () => reject(new Error('handshake failed')));
    socket.once('error', reject);
  });
}

/* ---------- Launching ---------- */

/** The environment variable that carries the launch line on Windows. */
export const LAUNCH_ENV = 'CHORD_PLAYER_LAUNCH';

/** What Chord tells the player as it starts it. */
export interface Launch {
  /** The channel's pipe or socket. */
  path: string;
  /** The per-launch secret, 64 hex digits. */
  secret: string;
  /** The player's own profile folder (cookies, the CDM). */
  profile: string;
  /** Windows: Chord's AppUserModelID, so the player's window joins Chord's taskbar button. */
  appUserModelId?: string;
  /**
   * Tests only (a development Chord asked by a test): plain HTTP for the
   * services' hosts, host-resolver rules for a local test server, origins to
   * treat as secure (EME needs a secure context), and the test-only requests.
   */
  test?: { hostResolverRules?: string; secureOrigins?: string[] };
}

export function parseLaunch(text: string): Launch | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (typeof l['path'] !== 'string' || !l['path'] || l['path'].length > 1024) return null;
  if (typeof l['secret'] !== 'string' || !/^[0-9a-f]{64}$/.test(l['secret'])) return null;
  if (typeof l['profile'] !== 'string' || !l['profile'] || l['profile'].length > 4096) return null;
  const launch: Launch = { path: l['path'], secret: l['secret'], profile: l['profile'] };
  if (typeof l['appUserModelId'] === 'string' && /^[\w.-]{1,128}$/.test(l['appUserModelId'])) launch.appUserModelId = l['appUserModelId'];
  const test = l['test'];
  if (test && typeof test === 'object') {
    const t = test as Record<string, unknown>;
    launch.test = {
      ...(typeof t['hostResolverRules'] === 'string' && t['hostResolverRules'].length < 2048 ? { hostResolverRules: t['hostResolverRules'] } : {}),
      ...(Array.isArray(t['secureOrigins']) ? { secureOrigins: t['secureOrigins'].filter((o): o is string => typeof o === 'string' && /^https?:\/\/[\w.-]+(:\d+)?$/.test(o)).slice(0, 8) } : {}),
    };
  }
  return launch;
}

/**
 * The launch line, read once: from the environment (removed from it at
 * once, so no child process inherits it) or else the first line on stdin.
 */
export function readLaunch(env: NodeJS.ProcessEnv = process.env, stdin: Readable = process.stdin, timeoutMs = 5000): Promise<Launch | null> {
  const fromEnv = env[LAUNCH_ENV];
  if (fromEnv !== undefined) {
    delete env[LAUNCH_ENV];
    return Promise.resolve(parseLaunch(fromEnv));
  }
  return new Promise((resolve) => {
    let text = '';
    const done = (launch: Launch | null) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.pause();
      resolve(launch);
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.length > 16_384) return done(null);
      const at = text.indexOf('\n');
      if (at >= 0) done(parseLaunch(text.slice(0, at)));
    };
    const onEnd = () => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onEnd);
  });
}

/**
 * The environment Chord starts the player with: its own, without what
 * Electron and Chromium add to their own process. With those, the player's
 * zygote died at once on Linux (S14 §4).
 */
export function playerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(CHROME_|ELECTRON_|GOOGLE_|ORIGINAL_XDG_|NODE_OPTIONS|FC_FONTATIONS|CHORD_)/.test(key)) continue;
    out[key] = value;
  }
  if (out['DBUS_SESSION_BUS_ADDRESS'] === 'disabled:') delete out['DBUS_SESSION_BUS_ADDRESS'];
  return out;
}
