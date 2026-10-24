import { describe, expect, it } from 'vitest';
import { apply, cardMedia, emptyState, imageSide, mediaVisibleTo, pickArtwork, type Command, type Context, type MediaImage, type State, type TabNode } from '../src';

const image = (src: string, sizes = '', type = ''): MediaImage => ({ src, sizes, type });

describe('artwork', () => {
  it('reads the longest side an image gives', () => {
    expect(imageSide('96x96')).toBe(96);
    expect(imageSide('96x96 512X256')).toBe(512);
    expect(imageSide('any')).toBe(0);
    expect(imageSide('')).toBe(0);
  });

  it('picks the smallest image big enough, else the biggest smaller one, else one without a size', () => {
    const small = image('https://a.test/64.png', '64x64');
    const fit = image('https://a.test/128.png', '128x128');
    const huge = image('https://a.test/1024.png', '1024x1024');
    const unsized = image('https://a.test/any.png');
    expect(pickArtwork([huge, unsized, fit, small], 128)).toBe(fit);
    expect(pickArtwork([small, unsized], 128)).toBe(small);
    expect(pickArtwork([unsized], 128)).toBe(unsized);
    expect(pickArtwork([], 128)).toBeNull();
  });

  it('only takes web addresses and image data, of a type the card shows (never SVG)', () => {
    expect(pickArtwork([image('file:///etc/art.png', '128x128'), image('chord://shell/x.png', '128x128')], 128)).toBeNull();
    expect(pickArtwork([image('https://a.test/a.svg', '128x128', 'image/svg+xml')], 128)).toBeNull();
    const data = image('data:image/png;base64,iVBORw0KGgo=', '96x96', 'image/png');
    expect(pickArtwork([data], 128)).toBe(data);
    expect(pickArtwork([image('https://a.test/a.webp', '128x128', 'image/webp')], 128)?.src).toBe('https://a.test/a.webp');
  });
});

describe('which media a window offers', () => {
  function setup() {
    let n = 0;
    const ctx: Context = { now: 1000, newId: () => `id-${++n}` };
    let state: State = emptyState();
    const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
    state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
    state.chords['c2'] = { id: 'c2', profileId: 'default', name: 'Work', icon: '♪', theme, rank: 'b0', createdAt: 0 };
    state.chords['p'] = { id: 'p', profileId: 'private-w2', name: 'Private', icon: '•', theme, rank: 'z', createdAt: 0, private: true };
    state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
    state.windows['w2'] = { id: 'w2', activeChordId: 'p', activeTab: { p: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null, private: true };
    const run = (command: Command) => (state = apply(state, command, ctx).state);
    run({ t: 'tab.open', windowId: 'w1', url: 'https://music.test/' });
    const music = state.windows['w1']!.activeTab['c1']!;
    run({ t: 'tab.open', windowId: 'w1', url: 'https://notes.test/' });
    const notes = state.windows['w1']!.activeTab['c1']!;
    run({ t: 'chord.activate', windowId: 'w1', chordId: 'c2' });
    run({ t: 'tab.open', windowId: 'w1', url: 'https://podcast.test/' });
    const podcast = state.windows['w1']!.activeTab['c2']!;
    run({ t: 'tab.open', windowId: 'w2', url: 'https://secret.test/' });
    const secret = state.windows['w2']!.activeTab['p']!;
    return { state: () => state, run, music, notes, podcast, secret };
  }

  it('a normal window: every chord it lists, never a private window’s tabs', () => {
    const t = setup();
    const playing = [{ nodeId: t.secret }, { nodeId: t.podcast }, { nodeId: t.music }, { nodeId: 'gone' }];
    expect(mediaVisibleTo(t.state(), 'w1', playing).map((p) => p.nodeId)).toEqual([t.podcast, t.music]);
    // A private window: its own tabs only.
    expect(mediaVisibleTo(t.state(), 'w2', playing).map((p) => p.nodeId)).toEqual([t.secret]);
  });

  it('the card leaves out what the window shows, a split’s other panes too', () => {
    const t = setup();
    const playing = [{ nodeId: t.podcast }, { nodeId: t.music }, { nodeId: t.notes }];
    // The window is on Work, showing the podcast.
    expect(cardMedia(t.state(), 'w1', playing).map((p) => p.nodeId)).toEqual([t.music, t.notes]);
    t.run({ t: 'tab.activate', windowId: 'w1', nodeId: t.notes });
    t.run({ t: 'split.add', windowId: 'w1', withId: t.notes, nodeId: t.music });
    expect(cardMedia(t.state(), 'w1', playing).map((p) => p.nodeId)).toEqual([t.podcast]);
  });
});

describe('muting a tab', () => {
  it('is kept on the tab, tells main to silence its page, and changes nothing when it already is', () => {
    const ctx: Context = { now: 1, newId: () => 'id-1' };
    let state = emptyState();
    const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
    state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
    state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
    state = apply(state, { t: 'tab.open', windowId: 'w1', url: 'https://music.test/' }, ctx).state;
    const muted = apply(state, { t: 'tab.mute', nodeId: 'id-1', muted: true }, ctx);
    expect((muted.state.nodes['id-1'] as TabNode).muted).toBe(true);
    expect(muted.effects).toEqual([{ e: 'view.mute', nodeId: 'id-1', muted: true }]);
    expect(apply(muted.state, { t: 'tab.mute', nodeId: 'id-1', muted: true }, ctx).patches).toEqual([]);
    const unmuted = apply(muted.state, { t: 'tab.mute', nodeId: 'id-1', muted: false }, ctx);
    // Unmuted, the field goes: a tab that was never muted and one that was look the same.
    expect('muted' in unmuted.state.nodes['id-1']!).toBe(false);
    expect(unmuted.effects).toEqual([{ e: 'view.mute', nodeId: 'id-1', muted: false }]);
    expect(apply(state, { t: 'tab.mute', nodeId: 'nope', muted: true }, ctx).patches).toEqual([]);
  });
});
