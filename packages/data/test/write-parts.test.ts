/**
 * A batch too big for one short transaction (S15 §13, the ninth review): past
 * WRITE_PART things sync stamps, a chord with its tabs going (or coming back
 * with Undo) is written in parts, each its own transaction, recorded first as
 * an intent (`write_intent`); one a stop left partway is finished at the next
 * open, and one never made whole is dropped, none of it written.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, seedState, type Context, type SidebarNode, type State } from '@chord/core';
import { ChordDatabase, WRITE_PART } from '../src/db';
import { opsForState, opsFromPatches, type WriteOp } from '../src';

let dir: string;
let file: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-parts-'));
  file = join(dir, 'chord.db');
  db = new ChordDatabase(file, 'linux');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ctx: Context = { now: 5000, newId: () => `id-${++n}` };
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const PINNED = WRITE_PART * 3 + 7;

/** Sync on, with a chord of PINNED pinned tabs beside the first. */
function setUp(): State {
  let state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  const first = Object.values(state.chords)[0]!;
  const nodes: Record<string, SidebarNode> = { ...state.nodes };
  for (let i = 0; i < PINNED; i++) {
    const id = `t${i}`;
    nodes[id] = { kind: 'tab', id, chordId: 'big', section: 'pinned', parentId: null, rank: `a${String(i).padStart(4, '0')}V`, url: `https://t${i}.test/`, title: `T${i}`, pinnedUrl: `https://t${i}.test/`, customTitle: null, favicon: null, lastActiveAt: 1, createdAt: 1 } as SidebarNode;
  }
  state = { ...state, chords: { ...state.chords, big: { ...first, id: 'big', name: 'Big', rank: 'a5' } }, nodes };
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk' });
  db.atomically(() => db.sync.addLocal('all'));
  return state;
}

const deletion = (state: State) => {
  const result = apply(state, { t: 'chord.delete', chordId: 'big' }, ctx);
  return { ops: opsFromPatches(result.patches, result.state, state), after: result.state };
};

const count = (sql: string): number => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

function run(steps: Generator<void, void>, upTo = Infinity): number {
  let n = 0;
  while (n < upTo && !steps.next().done) n++;
  return n;
}

describe('a batch written in parts', () => {
  it('a chord with its tabs going: a part a step, its tombstone stamped first, and every tab’s after it', () => {
    const state = setUp();
    const before = db.sync.outbox().records.length;
    const { ops } = deletion(state);
    const steps = run(db.writeSteps(ops, Date.now(), []));
    // Its parts recorded, then made whole, then written: more steps than one, none of it in one transaction.
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(PINNED / WRITE_PART) * 2);
    const records = db.sync.outbox().records.slice(before);
    expect(records[0]).toMatchObject({ type: 'chord', id: 'big', set: { deleted: true } });
    expect(records.filter((r) => r.type === 'tab' && r.set['deleted'] === true)).toHaveLength(PINNED);
    expect(db.load()!.nodes.filter((node) => node.chordId === 'big')).toEqual([]);
    expect(db.load()!.chords.map((c) => c.id)).not.toContain('big');
  });

  it('its Undo: the chord first in its first part, so each part’s tabs have it', () => {
    const state = setUp();
    const { ops, after } = deletion(state);
    run(db.writeSteps(ops, Date.now(), []));
    const windowId = Object.keys(after.windows)[0]!;
    const restored = apply(after, { t: 'chord.restore', chordId: 'big', windowId }, ctx);
    run(db.writeSteps(opsFromPatches(restored.patches, restored.state, after), Date.now(), []));
    expect(db.load()!.nodes.filter((node) => node.chordId === 'big')).toHaveLength(PINNED);
  });

  it('stopped once whole (a crash): the next open finishes it, before what comes next', () => {
    const state = setUp();
    const { ops } = deletion(state);
    const parts = Math.ceil(PINNED / WRITE_PART);
    // Recorded and made whole, and a part written; then it stops.
    run(db.writeSteps(ops, Date.now(), []), parts + 2);
    db.close();
    db = new ChordDatabase(file, 'linux');
    expect(count('SELECT count(*) AS n FROM write_intent')).toBeGreaterThan(0);
    run(db.writeSteps([], Date.now(), []));
    expect(count('SELECT count(*) AS n FROM write_intent')).toBe(0);
    expect(db.load()!.nodes.filter((node) => node.chordId === 'big')).toEqual([]);
    expect(db.sync.outbox().records.filter((r) => r.type === 'tab' && r.set['deleted'] === true)).toHaveLength(PINNED);
  });

  it('stopped before it was whole: none of it was written, and what was recorded goes', () => {
    const state = setUp();
    const { ops } = deletion(state);
    run(db.writeSteps(ops, Date.now(), []), 2);
    db.close();
    db = new ChordDatabase(file, 'linux');
    run(db.writeSteps([], Date.now(), []));
    expect(count('SELECT count(*) AS n FROM write_intent')).toBe(0);
    expect(db.load()!.nodes.filter((node) => node.chordId === 'big')).toHaveLength(PINNED);
  });

  it('small, or sync off: written at once, as `write` does', () => {
    setUp();
    const op = { k: 'linkRoute', id: 'mail.test', value: { host: 'mail.test', chordId: 'big', createdAt: 1 } } as WriteOp;
    expect(run(db.writeSteps([op], Date.now(), []))).toBe(0);
    db.sync.clear();
    const state = db.load()!;
    const big = state.nodes.filter((node) => node.chordId === 'big').map((node): WriteOp => ({ k: 'node', id: node.id, value: null }));
    expect(run(db.writeSteps(big, Date.now(), []))).toBe(0);
  });
});
