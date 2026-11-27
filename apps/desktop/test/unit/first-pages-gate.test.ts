/**
 * #321 (Carbon's B3 on #343): the E2E harness's gate exists from main's first moment, before index.ts loads (entry.ts
 * imports it first), so a harness that asks early waits instead of finding nothing and going on; index.ts opens that
 * same promise, with how it settled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const slot = globalThis as { chordFirstPagesGate?: Promise<'ok' | 'timeout'> };

afterEach(() => {
  delete slot.chordFirstPagesGate;
  delete (globalThis as { chordOpenFirstPagesGate?: unknown }).chordOpenFirstPagesGate;
  vi.resetModules();
  vi.doUnmock('electron');
});

describe('the first pages’ gate (#321)', () => {
  it('development and tests: there on import, open only when index.ts says, with how', async () => {
    vi.doMock('electron', () => ({ app: { isPackaged: false } }));
    const { openFirstPagesGate } = await import('../../src/main/first-pages-gate');
    const gate = slot.chordFirstPagesGate;
    expect(gate).toBeInstanceOf(Promise);
    let result: string | null = null;
    void gate!.then((r) => (result = r));
    await Promise.resolve();
    expect(result).toBeNull();
    openFirstPagesGate('timeout');
    await gate;
    expect(result).toBe('timeout');
  });

  it('imported again (entry.ts, then index.ts): one gate, never a second one in its place', async () => {
    vi.doMock('electron', () => ({ app: { isPackaged: false } }));
    await import('../../src/main/first-pages-gate');
    const first = slot.chordFirstPagesGate;
    vi.resetModules();
    const { openFirstPagesGate } = await import('../../src/main/first-pages-gate');
    expect(slot.chordFirstPagesGate).toBe(first);
    openFirstPagesGate('ok');
    expect(await first).toBe('ok');
  });

  it('a packaged build: no gate at all', async () => {
    vi.doMock('electron', () => ({ app: { isPackaged: true } }));
    const { openFirstPagesGate } = await import('../../src/main/first-pages-gate');
    expect(slot.chordFirstPagesGate).toBeUndefined();
    expect(() => openFirstPagesGate('ok')).not.toThrow();
  });
});
