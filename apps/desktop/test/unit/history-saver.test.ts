import type { NavState } from '@chord/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySaver } from '../../src/main/history-saver';

const nav = (url: string, pageState?: string): NavState => ({ entries: [{ url, title: url, ...(pageState ? { pageState } : {}) }], index: 0 });

function setUp() {
  const histories = new Map<string, NavState | null>();
  const unsavable = new Set<string>();
  const save = vi.fn();
  const saver = new HistorySaver(
    { history: (id) => histories.get(id) ?? null, save, savable: (id) => !unsavable.has(id) },
    { soonMs: 2000, everyMs: 30_000 },
  );
  return { saver, histories, unsavable, save };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HistorySaver', () => {
  it('saves a tab about two seconds after it navigates, once for several navigations', () => {
    const { saver, histories, save } = setUp();
    histories.set('t1', nav('https://a.test/1'));
    saver.touch('t1' as never, true);
    histories.set('t1', nav('https://a.test/2'));
    saver.touch('t1' as never, true);
    vi.advanceTimersByTime(1999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledExactlyOnceWith('t1', nav('https://a.test/2'));
    saver.stop();
  });

  it('saves scrolling and typing at the next 30-second save, and only what changed', () => {
    const { saver, histories, save } = setUp();
    histories.set('t1', nav('https://a.test/', 'top'));
    saver.touch('t1' as never);
    vi.advanceTimersByTime(29_999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
    // Touched, but where it was: nothing written.
    saver.touch('t1' as never);
    vi.advanceTimersByTime(30_000);
    expect(save).toHaveBeenCalledOnce();
    histories.set('t1', nav('https://a.test/', 'halfway'));
    saver.touch('t1' as never);
    vi.advanceTimersByTime(30_000);
    expect(save).toHaveBeenLastCalledWith('t1', nav('https://a.test/', 'halfway'));
    saver.stop();
  });

  it('flushes on demand, skips private and closed tabs, and never rewrites what launch restored', () => {
    const { saver, histories, unsavable, save } = setUp();
    histories.set('t1', nav('https://a.test/'));
    histories.set('private', nav('https://secret.test/'));
    unsavable.add('private');
    saver.restored('t1' as never, nav('https://a.test/'));
    saver.touch('t1' as never);
    saver.touch('private' as never);
    saver.flush();
    expect(save).not.toHaveBeenCalled();

    histories.set('t2', nav('https://b.test/'));
    saver.touch('t2' as never);
    saver.forget('t2' as never);
    saver.flush();
    expect(save).not.toHaveBeenCalled();
    saver.stop();
  });
});
