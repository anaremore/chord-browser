import { apply, emptyState, type Command, type NodeId, type State } from '@chord/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: { on: vi.fn(), off: vi.fn() } }));
const { IdleKeeper } = await import('../../src/main/idle');

/** A window on one tab, with a second tab in the background that's been hidden long enough to sleep. */
function setup() {
  let state: State = emptyState();
  const theme = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
  state.chords['c1'] = { id: 'c1', profileId: 'default', name: 'Personal', icon: '✦', theme, rank: 'a0', createdAt: 0 };
  state.windows['w1'] = { id: 'w1', activeChordId: 'c1', activeTab: { c1: null }, sidebar: 'docked', sidebarWidth: 248, bounds: null };
  let n = 0;
  const run = (command: Command) => (state = apply(state, command, { now: 0, newId: () => `t${++n}` }).state);
  run({ t: 'tab.open', windowId: 'w1', url: 'https://slides.test/', background: true });
  run({ t: 'tab.open', windowId: 'w1', url: 'https://meet.test/' });
  const dispatched: Command[] = [];
  let answerPip: ((inPip: boolean) => void) | null = null;
  const keeper = new IdleKeeper(
    {
      state: () => state,
      dispatch: (command) => dispatched.push(command),
      tabs: {
        loaded: () => ['t1', 't2'] as NodeId[],
        isPlaying: () => false,
        // Asking a page whether it's in picture-in-picture takes a moment.
        inPictureInPicture: () => new Promise<boolean>((resolve) => (answerPip = resolve)),
      },
      isCapturing: () => false,
      memoryLow: () => false,
    },
    { checkMs: 1000, archiveAfterMs: () => null, sleepAfterMs: 1000, pressureSleepAfterMs: 1000, memoryCheckMs: 1000 },
  );
  /** Answer the picture-in-picture question, once the check has asked it. */
  const answer = async (inPip: boolean) => {
    await vi.waitFor(() => expect(answerPip).not.toBeNull());
    answerPip!(inPip);
  };
  return { keeper, dispatched, run, answer, asked: () => vi.waitFor(() => expect(answerPip).not.toBeNull()) };
}

describe('the idle check', () => {
  it('puts a tab hidden long enough to sleep', async () => {
    const t = setup();
    const checked = t.keeper.check(10_000);
    await t.answer(false);
    await checked;
    expect(t.dispatched).toEqual([{ t: 'tab.sleep', nodeId: 't1' }]);
  });

  it('leaves it be when a page starts sharing it while the check asks about picture-in-picture', async () => {
    const t = setup();
    const checked = t.keeper.check(10_000);
    // The share starts while the question is out.
    await t.asked();
    t.run({ t: 'tab.live', nodeId: 't1', live: { shared: true } });
    await t.answer(false);
    await checked;
    expect(t.dispatched).toEqual([]);
  });
});
