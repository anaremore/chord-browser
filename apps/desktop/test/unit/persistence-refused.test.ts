/**
 * Persistence when chord-data refuses a write (S15 §13): one refused for a
 * reason that can pass (a full disk, by SQLite's result code) is never
 * dropped, the sidebar's or history's. Its entities go back in the queue and
 * are sent again, later and later, and the app hears when it keeps failing
 * and when it's in again; what's unsaved counts until a write of it lands.
 * One refused for what's in it is still dropped. And a big flush keeps chords
 * first, and sends a chord that goes in one transaction with every node's
 * move and deletion waiting, so the tabs it hands on have moved, histories
 * and all, and a stop between batches can't leave it partly emptied.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedState, type Chord } from '@chord/core';
import type { HistoryEvent, WriteOp } from '@chord/data';

type Answer = { ok: boolean; error?: string; passing?: boolean };
/** chord-data, stood in for: every request answered as \`answer\` says, the writes kept. */
class FakeChild extends EventEmitter {
  readonly writes: WriteOp[][] = [];
  readonly events: HistoryEvent[][] = [];
  answer: (request: { type: string; ops?: WriteOp[]; events?: HistoryEvent[] }) => Answer = () => ({ ok: true });
  postMessage(message: { id: number; type: string; ops?: WriteOp[]; events?: HistoryEvent[] }): void {
    if (message.type === 'write' && message.ops && message.ops.length > 0) this.writes.push(message.ops);
    if (message.type === 'write' && message.events && message.events.length > 0) this.events.push(message.events);
    const reply = message.type === 'open' ? { ok: true, saved: null, navs: {}, effects: [] } : message.type === 'search' ? { ok: true, search: { history: [], choices: [], archive: [] } } : this.answer(message);
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
const settingOp = (id: string): WriteOp => ({ k: 'setting', id, value: 1 }) as WriteOp;
const FULL: Answer = { ok: false, error: 'Error: database or disk is full', passing: true };
const seed = () => seedState({ now: 1, newId: (() => { let n = 0; return () => `id-${++n}`; })(), theme: THEME, homeUrl: 'https://home.test/' });

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
    child.answer = () => (full-- > 0 ? FULL : { ok: true });
    persistence.recordAll(seed());
    await persistence.flush();
    expect(persistence.unsaved).toBeGreaterThan(0);
    const sent = child.writes[0]!.length;
    expect(persistence.unsaved).toBe(sent);
    // Again 2 s later, then 4 s: still full, and past three tries the app hears it.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(child.writes).toHaveLength(3);
    expect(trouble).toEqual([true]);
    // Room again: it's in, whole, and the app hears that too.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(child.writes).toHaveLength(4);
    expect(child.writes[3]!.length).toBe(sent);
    expect(persistence.unsaved).toBe(0);
    expect(trouble).toEqual([true, false]);
  });

  it('for what’s in it (it would fail for ever): dropped and reported, as before', async () => {
    const { persistence } = await Persistence.open('/profile/chord.db');
    child.answer = () => ({ ok: false, error: 'Error: NOT NULL constraint failed', passing: false });
    persistence.recordAll(seedState({ now: 1, newId: () => 'x', theme: THEME, homeUrl: 'https://home.test/' }));
    await persistence.flush();
    expect(persistence.unsaved).toBe(0);
  });

  it('what passes is chord-data’s to say, by SQLite’s result code; a message is only read when it doesn’t say', () => {
    expect(refusalPasses({ error: 'Error: database or disk is full', passing: true })).toBe(true);
    expect(refusalPasses({ error: 'Error: database or disk is full', passing: false })).toBe(false);
    expect(refusalPasses({ error: 'Error: attempt to write a readonly database', passing: true })).toBe(true);
    expect(refusalPasses({ error: 'disk I/O error' })).toBe(true);
    expect(refusalPasses({ error: 'NOT NULL constraint failed' })).toBe(false);
  });

  it('refused for now, then refused for what’s in it: dropped, and nothing counts as unsaved for ever after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let tries = 0;
    child.answer = () => (tries++ === 0 ? FULL : { ok: false, error: 'Error: NOT NULL constraint failed', passing: false });
    persistence.recordAll(seed());
    await persistence.flush();
    expect(persistence.unsaved).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.writes).toHaveLength(2);
    expect(persistence.unsaved).toBe(0);
  });

  it('what’s unsaved counts until a write of each thing lands: a newer write of it queued meanwhile, then in, settles it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = () => (full ? FULL : { ok: true });
    persistence.recordAll(seed());
    await persistence.flush();
    const unsaved = persistence.unsaved;
    expect(unsaved).toBeGreaterThan(0);
    // The same things changed again meanwhile: still unsaved, the same ones.
    persistence.recordAll(seed());
    expect(persistence.unsaved).toBe(unsaved);
    full = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(persistence.unsaved).toBe(0);
  });

  it('history’s happenings written ahead of a search, refused for now: kept, and written with the next try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = (request) => (full && request.type === 'write' ? FULL : { ok: true });
    const visit = { t: 'visit', url: 'https://visited.test/', title: 'Visited', at: 1 } as unknown as HistoryEvent;
    persistence.history(visit);
    await persistence.search('visited', null);
    expect(child.events).toHaveLength(1);
    expect(persistence.unsaved).toBe(1);
    full = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.events).toHaveLength(2);
    expect(child.events[1]).toContain(visit);
    expect(persistence.unsaved).toBe(0);
  });
});

describe('a big flush, in batches', () => {
  it('chords that stay first; a chord that goes, last, in one batch with every node’s move and deletion waiting, however many', () => {
    const kept = chordOp('kept', { id: 'kept' } as Chord);
    const gone = chordOp('gone', null);
    const ops = [gone, nodeOp('t1'), kept, settingOp('s1'), nodeOp('t2'), nodeOp('t3')];
    expect(nextBatch(ops, 10).map((op) => op.id)).toEqual(['kept', 't1', 't2', 't3', 's1', 'gone']);
    // Past the batch's size: the chord still goes with all of its nodes; what else waits goes in the next batch.
    expect(nextBatch(ops, 3).map((op) => op.id)).toEqual(['kept', 't1', 't2', 't3', 'gone']);
    const many = [gone, ...Array.from({ length: 250 }, (_, i) => nodeOp(`n${i}`))];
    const batch = nextBatch(many, 100);
    expect(batch).toHaveLength(251);
    expect(batch.at(-1)!.id).toBe('gone');
    // No chord going: batches of the size asked for, chords that stay first.
    expect(nextBatch([nodeOp('a'), kept, nodeOp('b'), nodeOp('c')], 2).map((op) => op.id)).toEqual(['kept', 'a']);
  });
});
