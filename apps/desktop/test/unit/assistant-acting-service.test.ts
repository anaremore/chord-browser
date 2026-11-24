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
const { actCard } = await import('../../src/main/assistant/service');
const { Store } = await import('../../src/main/store');

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const dirs: string[] = [];
afterEach(() => {
  leases.ended.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Inner {
  stateFor(chordId: string): Promise<{ streaming: unknown; actTab: { nodeId: string; windowId: string } | null; actEnded: string | null; leased: Set<string>; queue: string[]; sendGrants: Map<string, Set<string>> }>;
  send(windowId: string, state: unknown, text: string): Promise<void>;
  barFor(nodeId: string, text: string | null): void;
  tailCard(s: unknown, nodeId: string, contents: unknown): (sites: string[], why: string | null, signal: AbortSignal, going?: string) => Promise<string>;
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
    // No shell here: the panel's pushes skip the window (isDestroyed); what acting asks (isMinimized) answers.
    allWindows: [{ id: 'w1', window: { isMinimized: () => false, isDestroyed: () => true } }],
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

  it('a tail card: each origin as cards show it (its own site is “its site”), where the page goes, a closed tab denied, and no answer in time takes it down (the reviews of #147)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { control: { ask: (card: unknown, signal: AbortSignal, waitMs: number) => Promise<string> } };
    const cards: { step: { site: string; sends?: string[]; going?: string }; takeDown?: AbortSignal; description: string; kind: string }[] = [];
    let answer = 'waiting';
    s.control.ask = async (card, _signal, waitMs) => {
      expect(waitMs).toBeLessThan(Infinity);
      cards.push(card as never);
      return answer;
    };
    let gone = false;
    const contents = { isDestroyed: () => gone, getURL: () => 'https://game.example/table' };
    const ask = t.inner.tailCard(s, t.mine, contents);
    expect(await ask(['https://game.example'], null, new AbortController().signal)).toBe('deny');
    expect(cards[0]!.step).toMatchObject({ site: 'game.example', sends: ['game.example'] });
    expect(actCard(cards[0] as never)?.note).toContain('its site');
    expect(cards[0]!.takeDown?.aborted).toBe(true);
    answer = 'always';
    expect(await ask(['https://shop.example'], 'leave', new AbortController().signal, 'https://shop.example/checkout')).toBe('once');
    expect(cards[1]!.step).toMatchObject({ site: 'shop.example', going: expect.stringContaining('shop.example') });
    expect(await ask(['https://shop.example'], null, new AbortController().signal)).toBe('until');
    gone = true;
    expect(await ask(['https://shop.example'], null, new AbortController().signal)).toBe('deny');
    expect(cards).toHaveLength(3);
  });

  it('Allow for this chat is the chat’s, per tab: your using the tab, the chat ending, or Settings’ Remove ends it (the reviews of #147)', async () => {
    for (const end of ['used', 'new', 'remove'] as const) {
      const t = setup();
      t.store.dispatch({ t: 'settings.set', settings: { assistant: { actSites: ['game.example'] } } });
      const s = await t.inner.stateFor('c1');
      s.sendGrants.set(t.mine, new Set(['https://game.example']));
      s.sendGrants.set(t.other, new Set(['https://shop.example']));
      if (end === 'used') t.service.userUsedTab(t.mine);
      else if (end === 'new') await t.service.act('w1', { do: 'new' } as never);
      else t.store.dispatch({ t: 'settings.set', settings: { assistant: { actSites: [] } } });
      expect(s.sendGrants.get(t.mine)?.size ?? 0, end).toBe(0);
      expect(s.sendGrants.get(t.other)?.size ?? 0, end).toBe(end === 'used' ? 1 : 0);
    }
  });

  it('a queued message acts where it was sent: its tab dequeued with it, and one sent with no tab on screen stays with none (Claude’s S7 on #147)', async () => {
    const t = setup();
    const s = (await t.inner.stateFor('c1')) as unknown as { streaming: unknown; windowId: string; queue: string[]; queuedWith: unknown[][]; queuedTab: unknown[] };
    const inner = t.service as unknown as { send: (...args: unknown[]) => Promise<void>; finishTurn(state: unknown, outcome: { status: 'done' }): Promise<void> };
    const sent: unknown[] = [];
    inner.send = async (...args) => void sent.push(args[5]);
    s.windowId = 'w1';
    for (const tab of [{ nodeId: t.mine, windowId: 'w1' }, null]) {
      s.streaming = { id: 'reply', body: { role: 'assistant', text: '' } };
      s.queue = ['and raise'];
      s.queuedWith = [[]];
      s.queuedTab = [tab];
      await inner.finishTurn(s, { status: 'done' });
    }
    expect(sent).toEqual([{ nodeId: t.mine, windowId: 'w1' }, null]);
  });
});
