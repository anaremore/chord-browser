/**
 * #336 (Neon's NSF3): a page that crashes while a read or an action waits for it to load ends the wait at once (its
 * crash says why: blockedNow), and one already crashed is never waited on.
 */
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { pageLoaded } from '../../src/main/control/tool-call';

function loadingPage() {
  const page = Object.assign(new EventEmitter(), { crashed: false, isDestroyed: () => false, isLoading: () => true, isCrashed: () => page.crashed });
  return page;
}

describe('waiting for a page to load (#336, Neon’s NSF3)', () => {
  it('a crash meanwhile ends the wait at once', async () => {
    vi.useFakeTimers();
    try {
      const page = loadingPage();
      let over = false;
      const waiting = pageLoaded(page as unknown as WebContents, 15_000).then(() => (over = true));
      await Promise.resolve();
      page.crashed = true;
      page.emit('render-process-gone', {}, { reason: 'crashed' });
      // No timer advanced: the crash alone ends it.
      for (let i = 0; i < 5 && !over; i++) await Promise.resolve();
      expect(over).toBe(true);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a page already crashed is never waited on', async () => {
    vi.useFakeTimers();
    try {
      const page = loadingPage();
      page.crashed = true;
      let over = false;
      void pageLoaded(page as unknown as WebContents, 15_000).then(() => (over = true));
      for (let i = 0; i < 5 && !over; i++) await Promise.resolve();
      expect(over).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
