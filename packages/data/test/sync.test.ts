/**
 * Sync's tables in chord-data (S15 §7, §9 step 3): migration 19; the stamping
 * hook in write(), which does nothing while sync is off, stamps only what you
 * changed, and never what came from another computer; what a computer writes
 * when it turns sync on; and merging another computer's records: checked,
 * capped, field by field, into what main applies.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, seedState, SYNC_LIMITS, thingKey, type Command, type Context, type DataRecord, type Stamp, type State } from '@chord/core';
import { ChordDatabase } from '../src/db';
import { MIGRATIONS } from '../src/migrations';
import { opsForState, opsFromPatches, type WriteOp } from '../src';

let dir: string;
let db: ChordDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ctx: Context = { now: 5000, newId: () => `id-${++n}` };
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const OTHER = '00000000000000bb';

/** Apply commands to state and the database, the way main and chord-data do; `sync` marks them as another computer's. */
function drive(state: State, commands: Command[], sync = false): State {
  for (const command of commands) {
    const result = apply(state, command, ctx);
    db.write(opsFromPatches(result.patches, result.state).map((op): WriteOp => (sync ? { ...op, sync: true } : op)));
    state = result.state;
  }
  return state;
}

/** A first launch saved, then sync turned on as setting up does: this computer's things into the copy. */
function setUp(): State {
  const state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk' });
  db.atomically(() => db.sync.addLocal('all'));
  return state;
}

const outbox = () => db.sync.outbox().records;
const chordId = (s: State) => Object.keys(s.chords)[0]!;

describe('migration 19', () => {
  it('adds sync’s tables, empty', () => {
    expect(db.version).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(19);
    expect(db.sync.outboxSize()).toBe(0);
    expect(db.sync.meta.on).toBe(false);
  });
});

describe('the stamping hook', () => {
  it('does nothing while sync is off', () => {
    const state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
    db.write(opsForState(state));
    drive(state, [{ t: 'chord.update', chordId: chordId(state), name: 'Renamed' }]);
    expect(outbox()).toEqual([]);
    expect(db.sync.snapshot()).toEqual([]);
  });

  it('turning on writes nothing to the outbox: the first segment is a snapshot of the copy', () => {
    setUp();
    expect(outbox()).toEqual([]);
    expect(db.sync.snapshot().some((r) => r.type === 'chord')).toBe(true);
  });

  it('stamps only the field you changed, with this computer’s clock', () => {
    const state = setUp();
    drive(state, [{ t: 'chord.update', chordId: chordId(state), name: 'Work' }]);
    const [record] = outbox();
    expect(record).toMatchObject({ type: 'chord', id: chordId(state), set: { name: 'Work' } });
    expect(Object.keys(record!.set)).toEqual(['name']);
    expect(record!.at![2]).toBe(db.device());
  });

  it('what came from another computer is saved, and never stamped', () => {
    const state = setUp();
    drive(state, [{ t: 'chord.update', chordId: chordId(state), name: 'From elsewhere' }], true);
    expect(outbox()).toEqual([]);
  });

  it('a tab you pin syncs; one you unpin is a tombstone; pinned again, it goes whole with deleted: false', () => {
    let state = setUp();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [{ t: 'tab.pin', nodeId: tab }]);
    expect(outbox().at(-1)).toMatchObject({ type: 'tab', id: tab, set: { pinnedUrl: 'https://home.test/' } });
    expect(outbox().at(-1)!.set).not.toHaveProperty('url');
    state = drive(state, [{ t: 'tab.unpin', nodeId: tab }]);
    expect(outbox().at(-1)).toMatchObject({ type: 'tab', id: tab, set: { deleted: true } });
    drive(state, [{ t: 'tab.pin', nodeId: tab }]);
    expect(outbox().at(-1)!.set).toMatchObject({ deleted: false, pinnedUrl: 'https://home.test/', title: expect.any(String) });
  });

  it('a Today tab, a window, history and zoom are never stamped', () => {
    const state = setUp();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    drive(state, [
      { t: 'tab.updated', nodeId: tab, title: 'New title' },
      { t: 'zoom.set', host: 'docs.test', factor: 1.25 },
      { t: 'permission.set', origin: 'https://meet.test', permissions: ['camera'], decision: 'allow' },
    ]);
    expect(outbox()).toEqual([]);
  });

  it('settings: only what you changed, and never the proxy or the interface size', () => {
    const state = setUp();
    drive(state, [{ t: 'settings.set', settings: { searchEngine: 'duckduckgo', uiScale: 1.25, proxy: { mode: 'none' } as never } }]);
    expect(outbox().map((r) => r.set)).toEqual([{ searchEngine: 'duckduckgo' }]);
  });

  it('themes are things of their own: one added, then a tombstone when it goes', () => {
    let state = setUp();
    const theme = { id: 'late', name: 'Late Night', stops: [{ l: 0.5, c: 0.2, h: 280 }], grain: 0.3 };
    state = drive(state, [{ t: 'theme.save', theme }]);
    expect(outbox().at(-1)).toMatchObject({ type: 'theme', id: 'late', set: { name: 'Late Night' } });
    drive(state, [{ t: 'theme.delete', id: 'late' }]);
    expect(outbox().at(-1)).toMatchObject({ type: 'theme', id: 'late', set: { deleted: true } });
  });

  it('a chord deleted here: a tombstone for it and for what was pinned in it', () => {
    let state = setUp();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [{ t: 'tab.pin', nodeId: tab }, { t: 'chord.create', windowId: Object.keys(state.windows)[0]!, name: 'Two', icon: 'T', theme: THEME }]);
    const first = chordId(state);
    drive(state, [{ t: 'chord.delete', chordId: first }]);
    const tombstones = outbox().filter((r) => r.set['deleted'] === true).map((r) => `${r.type}:${r.id}`);
    expect(tombstones).toEqual(expect.arrayContaining([`chord:${first}`, `tab:${tab}`]));
  });
});

describe('merging another computer’s records', () => {
  const at = (ms: number, device = OTHER): Stamp => [Date.now() + ms, 0, device];

  it('merges field by field into what main applies, and moves the clock up to what it read', () => {
    const state = setUp();
    const id = chordId(state);
    const ahead = at(60_000);
    const result = db.atomically(() => db.sync.merge([{ type: 'chord', id, at: ahead, set: { name: 'Synced name' } }], Date.now()));
    expect([...result.changes.get(thingKey('chord', id))!]).toEqual(['name']);
    const out = db.sync.planFor(result.changes);
    expect(out.chords.map((c) => c.name)).toEqual(['Synced name']);
    // A change made here now wins over it, though the other computer's clock is a minute ahead.
    drive(state, [{ t: 'chord.update', chordId: id, name: 'Mine' }]);
    const mine = outbox().at(-1)!;
    expect(mine.at![0]).toBeGreaterThanOrEqual(ahead[0]);
  });

  it('never keeps what sync doesn’t carry: history, Duet chats and their messages, zoom, permissions', () => {
    setUp();
    const records: DataRecord[] = [
      { type: 'page', id: 'https://a.test/', set: { title: 'A', visits: [1] } },
      { type: 'thread', id: 'th', set: { chord: 'x', title: 'T', provider: 'codex', created: 1 } },
      { type: 'message', id: 'm', set: { thread: 'th', created: 1, body: { role: 'user', text: 'hi', attachments: [] } } },
      { type: 'permission', id: 'https://meet.test', at: at(1), set: { camera: 'allow' } },
      { type: 'zoom', id: 'docs.test', at: at(1), set: { factor: 2 } },
    ];
    const result = db.atomically(() => db.sync.merge(records, Date.now()));
    expect(result.dropped).toBe(records.length);
    expect(result.changes.size).toBe(0);
  });

  it('keeps a newer Chord’s things as they came, to write back, and never applies them', () => {
    setUp();
    const stamp = at(1);
    const result = db.atomically(() => db.sync.merge([{ type: 'widget', id: 'w1', at: stamp, set: { size: 3 } }], Date.now()));
    expect(db.sync.snapshot()).toContainEqual({ type: 'widget', id: 'w1', at: stamp, set: { size: 3 } });
    expect(db.sync.planFor(result.changes)).toMatchObject({ chords: [], nodes: [], favorites: [] });
  });

  it('caps what arrives: past a type’s limit, new things are left out', () => {
    setUp();
    const many: DataRecord[] = Array.from({ length: SYNC_LIMITS.byType['theme']! + 5 }, (_, i) => ({ type: 'theme', id: `t${i}`, at: at(1), set: { name: `T${i}`, stops: THEME.stops, grain: 0.2 } }));
    const result = db.atomically(() => db.sync.merge(many, Date.now()));
    expect(result.capped).toBe(5);
  });

  it('notices this computer was removed, by another computer', () => {
    setUp();
    db.sync.stampDevice({ name: 'Desk', os: 'linux', app: '0.5.0', removed: false });
    const removedAt = Date.now() + 10_000;
    const result = db.atomically(() => db.sync.merge([{ type: 'device', id: db.device(), at: [removedAt, 0, OTHER], set: { removed: true } }], Date.now()));
    expect(result.removed).toBe(removedAt);
  });

  it('a value it applies comes back as a sync write: nothing goes into this computer’s log', () => {
    let state = setUp();
    const id = chordId(state);
    const result = db.atomically(() => db.sync.merge([{ type: 'chord', id, at: at(1), set: { name: 'Elsewhere' } }], Date.now()));
    const out = db.sync.planFor(result.changes);
    state = drive(state, [{ t: 'sync.apply', chords: out.chords }], true);
    expect(state.chords[id]!.name).toBe('Elsewhere');
    expect(outbox()).toEqual([]);
    // And a later change here is stamped as yours.
    drive(state, [{ t: 'chord.update', chordId: id, name: 'Mine again' }]);
    expect(outbox().map((r) => r.set)).toEqual([{ name: 'Mine again' }]);
  });
});
