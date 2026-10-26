/**
 * Main's side of sync (src/main/sync.ts) with the store's reducer behind it:
 * a chord another computer deleted never takes what only this computer has
 * (its Today tabs and open tabs move, a toast says where, and its Undo puts it
 * all back), and joining with *Use the synced setup* makes way before it
 * applies anything that would delete, so its one Undo covers everything.
 */
import { describe, expect, it, vi } from 'vitest';
import { apply, emptyApply, seedState, SYNC_OFF, type Chord, type Command, type State, type SyncApply, type TabNode } from '@chord/core';
import type { DataPush, SyncReply, SyncRequest } from '@chord/data';
import type { SyncView, Toast } from '@chord/ipc';

/** Whether the key kept opens here: by default it was kept on another computer, and this one's keyring can't read it. */
const keyring = vi.hoisted(() => ({ readable: false }));
vi.mock('electron', () => ({
  dialog: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async () => {
      if (!keyring.readable) throw new Error('not this computer’s');
      return { result: Buffer.alloc(32, 7).toString('base64'), shouldReEncrypt: false };
    },
  },
}));
const { SyncService } = await import('../../src/main/sync');

const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const chord = (id: string, rank: string): Chord => ({ id, profileId: 'default', name: id.toUpperCase(), icon: 'W', theme: THEME, rank, createdAt: 1 });
const tab = (id: string, chordId: string, extra: Partial<TabNode> = {}): TabNode => ({
  kind: 'tab',
  id,
  chordId,
  section: 'pinned',
  parentId: null,
  rank: 'a0',
  url: `https://${id}.test/`,
  title: id,
  pinnedUrl: `https://${id}.test/`,
  customTitle: null,
  favicon: null,
  lastActiveAt: 1,
  createdAt: 1,
  ...extra,
});

/** A store with this computer's chords: its first-run one, and "x", shown, with a Today tab and a pinned one. */
function harness(reply: (request: SyncRequest) => SyncReply, waiting: (key: string) => boolean = () => false) {
  let n = 0;
  const ctx = { now: 1000, newId: () => `id-${++n}` };
  let state: State = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  const home = Object.keys(state.chords)[0]!;
  const windowId = Object.keys(state.windows)[0]!;
  state = {
    ...state,
    chords: { ...state.chords, x: chord('x', 'b0') },
    nodes: { ...state.nodes, d: tab('d', 'x', { section: 'today', pinnedUrl: null }), p: tab('p', 'x') },
    windows: { ...state.windows, [windowId]: { ...state.windows[windowId]!, activeChordId: 'x', activeTab: { ...state.windows[windowId]!.activeTab, x: 'd' } } },
  };
  const commands: Command[] = [];
  const toasts: Toast[] = [];
  // Writes chord-data refused so far (main counts them): `fail` refuses one.
  let failures = 0;
  let flushing: () => void = () => undefined;
  const views: SyncView[] = [];
  let push: ((message: DataPush) => void) | null = null;
  const dispatch = (command: Command) => {
    commands.push(command);
    state = apply(state, command, ctx).state;
  };
  const service = new SyncService({
    data: { sync: async (request) => reply(request), flush: async () => flushing(), failures: () => failures, waiting, onPush: (listener) => (push = listener) },
    state: () => state,
    dispatch,
    effects: { syncSites: async () => undefined },
    toast: (_windowId, toast) => toasts.push(toast),
    lastWindow: () => windowId,
    notify: (view) => views.push(view),
    info: () => ({ name: 'Desk', os: 'Linux', app: '0.5.0' }),
    platform: 'linux',
    folder: () => '/home',
  });
  return { service, home, windowId, commands, toasts, views, fail: () => void failures++, whenFlushed: (then: () => void) => void (flushing = then), dispatch, state: () => state, push: (apply: SyncApply, versions?: Record<string, string>) => push!({ push: 'sync.apply', apply, ...(versions ? { versions } : {}) }) };
}

describe('a chord another computer deleted', () => {
  it('its Today tabs move to another chord, a toast says where, and its Undo brings everything back', async () => {
    const h = harness(() => ({}));
    h.push({ ...emptyApply(), gone: { ...emptyApply().gone, chords: ['x'] } });
    await vi.waitFor(() => expect(h.toasts).toHaveLength(1));
    expect(h.state().chords['x']).toBeUndefined();
    expect(h.state().nodes['d']).toMatchObject({ chordId: h.home, section: 'today' });
    expect(h.toasts[0]!.message).toBe('“X” was deleted on another computer. Its tab moved to “Personal”.');
    h.dispatch((h.toasts[0]!.action as { command: Command }).command);
    expect(h.state().chords['x']).toBeDefined();
    expect(h.state().nodes['p']).toMatchObject({ chordId: 'x', section: 'pinned' });
    expect(h.state().nodes['d']).toMatchObject({ chordId: 'x', section: 'today' });
  });
});

describe('a chord another computer deleted, while a change of yours to it waits', () => {
  it('its tabs’ tombstones wait with it, so when it goes it takes them, kept for its Undo', async () => {
    const asked: SyncRequest[] = [];
    const h = harness((request) => (asked.push(request), {}), (key) => key === 'chord:x');
    h.push({ ...emptyApply(), gone: { ...emptyApply().gone, chords: ['x'], nodes: [{ id: 'p', kind: 'tab' }] } });
    await vi.waitFor(() => expect(asked.some((r) => r.type === 'sync.repush')).toBe(true));
    expect(h.state().nodes['p']).toMatchObject({ chordId: 'x', section: 'pinned' });
    expect(asked.find((r) => r.type === 'sync.repush')).toMatchObject({ keys: expect.arrayContaining(['chord:x', 'node:p']) });
  });
});

describe('confirming what was applied', () => {
  const key = (type: string, id: string) => `${type}\n${id}`;

  it('a tab whose chord isn’t here yet, and one whose folder isn’t: not confirmed; once a chord or folder comes, what waited is asked for again', async () => {
    const asked: SyncRequest[] = [];
    const h = harness((request) => {
      asked.push(request);
      return {};
    });
    const confirmed = () => asked.filter((r): r is Extract<SyncRequest, { type: 'sync.applied' }> => r.type === 'sync.applied');
    const early = tab('early', 'later-chord');
    const inFolder = tab('in-folder', 'x', { parentId: 'later-folder' });
    h.push({ ...emptyApply(), chords: [chord('y', 'c0')], nodes: [early, inFolder] }, { [key('chord', 'y')]: 'v1', [key('tab', 'early')]: 'v2', [key('tab', 'in-folder')]: 'v3' });
    await vi.waitFor(() => expect(confirmed()).toHaveLength(1));
    // The chord that came is confirmed; the tab waiting for its chord, and the one put at the top for want of its folder, aren't.
    expect(confirmed()[0]!.versions).toEqual({ [key('chord', 'y')]: 'v1' });
    expect(h.state().nodes['early']).toBeUndefined();
    expect(h.state().nodes['in-folder']).toMatchObject({ chordId: 'x', parentId: null });
    // A chord came: what waited is asked for again.
    expect(asked.filter((r) => r.type === 'sync.reconcile')).toHaveLength(1);
    // A push of only tabs, all of which apply: confirmed, and nothing more asked for.
    h.push({ ...emptyApply(), nodes: [tab('plain', 'x')] }, { [key('tab', 'plain')]: 'v4' });
    await vi.waitFor(() => expect(confirmed()).toHaveLength(2));
    expect(confirmed()[1]!.versions).toEqual({ [key('tab', 'plain')]: 'v4' });
    expect(asked.filter((r) => r.type === 'sync.reconcile')).toHaveLength(1);
  });

  it('kept otherwise for good (a folder that would hold itself): confirmed, so it isn’t pushed again for nothing', async () => {
    const asked: SyncRequest[] = [];
    const h = harness((request) => {
      asked.push(request);
      return {};
    });
    const folder = { kind: 'folder' as const, id: 'f', chordId: 'x', section: 'pinned' as const, parentId: 'f', rank: 'a1', title: 'F', collapsed: false, createdAt: 1 };
    h.push({ ...emptyApply(), nodes: [folder] }, { [key('folder', 'f')]: 'v1' });
    await vi.waitFor(() => expect(asked.some((r) => r.type === 'sync.applied')).toBe(true));
    expect(h.state().nodes['f']).toMatchObject({ parentId: null });
    expect(asked.find((r) => r.type === 'sync.applied')).toMatchObject({ versions: { [key('folder', 'f')]: 'v1' } });
  });

  it('a write of what was applied that chord-data refused (a full disk): nothing is confirmed, and it’s asked for again later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const asked: SyncRequest[] = [];
      const h = harness((request) => {
        asked.push(request);
        return {};
      });
      // The store's write of the apply is refused (as persistence counts it) before main confirms.
      const flushed = vi.fn(() => h.fail());
      h.whenFlushed(flushed);
      h.push({ ...emptyApply(), nodes: [tab('plain', 'x')] }, { [key('tab', 'plain')]: 'v1' });
      for (let i = 0; i < 20 && flushed.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(10);
      expect(flushed).toHaveBeenCalled();
      expect(asked.some((r) => r.type === 'sync.applied')).toBe(false);
      // Asked for again, later.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(asked.some((r) => r.type === 'sync.reconcile')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('after a launch', () => {
  it('with a key kept that opens here: sync carries on, and never asks for the passphrase or says it’s paused, not even while the key is read', async () => {
    keyring.readable = true;
    try {
      const h = harness((request) => {
        if (request.type === 'sync.status') return { status: { ...SYNC_OFF, state: 'locked' }, keyBlob: 'a2V5' };
        if (request.type === 'sync.start') return { status: { ...SYNC_OFF, state: 'on' } };
        return {};
      });
      expect(h.service.view()).toMatchObject({ state: 'off', opening: false });
      await h.service.afterLaunch();
      expect(h.views.filter((v) => v.state === 'locked').every((v) => v.opening)).toBe(true);
      expect(h.views.at(-1)).toMatchObject({ state: 'on', opening: false, keyKept: true });
      expect(h.toasts).toEqual([]);
    } finally {
      keyring.readable = false;
    }
  });

  it('with no key kept: once that’s known, Settings asks, and a toast says so once', async () => {
    const h = harness((request) => (request.type === 'sync.status' ? { status: { ...SYNC_OFF, state: 'locked' } } : {}));
    await h.service.afterLaunch();
    expect(h.views.at(-1)).toMatchObject({ state: 'locked', opening: false });
    expect(h.toasts.map((t) => t.id)).toEqual(['sync:locked']);
    await h.service.refresh();
    expect(h.toasts).toHaveLength(1);
  });
});

describe('a profile copied from another computer', () => {
  it('its kept key can’t be read here: unlocking asks for a new id', async () => {
    const asked: SyncRequest[] = [];
    const h = harness((request) => {
      asked.push(request);
      if (request.type === 'sync.status') return { status: { ...SYNC_OFF, state: 'locked' }, keyBlob: 'a2V5' };
      if (request.type === 'sync.unlock') return { key: new Uint8Array(32), status: { ...SYNC_OFF, state: 'on' } };
      return {};
    });
    await h.service.afterLaunch();
    await h.service.unlock('correct horse battery staple');
    expect(asked.find((r) => r.type === 'sync.unlock')).toMatchObject({ rebind: true });
    // Once unlocked, not again.
    await h.service.unlock('correct horse battery staple');
    expect(asked.filter((r) => r.type === 'sync.unlock').at(-1)).not.toHaveProperty('rebind');
  });
});

describe('joining with Use the synced setup', () => {
  it('the synced chords come first, then this computer’s make way, then what deletes: one Undo brings all of this computer’s back', async () => {
    const apply: SyncApply = { ...emptyApply(), chords: [chord('synced', 'c0')], gone: { ...emptyApply().gone, chords: ['x'] } };
    const h = harness((request) => (request.type === 'sync.choose' ? { apply, replace: { to: 'synced', keep: ['synced'] }, status: { ...SYNC_OFF, state: 'on' } } : {}));
    const result = await h.service.choose('synced');
    expect(result.ok).toBe(true);
    expect(h.commands.map((c) => c.t)).toEqual(['sync.apply', 'sync.replace', 'sync.apply']);
    expect(Object.keys(h.state().chords)).toEqual(['synced']);
    const undo = h.toasts.find((t) => t.id === 'sync:replaced')!;
    expect(undo.message).toBe('This computer’s 2 chords made way for the synced setup');
    h.dispatch((undo.action as { command: Command }).command);
    expect(h.state().chords['x']).toBeDefined();
    expect(h.state().chords[h.home]).toBeDefined();
    expect(h.state().nodes['p']).toMatchObject({ chordId: 'x' });
    expect(h.state().nodes['d']).toMatchObject({ chordId: 'x', section: 'today' });
  });
});
