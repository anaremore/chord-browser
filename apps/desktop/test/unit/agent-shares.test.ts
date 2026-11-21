/**
 * Sharing a tab with an outside agent (S18 M1e): when it can be shared, when
 * sharing ends (you stop it, the tab closes, leaves the site it was shared on
 * or goes to one you keep private, the agent goes), its bar, and what the
 * agent's scope makes of it (an `s` ref, read-only, refused in its own words
 * once sharing ends).
 */
import { emptyState, nodeOf, type State } from '@chord/core';
import { describe, expect, it } from 'vitest';
import { agentScope, NOT_SHARED, NOT_YOURS } from '../../src/main/agents/scope';
import { AgentShares, shareable } from '../../src/main/agents/shares';
import { ControlAgent } from '../../src/main/control/gate';
import { Store } from '../../src/main/store';

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const CODEX = { agentId: 'agent:1', name: 'Codex', chordId: '' };

/** Your Personal chord with a docs tab on screen, a private window with a tab, and an agent's chord with a tab. */
function setup() {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://docs.example.com/a' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://other.test/' });
  const other = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: mine });
  const never: string[] = [];
  const shares = new AgentShares({ store, neverSites: () => never });
  return { store, shares, mine, other, never };
}

const bar = (store: Store, nodeId: string) => store.state.live[nodeId]?.agent ?? null;

describe('Sharing a tab', () => {
  it('shares a web page of yours, with its bar; never a private window’s, an agent’s, a Chord page or a site you keep private', () => {
    const t = setup();
    expect(t.shares.share(t.mine, CODEX)).toBe(true);
    expect(t.shares.sharedWith(t.mine)).toEqual(CODEX);
    expect(bar(t.store, t.mine)).toEqual({ name: 'Codex', chordId: '', state: 'shared' });
    expect(t.shares.tabsOf('agent:1')).toEqual([t.mine]);

    t.store.dispatch({ t: 'tab.updated', nodeId: t.other, url: 'chord://settings/' });
    expect(shareable(t.store.state, t.other, [])).toBe(false);
    t.store.dispatch({ t: 'tab.updated', nodeId: t.other, url: 'https://bank.test/' });
    expect(shareable(t.store.state, t.other, ['bank.test'])).toBe(false);
    expect(shareable(t.store.state, t.other, [])).toBe(true);
    expect(shareable(t.store.state, 'no-such-tab', [])).toBe(false);
    const priv = { ...t.store.state, chords: { ...t.store.state.chords, c1: { ...t.store.state.chords['c1']!, private: true } } } as State;
    expect(shareable(priv, t.mine, [])).toBe(false);
  });

  it('ends when you stop it, the tab closes, leaves its site, goes somewhere you keep private, or the agent goes', () => {
    // [what happens, still shared after]
    const table: [string, (t: ReturnType<typeof setup>) => void, boolean][] = [
      ['another page on the same site', (t) => t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, url: 'https://www.example.com/b' }), true],
      ['its title changes', (t) => t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, title: 'Docs' }), true],
      ['you switch tabs', (t) => t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: t.other }), true],
      ['Stop sharing', (t) => t.shares.unshare(t.mine), false],
      ['the tab closes', (t) => t.store.dispatch({ t: 'tab.close', windowId: 'w1', nodeId: t.mine }), false],
      ['it leaves the site', (t) => t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, url: 'https://elsewhere.test/' }), false],
      ['it goes to a Chord page', (t) => t.store.dispatch({ t: 'tab.updated', nodeId: t.mine, url: 'chord://settings/' }), false],
      [
        'its site goes on the Never list',
        (t) => {
          t.never.push('example.com');
          t.store.dispatch({ t: 'settings.set', settings: { assistant: { neverSites: ['example.com'] } } });
        },
        false,
      ],
      ['the agent goes', (t) => t.shares.agentGone('agent:1'), false],
    ];
    for (const [what, act, stays] of table) {
      const t = setup();
      t.shares.share(t.mine, CODEX);
      act(t);
      expect(t.shares.sharedWith(t.mine) !== null, what).toBe(stays);
      if (!stays && nodeOf(t.store.state, t.mine)) expect(bar(t.store, t.mine), what).toBeNull();
    }
  });

  it('sharing with another agent takes the place of the first; its chord, once made, goes on the bar', () => {
    const t = setup();
    t.shares.share(t.mine, CODEX);
    t.shares.share(t.mine, { agentId: 'agent:2', name: 'Claude Code', chordId: '' });
    expect(t.shares.tabsOf('agent:1')).toEqual([]);
    expect(t.shares.sharedWith(t.mine)?.name).toBe('Claude Code');
    t.shares.chordMade('agent:2', 'chord-x');
    expect(bar(t.store, t.mine)).toEqual({ name: 'Claude Code', chordId: 'chord-x', state: 'shared' });
  });
});

describe('A shared tab in the agent’s scope', () => {
  it('is listed as s1, readable and inspectable; its own tabs number apart; once unshared it says so', () => {
    const t = setup();
    const agent = new ControlAgent('agent:1', async () => 'once');
    const scope = agentScope(agent, { state: () => t.store.state, chordId: () => null, neverSites: () => t.never, shared: () => t.shares.tabsOf('agent:1') });
    const node = () => nodeOf(t.store.state, t.mine) as Parameters<typeof scope.readable>[0];
    // Not shared: not listed, not readable, not its own.
    expect(scope.tabs()).toEqual([]);
    expect(scope.readable(node())).toBe(false);
    expect(scope.mayInspect(node(), 'read_form')).toBe(NOT_YOURS);
    t.shares.share(t.mine, CODEX);
    const listed = scope.tabs();
    expect(listed.map((x) => [x.node.id, x.given])).toEqual([[t.mine, true]]);
    expect(scope.refs.refFor(t.mine)).toBe('s1');
    expect(scope.refs.refFor('an-own-tab')).toBe('a1');
    expect(scope.readable(node())).toBe(true);
    expect(scope.mayInspect(node(), 'page_diagnostics')).toBeNull();
    t.shares.unshare(t.mine);
    expect(scope.tabs()).toEqual([]);
    expect(scope.readable(node())).toBe(false);
    expect(scope.whyNot?.(node())).toBe(NOT_SHARED);
    expect(scope.mayInspect(node(), 'read_form')).toBe(NOT_SHARED);
    // Its ref still names it: shared again, the same s1.
    t.shares.share(t.mine, CODEX);
    expect(scope.refs.refFor(t.mine)).toBe('s1');
  });

  it('a ref closed by hand (a tab handed to you) resolves as closed', () => {
    const t = setup();
    const scope = agentScope(new ControlAgent('agent:1', async () => 'once'), { state: () => t.store.state, chordId: () => 'c1', neverSites: () => [] });
    const ref = scope.refs.refFor(t.mine);
    expect(scope.refs.resolve(ref, () => true)).toEqual({ ok: true, id: t.mine });
    scope.refs.close(t.mine);
    expect(scope.refs.resolve(ref, () => true)).toEqual({ ok: false, why: 'closed' });
    // A new ref for it would be a new one, never the old.
    expect(scope.refs.refFor(t.mine)).toBe('a2');
  });
});
