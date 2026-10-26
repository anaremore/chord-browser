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
import type { Toast } from '@chord/ipc';

vi.mock('electron', () => ({
  dialog: {},
  // A key kept on another computer: this one's keyring can't read it.
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async () => {
      throw new Error('not this computer’s');
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
  let push: ((message: DataPush) => void) | null = null;
  const dispatch = (command: Command) => {
    commands.push(command);
    state = apply(state, command, ctx).state;
  };
  const service = new SyncService({
    data: { sync: async (request) => reply(request), flush: async () => undefined, waiting, onPush: (listener) => (push = listener) },
    state: () => state,
    dispatch,
    effects: { syncSites: async () => undefined },
    toast: (_windowId, toast) => toasts.push(toast),
    lastWindow: () => windowId,
    notify: () => undefined,
    info: () => ({ name: 'Desk', os: 'Linux', app: '0.5.0' }),
    platform: 'linux',
    folder: () => '/home',
  });
  return { service, home, windowId, commands, toasts, dispatch, state: () => state, push: (apply: SyncApply) => push!({ push: 'sync.apply', apply }) };
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
