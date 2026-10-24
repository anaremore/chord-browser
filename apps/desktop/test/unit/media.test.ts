import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINGER_MS, MediaWatcher, POLL_MS } from '../../src/main/media';

/** What the isolated world's read answers. */
interface Page {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type: string }[];
  playing: boolean;
  video: boolean;
  players: number;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A tab's page as Electron shows it to main: events, sound, and scripts run in Chord's isolated world. */
class FakePage extends EventEmitter {
  destroyed = false;
  audible = false;
  page: Page = { title: 'Song', artist: 'Artist', album: 'Album', artwork: [], playing: true, video: false, players: 1 };
  reads = 0;
  scripts: { world: number; gesture: boolean | undefined; kind: string }[] = [];
  artwork = { type: 'image/png', bytes: PNG };
  readonly session = {
    fetch: vi.fn(async () => new Response(new Uint8Array(this.artwork.bytes), { headers: { 'content-type': this.artwork.type } })),
  };

  isDestroyed() {
    return this.destroyed;
  }
  isCrashed() {
    return false;
  }
  isCurrentlyAudible() {
    return this.audible;
  }
  async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[], gesture?: boolean): Promise<unknown> {
    const code = scripts[0]!.code;
    const kind = code.includes('mediaSession') ? 'read' : code.includes('el.pause()') ? 'pause' : 'play';
    this.scripts.push({ world, gesture, kind });
    if (kind === 'read') {
      this.reads++;
      return structuredClone(this.page);
    }
    this.page.playing = kind === 'play';
    return 1;
  }
  /** Sound starts or stops, as Chromium reports it. */
  sound(audible: boolean) {
    this.audible = audible;
    this.emit('audio-state-changed', { audible });
  }
}

function setUp() {
  const changed = vi.fn();
  const tabs = new Map<string, FakePage>();
  const media = new MediaWatcher({ isTab: (contents, nodeId) => tabs.get(nodeId) === (contents as unknown as FakePage), changed });
  const open = (nodeId: string) => {
    const page = new FakePage();
    tabs.set(nodeId, page);
    media.attach(page as unknown as WebContents, nodeId as never);
    return page;
  };
  return { media, changed, tabs, open };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MediaWatcher', () => {
  it('lists a tab once it makes sound and its page is read, with what its Media Session says', async () => {
    const { media, open, changed } = setUp();
    const page = open('t1');
    page.sound(true);
    expect(media.list()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()).toEqual([{ nodeId: 't1', title: 'Song', artist: 'Artist', album: 'Album', artwork: null, playing: true, pausable: true, video: false, pip: false }]);
    expect(changed).toHaveBeenCalledTimes(1);
    // Read in Chord's own isolated world, never the page's.
    expect(page.scripts.every((s) => s.world === 1008)).toBe(true);
    media.stop();
  });

  it('reads a playing tab every few seconds, and stops reading once nothing plays', async () => {
    const { media, open } = setUp();
    const page = open('t1');
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    const first = page.reads;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(page.reads).toBe(first + 3);
    // Paused in the page: Electron says so, the read confirms it, and the reading stops.
    page.page.playing = false;
    page.sound(false);
    page.emit('media-paused');
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()[0]).toMatchObject({ playing: false, pausable: true });
    const paused = page.reads;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(page.reads).toBe(paused);
    media.stop();
  });

  it('keeps a paused tab a minute, then lets it go; playing again in time keeps it', async () => {
    const { media, open } = setUp();
    const page = open('t1');
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    page.page.playing = false;
    page.sound(false);
    await vi.advanceTimersByTimeAsync(LINGER_MS - 1000);
    expect(media.list()).toHaveLength(1);
    page.page.playing = true;
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(media.list()[0]).toMatchObject({ playing: true });
    page.page.playing = false;
    page.sound(false);
    await vi.advanceTimersByTimeAsync(LINGER_MS + 200);
    expect(media.list()).toEqual([]);
    media.stop();
  });

  it('pauses and plays from the isolated world (Play as your gesture), and believes the page over Electron’s lagging sound report', async () => {
    const { media, open } = setUp();
    const page = open('t1');
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    // Chromium goes on reporting sound for a moment after a pause: the card says paused at once.
    await media.act('t1' as never, 'pause');
    expect(media.list()[0]).toMatchObject({ playing: false });
    page.sound(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(media.list()[0]).toMatchObject({ playing: false });
    await media.act('t1' as never, 'play');
    expect(media.list()[0]).toMatchObject({ playing: true });
    expect(page.scripts.filter((s) => s.kind !== 'read')).toEqual([
      { world: 1008, gesture: false, kind: 'pause' },
      { world: 1008, gesture: true, kind: 'play' },
    ]);
    media.stop();
  });

  it('sound that goes on after the page’s own players stop comes from elsewhere: still playing, but not pausable', async () => {
    const { media, open } = setUp();
    const page = open('t1');
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    // Its own player stops; an embedded frame's keeps the tab audible.
    page.page.playing = false;
    page.emit('media-paused');
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()[0]).toMatchObject({ playing: false });
    await vi.advanceTimersByTimeAsync(1200);
    expect(media.list()[0]).toMatchObject({ playing: true, pausable: false });
    media.stop();
  });

  it('fetches artwork through the tab’s session: a small image of a type the card shows, or nothing', async () => {
    const { media, open } = setUp();
    const page = open('t1');
    page.page.artwork = [
      { src: 'https://art.test/64.png', sizes: '64x64', type: 'image/png' },
      { src: 'https://art.test/256.png', sizes: '256x256', type: 'image/png' },
    ];
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(page.session.fetch).toHaveBeenCalledExactlyOnceWith('https://art.test/256.png', expect.anything());
    expect(media.list()[0]!.artwork).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    // A new track whose artwork turns out to be SVG, or too big: the card shows the site's icon instead.
    page.artwork = { type: 'image/svg+xml', bytes: Buffer.from('<svg/>') };
    page.page.artwork = [{ src: 'https://art.test/next', sizes: '', type: '' }];
    page.emit('page-title-updated');
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()[0]!.artwork).toBeNull();
    page.artwork = { type: 'image/jpeg', bytes: Buffer.alloc(300 * 1024) };
    page.page.artwork = [{ src: 'https://art.test/big.jpg', sizes: '', type: '' }];
    page.emit('page-title-updated');
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()[0]!.artwork).toBeNull();
    media.stop();
  });

  it('lists the newest first, and drops a tab at once when its page goes or navigates', async () => {
    const { media, open } = setUp();
    const a = open('a');
    a.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    const b = open('b');
    b.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list().map((p) => p.nodeId)).toEqual(['b', 'a']);
    b.emit('did-navigate');
    expect(media.list().map((p) => p.nodeId)).toEqual(['a']);
    a.destroyed = true;
    a.emit('destroyed');
    expect(media.list()).toEqual([]);
    media.stop();
  });

  it('ignores a page that isn’t its tab’s (Peek’s, before it becomes a tab)', async () => {
    const { media, open, tabs } = setUp();
    const page = open('t1');
    tabs.delete('t1');
    page.sound(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(media.list()).toEqual([]);
    expect(page.reads).toBe(0);
    media.stop();
  });
});
