/**
 * Starting Chord Player and holding its control channel (ARCHITECTURE.md §9;
 * @chord/player-protocol's channel.ts). Chord is the server: it makes a fresh
 * pipe or socket and a 256-bit secret for each start, starts the installed
 * version with a cleaned environment, hands it the launch line (stdin on
 * macOS and Linux; its environment on Windows, which the player clears at
 * once), and takes that one player once it proves the secret.
 *
 * Every message from the player is checked before it's used (messages.ts);
 * links it hands over are limited to a few at a time, as the player limits
 * them too.
 */
import {
  executableIn,
  LAUNCH_ENV,
  listen,
  newAddress,
  newSecret,
  parseArtwork,
  parseLink,
  parseMedia,
  parseStatus,
  playerEnv,
  PROTOCOL,
  PROTOCOL_MIN,
  rateLimiter,
  type CdmState,
  type Hello,
  type Launch,
  type MediaReport,
  type Peer,
} from '@chord/player-protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:net';
import { join } from 'node:path';
import type { Installed } from './install-state';
import { profileDir, versionDir } from './paths';

/** How long a started player has to prove the secret (S14 measured 0.1–0.6 s, ECS's launch included). */
const START_MS = 30_000;

export interface HostDeps {
  root: string;
  platform: NodeJS.Platform;
  /** Windows: Chord's AppUserModelID, so the player joins Chord's taskbar button. */
  appUserModelId?: string;
  /** Tests only (a development Chord asked by a test). */
  test?: Launch['test'];
  /** Development: the player's console output goes to Chord's. */
  verbose: boolean;
  onMedia(media: MediaReport): void;
  onArtwork(data: string | null): void;
  onLink(url: string): void;
  onBack(): void;
  onStatus(cdm: CdmState): void;
  /** The player is gone (its window closed, it quit, or it crashed). */
  onClosed(): void;
}

export class StartError extends Error {
  constructor(
    message: string,
    readonly why: 'missing' | 'exited' | 'timeout' | 'protocol',
  ) {
    super(message);
  }
}

export class PlayerHost {
  private child: ChildProcess | null = null;
  private peer: Peer | null = null;
  private server: Server | null = null;
  private cleanupAddress: (() => void) | null = null;
  private starting: Promise<Peer> | null = null;
  private readonly allowLink = rateLimiter(3, 10_000);
  /** What the running player said about itself. */
  hello: Hello | null = null;

  constructor(private readonly deps: HostDeps) {}

  get running(): boolean {
    return Boolean(this.peer?.open);
  }

  get channel(): Peer | null {
    return this.peer?.open ? this.peer : null;
  }

  /** Starts `installed` (if no player runs) and resolves once it's proved the secret. */
  start(installed: Installed): Promise<Peer> {
    if (this.peer?.open) return Promise.resolve(this.peer);
    this.starting ??= this.launch(installed).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(installed: Installed): Promise<Peer> {
    const exe = join(versionDir(this.deps.root, installed.version), ...executableIn(this.deps.platform).split('/'));
    if (!existsSync(exe)) throw new StartError(`${exe} is missing`, 'missing');
    const address = newAddress(this.deps.platform);
    const secret = newSecret();
    let opened: (peer: Peer) => void = () => {};
    let refused: () => void = () => {};
    const handshake = new Promise<Peer>((resolve, reject) => {
      opened = resolve;
      refused = () => reject(new StartError(`Chord Player ${installed.version} speaks another protocol`, 'protocol'));
    });
    this.server = await listen(
      address,
      secret,
      [PROTOCOL_MIN, PROTOCOL],
      (peer, hello) => {
        this.hello = hello;
        opened(peer);
      },
      () => refused(),
    );
    this.cleanupAddress = address.cleanup;
    const launch: Launch = { path: address.path, secret, profile: profileDir(this.deps.root), ...(this.deps.appUserModelId ? { appUserModelId: this.deps.appUserModelId } : {}), ...(this.deps.test ? { test: this.deps.test } : {}) };
    const line = JSON.stringify(launch);
    const env = playerEnv(process.env);
    // Windows: an Electron app's main process gets no stdin, so the line goes in the environment, which the player clears at once.
    if (this.deps.platform === 'win32') env[LAUNCH_ENV] = line;
    const output = this.deps.verbose ? 'inherit' : 'ignore';
    const child = spawn(exe, [], { env, stdio: [this.deps.platform === 'win32' ? 'ignore' : 'pipe', output, output], windowsHide: false });
    this.child = child;
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${line}\n`);
    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => reject(new StartError(error.message, 'exited')));
      child.once('exit', (code, signal) => reject(new StartError(`Chord Player exited (${code ?? signal}) before it connected`, 'exited')));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StartError('Chord Player didn’t connect in time', 'timeout')), START_MS);
    });
    let peer: Peer;
    try {
      peer = await Promise.race([handshake, exited, timeout]);
    } catch (error) {
      this.stopProcess();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.peer = peer;
    this.wire(peer, child);
    return peer;
  }

  private wire(peer: Peer, child: ChildProcess): void {
    peer.handle('media', (m) => {
      const media = parseMedia(m);
      if (media) this.deps.onMedia(media);
    });
    peer.handle('artwork', (m) => this.deps.onArtwork(parseArtwork(m['data'])));
    peer.handle('link', (m) => {
      const link = parseLink(m);
      if (link && this.allowLink()) this.deps.onLink(link.url);
    });
    peer.handle('back', () => this.deps.onBack());
    peer.handle('status', (m) => {
      const status = parseStatus(m);
      if (status) this.deps.onStatus(status.cdm);
    });
    peer.handle('bye', () => {});
    let gone = false;
    const closed = () => {
      if (gone) return;
      gone = true;
      if (this.peer === peer) this.peer = null;
      this.hello = null;
      // A player quitting gets a few seconds to save its cookies (a fresh sign-in) before it's stopped.
      if (child.exitCode === null && child.signalCode === null) setTimeout(() => this.stopProcess(child), 5000).unref();
      else this.stopProcess(child);
      this.deps.onClosed();
    };
    peer.once('close', closed);
    child.once('exit', closed);
  }

  /** Asks the player something; null when it isn't running or doesn't answer. */
  async request<T>(t: string, body: Record<string, unknown> = {}, timeout = 5000): Promise<T | null> {
    const peer = this.channel;
    if (!peer) return null;
    try {
      return await peer.request<T>(t, body, timeout);
    } catch {
      return null;
    }
  }

  send(t: string, body: Record<string, unknown> = {}): void {
    this.channel?.send(t, body);
  }

  /** Asks the player to quit, and makes sure it has within a few seconds. */
  async close(): Promise<void> {
    const child = this.child;
    if (this.peer?.open) await this.request('close', {}, 2000);
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    this.stopProcess(child ?? undefined);
  }

  private stopProcess(child: ChildProcess | null = this.child): void {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (child === this.child) this.child = null;
    if (!this.child && !this.peer?.open) {
      this.server?.close();
      this.server = null;
      this.cleanupAddress?.();
      this.cleanupAddress = null;
    }
  }
}
