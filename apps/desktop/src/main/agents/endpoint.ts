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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Line-delimited JSON over a stream. */
export function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = '';
  (stream as { setEncoding?: (e: string) => void }).setEncoding?.('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export type Send = (message: unknown) => void;

export interface Endpoint {
  readonly path: string;
  readonly file: string;
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
  /** The first connection of any kind, before its hello (the Windows DACL, once). */
  onFirstConnection?(): void;
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
  let first = true;
  const server: Server = createServer((socket) => {
    if (first) {
      first = false;
      options.onFirstConnection?.();
    }
    live.add(socket);
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
      handler?.closed?.();
    });
    socket.on('error', () => undefined);
    lines(socket, (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        socket.destroy();
        return;
      }
      if (handler) return handler.message(message);
      clearTimeout(timer);
      const given = Buffer.from(typeof message['token'] === 'string' ? message['token'] : '', 'hex');
      if (message['type'] !== 'hello' || given.length !== token.length || !timingSafeEqual(given, token)) {
        log('agent endpoint: refused a connection without the token');
        socket.destroy();
        return;
      }
      send({ type: 'welcome' });
      handler = options.onConnection(message as unknown as AgentHello, send, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Never writableAll/readableAll: on Windows the pipe's own write access is the lock (S18 §1).
    server.listen(path, () => resolve());
  });
  const file = join(options.userData, AGENT_ENDPOINT_FILE);
  mkdirSync(options.userData, { recursive: true });
  const info: AgentEndpointInfo = { path, token: token.toString('hex'), pid: process.pid };
  writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
  return {
    path,
    file,
    close() {
      server.close();
      for (const socket of live) socket.destroy();
      rmSync(file, { force: true });
      if (platform !== 'win32') rmSync(dirname(path), { recursive: true, force: true });
    },
  };
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
