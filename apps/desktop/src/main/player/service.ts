/**
 * Chord Player in Chord (ARCHITECTURE.md §9, §16 D4; DESIGN.md §7.1, §7.10,
 * §7.13): what the DRM notice offers, installing and opening a service's page
 * in the player, the tab that stays behind ("Playing in Chord Player"), the
 * Now playing card's entry for it, links it hands back, and Settings.
 *
 * It's never offered in Google-free mode (Widevine's CDM comes from Google's
 * component updater) or in private windows (the player has one profile of
 * its own, which keeps sign-ins), and turning Google-free mode on closes it.
 * One player at a time, tied to the tab it was opened from: opening another
 * service's page moves it there.
 */
import type { NodeId } from '@chord/core';
import type { NowPlaying, PlayerFailure, PlayerOffer, PlayerStatus } from '@chord/ipc';
import type { CdmState, MediaReport, Theme } from '@chord/player-protocol';
import { PlayerHost, StartError, type HostDeps } from './host';
import { offerFor } from './install-state';
import type { PlayerInstaller } from './installer';

const DAY_MS = 24 * 3_600_000;
/** The first update check waits for launch to settle. */
const FIRST_UPDATE_MS = 60_000;
/** After GitHub couldn't be reached, how long before a notice asks again. */
const RECHECK_MS = 10 * 60_000;
/** Opening waits this long for the page: on a first start the CDM comes first (S14: under 2 s; up to a minute on a slow network). */
const OPEN_MS = 90_000;

export interface ChordPlayerDeps {
  installer: PlayerInstaller;
  host: Omit<HostDeps, 'onMedia' | 'onArtwork' | 'onLink' | 'onBack' | 'onStatus' | 'onClosed'>;
  /** Not in Google-free mode. */
  enabled(): boolean;
  tabExists(nodeId: NodeId): boolean;
  /** The tab plays in the player (its frame says so), or doesn't any more. */
  setTabInPlayer(nodeId: NodeId, inPlayer: boolean): void;
  /** A link the player handed back: Chord opens it beside the tab it plays for. */
  openLink(url: string, nodeId: NodeId | null): void;
  /** The bar's Back to Chord. */
  back(nodeId: NodeId | null): void;
  /** The chord's colors for the bar, for the tab the player plays for. */
  theme(nodeId: NodeId): Theme | null;
  /** What the notice or Settings would show changed. */
  changed(): void;
  /** What the Now playing cards would show changed. */
  mediaChanged(): void;
  /** The player is gone. */
  closed(): void;
  now?(): number;
}

export class ChordPlayer {
  readonly host: PlayerHost;
  /** The tab the player plays for. */
  nodeId: NodeId | null = null;
  private media: MediaReport | null = null;
  private artwork: string | null = null;
  /** Something has played since the player opened: from then on it's on the Now playing card. */
  private played = false;
  private opening = false;
  /** Installing or opening, from one click: a second click waits its turn. */
  private busy = false;
  private failure: PlayerFailure | null = null;
  private cdm: CdmState | null = null;
  private lastCheck = 0;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Goes up whenever what the card shows of the player changes. */
  version = 0;

  constructor(private readonly deps: ChordPlayerDeps) {
    this.host = new PlayerHost({
      ...deps.host,
      onMedia: (media) => {
        this.media = media;
        if (media.playing) this.played = true;
        this.version++;
        deps.mediaChanged();
      },
      onArtwork: (data) => {
        this.artwork = data;
        this.version++;
        deps.mediaChanged();
      },
      onLink: (url) => deps.openLink(url, this.nodeId),
      onBack: () => deps.back(this.nodeId),
      onStatus: (cdm) => {
        this.cdm = cdm;
      },
      onClosed: () => this.gone(),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get running(): boolean {
    return this.host.running;
  }

  /**
   * What the DRM notice offers of Chord Player: `pending` while Chord finds
   * out (briefly: the card waits so it arrives whole), null when nothing.
   */
  offer(): PlayerOffer | null | 'pending' {
    if (!this.deps.enabled() || !this.deps.installer.supported) return null;
    const installer = this.deps.installer;
    const state = installer.state;
    // Found out once; after a network failure, again once a while has passed (the next notice that asks).
    const stale = state.s === 'unavailable' && state.why === 'unreachable' && this.now() - this.lastCheck > RECHECK_MS;
    if (state.s === 'unknown' || stale) {
      this.lastCheck = this.now();
      void installer.check();
    }
    if (installer.state.s === 'installed' && this.failure) return { state: 'failed', why: this.failure };
    return offerFor(installer.state, { now: this.now(), opening: this.opening });
  }

  /** The notice's button: installs Chord Player if it isn't yet, then opens the tab's page in it. */
  async openFor(nodeId: NodeId, url: string): Promise<void> {
    if (!this.deps.enabled() || this.busy) return;
    this.busy = true;
    try {
      await this.installAndOpen(nodeId, url);
    } finally {
      this.busy = false;
    }
  }

  private async installAndOpen(nodeId: NodeId, url: string): Promise<void> {
    const installer = this.deps.installer;
    this.failure = null;
    await installer.load();
    if (!installer.installed()) {
      if (installer.state.s !== 'available' && installer.state.s !== 'failed') await installer.check();
      if (!(await installer.install())) return;
    }
    this.opening = true;
    this.deps.changed();
    try {
      await this.start();
      this.attach(nodeId);
      const theme = this.deps.theme(nodeId);
      if (theme) this.host.send('theme', { ...theme });
      const answer = await this.host.request<{ ok: boolean; why?: string }>('open', { url }, OPEN_MS);
      if (!answer?.ok) {
        console.warn(`[chord] Chord Player didn't open the page: ${answer?.why ?? 'no answer'}`);
        this.failure = answer?.why === 'cdm' ? 'widevine' : 'start';
        this.detach();
      }
    } catch (error) {
      console.warn(`[chord] Chord Player didn't open: ${(error as Error).message}`);
      this.failure = 'start';
    } finally {
      this.opening = false;
      this.deps.changed();
    }
  }

  /** Starts the version waiting to start, or else the one that ran last; a version that won't start is skipped from then on. */
  private async start(): Promise<void> {
    if (this.host.running) return;
    const installer = this.deps.installer;
    for (const candidate of installer.candidates()) {
      try {
        await this.host.start(candidate);
        await installer.started(candidate.version);
        return;
      } catch (error) {
        console.warn(`[chord] Chord Player ${candidate.version} didn't start: ${(error as Error).message}`);
        if (error instanceof StartError && error.why === 'missing') continue;
        // An update that won't start is skipped from now on; the version that ran before is still there to fall back on.
        if (candidate.version === installer.pendingVersion) await installer.failedToStart(candidate.version);
      }
    }
    throw new Error('No version of Chord Player started');
  }

  /** The player plays for this tab now (a tab it played for before goes back to its page). */
  private attach(nodeId: NodeId): void {
    if (this.nodeId && this.nodeId !== nodeId && this.deps.tabExists(this.nodeId)) this.deps.setTabInPlayer(this.nodeId, false);
    this.nodeId = nodeId;
    this.deps.setTabInPlayer(nodeId, true);
    this.version++;
    this.deps.mediaChanged();
  }

  private detach(): void {
    if (this.nodeId && this.deps.tabExists(this.nodeId)) this.deps.setTabInPlayer(this.nodeId, false);
    this.nodeId = null;
  }

  private gone(): void {
    this.detach();
    this.media = null;
    this.artwork = null;
    this.played = false;
    this.cdm = null;
    this.version++;
    this.deps.mediaChanged();
    this.deps.changed();
    this.deps.closed();
  }

  /** Back to the player (the card, the tab's frame): it comes to the front. */
  async focus(): Promise<void> {
    await this.host.request('focus');
  }

  /** The card's Play, Pause and Mute, for the player. */
  async act(action: 'play' | 'pause' | 'mute' | 'unmute'): Promise<void> {
    if (action === 'mute' || action === 'unmute') await this.host.request('mute', { muted: action === 'mute' });
    else await this.host.request(action);
  }

  /** The frame's "Show the page here": the tab shows its page again; the player plays on, still on the card. */
  release(nodeId: NodeId): void {
    if (nodeId === this.nodeId) this.deps.setTabInPlayer(nodeId, false);
  }

  /** The tab it plays for closed: the player plays on, but nothing in Chord stands for it any more. */
  tabClosed(nodeId: NodeId): void {
    if (nodeId !== this.nodeId) return;
    this.nodeId = null;
    this.version++;
    this.deps.mediaChanged();
  }

  /** The chord's colors changed (its theme, the appearance): the bar follows. */
  themeChanged(): void {
    if (!this.nodeId || !this.host.running) return;
    const theme = this.deps.theme(this.nodeId);
    if (theme) this.host.send('theme', { ...theme });
  }

  /** The player on the Now playing card, as its tab would be. */
  nowPlaying(): NowPlaying | null {
    const media = this.media;
    if (!this.nodeId || !media || !this.played || !this.host.running || !this.deps.tabExists(this.nodeId)) return null;
    return {
      nodeId: this.nodeId,
      title: media.title,
      artist: media.artist,
      album: media.album,
      artwork: this.artwork,
      playing: media.playing,
      pausable: media.pausable,
      video: false,
      pip: false,
      player: true,
      muted: media.muted,
    };
  }

  status(): PlayerStatus {
    const installed = this.deps.installer.installed();
    return {
      available: this.deps.installer.supported,
      googleFree: !this.deps.enabled(),
      installed: installed ? { version: installed.version, ecs: installed.ecs, vmp: installed.vmp } : null,
      pending: this.deps.installer.pendingVersion,
      running: this.host.running,
    };
  }

  /** Settings' Remove: the player quits, then every version and its profile go. */
  async remove(): Promise<PlayerStatus> {
    await this.host.close();
    await this.deps.installer.remove();
    this.failure = null;
    this.deps.changed();
    return this.status();
  }

  async close(): Promise<void> {
    await this.host.close();
  }

  /** Daily, while it's installed and allowed: a newer release downloads beside it, to start next time. */
  startUpdates(): void {
    const run = async () => {
      if (this.deps.enabled() && this.deps.installer.supported) {
        await this.deps.installer.load();
        if (this.deps.installer.installed()) await this.deps.installer.checkForUpdate().catch(() => undefined);
      }
      this.updateTimer = setTimeout(() => void run(), DAY_MS);
      this.updateTimer.unref?.();
    };
    this.updateTimer = setTimeout(() => void run(), FIRST_UPDATE_MS);
    this.updateTimer.unref?.();
  }

  stopUpdates(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
  }

  /** For the E2E tests' hooks: where things stand. */
  inspect(): Record<string, unknown> {
    return { state: this.deps.installer.state.s, installed: this.deps.installer.installed(), running: this.host.running, hello: this.host.hello, nodeId: this.nodeId, media: this.media, cdm: this.cdm, failure: this.failure };
  }
}
