/**
 * The E2E harness's gate (#321), development and test builds only: open once launch's chords can load their first
 * pages, their ad-blocking rules on (`'ok'`) or their wait over without them (`'timeout'`, the product's own fallback).
 * entry.ts imports this before index.ts loads, so the gate is there from main's first moment: a harness that asks early
 * waits, never finding nothing (Carbon's B3 on #343). The promise and what opens it live on globalThis, so the one
 * entry.ts made is the one index.ts opens. test/e2e/main-errors.ts waits for it.
 */
import { app } from 'electron';

export type FirstPages = 'ok' | 'timeout';

const slot = globalThis as { chordFirstPagesGate?: Promise<FirstPages>; chordOpenFirstPagesGate?: (how: FirstPages) => void };

if (!app.isPackaged && !slot.chordFirstPagesGate) slot.chordFirstPagesGate = new Promise<FirstPages>((open) => (slot.chordOpenFirstPagesGate = open));

/** Launch's chords can load their first pages (index.ts, once their sessions are made and their rules settled). */
export function openFirstPagesGate(how: FirstPages): void {
  slot.chordOpenFirstPagesGate?.(how);
}
