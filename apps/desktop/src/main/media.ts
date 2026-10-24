/**
 * Now playing (ARCHITECTURE.md §9, DESIGN.md §7.10): which tabs play media,
 * what they play, and the sidebar card's play and pause.
 *
 * Electron says when a page makes sound (`audio-state-changed`, still true
 * while the tab is muted) and when its players start and stop, but not what's
 * playing. Chord reads the page's Media Session metadata and its media
 * elements from an isolated world: the page's DOM and Media Session, none of
 * its scripts. The page gets nothing and learns nothing, and no form is read.
 * Electron has isolated worlds only in a tab's main frame, so a player in an
 * embedded frame (a video in an article) shows with its tab's title, and can
 * be muted but not paused.
 *
 * A read is one round trip to the page's renderer. It happens when Electron
 * reports a change, and while something plays every few seconds (a playlist
 * can move on without telling Electron). With nothing playing, nothing runs.
 * A tab that pauses stays a minute, so it can be played again from the card.
 */
import { isArtworkType, pickArtwork, usableDataIcon, type MediaImage, type NodeId } from '@chord/core';
import type { NowPlaying } from '@chord/ipc';
import type { WebContents } from 'electron';

/** Chord's isolated world for this: same DOM as the page, none of its scripts. */
const WORLD = 1008;
/** While a tab plays, how often its page is read again. */
export const POLL_MS = 5000;
/** A paused tab stays on the card this long. */
export const LINGER_MS = 60_000;
/** Electron's reports come in bursts (a pause, the sound stopping, a new title): one read once they settle. */
const SETTLE_MS = 150;
/** After a page's players stop, Electron goes on saying it makes sound for a moment; sound that lasts longer comes from elsewhere. */
const SOUND_LAG_MS = 1000;
/** Artwork for the card's 40 px square at up to 150% on a 2× screen, and no heavier than this. */
const ARTWORK_SIDE = 128;
const MAX_ARTWORK_BYTES = 256 * 1024;

/**
 * What the page says it plays. A player counts as playing when the page
 * hasn't silenced it itself (a muted background loop isn't "now playing").
 */
const READ = `(() => {
  const clip = (s, n = 200) => (typeof s === 'string' ? s.slice(0, n) : '');
  const m = navigator.mediaSession ? navigator.mediaSession.metadata : null;
  const players = [...document.querySelectorAll('video, audio')];
  const heard = (el) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  const big = (el) => { const r = el.getBoundingClientRect(); return r.width >= 200 && r.height >= 112; };
  return {
    title: clip(m && m.title),
    artist: clip(m && m.artist),
    album: clip(m && m.album),
    artwork: m ? [...m.artwork].slice(0, 8).map((a) => ({ src: clip(a.src, ${Math.ceil((MAX_ARTWORK_BYTES * 4) / 3) + 64}), sizes: clip(a.sizes), type: clip(a.type) })) : [],
    playing: players.some(heard),
    video: players.some((el) => el instanceof HTMLVideoElement && heard(el) && el.readyState >= 2 && !el.disablePictureInPicture && big(el)),
    players: players.length,
  };
})()`;

/** Pauses what the page plays, and remembers it (in this world only) for Play. */
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

/** Plays what Chord paused; or, paused in the page itself, the player it got furthest into. */
const PLAY = `(() => {
  const mine = (globalThis.__chordPaused || []).map((r) => r.deref()).filter((el) => el && el.isConnected && el.paused && !el.ended);
  globalThis.__chordPaused = [];
  const last = [...document.querySelectorAll('video, audio')].filter((el) => el.paused && !el.ended && el.currentTime > 0).sort((a, b) => b.currentTime - a.currentTime);
  const players = mine.length > 0 ? mine : last.slice(0, 1);
  for (const el of players) el.play().catch(() => {});
  return players.length;
})()`;

/** What READ answers. */
interface PageMedia {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
  playing: boolean;
  video: boolean;
  /** Media elements in the page itself: the ones Chord can pause and play. */
  players: number;
}

interface Session {
  contents: WebContents;
  /** When it last started playing: the card shows the newest. */
  since: number;
  playing: boolean;
  page: PageMedia | null;
  /** When the page's own players last stopped (null while they play). */
  quietAt: number | null;
  artwork: { src: string; data: string | null } | null;
  /** Lets it go a while after it paused. */
  linger: ReturnType<typeof setTimeout> | null;
  /** A read waiting for reports to settle; one under way, and whether another is due after it. */
  pending: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  again: boolean;
  /** What the card shows of it, the last time it changed (artwork by address, not its bytes). */
  shown: string;
}

export interface MediaDeps {
  /** The tab this page is now (Peek's and mini windows' pages aren't tabs until they're adopted). */
  isTab(contents: WebContents, nodeId: NodeId): boolean;
  /** What the cards offer changed. */
  changed(): void;
}

export class MediaWatcher {
  private readonly sessions = new Map<NodeId, Session>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Goes up whenever what the cards would show changes, so windows compare a number, not the list. */
  version = 0;

  constructor(private readonly deps: MediaDeps) {}

  get size(): number {
    return this.sessions.size;
  }

  has(nodeId: NodeId): boolean {
    return this.sessions.has(nodeId);
  }

  /** Watch a tab's page: sound starting begins a session, and changes are read once they settle. */
  attach(contents: WebContents, nodeId: NodeId): void {
    const mine = () => !contents.isDestroyed() && this.deps.isTab(contents, nodeId);
    const soon = () => {
      if (mine()) this.soon(nodeId, SETTLE_MS);
    };
    contents.on('audio-state-changed', (event) => {
      if (event.audible && mine()) this.heard(nodeId, contents);
      else soon();
    });
    contents.on('media-started-playing', soon);
    contents.on('media-paused', soon);
    // A playlist moving on often changes only the title (or, in a web app, the address).
    contents.on('page-title-updated', soon);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) soon();
    });
    // A new document: whatever played is gone.
    contents.on('did-navigate', () => this.end(nodeId, contents));
    contents.once('destroyed', () => this.end(nodeId, contents));
  }

  /** What's playing (or paused a moment ago), newest first. */
  list(): NowPlaying[] {
    return [...this.sessions.entries()].sort(([, a], [, b]) => b.since - a.since).map(([nodeId, s]) => view(nodeId, s));
  }

  /** The card's Play or Pause. */
  async act(nodeId: NodeId, action: 'play' | 'pause'): Promise<void> {
    const s = this.sessions.get(nodeId);
    if (!s || s.contents.isDestroyed()) return;
    // Playing again counts as your gesture, as a click in the page would.
    await s.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: action === 'pause' ? PAUSE : PLAY }], action === 'play').catch(() => 0);
    await this.read(nodeId);
  }

  /** Stop watching everything (quitting). */
  stop(): void {
    for (const nodeId of [...this.sessions.keys()]) this.end(nodeId);
  }

  /** The page made sound: a session starts (or carries on), and it's read soon. */
  private heard(nodeId: NodeId, contents: WebContents): void {
    let s = this.sessions.get(nodeId);
    if (s && s.contents !== contents) this.end(nodeId);
    s = this.sessions.get(nodeId);
    if (!s) {
      s = { contents, since: Date.now(), playing: true, page: null, quietAt: null, artwork: null, linger: null, pending: null, reading: false, again: false, shown: '' };
      this.sessions.set(nodeId, s);
      this.poll();
    }
    this.soon(nodeId, SETTLE_MS);
  }

  private soon(nodeId: NodeId, delay: number): void {
    const s = this.sessions.get(nodeId);
    if (!s) return;
    if (s.pending) clearTimeout(s.pending);
    s.pending = setTimeout(() => {
      s.pending = null;
      void this.read(nodeId);
    }, delay);
  }

  private async read(nodeId: NodeId): Promise<void> {
    const s = this.sessions.get(nodeId);
    if (!s) return;
    if (s.reading) {
      s.again = true;
      return;
    }
    s.reading = true;
    const page = await readPage(s.contents);
    s.reading = false;
    if (this.sessions.get(nodeId) !== s || s.contents.isDestroyed()) return;
    const wasPlaying = s.page?.playing ?? false;
    if (page) s.page = page;
    const now = Date.now();
    const audible = s.contents.isCurrentlyAudible();
    // The page's own players say whether they play. Just after they stop, Electron still reports sound for a
    // moment; sound that goes on past that comes from elsewhere (an embedded frame's player, Web Audio).
    if (!page || page.playing) s.quietAt = null;
    else if (wasPlaying) s.quietAt = now;
    const settling = s.quietAt !== null && now - s.quietAt < SOUND_LAG_MS;
    this.setPlaying(nodeId, s, Boolean(page?.playing) || (audible && !settling));
    if (audible && settling) this.soon(nodeId, SOUND_LAG_MS - (now - s.quietAt!));
    void this.loadArtwork(nodeId, s);
    this.update(nodeId, s);
    if (s.again) {
      s.again = false;
      void this.read(nodeId);
    }
  }

  private setPlaying(nodeId: NodeId, s: Session, playing: boolean): void {
    if (playing === s.playing) return;
    s.playing = playing;
    if (playing) {
      s.since = Date.now();
      if (s.linger) clearTimeout(s.linger);
      s.linger = null;
    } else {
      s.linger = setTimeout(() => this.end(nodeId, s.contents), LINGER_MS);
    }
    this.poll();
  }

  /** Reads playing tabs every few seconds while any plays; with none playing, the timer stops. */
  private poll(): void {
    const playing = [...this.sessions.values()].some((s) => s.playing);
    if (playing && !this.timer) {
      this.timer = setInterval(() => {
        for (const [nodeId, s] of this.sessions) if (s.playing) void this.read(nodeId);
      }, POLL_MS);
    } else if (!playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async loadArtwork(nodeId: NodeId, s: Session): Promise<void> {
    const src = (s.page && pickArtwork(s.page.artwork, ARTWORK_SIDE)?.src) ?? null;
    if ((s.artwork?.src ?? null) === src) return;
    s.artwork = src ? { src, data: null } : null;
    if (!src) return;
    const data = await fetchArtwork(s.contents, src);
    if (this.sessions.get(nodeId) !== s || s.artwork?.src !== src) return;
    s.artwork.data = data;
    this.update(nodeId, s);
  }

  /** Tell the windows, if what the card would show of it changed. */
  private update(nodeId: NodeId, s: Session): void {
    const shown = JSON.stringify({ ...view(nodeId, s), artwork: s.artwork?.data ? s.artwork.src : null, since: s.since });
    if (shown === s.shown) return;
    s.shown = shown;
    this.version++;
    this.deps.changed();
  }

  private end(nodeId: NodeId, contents?: WebContents): void {
    const s = this.sessions.get(nodeId);
    if (!s || (contents && s.contents !== contents)) return;
    if (s.linger) clearTimeout(s.linger);
    if (s.pending) clearTimeout(s.pending);
    this.sessions.delete(nodeId);
    this.poll();
    if (s.shown) {
      this.version++;
      this.deps.changed();
    }
  }
}

function view(nodeId: NodeId, s: Session): NowPlaying {
  const page = s.page;
  return {
    nodeId,
    title: page?.title ?? '',
    artist: page?.artist ?? '',
    album: page?.album ?? '',
    artwork: s.artwork?.data ?? null,
    playing: s.playing,
    // Playing, its own players are what plays; paused, Play can start one of them again.
    pausable: Boolean(page && page.players > 0 && (page.playing || !s.playing)),
    video: s.playing && Boolean(page?.video),
  };
}

/** Reads the page from Chord's isolated world; null when it can't be read (crashed, between documents). */
async function readPage(contents: WebContents): Promise<PageMedia | null> {
  if (contents.isDestroyed() || contents.isCrashed()) return null;
  try {
    const page = (await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: READ }])) as PageMedia | null;
    return page && typeof page === 'object' && Array.isArray(page.artwork) ? page : null;
  } catch {
    return null;
  }
}

/**
 * The artwork as a data: URL: fetched through the tab's own session (as its
 * favicon is), only an image of a type the card shows, and small. Null when
 * it can't be had; the card shows the site's icon instead.
 */
async function fetchArtwork(contents: WebContents, src: string): Promise<string | null> {
  if (src.startsWith('data:')) {
    const type = /^data:([^;,]+)/i.exec(src)?.[1]?.toLowerCase() ?? '';
    return isArtworkType(type) && usableDataIcon(src, MAX_ARTWORK_BYTES) ? src : null;
  }
  if (!/^https?:/i.test(src) || contents.isDestroyed()) return null;
  try {
    const response = await contents.session.fetch(src, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!isArtworkType(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
