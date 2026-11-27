/**
 * #321 (Carbon's round 1 on #343): the E2E harness's wait for Chord's first pages. The product's own 15 s fallback goes
 * on with a notice (B1), a main with no gate fails rather than going on unwaited (B3), and one that never settles fails
 * with its timeline in the error (B2).
 */
import { describe, expect, it, vi } from 'vitest';
import { firstPagesCanLoad, notice, type Launched } from '../e2e/first-pages';

/** An app whose gate settles as `gate` does, with this timeline. */
function launched(gate: Promise<unknown> | 'none' | 'ended', timeline = '+29 ms  main started\n+14100 ms  ad blocking rules on (default)') {
  const close = vi.fn(async () => {});
  let calls = 0;
  const app: Launched = {
    evaluate: (async () => {
      calls++;
      if (calls === 1) {
        if (gate === 'ended') throw new Error('Target closed');
        return gate === 'none' ? 'no gate' : gate;
      }
      return timeline;
    }) as Launched['evaluate'],
    close,
  };
  return { app, close };
}

describe('the harness waits for Chord’s first pages (#321)', () => {
  it('rules on: the test goes on, nothing said', async () => {
    const log = vi.fn();
    expect(await firstPagesCanLoad(launched(Promise.resolve('ok')).app, { log })).toBe('ok');
    expect(log).not.toHaveBeenCalled();
  });

  it('the product’s 15 s cap (B1): the test goes on, and the timeline goes out as a notice', async () => {
    const log = vi.fn();
    expect(await firstPagesCanLoad(launched(Promise.resolve('timeout')).app, { log })).toBe('timeout');
    expect(log).toHaveBeenCalledWith('::notice title=Ad-blocking rules hit their 15 s cap at launch (#342)::+29 ms  main started%0A+14100 ms  ad blocking rules on (default)');
  });

  it('no gate in main (B3): fails, never going on unwaited', async () => {
    await expect(firstPagesCanLoad(launched('none').app, { log: vi.fn() })).rejects.toThrow(/no first-pages gate/);
  });

  it('never settled within the guard (B2): the app closed, and the timeline in the error', async () => {
    const { app, close } = launched(new Promise(() => {}), '+29 ms  main started\n+4356 ms  extensions and ad blocking loading');
    await expect(firstPagesCanLoad(app, { guardMs: 20, log: vi.fn() })).rejects.toThrow(/Its launch timeline:\n\+29 ms {2}main started\n\+4356 ms {2}extensions and ad blocking loading/);
    expect(close).toHaveBeenCalled();
  });

  it('main ended first (a launch its test ends): nothing to wait for', async () => {
    expect(await firstPagesCanLoad(launched('ended').app, { log: vi.fn() })).toBe('ended');
  });

  it('a notice keeps its lines and its percent signs', () => {
    expect(notice('t', 'a\nb 50%')).toBe('::notice title=t::a%0Ab 50%25');
  });
});
