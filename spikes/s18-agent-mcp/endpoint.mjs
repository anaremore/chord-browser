// Spike S18 M0: the local endpoint a running Chord serves to `chord mcp` (no port: D9).
// Windows: a named pipe with a random name. macOS/Linux: a Unix socket in a 0700 folder.
// Either way, the name and a random token go in `agent-endpoint.json` in the profile
// folder (userData), which only the current OS user can read. A connection must send
// the token first; until it does, the endpoint writes nothing.
// Plain Node (no Electron imports), so it runs under node for tests and inside Electron's main.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ENDPOINT_FILE = 'agent-endpoint.json';
const HELLO_MS = 2000;

/** Where the socket goes. The path is short: sun_path is 104 bytes on macOS, 108 on Linux. */
export function endpointPath(id = randomBytes(8).toString('hex')) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\chord-agent-${id}`;
  // Flatpak: $XDG_RUNTIME_DIR/app/<flatpak id>/ is the same folder inside and outside the sandbox.
  const flatpak = process.env.FLATPAK_ID && process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'app', process.env.FLATPAK_ID) : null;
  const base = flatpak ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const dir = join(base, `chord-agent-${id}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return join(dir, 's');
}

/** Line-delimited JSON over a stream: what the bridge and the endpoint both speak. */
export function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/**
 * Serves the endpoint until `close()`. `onConnection(hello, send, conn)` gets each
 * authenticated connection's hello (clientInfo comes later, in MCP initialize) and
 * returns `(message) => void` for the MCP messages that follow.
 */
export async function startEndpoint({ userData, onConnection, log = () => {} }) {
  const token = randomBytes(32);
  const path = endpointPath();
  const live = new Set();
  const server = createServer((conn) => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    let handler = null;
    const timer = setTimeout(() => {
      log('refused: no hello within', HELLO_MS, 'ms');
      conn.destroy();
    }, HELLO_MS);
    const send = (obj) => conn.writable && conn.write(`${JSON.stringify(obj)}\n`);
    lines(conn, (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return conn.destroy();
      }
      if (!handler) {
        const given = Buffer.from(String(m?.token ?? ''), 'hex');
        if (m?.type !== 'hello' || given.length !== token.length || !timingSafeEqual(given, token)) {
          log('refused: bad hello');
          clearTimeout(timer);
          return conn.destroy();
        }
        clearTimeout(timer);
        send({ type: 'welcome' });
        handler = onConnection(m, send, conn);
        return;
      }
      handler(m);
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const file = join(userData, ENDPOINT_FILE);
  mkdirSync(userData, { recursive: true });
  writeFileSync(file, JSON.stringify({ path, token: token.toString('hex'), pid: process.pid }), { mode: 0o600 });
  return {
    path,
    file,
    server,
    close() {
      server.close();
      for (const c of live) c.destroy(); // what quitting Chord does to connected bridges
      rmSync(file, { force: true });
      if (process.platform !== 'win32') rmSync(join(path, '..'), { recursive: true, force: true });
    },
  };
}

/** The bridge's side: find the endpoint, connect, say hello. Null when Chord isn't running. */
export function connectEndpoint(userData, hello) {
  let info;
  try {
    info = JSON.parse(readFileSync(join(userData, ENDPOINT_FILE), 'utf8'));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const conn = connect(info.path);
    conn.once('error', () => resolve(null));
    conn.once('connect', () => {
      conn.write(`${JSON.stringify({ type: 'hello', token: info.token, ...hello })}\n`);
      resolve(conn);
    });
  });
}
