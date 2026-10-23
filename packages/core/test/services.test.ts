import { describe, expect, it } from 'vitest';
import { apply, describeLoadError, emptyState, restoreState, type Context } from '../src';

describe('describeLoadError', () => {
  it('names the problem in plain words and keeps the code for experts', () => {
    expect(describeLoadError(-106, 'a.test')).toMatchObject({ kind: 'offline', name: 'ERR_INTERNET_DISCONNECTED', action: 'retry' });
    expect(describeLoadError(-105, 'typo.test')).toMatchObject({ kind: 'not-found', title: 'Can’t find typo.test.' });
    expect(describeLoadError(-102, 'localhost')).toMatchObject({ kind: 'unreachable', name: 'ERR_CONNECTION_REFUSED' });
    expect(describeLoadError(-312, '127.0.0.1')).toMatchObject({ kind: 'blocked', name: 'ERR_UNSAFE_PORT' });
    expect(describeLoadError(-999, '')).toMatchObject({ kind: 'failed', name: 'ERR_999' });
  });

  it('offers a way back, not a retry, for certificate errors', () => {
    expect(describeLoadError(-202, 'self-signed.test')).toMatchObject({ kind: 'insecure', action: 'back', name: 'ERR_CERT_AUTHORITY_INVALID' });
  });
});

describe('downloads', () => {
  const ctx: Context = { now: 1, newId: () => 'x' };
  const file = (id: string, state: 'progressing' | 'completed', startedAt: number) => ({
    id,
    url: `https://a.test/${id}`,
    filename: `${id}.zip`,
    path: `C:/Downloads/${id}.zip`,
    mime: 'application/zip',
    state,
    received: 5,
    total: 10,
    speed: 0,
    startedAt,
    endedAt: state === 'completed' ? startedAt + 1 : null,
  });

  it('tracks progress, clears only finished downloads, and comes back interrupted after a restart', () => {
    let state = emptyState();
    state = apply(state, { t: 'download.update', download: file('a', 'progressing', 1) }, ctx).state;
    state = apply(state, { t: 'download.update', download: file('b', 'completed', 2) }, ctx).state;
    expect(apply(state, { t: 'download.update', download: file('b', 'completed', 2) }, ctx).patches).toHaveLength(0);
    state = apply(state, { t: 'download.clear' }, ctx).state;
    expect(Object.keys(state.downloads)).toEqual(['a']);

    const seed = { now: 1, newId: () => 'n', theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'h' };
    const restored = restoreState({ chords: [], nodes: [], windows: [], settings: {}, downloads: [file('a', 'progressing', 1)] }, seed);
    expect(restored.downloads['a']).toMatchObject({ state: 'interrupted', speed: 0 });
  });
});

describe('extensions', () => {
  const ctx: Context = { now: 1, newId: () => 'x' };
  const ID = 'nngceckbapebfimnlniiiahkandclblb';
  const ext = { id: ID, profileId: 'default', name: 'Bitwarden', version: '1.0', source: 'store' as const, path: '/e', notifiedVersion: null, pinned: true, installedAt: 1, updatedAt: 1 };

  it('records installs per profile and forgets removals', () => {
    let state = emptyState();
    state = apply(state, { t: 'extension.record', extension: ext }, ctx).state;
    state = apply(state, { t: 'extension.record', extension: { ...ext, profileId: 'work' } }, ctx).state;
    expect(Object.keys(state.extensions).sort()).toEqual([`default:${ID}`, `work:${ID}`]);
    expect(apply(state, { t: 'extension.record', extension: ext }, ctx).patches).toHaveLength(0);
    state = apply(state, { t: 'extension.forget', profileId: 'work', id: ID }, ctx).state;
    expect(Object.keys(state.extensions)).toEqual([`default:${ID}`]);
  });

  it('pins and unpins, and a removal can be undone this session', () => {
    let state = apply(emptyState(), { t: 'extension.record', extension: ext }, ctx).state;
    state = apply(state, { t: 'extension.pin', profileId: 'default', id: ID, pinned: false }, ctx).state;
    expect(state.extensions[`default:${ID}`]?.pinned).toBe(false);
    state = apply(state, { t: 'extension.forget', profileId: 'default', id: ID }, ctx).state;
    expect(state.extensions).toEqual({});
    expect(state.removedExtensions).toHaveLength(1);
    state = apply(state, { t: 'extension.restore', profileId: 'default', id: ID }, ctx).state;
    expect(state.extensions[`default:${ID}`]).toEqual({ ...ext, pinned: false });
    expect(state.removedExtensions).toEqual([]);
    expect(apply(state, { t: 'extension.restore', profileId: 'default', id: ID }, ctx).patches).toHaveLength(0);
  });

  it('remembers where extension buttons go', () => {
    const state = apply(emptyState(), { t: 'settings.set', settings: { extensionButtons: 'titleBar' } }, ctx).state;
    expect(state.settings.extensionButtons).toBe('titleBar');
    const seed = { now: 1, newId: () => 'n', theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'h' };
    expect(restoreState({ chords: [], nodes: [], windows: [], settings: { extensionButtons: 'titleBar' } }, seed).settings.extensionButtons).toBe('titleBar');
    expect(restoreState({ chords: [], nodes: [], windows: [], settings: { extensionButtons: 'toolbar' } }, seed).settings.extensionButtons).toBe('sidebar');
  });

  it('restores only well-formed installs', () => {
    const seed = { now: 1, newId: () => 'n', theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'h' };
    const restored = restoreState(
      {
        chords: [],
        nodes: [],
        windows: [],
        settings: {},
        extensions: [ext, { ...ext, id: 'not-an-id' }, { ...ext, profileId: 'work', source: 'sideloaded' as 'store' }, { ...ext, profileId: 'p2', path: '' }],
      },
      seed,
    );
    expect(Object.values(restored.extensions)).toEqual([ext]);
  });
});

describe('site permissions', () => {
  const ctx: Context = { now: 1, newId: () => 'x' };

  it('remembers decisions per origin and forgets them on null', () => {
    let state = emptyState();
    state = apply(state, { t: 'permission.set', origin: 'https://meet.test', permissions: ['camera', 'microphone'], decision: 'allow' }, ctx).state;
    expect(state.sitePermissions['https://meet.test']).toEqual({ camera: 'allow', microphone: 'allow' });
    state = apply(state, { t: 'permission.set', origin: 'https://meet.test', permissions: ['camera', 'microphone'], decision: null }, ctx).state;
    expect(state.sitePermissions).toEqual({});
  });

  it('restores only well-formed decisions', () => {
    const seed = { now: 1, newId: () => 'n', theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'h' };
    const state = restoreState(
      { chords: [], nodes: [], windows: [], settings: {}, sitePermissions: { 'https://a.test': { camera: 'allow', location: 'maybe' as never } } },
      seed,
    );
    expect(state.sitePermissions).toEqual({ 'https://a.test': { camera: 'allow' } });
  });
});

describe('themes and appearance settings', () => {
  const ctx: Context = { now: 1, newId: () => 'x' };
  const seed = { now: 1, newId: () => 'n', theme: { stops: [{ l: 0.7, c: 0.1, h: 1 }], grain: 0.2, appearance: 'auto' as const }, homeUrl: 'h' };

  it('saves custom themes, and chords made from one follow its edits', () => {
    let state = restoreState(null, seed);
    const chordId = Object.keys(state.chords)[0]!;
    const theme = { id: 't1', name: 'Mine', stops: [{ l: 0.7, c: 0.12, h: 40 }], grain: 0.3 };
    state = apply(state, { t: 'theme.save', theme }, ctx).state;
    state = apply(state, { t: 'chord.theme', chordId, theme: { stops: theme.stops, grain: theme.grain, themeId: 't1' } }, ctx).state;
    state = apply(state, { t: 'theme.save', theme: { ...theme, stops: [{ l: 0.7, c: 0.12, h: 200 }] } }, ctx).state;
    expect(state.chords[chordId]!.theme.stops[0]!.h).toBe(200);
    state = apply(state, { t: 'theme.delete', id: 't1' }, ctx).state;
    expect(state.settings.themes).toEqual([]);
    expect(state.chords[chordId]!.theme).toMatchObject({ themeId: null, stops: [{ h: 200 }] });
  });

  it('clamps interface settings and restores only valid themes', () => {
    let state = restoreState(null, seed);
    state = apply(state, { t: 'settings.set', settings: { colorScheme: 'dark', interface: { contrast: 2 } } }, ctx).state;
    expect(state.settings).toMatchObject({ colorScheme: 'dark', interface: { contrast: 1, glass: 0.5 } });
    const restored = restoreState(
      { chords: [], nodes: [], windows: [], settings: { colorScheme: 'sepia', themes: [{ id: 'a', name: 'A', stops: [{ l: 0.5, c: 0.1, h: 10 }], grain: 0.2 }, { id: 'b', stops: [] }] } },
      seed,
    );
    expect(restored.settings.colorScheme).toBe('system');
    expect(restored.settings.themes.map((t) => t.id)).toEqual(['a']);
  });
});
