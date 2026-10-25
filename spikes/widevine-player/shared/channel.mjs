// The control channel between Chord (the host, server) and the Widevine player
// (client): newline-delimited JSON over a named pipe (Windows) or a Unix socket
// in a private 0700 folder (macOS, Linux).
//
// Both ends prove they hold the per-launch secret without sending it: the host
// sends a nonce, the player answers with its own nonce and an HMAC over both,
// and the host answers with an HMAC the other way round. Nothing else is read
// before that, the first message has 3 s to arrive, lines are capped at 64 KB,
// and the host takes one player at a time.
//
// The secret reaches the player on its stdin, not its command line (readable
// by any local process on Linux) nor its environment (inherited by every
// Chromium child process, renderers included).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_LINE = 1 << 16;
const HANDSHAKE_MS = 3000;

/** Milliseconds on the OS's monotonic clock (QPC, mach_absolute_time, CLOCK_MONOTONIC), comparable across processes. */
export const now = () => Number(process.hrtime.bigint()) / 1e6;

/** A fresh address: a random pipe name, or a socket in a new private folder (removed by cleanup). */
export function newAddress() {
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\chord-wv-${randomBytes(16).toString('hex')}`, cleanup() {} };
  // XDG_RUNTIME_DIR is per-user and 0700 already; mkdtemp makes the folder 0700 either way.
  const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'chord-wv-'));
  return { path: join(dir, 's'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const newSecret = () => randomBytes(32).toString('hex');

const hmac = (secret, ...parts) => createHmac('sha256', Buffer.from(secret, 'hex')).update(parts.join('\0')).digest('hex');
const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** One end of the channel. Emits 'open' once authenticated, 'close' when gone. */
export class Peer extends EventEmitter {
  #socket;
  #secret;
  #state;
  #nonce = randomBytes(16).toString('hex');
  #buffer = '';
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #timer;

  constructor(socket, role, secret) {
    super();
    this.#socket = socket;
    this.#secret = secret;
    this.#state = role === 'host' ? 'await-hello' : 'await-challenge';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#data(chunk));
    socket.on('close', () => {
      clearTimeout(this.#timer);
      for (const { t, reject } of this.#pending.values()) reject(new Error(`${t}: channel closed`));
      this.#pending.clear();
      this.emit('close');
    });
    socket.on('error', () => {});
    this.#timer = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    if (role === 'host') this.#write({ t: 'challenge', n: this.#nonce });
  }

  get open() {
    return this.#state === 'open';
  }

  /** Sends a message that wants no answer. */
  send(t, body = {}) {
    if (this.open) this.#write({ ...body, t });
  }

  /** Sends a request and resolves with the other end's answer. */
  request(t, body = {}, timeout = 5000) {
    if (!this.open) return Promise.reject(new Error('channel not open'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${t}: no answer in ${timeout} ms`));
      }, timeout);
      this.#pending.set(id, {
        t,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#write({ ...body, t, id });
    });
  }

  /** Handles a message type; what `fn` returns (or resolves to) answers a request. */
  handle(t, fn) {
    this.#handlers.set(t, fn);
    return this;
  }

  close() {
    this.#socket.end();
  }

  #write(message) {
    this.#socket.write(`${JSON.stringify(message)}\n`);
  }

  #data(chunk) {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE && !this.#buffer.includes('\n')) return this.#socket.destroy();
    let at;
    while ((at = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.length > MAX_LINE) return this.#socket.destroy();
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return this.#socket.destroy();
      }
      const valid = message && typeof message === 'object' && (typeof message.t === 'string' || (this.open && Number.isInteger(message.re)));
      if (!valid) return this.#socket.destroy();
      this.#message(message);
    }
  }

  #message(m) {
    switch (this.#state) {
      case 'await-challenge':
        if (m.t !== 'challenge' || typeof m.n !== 'string') return this.#socket.destroy();
        this.#peerNonce = m.n;
        this.#write({ t: 'hello', n: this.#nonce, mac: hmac(this.#secret, 'player', m.n, this.#nonce), pid: process.pid });
        this.#state = 'await-welcome';
        return;
      case 'await-hello':
        if (m.t !== 'hello' || typeof m.n !== 'string' || !same(m.mac, hmac(this.#secret, 'player', this.#nonce, m.n))) return this.#socket.destroy();
        this.#write({ t: 'welcome', mac: hmac(this.#secret, 'host', m.n, this.#nonce) });
        return this.#opened(m);
      case 'await-welcome':
        if (m.t !== 'welcome' || !same(m.mac, hmac(this.#secret, 'host', this.#nonce, this.#peerNonce))) return this.#socket.destroy();
        return this.#opened(m);
      case 'open':
        return this.#dispatch(m);
      default:
        return this.#socket.destroy();
    }
  }

  #peerNonce = '';

  #opened(m) {
    clearTimeout(this.#timer);
    this.#state = 'open';
    this.emit('open', m);
  }

  async #dispatch(m) {
    if (m.re !== undefined) {
      const pending = this.#pending.get(m.re);
      this.#pending.delete(m.re);
      if (!pending) return;
      if (m.ok) pending.resolve(m.value);
      else pending.reject(new Error(m.error ?? 'failed'));
      return;
    }
    const fn = this.#handlers.get(m.t);
    if (m.id === undefined) {
      if (fn) Promise.resolve().then(() => fn(m)).catch((e) => this.emit('error', e));
      else this.emit('message', m);
      return;
    }
    if (!fn) return this.#write({ re: m.id, ok: false, error: `no handler for ${m.t}` });
    try {
      this.#write({ re: m.id, ok: true, value: await fn(m) });
    } catch (error) {
      this.#write({ re: m.id, ok: false, error: String(error?.message ?? error) });
    }
  }
}

/**
 * The host's end: listens at `address` and hands over one authenticated player at a time.
 * Connections that fail the handshake are dropped without a word.
 */
export function listen(address, secret, onPeer) {
  let current = null;
  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    if (current) return socket.destroy();
    const peer = new Peer(socket, 'host', secret);
    peer.once('open', (hello) => {
      current = peer;
      peer.once('close', () => (current = null));
      onPeer(peer, hello);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.path, () => resolve(server));
  });
}

/** The player's end: connects and resolves once both sides have proved the secret. */
export function connect(address, secret) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address.path);
    const peer = new Peer(socket, 'player', secret);
    peer.once('open', () => resolve(peer));
    peer.once('close', () => reject(new Error('handshake failed')));
    socket.once('error', reject);
  });
}

/**
 * The launch line: {"path": …, "secret": …}. On macOS and Linux Chord writes it to the
 * player's stdin. On Windows an Electron app's main process gets no stdin (it's a GUI
 * program), so it comes in the environment, and the player removes it from its own
 * environment before any Chromium child process is started, so none inherits it.
 */
export const LAUNCH_ENV = 'CHORD_WV_LAUNCH';

export function readLaunchLine(stream = process.stdin, timeout = 5000) {
  const fromEnv = process.env[LAUNCH_ENV];
  if (fromEnv) {
    delete process.env[LAUNCH_ENV];
    return Promise.resolve(JSON.parse(fromEnv));
  }
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('no launch line on stdin')), timeout);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      const at = text.indexOf('\n');
      if (at < 0) return;
      clearTimeout(timer);
      stream.pause();
      try {
        resolve(JSON.parse(text.slice(0, at)));
      } catch (error) {
        reject(error);
      }
    });
  });
}
