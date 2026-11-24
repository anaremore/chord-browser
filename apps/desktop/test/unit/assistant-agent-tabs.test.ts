/**
 * The assistant's panel and an outside agent's tabs (S18 M2e-1), through AssistantService itself: the tab on screen
 * is the agent's the window shows over your chord's (so it's what a message points at), and the attach menu lists
 * agents' tabs by agent, whatever the chat's scope.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, type AssistantScope, type State } from '@chord/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {}, clipboard: {}, BrowserWindow: class {}, WebContentsView: class {} }));
const { AssistantService } = await import('../../src/main/assistant/service');
const { Store } = await import('../../src/main/store');

const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(scope: AssistantScope) {
  const state: State = emptyState();
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.chords['ag'] = { id: 'ag', profileId: 'default', name: 'Claude Code', icon: '✳', theme, rank: 'a1', createdAt: 1, agent: { name: 'Claude Code' } };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  state.settings = { ...state.settings, assistant: { ...state.settings.assistant, scope, enabled: true } };
  const store = new Store(state);
  store.dispatch({ t: 'tab.open', windowId: 'w1', url: 'https://mine.test/' });
  const mine = store.state.windows['w1']!.activeTab['c1']!;
  store.dispatch({ t: 'agent.tab.add', chordId: 'ag', nodeId: 'a1', url: 'https://shop.test/checkout' });
  store.dispatch({ t: 'tab.updated', nodeId: 'a1', title: 'Checkout' } as never);
  const dir = mkdtempSync(join(tmpdir(), 'chord-assistant-'));
  dirs.push(dir);
  const persistence = { assistant: async () => ({ threads: [] }) };
  // No windows to push the panel to (its push runs on a timer after the test too).
  const service = new AssistantService({ store, allWindows: [] } as never, persistence as never, dir);
  return { store, service, mine };
}

describe('The assistant’s panel and an agent’s tab (S18 M2e-1)', () => {
  for (const scope of ['every', 'ask', 'chord', 'all'] as const) {
    it(`${scope}: the attach menu lists the agent’s tab by its agent; on screen, it’s the tab a message points at`, async () => {
      const t = setup(scope);
      let view = await t.service.view('w1');
      expect(view.attachable.map((a) => a.title)).toContain('Claude Code · Checkout');
      expect(view.attachable.find((a) => a.nodeId === 'a1')?.url).toBe('https://shop.test/checkout');
      // The tab on screen goes with a message (every scope but "Ask every time"): yours, until the window shows the agent's.
      const current = () => view.attachments.filter((a) => a.current).map((a) => a.nodeId);
      expect(current()).toEqual(scope === 'every' ? [] : [t.mine]);
      t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
      expect(t.store.state.windows['w1']!.agentTab).toBe('a1');
      view = await t.service.view('w1');
      expect(current()).toEqual(scope === 'every' ? [] : ['a1']);
    });
  }

  it('a message queued while a reply runs keeps what was on screen when you sent it, not the agent’s tab you look at after', async () => {
    const t = setup('ask');
    type Inner = { stateFor(chordId: string): Promise<{ streaming: unknown; queue: string[]; queuedWith: { url: string }[][] }>; send(windowId: string, state: unknown, text: string): Promise<void> };
    const inner = t.service as unknown as Inner;
    const state = await inner.stateFor('c1');
    state.streaming = { id: 'reply' };
    await inner.send('w1', state, 'and summarize this');
    t.store.dispatch({ t: 'tab.activate', windowId: 'w1', nodeId: 'a1' });
    expect(state.queue).toEqual(['and summarize this']);
    expect(state.queuedWith.map((list) => list.map((a) => a.url))).toEqual([['https://mine.test/']]);
  });
});
