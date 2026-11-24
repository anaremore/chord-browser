/**
 * The assistant service's side of acting (S18 M2e-2a; the reviews of #147): the message's tab only when acting is on,
 * your hands ending any lease whatever the chat is doing, Stop letting tails go, the message's tab leaving the screen,
 * every way a chat ends, and only its own bars cleared.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, type State } from '@chord/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {}, net: {}, nativeImage: {}, ClipboardItem: class {} }));
const leases = vi.hoisted(() => ({ ended: [] as unknown[] }));
vi.mock('../../src/main/control/user-watch', () => ({
  beginUserAction: async () => 'on',
  endUserAction: () => undefined,
  endUserLease: (contents: unknown) => void leases.ended.push(contents),
}));
const { AssistantService } = await import('../../src/main/assistant/service');
const { USER_TAB_REFUSALS } = await import('../../src/main/assistant/scope');
const { Store } = await import('../../src/main/store');

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const dirs: string[] = [];
afterEach(() => {
  leases.ended.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Inner {
  stateFor(chordId: string): Promise<{ streaming: unknown; actTab: { nodeId: string; windowId: string } | null; actEnded: string | null; leased: Set<string>; queue: string[] }>;
  send(windowId: string, state: unknown, text: string): Promise<void>;
  barFor(nodeId: string, text: string | null): void;
}

function setup(acting = true) {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.settings = { ...state.settings, assistant: { ...state.settings.assistant, enabled: true, acting } };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://game.example/table' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://shop.example/', background: true });
  const other = Object.values(store.state.nodes).flatMap((b) => Object.values(b)).find((n) => n.kind === 'tab' && n.id !== mine)!.id;
  const pages = new Map<string, { isDestroyed(): boolean }>();
  const page = (id: string) => {
    let p = pages.get(id);
    if (!p) pages.set(id, (p = { isDestroyed: () => false }));
    return p;
  };
  const dir = mkdtempSync(join(tmpdir(), 'chord-assistant-'));
  dirs.push(dir);
  const browser = {
    store,
    allWindows: [{ id: 'w1', window: { isMinimized: () => false } }],
    peeks: { isOpen: () => false },
    tabs: { get: (id: string) => ({ webContents: page(id) }) },
    assistantBars: false,
  };
  const service = new AssistantService(browser as never, { assistant: async () => ({ threads: [] }) } as never, dir);
  const inner = service as unknown as Inner;
  /** A turn under way for the message just sent (no provider: the state is as send left it). */
  const turn = async () => {
    const s = await inner.stateFor('c1');
    s.streaming = { id: 'reply' };
    s.actTab = acting ? { nodeId: mine, windowId: 'w1' } : null;
    s.actEnded = null;
    return s;
  };
  return { store, service, inner, mine, other, page, turn };
}

describe('The service’s side of acting (S18 M2e-2a; the reviews of #147)', () => {
  it('acting off (Settings): no message’s tab, and your click in the tab during a reply says nothing (Claude’s B1)', async () => {
    const t = setup(false);
    const s = await t.turn();
    t.service.userUsedTab(t.mine);
    expect(s.actEnded).toBeNull();
    // An outside agent's bar on a tab is never cleared by the assistant: it only clears bars it put up.
    t.store.dispatch({ t: 'tab.live', nodeId: t.mine, live: { agent: { state: 'working', name: 'Codex', chordId: 'c1' } } });
    t.inner.barFor(t.mine, null);
    expect(t.store.state.live[t.mine]?.agent?.name).toBe('Codex');
  });

  it('your click or your page move after the turn still ends any lease of the assistant’s there (Claude’s and Neon’s B2)', async () => {
    const t = setup();
    const s = await t.inner.stateFor('c1');
    s.streaming = null;
    s.leased.add(t.mine);
    t.service.userUsedTab(t.mine);
    expect(leases.ended).toContain(t.page(t.mine));
    leases.ended.length = 0;
    t.service.userMovedPage(t.page(t.other) as never);
    expect(leases.ended).toContain(t.page(t.other));
  });

  it('Stop (Ctrl+.) lets go of a tail still running after the turn (Claude’s B2)', async () => {
    const t = setup();
    const s = await t.inner.stateFor('c1');
    s.leased.add(t.mine);
    t.service.stopAll();
    expect(leases.ended).toContain(t.page(t.mine));
    expect(s.leased.size).toBe(0);
  });

  it('the message’s tab leaving the screen ends acting for the message, with no coming back (Neon’s B6)', async () => {
    const t = setup();
    const s = await t.turn();
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other });
    expect(s.actEnded).toBe(USER_TAB_REFUSALS.switched);
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.mine });
    expect(s.actEnded).toBe(USER_TAB_REFUSALS.switched);
  });

  it('every way a chat ends lets its leases go: a new chat, Settings’ Nothing, the chord turned off (E6)', async () => {
    for (const end of ['new', 'nothing', 'chordOff'] as const) {
      const t = setup();
      const s = await t.turn();
      s.leased.add(t.mine);
      if (end === 'new') await t.service.act('w1', { do: 'new' } as never);
      else if (end === 'nothing') t.store.dispatch({ t: 'settings.set', settings: { assistant: { readsNothing: true } } });
      else t.store.dispatch({ t: 'settings.set', settings: { assistant: { offChords: ['c1'] } } });
      expect(leases.ended, end).toContain(t.page(t.mine));
    }
  });
});
