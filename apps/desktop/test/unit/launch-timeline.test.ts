/**
 * #321 (Carbon's B2 on #343): a launch whose first page never started (its ad-blocking rules never on) still prints
 * its timeline at quit, and the E2E harness can read it to put beside a failure or a notice.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = Object.assign(new EventEmitter(), { isPackaged: false });
vi.mock('electron', () => ({ app }));
vi.mock('../../src/main/launch-netlog', () => ({ recordNetLog: vi.fn(), requestEvents: vi.fn(async () => []), stopNetLog: vi.fn() }));

const printed: string[] = [];

beforeEach(() => {
  vi.resetModules();
  app.removeAllListeners();
  printed.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation((text: string) => void printed.push(text));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { chordLaunchTimeline?: unknown }).chordLaunchTimeline;
});

describe('launch’s timeline (#321)', () => {
  it('no navigation ever started (the rules never on): the slow block at 5 s, and again at quit', async () => {
    const { watchLaunch, mark } = await import('../../src/main/launch-timeline');
    watchLaunch(5000);
    mark('ad blocking rules staged (default)');
    vi.advanceTimersByTime(5000);
    expect(printed).toHaveLength(1);
    app.emit('will-quit');
    expect(printed).toHaveLength(2);
    expect(printed[1]).toContain('[chord] slow launch: at quit, the first page never loaded');
    expect(printed[1]).toContain('ad blocking rules staged (default)');
  });

  it('a quick launch that quit before 5 s, nothing started: nothing at quit', async () => {
    const { watchLaunch } = await import('../../src/main/launch-timeline');
    watchLaunch(5000);
    app.emit('will-quit');
    expect(printed).toEqual([]);
  });

  it('the harness reads the timeline so far (development and tests)', async () => {
    const { watchLaunch, mark } = await import('../../src/main/launch-timeline');
    watchLaunch(5000);
    mark('ad blocking rules written (default)');
    const read = (globalThis as { chordLaunchTimeline?: () => string }).chordLaunchTimeline;
    expect(read?.()).toMatch(/\+\d+ ms {2}main started\n\+\d+ ms {2}ad blocking rules written \(default\)/);
  });
});
