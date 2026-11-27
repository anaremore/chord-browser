/**
 * #358: an outside agent's tabs are parked (attached to a window off screen, so they paint) for its session, the ones
 * AgentChords says run at full speed, not only while its bar says it's working: a detached view has no compositor, so
 * its page would get no animation frames at all while the agent thinks. Without the agents' chords, the bar decides.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const any: object = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any), apply: () => any, construct: () => any });
  return new Proxy({} as Record<string | symbol, unknown>, { get: (_t, k) => (k === 'then' ? undefined : any), has: () => true });
});

const { Browser } = await import('../../src/main/browser');

const view = (id: string) => ({ id, webContents: { isDestroyed: () => false } });

/** A Browser with one normal window (showing a tab of yours) and these agent tabs' views; `live`: each one's bar. */
function browser(fullSpeed: string[] | null, live: Record<string, { agent: { state: string } | null }> = {}) {
  const views = { a1: view('a1'), a2: view('a2') };
  const park = vi.fn();
  const w = { id: 'w1', isPrivate: false, window: { isDestroyed: () => false }, holds: () => false, park };
  const state = {
    windows: { w1: { id: 'w1', activeChordId: 'c1', activeTab: { c1: 'mine' } } },
    nodes: {},
    live,
  };
  const self = Object.assign(Object.create(Browser.prototype) as object, {
    store: { state },
    windows: new Map([['w1', w]]),
    tabs: { get: (id: string) => views[id as keyof typeof views] },
    readers: { viewFor: () => undefined },
    options: { screenShare: { sharedTabs: () => [] } },
    lastNormalWindow: () => w,
    agentFullSpeedTabs: fullSpeed ? () => fullSpeed : null,
  });
  (Browser.prototype as unknown as { agentSpeedChanged(): void }).agentSpeedChanged.call(self);
  return { park, views };
}

describe('an agent’s tabs parked for its session (#358)', () => {
  it('the tabs AgentChords says run at full speed are parked, whatever their bar says (past its 45 s steady frame)', () => {
    const { park, views } = browser(['a1', 'a2'], { a1: { agent: null }, a2: { agent: null } });
    expect(park).toHaveBeenCalledWith([views.a1, views.a2]);
  });

  it('none at full speed (done, stopped, paused, or past the 10 min cap): none parked, even one its bar still shows working', () => {
    const { park } = browser([], { a1: { agent: { state: 'working' } } });
    expect(park).toHaveBeenCalledWith([]);
  });

  it('without the agents’ chords: the tabs its bar shows as worked on, as before', () => {
    const { park, views } = browser(null, { a1: { agent: { state: 'working' } }, a2: { agent: null } });
    expect(park).toHaveBeenCalledWith([views.a1]);
  });
});
