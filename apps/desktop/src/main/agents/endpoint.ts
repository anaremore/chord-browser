/**
 * The endpoint a running Chord serves to `chord mcp` (docs/decisions/S18-agent-mcp.md
 * §1): no port (D9). Windows: a named pipe with a random name. macOS and Linux: a
 * Unix socket in a new 0700 folder. Either way its path and a random 32-byte token
 * go in `agent-endpoint.json` (0600) in the profile folder. A connection must send
 * the token first: until it does, Chord writes nothing, and after AGENT_HELLO_MS it
 * hangs up. One line of JSON per message, both ways.
 *
 * Plain Node, no Electron: the units run it as it is.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_ENDPOINT_FILE, AGENT_HELLO_MS, type AgentEndpointInfo, type AgentHello } from '@chord/core/agent-tools';

/**
 * Where the socket goes. Short, as sun_path is 104 bytes on macOS and 108 on Linux.
 * The Flatpak's `$XDG_RUNTIME_DIR/app/<id>/` is the same folder inside and outside its sandbox.
 */
export function endpointPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, id = randomBytes(8).toString('hex'), temp = tmpdir()): string {
  if (platform === 'win32') return `\\\\.\\pipe\\chord-agent-${id}`;
  const runtime = env['XDG_RUNTIME_DIR'];
  const base = env['FLATPAK_ID'] && runtime ? join(runtime, 'app', env['FLATPAK_ID']) : (runtime ?? temp);
  return join(base, `chord-agent-${id}`, 's');
}

/** Lines a peer may send before its hello (the token and a client's initialize fit easily). */
export const HELLO_MAX = 64 * 1024;
/** Lines after it: a tool call and its arguments. */
export const MESSAGE_MAX = 4 * 1024 * 1024;
/** Lines from Chord to the relay: a screenshot is the largest answer. */
export const ANSWER_MAX = 64 * 1024 * 1024;
/** Connections held at once, and of those, ones still before their hello: past either, a new one is hung up on at once. */
export const LIVE_MAX = 32;
export const UNAUTHENTICATED_MAX = 8;

/**
 * Line-delimited JSON over a stream. A line longer than `max()` characters
 * (finished or not) stops the reading and calls `overflow`, where the caller
 * hangs up: a peer can't make Chord or the relay hold an endless line.
 */
export function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, max: () => number = () => MESSAGE_MAX, overflow: () => void = () => undefined): void {
  let buffer = '';
  let over = false;
  const stop = () => {
    over = true;
    buffer = '';
    overflow();
  };
  (stream as { setEncoding?: (e: string) => void }).setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    if (over) return;
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (line.length > max()) return stop();
      if (line.trim()) onLine(line);
      if (over) return;
    }
    if (buffer.length > max()) stop();
  });
}

export type Send = (message: unknown) => void;

export interface Endpoint {
  readonly path: string;
  readonly file: string;
  /** Connections held now, said hello or not: how many clients Windows' peer lookup expects to find (agents/peer.ts). */
  connected(): number;
  /** Stops serving: every connection ends (as quitting Chord does to connected bridges), and the file and folder go. */
  close(): void;
}

export interface EndpointOptions {
  /** The profile folder, for agent-endpoint.json. */
  userData: string;
  /**
   * An authenticated connection: its hello, and how to answer. Returns what to do with each
   * message after it, and when it ends. Lazy work (the gate, the parent lookup) starts here.
   */
  onConnection(hello: AgentHello, send: Send, socket: Socket): { message(m: Record<string, unknown>): void; closed?(): void };
  /** The first connection of any kind, before its hello (the Windows DACL, once): the endpoint's path, known before it's returned. */
  onFirstConnection?(path: string): void;
  log?(...args: unknown[]): void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export async function startEndpoint(options: EndpointOptions): Promise<Endpoint> {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => undefined);
  const token = randomBytes(32);
  const path = endpointPath(platform, options.env ?? process.env);
  if (platform !== 'win32') {
    // A folder of its own, only ours: connecting to a socket needs write access to it, and the folder keeps everyone out.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }
  const live = new Set<Socket>();
  /** Connections that haven't sent the token yet. */
  const waiting = new Set<Socket>();
  let first = true;
  const server: Server = createServer((socket) => {
    if (first) {
      first = false;
      options.onFirstConnection?.(path);
    }
    if (live.size >= LIVE_MAX || waiting.size >= UNAUTHENTICATED_MAX) {
      log('agent endpoint: too many connections, hung up');
      socket.destroy();
      return;
    }
    live.add(socket);
    waiting.add(socket);
    let handler: ReturnType<EndpointOptions['onConnection']> | null = null;
    const timer = setTimeout(() => {
      log('agent endpoint: no hello in time');
      socket.destroy();
    }, AGENT_HELLO_MS);
    timer.unref?.();
    const send: Send = (message) => {
      if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
    };
    socket.on('close', () => {
      clearTimeout(timer);
      live.delete(socket);
      waiting.delete(socket);
      handler?.closed?.();
    });
    socket.on('error', () => undefined);
    lines(
      socket,
      (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy();
          return;
        }
        if (handler) return handler.message(message);
        clearTimeout(timer);
        waiting.delete(socket);
        // Constant-time: how much of a wrong token matched says nothing.
        const given = Buffer.from(typeof message['token'] === 'string' ? message['token'] : '', 'hex');
        if (message['type'] !== 'hello' || given.length !== token.length || !timingSafeEqual(given, token)) {
          log('agent endpoint: refused a connection without the token');
          socket.destroy();
          return;
        }
        send({ type: 'welcome' });
        handler = options.onConnection(message as unknown as AgentHello, send, socket);
      },
      // 64 KB until the token's in; a few MB a message after.
      () => (handler ? MESSAGE_MAX : HELLO_MAX),
      () => {
        log('agent endpoint: a line too long, hung up');
        socket.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Never writableAll/readableAll: on Windows the pipe's own write access is the lock (S18 §1).
    server.listen(path, () => resolve());
  });
  const file = join(options.userData, AGENT_ENDPOINT_FILE);
  mkdirSync(options.userData, { recursive: true });
  const info: AgentEndpointInfo = { path, token: token.toString('hex'), pid: process.pid };
  writeTokenFile(file, JSON.stringify(info));
  return {
    path,
    file,
    connected: () => live.size,
    close() {
      server.close();
      for (const socket of live) socket.destroy();
      rmSync(file, { force: true });
      if (platform !== 'win32') rmSync(dirname(path), { recursive: true, force: true });
    },
  };
}

/**
 * The token file, 0600 from its first byte: written to a new file of its own (`wx`: never
 * an existing one, whose mode writeFileSync would keep), then renamed over the old one in
 * one step, so a reader sees the old file or the new one, never half of either.
 */
export function writeTokenFile(file: string, text: string): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The endpoint file's contents, or null (no Chord running for this profile, or a file that isn't one). */
export function readEndpoint(userData: string): AgentEndpointInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(userData, AGENT_ENDPOINT_FILE), 'utf8')) as Partial<AgentEndpointInfo>;
    return typeof info.path === 'string' && typeof info.token === 'string' ? (info as AgentEndpointInfo) : null;
  } catch {
    return null;
  }
}

/** The bridge's side: connect and say hello. Null when Chord isn't running. */
export function connectEndpoint(userData: string, hello: Omit<AgentHello, 'type' | 'token'>): Promise<Socket | null> {
  const info = readEndpoint(userData);
  if (!info) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(info.path);
    // Every error, not just the first: one after connecting must never throw in the bridge.
    socket.on('error', () => resolve(null));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'hello', token: info.token, ...hello } satisfies AgentHello)}\n`);
      resolve(socket);
    });
  });
}
