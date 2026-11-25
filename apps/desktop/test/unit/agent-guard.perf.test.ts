/**
 * The typing guard every tab of yours has, dormant (S18 M2e-2a; invariant 9, the reviews of #147): what it costs a
 * page that never sees the assistant act. Installing it is a handful of capture listeners; each key the page gets
 * runs one of them, which returns at once while it's down. Measured here against the same window without it.
 */
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { GUARDED_EVENTS, installAgentGuard } from '../../src/preload/agent-guard';

/** A window with a page's own capture listener on keydown, as most pages with shortcuts have. */
function page(guarded: boolean) {
  const win = Object.assign(new EventTarget(), { document: { activeElement: null }, setTimeout: () => 0, clearTimeout: () => undefined });
  const t0 = performance.now();
  if (guarded) installAgentGuard(win as never);
  const install = performance.now() - t0;
  let seen = 0;
  win.addEventListener('keydown', () => void seen++, true);
  return { win, install, seen: () => seen };
}

/** Microseconds a key (keydown, keypress, keyup, beforeinput) takes to reach the page, the median of 5 runs. */
function perKey(guarded: boolean): number {
  const p = page(guarded);
  const events = (['keydown', 'keypress', 'keyup', 'beforeinput'] as const).map((type) => new Event(type));
  const runs: number[] = [];
  for (let run = 0; run < 5; run++) {
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) for (const e of events) p.win.dispatchEvent(e);
    runs.push(((performance.now() - t0) * 1000) / 20_000);
  }
  expect(p.seen()).toBe(100_000);
  return runs.sort((a, b) => a - b)[2]!;
}

describe('The typing guard, dormant, in a tab of yours (invariant 9)', () => {
  it('installs in under 2 ms, and adds under 5 µs to each key the page gets', () => {
    expect(GUARDED_EVENTS.length).toBe(7);
    const installs = Array.from({ length: 20 }, () => page(true).install).sort((a, b) => a - b);
    perKey(false);
    const without = perKey(false);
    const withGuard = perKey(true);
    // What CI prints, for the record (docs/decisions/S18-agent-mcp.md, M2e-2a).
    console.log(`agent guard: install median ${installs[10]!.toFixed(3)} ms; a key ${without.toFixed(2)} µs without, ${withGuard.toFixed(2)} µs with`);
    expect(installs[10]!).toBeLessThan(2);
    expect(withGuard - without).toBeLessThan(5);
  });
});
