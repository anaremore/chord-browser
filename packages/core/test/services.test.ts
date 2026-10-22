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
