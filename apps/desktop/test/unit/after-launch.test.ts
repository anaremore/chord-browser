import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AfterLaunch } from '../../src/main/after-launch';

const timing = { settleMs: 1000, capMs: 10_000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Signal = 'opened' | 'shellPainted' | 'pageLoaded';

describe('AfterLaunch', () => {
  // What happened at launch, and when the waiting work ran (ms from the first signal).
  const cases: { name: string; signals: Signal[]; runsAt: number }[] = [
    { name: 'the window painted and its page loaded', signals: ['opened', 'shellPainted', 'pageLoaded'], runsAt: timing.settleMs },
    { name: 'the page loaded before the window painted', signals: ['opened', 'pageLoaded', 'shellPainted'], runsAt: timing.settleMs },
    { name: 'no web page loaded (an empty chord, the archive)', signals: ['opened', 'shellPainted'], runsAt: timing.capMs },
    { name: 'the window never painted', signals: ['opened', 'pageLoaded'], runsAt: timing.capMs },
    { name: 'only a mini window opened', signals: ['opened'], runsAt: timing.capMs },
  ];
  for (const { name, signals, runsAt } of cases) {
    it(`runs its work once launch is over: ${name}`, () => {
      const launch = new AfterLaunch(timing);
      const task = vi.fn();
      launch.run(task);
      for (const signal of signals) launch[signal]();
      vi.advanceTimersByTime(runsAt - 1);
      expect(task).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(task).toHaveBeenCalledOnce();
      // Later windows painting and pages loading don't run it again, and nor does the cap.
      launch.shellPainted();
      launch.pageLoaded();
      vi.advanceTimersByTime(timing.capMs * 2);
      expect(task).toHaveBeenCalledOnce();
    });
  }

  it('runs work asked for after launch at once, and every task in order', () => {
    const launch = new AfterLaunch(timing);
    const order: string[] = [];
    launch.run(() => order.push('sweep'));
    launch.run(() => order.push('duet'));
    launch.opened();
    launch.shellPainted();
    launch.pageLoaded();
    vi.advanceTimersByTime(timing.settleMs);
    expect(order).toEqual(['sweep', 'duet']);
    launch.run(() => order.push('late'));
    expect(order).toEqual(['sweep', 'duet', 'late']);
  });
});
