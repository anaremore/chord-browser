/**
 * Persistence when chord-data refuses a write (S15 §13): one refused for a
 * reason that can pass (a full disk) is never dropped. Its entities go back in
 * the queue and are sent again, later and later, and the app hears when it
 * keeps failing and when it's in again. One refused for what's in it is still
 * dropped. And a big flush keeps chords first and sends a chord that goes
 * last, so the tabs it hands on have moved, histories and all, before it goes.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedState, type Chord } from '@chord/core';
import type { WriteOp } from '@chord/data';

/** chord-data, stood in for: every request answered as \`answer\` says, the writes kept. */
class FakeChild extends EventEmitter {
  readonly writes: WriteOp[][] = [];
  answer: (request: { type: string }) => { ok: boolean; error?: string } = () => ({ ok: true });
  postMessage(message: { id: number; type: string; ops?: WriteOp[] }): void {
    if (message.type === 'write' && message.ops && message.ops.length > 0) this.writes.push(message.ops);
    const reply = message.type === 'open' ? { ok: true, saved: null, navs: {}, effects: [] } : this.answer(message);
    queueMicrotask(() => this.emit('message', { id: message.id, ...reply }));
  }
  kill(): void {}
}
let child: FakeChild;
vi.mock('electron', () => ({ utilityProcess: { fork: () => child }, MessageChannelMain: class {} }));
const { nextBatch, Persistence, refusalPasses } = await import('../../src/main/persistence');

const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const chordOp = (id: string, value: Chord | null): WriteOp => ({ k: 'chord', id, value }) as WriteOp;
const nodeOp = (id: string): WriteOp => ({ k: 'node', id, value: null }) as WriteOp;

beforeEach(() => {
  child = new FakeChild();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a write chord-data refused', () => {
  it('for a reason that can pass (a full disk): nothing’s dropped; it goes again later and later, and the app hears when it keeps failing and when it’s in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    const trouble: boolean[] = [];
    persistence.onTrouble((failing) => trouble.push(failing));
    let full = 3;
    child.answer = () => (full-- > 0 ? { ok: false, error: 'Error: database or disk is full' } : { ok: true });
    const state = seedState({ now: 1, newId: (() => { let n = 0; return () => `id-${++n}`; })(), theme: THEME, homeUrl: 'https://home.test/' });
    persistence.recordAll(state);
    await persistence.flush();
    expect(persistence.unsaved).toBe(true);
    const sent = child.writes[0]!.length;
    // Again 2 s later, then 4 s: still full, and past three tries the app hears it.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(child.writes).toHaveLength(3);
    expect(trouble).toEqual([true]);
    // Room again: it's in, whole, and the app hears that too.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(child.writes).toHaveLength(4);
    expect(child.writes[3]!.length).toBe(sent);
    expect(persistence.unsaved).toBe(false);
    expect(trouble).toEqual([true, false]);
  });

  it('for what’s in it (it would fail for ever): dropped and reported, as before', async () => {
    const { persistence } = await Persistence.open('/profile/chord.db');
    child.answer = () => ({ ok: false, error: 'Error: NOT NULL constraint failed' });
    persistence.recordAll(seedState({ now: 1, newId: () => 'x', theme: THEME, homeUrl: 'https://home.test/' }));
    await persistence.flush();
    expect(persistence.unsaved).toBe(false);
    expect(refusalPasses('database or disk is full')).toBe(true);
    expect(refusalPasses('disk I/O error')).toBe(true);
    expect(refusalPasses('NOT NULL constraint failed')).toBe(false);
  });
});

describe('a big flush, in batches', () => {
  it('chords that stay first, chords that go last: a chord’s tabs move before it goes, in this batch or an earlier one', () => {
    const kept = chordOp('kept', { id: 'kept' } as Chord);
    const gone = chordOp('gone', null);
    const ops = [gone, nodeOp('t1'), kept, nodeOp('t2'), nodeOp('t3')];
    expect(nextBatch(ops, 10).map((op) => op.id)).toEqual(['kept', 't1', 't2', 't3', 'gone']);
    // Split across batches: the chord that goes is never ahead of the moves.
    expect(nextBatch(ops, 3).map((op) => op.id)).toEqual(['kept', 't1', 't2']);
    expect(nextBatch([gone, nodeOp('t3')], 3).map((op) => op.id)).toEqual(['t3', 'gone']);
  });
});
