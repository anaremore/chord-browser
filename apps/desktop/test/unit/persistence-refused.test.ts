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
/** Another computer's change applied here (`sync.apply`): what `unsaved` counts, when refused. */
const applied = (persistence: Awaited<ReturnType<typeof Persistence.open>>['persistence'], state = seed()) => persistence.record([{ path: ['chords'] }, { path: ['nodes'] }], state, 'sync');

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
    applied(persistence);
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
    applied(persistence);
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
    applied(persistence);
    await persistence.flush();
    const unsaved = persistence.unsaved;
    expect(unsaved).toBeGreaterThan(0);
    // The same things applied again meanwhile: still unsaved, the same ones.
    applied(persistence);
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
    // History isn't sync's: never counted as what sync applied that isn't saved.
    expect(persistence.unsaved).toBe(0);
    full = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.events).toHaveLength(2);
    expect(child.events[1]).toContain(visit);
  });

  it('your own changes refused are kept and sent again, but never counted as what sync applied that isn’t saved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = () => (full ? FULL : { ok: true });
    persistence.recordAll(seed());
    await persistence.flush();
    expect(persistence.unsaved).toBe(0);
    // Sync's apply refused too, then a change of yours to the same chords: each in its turn, in the order made (yours from
    // before theirs, theirs, then yours since: what you changed of theirs is known exactly), and theirs counts until it's in.
    const state = seed();
    applied(persistence, state);
    await vi.advanceTimersByTimeAsync(2_000);
    const theirs = persistence.unsaved;
    expect(theirs).toBeGreaterThan(0);
    persistence.record([{ path: ['chords'] }, { path: ['nodes'] }], state, 'user');
    expect(persistence.unsaved).toBe(theirs);
    full = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(persistence.unsaved).toBe(0);
    const last = child.writes.slice(-2).flat();
    const chordId = Object.keys(state.chords)[0]!;
    const order = last.filter((op) => op.k === 'chord' && op.id === chordId).map((op) => op.origin ?? 'user');
    expect(order).toEqual(['user', 'sync', 'user']);
  });

  it('sync’s, yours, then sync’s again, all waiting: each in its turn, in the order made, never sync’s since ahead of yours (S15 §13, the ninth review)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = () => (full ? FULL : { ok: true });
    const state = seed();
    const chordId = Object.keys(state.chords)[0]!;
    applied(persistence, state);
    await persistence.flush();
    persistence.record([{ path: ['chords'] }], state, 'user');
    applied(persistence, state);
    full = false;
    await vi.advanceTimersByTimeAsync(4_000);
    const order = child.writes.flat().filter((op) => op.k === 'chord' && op.id === chordId);
    expect(order.slice(-3).map((op) => op.origin ?? 'user')).toEqual(['sync', 'user', 'sync']);
  });

  it('two changes of yours to one thing, made more than a second apart, written together: the earlier a step, stamped as of its own time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = () => (full ? FULL : { ok: true });
    const state = seed();
    const chordId = Object.keys(state.chords)[0]!;
    persistence.record([{ path: ['chords'] }], state, 'user');
    const first = Date.now();
    await persistence.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    const renamed = { ...state, chords: { ...state.chords, [chordId]: { ...state.chords[chordId]!, name: 'Later' } } };
    persistence.record([{ path: ['chords', chordId] }], renamed, 'user');
    full = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const op = child.writes.flat().filter((o) => o.k === 'chord' && o.id === chordId).at(-1)!;
    expect(op.before?.map((step) => step.at)).toEqual([first]);
    expect((op.value as Chord).name).toBe('Later');
    expect(op.at).toBeGreaterThan(first + 1000);
  });

  it('history in a batch being written, refused, never lands after what a search sent later: the search waits for it, and the order holds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { persistence } = await Persistence.open('/profile/chord.db');
    let full = true;
    child.answer = (request) => (full && request.type === 'write' ? FULL : { ok: true });
    const archive = { k: 'archive', at: 1 } as unknown as HistoryEvent;
    const unarchive = { k: 'unarchive', at: 2 } as unknown as HistoryEvent;
    persistence.history(archive);
    const writing = persistence.flush();
    persistence.history(unarchive);
    const searching = persistence.search('x', null);
    await writing;
    await searching;
    full = false;
    await vi.advanceTimersByTimeAsync(2_000);
    const written = child.events.at(-1)!;
    expect(written.indexOf(archive)).toBeLessThan(written.indexOf(unarchive));
    expect(written).toContain(unarchive);
  });

  it('a change of yours waiting, then sync’s or tidying’s to the same entity: both written, yours first, so yours is stamped and theirs isn’t', async () => {
    const { persistence } = await Persistence.open('/profile/chord.db');
    const state = seed();
    const chordId = Object.keys(state.chords)[0]!;
    persistence.record([{ path: ['chords', chordId] }], state, 'user');
    persistence.record([{ path: ['chords', chordId] }], { ...state, chords: {} }, 'tidy');
    await persistence.flush();
    expect(child.writes[0]!.map((op) => [op.id, op.origin ?? 'user', op.value === null])).toEqual([
      [chordId, 'user', false],
      [chordId, 'tidy', true],
    ]);
    // Theirs, then an edit of yours: both, theirs first, so chord-data knows what you changed of what it applied.
    persistence.record([{ path: ['chords', chordId] }], state, 'sync');
    persistence.record([{ path: ['chords', chordId] }], state, 'user');
    await persistence.flush();
    expect(child.writes[1]!.map((op) => op.origin ?? 'user')).toEqual(['sync', 'user']);
    // Theirs, then yours taking it away: both, theirs first (what it was when it went is what sync applied).
    persistence.record([{ path: ['chords', chordId] }], state, 'sync');
    persistence.record([{ path: ['chords', chordId] }], { ...state, chords: {} }, 'user');
    await persistence.flush();
    expect(child.writes[2]!.map((op) => [op.origin ?? 'user', op.value === null])).toEqual([
      ['sync', false],
      ['user', true],
    ]);
    // Theirs taking it away, then yours bringing it back: yours takes its place.
    persistence.record([{ path: ['chords', chordId] }], { ...state, chords: {} }, 'tidy');
    persistence.record([{ path: ['chords', chordId] }], state, 'user');
    await persistence.flush();
    expect(child.writes[3]!.map((op) => [op.origin ?? 'user', op.value === null])).toEqual([['user', false]]);
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
