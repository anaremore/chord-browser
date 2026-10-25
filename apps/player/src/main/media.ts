/**
 * What plays in Chord Player, for Chord's Now playing card (DESIGN.md §7.10),
 * and its play, pause and mute. The same approach as Chord's own tabs
 * (apps/desktop/src/main/media.ts): the page's Media Session metadata and its
 * media elements, read from an isolated world (the page's DOM, none of its
 * scripts), when Electron reports a change and every few seconds while
 * something plays. Nothing runs while nothing plays.
 */
import { MAX_ARTWORK_CHARS, type MediaReport } from '@chord/player-protocol';
import type { WebContents } from 'electron';

const WORLD = 1008;
const POLL_MS = 5000;
const SETTLE_MS = 150;
/** A call into a hung page never settles: give up after this long. */
const CALL_MS = 2000;
const ARTWORK_SIDE = 128;
const MAX_ARTWORK_BYTES = 256 * 1024;

const READ = `(() => {
  const clip = (s, n = 300) => (typeof s === 'string' ? s.slice(0, n) : '');
  const m = navigator.mediaSession ? navigator.mediaSession.metadata : null;
  const players = [...document.querySelectorAll('video, audio')];
  const heard = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  return {
    title: clip(m && m.title),
    artist: clip(m && m.artist),
    album: clip(m && m.album),
    artwork: m ? [...m.artwork].slice(0, 8).map((a) => ({ src: clip(a.src, 2048), sizes: clip(a.sizes, 64), type: clip(a.type, 64) })) : [],
    playing: players.some(heard),
    players: players.length,
  };
})()`;

/** Pauses the players the page hasn't silenced itself, remembered (in this world only) for Play. */
const PAUSE = `(() => {
  const paused = [];
  for (const el of document.querySelectorAll('video, audio')) {
    if (el.paused || el.ended || el.muted || el.volume === 0) continue;
    el.pause();
    paused.push(new WeakRef(el));
  }
  if (paused.length > 0) globalThis.__chordPaused = paused;
  return paused.length;
})()`;

/** Plays what Chord paused, or, paused in the page, the player it got furthest into. */
const PLAY = `(() => {
  const mine = (globalThis.__chordPaused || []).map((r) => r.deref()).filter((el) => el && el.isConnected && el.paused && !el.ended);
  globalThis.__chordPaused = [];
  const last = [...document.querySelectorAll('video, audio')].filter((el) => el.paused && !el.ended && el.currentTime > 0).sort((a, b) => b.currentTime - a.currentTime);
  const players = mine.length > 0 ? mine : last.slice(0, 1);
  for (const el of players) el.play().catch(() => {});
  return players.length;
})()`;

interface PageMedia {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type: string }[];
  playing: boolean;
  players: number;
}

function call<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CALL_MS).unref?.())]);
}

/** The smallest image of at least `side` pixels, else the largest. */
function pickArtwork(images: PageMedia['artwork']): string | null {
  const sized = images
    .filter((a) => /^(https?:|data:image\/)/i.test(a.src))
    .map((a) => ({ src: a.src, side: Math.max(0, ...a.sizes.split(/\s+/).map((s) => Number(/^(\d+)x\d+$/i.exec(s)?.[1] ?? 0))) }));
  if (!sized.length) return null;
  const big = sized.filter((a) => a.side >= ARTWORK_SIDE).sort((a, b) => a.side - b.side);
  return (big[0] ?? sized.sort((a, b) => b.side - a.side)[0])!.src;
}

export interface MediaDeps {
  /** The service whose page plays ("Netflix"). */
  service(): string;
  report(media: MediaReport): void;
  artwork(data: string | null): void;
}

export class MediaWatch {
  private last = '';
  private lastArtworkSrc: string | null | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private again = false;
  current: MediaReport | null = null;

  constructor(
    private readonly contents: WebContents,
    private readonly deps: MediaDeps,
  ) {
    const soon = () => this.soon();
    contents.on('audio-state-changed', soon);
    contents.on('media-started-playing', soon);
    contents.on('media-paused', soon);
    contents.on('page-title-updated', soon);
    contents.on('did-navigate', soon);
    contents.on('did-navigate-in-page', soon);
  }

  async play(): Promise<void> {
    await call(this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: PLAY }], true), 0);
    await this.read();
  }

  async pause(): Promise<void> {
    await call(this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: PAUSE }]), 0);
    await this.read();
  }

  async mute(muted: boolean): Promise<boolean> {
    this.contents.setAudioMuted(muted);
    await this.read();
    return this.contents.isAudioMuted();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.timer = this.pending = null;
  }

  private soon(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.read();
    }, SETTLE_MS);
  }

  async read(): Promise<void> {
    if (this.contents.isDestroyed()) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    const page = (await call(this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: READ }]), null)) as PageMedia | null;
    this.reading = false;
    if (this.contents.isDestroyed()) return;
    const ok = page && typeof page === 'object' && Array.isArray(page.artwork);
    const report: MediaReport = {
      service: this.deps.service(),
      title: ok ? String(page.title) : '',
      artist: ok ? String(page.artist) : '',
      album: ok ? String(page.album) : '',
      page: this.contents.getTitle().slice(0, 300),
      // A player in an embedded frame isn't readable from here; its sound still says it plays.
      playing: ok ? page.playing || (this.contents.isCurrentlyAudible() && page.players === 0) : this.contents.isCurrentlyAudible(),
      muted: this.contents.isAudioMuted(),
      pausable: Boolean(ok && page.players > 0),
    };
    this.current = report;
    const key = JSON.stringify(report);
    if (key !== this.last) {
      this.last = key;
      this.deps.report(report);
    }
    this.poll(report.playing);
    void this.loadArtwork(ok ? pickArtwork(page.artwork) : null);
    if (this.again) {
      this.again = false;
      void this.read();
    }
  }

  private poll(playing: boolean): void {
    if (playing && !this.timer) this.timer = setInterval(() => void this.read(), POLL_MS);
    else if (!playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The artwork as a small data: URL, fetched through the page's own session; null when there's none to show. */
  private async loadArtwork(src: string | null): Promise<void> {
    if (src === this.lastArtworkSrc) return;
    this.lastArtworkSrc = src;
    let data: string | null = null;
    if (src?.startsWith('data:image/')) data = src.length <= MAX_ARTWORK_CHARS && /^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(src) ? src : null;
    else if (src) {
      try {
        const response = await this.contents.session.fetch(src, { signal: AbortSignal.timeout(8000) });
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const bytes = response.ok && /^image\/(png|jpeg|webp|gif|avif)$/.test(type) ? Buffer.from(await response.arrayBuffer()) : null;
        if (bytes && bytes.length > 0 && bytes.length <= MAX_ARTWORK_BYTES) data = `data:${type};base64,${bytes.toString('base64')}`;
      } catch {
        data = null;
      }
    }
    if (this.lastArtworkSrc === src && !this.contents.isDestroyed()) this.deps.artwork(data);
  }
}
