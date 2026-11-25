/**
 * The assistant and an outside agent's tabs (S18 M2e-1): read only when you point at one (it's attached: on screen
 * when you sent the message, or added to it), never filled; your own tabs as before.
 */
import { emptyState, nodeOf, TabRefs, type NodeId, type State, type TabNode } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { AGENT_TAB_REFUSALS, duetScope, type DuetChat, type DuetHost } from '../../src/main/assistant/scope';
import { ControlAgent } from '../../src/main/control/gate';
import { Store } from '../../src/main/store';

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

function setup() {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['ag'] = { id: 'ag', profileId: 'default', name: 'Claude Code', icon: '✳', theme, rank: 'a1', createdAt: 1, agent: { name: 'Claude Code' } };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://mine.test/' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'agent.tab.add', chordId: 'ag', nodeId: 'a1', url: 'https://shop.test/checkout' });
  const chat: DuetChat = {
    chordId: 'c1',
    thread: { id: 't1', chordId: 'c1', title: '', scope: 'all', provider: 'claude', model: null, createdAt: 0, lastUsedAt: 0 } as unknown as DuetChat['thread'],
    refs: new TabRefs<NodeId>('t'),
    attached: new Set(),
    pointed: new Set(),
    actTab: null,
    actEnded: null,
    windowId: 'w1',
    control: new ControlAgent('chat:1', async () => 'once'),
    pdfs: new Map(),
    form: null,
    nextField: 1,
    read: new Set(),
  };
  const host = {
    browser: { store } as unknown as DuetHost['browser'],
    settings: () => ({ readsNothing: false, neverSites: [] }),
    readable: () => true,
    agentOf: (node: TabNode) => store.state.chords[node.chordId]?.agent?.name ?? null,
    activeTab: () => null,
    activity: async () => undefined,
    search: async () => [],
    fills: () => ({ refuse: () => null, show: async () => undefined }),
  } satisfies DuetHost;
  const tab = (id: string) => nodeOf(store.state, id) as TabNode;
  return { chat, host, scope: duetScope(chat, host), mine, tab };
}

describe('An outside agent’s tab, for the assistant (S18 M2e-1)', () => {
  it('left out of everything until you point at it, even with All your tabs', () => {
    const t = setup();
    expect(t.scope.tabs().map(({ node }) => node.id)).toEqual([t.mine]);
    expect(t.scope.readable(t.tab('a1'))).toBe(false);
    expect(t.scope.whyNot?.(t.tab('a1'))).toBe(AGENT_TAB_REFUSALS.read('Claude Code'));
    // Your own tab: as before.
    expect(t.scope.readable(t.tab(t.mine))).toBe(true);
    expect(t.scope.whyNot?.(t.tab(t.mine))).toBeNull();
  });

  it('attached (on screen when you sent it, or added): read, but never filled', () => {
    const t = setup();
    t.chat.attached.add('a1');
    t.chat.pointed.add('a1');
    expect(t.scope.tabs().map(({ node }) => node.id).sort()).toEqual([t.mine, 'a1'].sort());
    expect(t.scope.readable(t.tab('a1'))).toBe(true);
    expect(t.scope.whyNot?.(t.tab('a1'))).toBeNull();
    expect(t.scope.mayInspect(t.tab('a1'), 'propose_fill')).toBe(AGENT_TAB_REFUSALS.act('Claude Code'));
    expect(AGENT_TAB_REFUSALS.act('Claude Code')).toBe('That tab is Claude Code’s. Keep it first to make it yours, then I can act in it.');
  });

  it('pointing is per message: an agent’s tab attached to an earlier message isn’t read for the next one', () => {
    const t = setup();
    t.chat.attached.add('a1');
    // The next message points at nothing of the agent's.
    expect(t.scope.readable(t.tab('a1'))).toBe(false);
    expect(t.scope.tabs().map(({ node }) => node.id)).toEqual([t.mine]);
    expect(t.scope.defaultTab()).toBeNull();
  });

  it('under any scope, the tab the message points at is listed; a never-readable one gets the usual refusal, not a hint', () => {
    const t = setup();
    (t.chat.thread as { scope: string }).scope = 'ask';
    t.chat.pointed.add('a1');
    expect(t.scope.tabs().map(({ node }) => node.id).sort()).toEqual([t.mine, 'a1'].sort());
    t.chat.pointed.clear();
    const never = setup();
    const scope = duetScope(never.chat, { ...never.host, readable: () => false });
    expect(scope.whyNot?.(never.tab('a1'))).toBeNull();
  });
});
