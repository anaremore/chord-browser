/**
 * Sync's tables in chord-data (S15 §7, §9 step 3): migration 19; the stamping
 * hook in write(), which does nothing while sync is off, stamps only what you
 * changed, and never what came from another computer; what a computer writes
 * when it turns sync on; and merging another computer's records: checked,
 * capped, field by field, into what main applies.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, CLOCK_DRIFT_MS, compareStamps, isStamp, MAX_COUNTER, MAX_STAMP_MS, seedState, SYNC_LIMITS, thingKey, type Command, type Context, type DataRecord, type Stamp, type State } from '@chord/core';
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

describe('migrations 19 and 20', () => {
  it('add sync’s tables, empty, and what its reader remembers of junk', () => {
    expect(db.version).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(20);
    expect(db.sync.outboxSize()).toBe(0);
    expect(db.sync.meta.on).toBe(false);
    expect(db.sync.junk()).toEqual([]);
    db.sync.saveJunk([['1/00000000000000aa/000002.chordlog', '12:34']]);
    expect(db.sync.junk()).toEqual([['1/00000000000000aa/000002.chordlog', '12:34']]);
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

  it('a thing that’s here grows only so far, however many records add fields to it', () => {
    setUp();
    const fields = (prefix: string) => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${prefix}${i}`, i]));
    const first = db.atomically(() => db.sync.merge([{ type: 'widget', id: 'w1', at: at(1), set: fields('a') }], Date.now()));
    expect(first.capped).toBe(0);
    const second = db.atomically(() => db.sync.merge([{ type: 'widget', id: 'w1', at: at(2), set: fields('b') }], Date.now()));
    expect(second.capped).toBe(1);
  });

  it('notices this computer was removed, by another computer', () => {
    setUp();
    db.sync.stampDevice({ name: 'Desk', os: 'linux', app: '0.5.0', removed: false });
    const removedAt = Date.now() + 10_000;
    const result = db.atomically(() => db.sync.merge([{ type: 'device', id: db.device(), at: [removedAt, 0, OTHER], set: { removed: true } }], Date.now()));
    expect(result.removed).toBe(removedAt);
  });

  it('a change made here beats a value whose stamp is far ahead, and the clock stays near the time', () => {
    const state = setUp();
    const id = chordId(state);
    const far: Stamp = [Date.now() + 300 * 86_400_000, MAX_COUNTER, OTHER];
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: far, set: { name: 'From a wrong clock' } }], Date.now()));
    drive(state, [{ t: 'chord.update', chordId: id, name: 'Mine' }]);
    const mine = outbox().at(-1)!;
    expect(compareStamps(mine.at!, far)).toBeGreaterThan(0);
    expect(isStamp(mine.at)).toBe(true);
    expect(db.sync.snapshot().filter((r) => r.type === 'chord' && r.id === id && 'name' in r.set).at(-1)!.set['name']).toBe('Mine');
    // The clock moved no further than a minute past the wall clock: the next change elsewhere is stamped by the time.
    drive(state, [{ t: 'settings.set', settings: { searchEngine: 'duckduckgo' } }]);
    expect(outbox().at(-1)!.at![0]).toBeLessThanOrEqual(Date.now() + CLOCK_DRIFT_MS);
  });

  it('a change that can’t win (a stamp at the very last there can be, from a computer with a larger id) isn’t written, and main is sent the merged value back', () => {
    let state = setUp();
    const id = chordId(state);
    const top: Stamp = [MAX_STAMP_MS, MAX_COUNTER, 'ffffffffffffffff'];
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: top, set: { name: 'Zed' } }], Date.now()));
    const before = outbox().length;
    state = drive(state, [{ t: 'chord.update', chordId: id, name: 'Alpha' }]);
    // Nothing goes out that every other computer would drop in favour of Zed.
    expect(outbox().slice(before).filter((r) => 'name' in r.set)).toEqual([]);
    // What lost is named, and what the copy has (Zed) is what main is sent: this computer shows what every other does.
    const lost = db.sync.takeLost();
    expect([...lost.keys()]).toEqual([thingKey('chord', id)]);
    expect(db.sync.describe(thingKey('chord', id))).toBe('“Zed”');
    expect(db.sync.planFor(lost).chords.map((c) => c.name)).toEqual(['Zed']);
    state = drive(state, [{ t: 'sync.apply', chords: db.sync.planFor(lost).chords }], true);
    expect(state.chords[id]!.name).toBe('Zed');
    expect(db.sync.takeLost().size).toBe(0);
  });

  it('a change from another computer stamped far ahead counts as come now: no last change in the future', () => {
    setUp();
    const result = db.atomically(() => db.sync.merge([{ type: 'chord', id: 'far', at: [Date.now() + 300 * 86_400_000, 0, OTHER], set: { name: 'Far' } }], Date.now()));
    expect(result.newest.get(OTHER)!).toBeLessThanOrEqual(Date.now());
  });

  it('what a thing counts for includes its stamps and what a snapshot adds for them: never less than the snapshot holds', () => {
    setUp();
    // 200 fields of one character, each with a stamp of its own: a snapshot of one record per field.
    const fields = Array.from({ length: 200 }, (_, i): DataRecord => ({ type: 'widget', id: 'many-stamps', at: at(i + 1), set: { [`f${i}`]: 'x' } }));
    db.atomically(() => db.sync.merge(fields, Date.now()));
    const snapshot = db.sync.snapshot().filter((r) => r.id === 'many-stamps');
    expect(snapshot).toHaveLength(200);
    expect(db.sync.size()).toBeGreaterThanOrEqual(snapshot.reduce((n, r) => n + JSON.stringify(r).length, 0));
  });

  it('many small changes to one big thing: one slice reads and writes it once', () => {
    setUp();
    db.atomically(() => db.sync.merge([{ type: 'widget', id: 'big', at: at(1), set: { blob: 'x'.repeat(1024 * 1024) } }], Date.now()));
    const small = Array.from({ length: 100 }, (_, i): DataRecord => ({ type: 'widget', id: 'big', at: at(i + 2), set: { tick: i } }));
    const started = performance.now();
    const result = db.atomically(() => db.sync.merge(small, Date.now(), 512 * 1024));
    const ms = performance.now() - started;
    expect(result.consumed).toBe(100);
    // First built, each record rewrote the thing: about 470 ms for this slice.
    expect(ms).toBeLessThan(150);
    expect(db.sync.snapshot().find((r) => r.id === 'big' && 'tick' in r.set)!.set['tick']).toBe(99);
  });

  it('a slice stops once it has read and written its budget of things, and says how many records it took', () => {
    setUp();
    const big = Array.from({ length: 5 }, (_, i): DataRecord => ({ type: 'widget', id: `big${i}`, at: at(1), set: { blob: 'x'.repeat(300 * 1024) } }));
    const result = db.atomically(() => db.sync.merge(big, Date.now(), 512 * 1024));
    expect(result.consumed).toBe(2);
    expect(db.atomically(() => db.sync.merge(big.slice(result.consumed), Date.now(), 512 * 1024)).consumed).toBe(2);
  });

  it('every thing grows only so far, and the copy as a whole: changes to things it has count, not only new things', () => {
    setUp();
    const blob = (n: number) => 'x'.repeat(n);
    const small = Array.from({ length: 40 }, (_, i): DataRecord => ({ type: 'widget', id: `w${i}`, at: at(1), set: { blob: blob(10) } }));
    expect(db.atomically(() => db.sync.merge(small, Date.now())).capped).toBe(0);
    // Each grows to nearly what one thing may be: together, past what the copy keeps.
    const grown = small.map((r): DataRecord => ({ ...r, at: at(2), set: { blob: blob(SYNC_LIMITS.thingChars - 100) } }));
    let capped = 0;
    for (let i = 0; i < grown.length; i += 5) capped += db.atomically(() => db.sync.merge(grown.slice(i, i + 5), Date.now())).capped;
    expect(capped).toBeGreaterThan(0);
    const total = db.sync.snapshot().reduce((n, r) => n + JSON.stringify(r.set).length, 0);
    expect(total).toBeLessThanOrEqual(SYNC_LIMITS.chars);
    // And one thing grows no further than one thing may, field by field.
    const wide = db.atomically(() => db.sync.merge([{ type: 'widget', id: 'w0', at: at(3), set: { more: blob(SYNC_LIMITS.thingChars - 100) } }], Date.now()));
    expect(wide.capped).toBe(1);
    // Tens of megabytes merged: seconds when the whole suite runs at once.
  }, 30_000);

  it('an icon whose bytes aren’t what its id says is left out', () => {
    setUp();
    const data = Buffer.from('a picture').toString('base64');
    const id = `sha256-${createHash('sha256').update(Buffer.from('a picture')).digest('hex')}`;
    const result = db.atomically(() =>
      db.sync.merge(
        [
          { type: 'icon', id: `sha256-${'0'.repeat(64)}`, set: { mime: 'image/png', data } },
          { type: 'icon', id, set: { mime: 'image/png', data } },
        ],
        Date.now(),
      ),
    );
    expect(result.dropped).toBe(1);
    expect(db.sync.snapshot().filter((r) => r.type === 'icon').map((r) => r.id)).toEqual([id]);
  });

  it.each([
    ['changed here after another computer deleted it: it stays, for everyone', -1000, false],
    ['deleted elsewhere after it was last changed here: it goes', 1000, true],
  ])('joining again with Keep both, a thing %s', (_what, offset, goes) => {
    const state = setUp();
    const id = chordId(state);
    const row = db.sync.localThings().find((r) => r.type === 'chord' && r.id === id)!.at![0];
    // Sync off, then on again: the folder has a tombstone from another computer.
    db.sync.clear();
    db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk', joining: true });
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: [row + offset, 0, OTHER], set: { deleted: true } }], Date.now()));
    const changes = db.atomically(() => db.sync.addLocal('all'));
    const plan = db.sync.planFor(db.sync.everything());
    expect(plan.gone.chords.includes(id)).toBe(goes);
    expect(db.sync.snapshot().some((r) => r.type === 'chord' && r.id === id && r.set['deleted'] === false && r.at![2] === db.device())).toBe(!goes);
    void changes;
  });

  it('a snapshot goes a page at a time, icons first; changes stamped while it’s written stay in the outbox to follow it', () => {
    let state = setUp();
    const id = chordId(state);
    const pages = [...db.sync.snapshotPages(20)];
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(db.sync.snapshot());
    state = drive(state, [{ t: 'chord.update', chordId: id, name: 'Before' }]);
    const mark = db.sync.outboxMark();
    drive(state, [{ t: 'chord.update', chordId: id, name: 'While it was written' }]);
    db.atomically(() => db.sync.snapshotted({ generation: 1, device: db.device(), segment: 1, size: 1, frames: 1 }, Date.now(), mark));
    expect(outbox().map((r) => r.set['name'])).toEqual(['While it was written']);
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

describe('a chord another computer deleted, with more than a push holds', () => {
  it('its tombstone and every one of its tabs’ go in one push, so its Undo brings every tab back', () => {
    let state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
    const big = 'big-chord';
    const tabs = Array.from({ length: 150 }, (_, i) => `pinned-${i}`);
    state = {
      ...state,
      chords: { ...state.chords, [big]: { id: big, profileId: 'default', name: 'Big', icon: 'B', theme: THEME, rank: 'b0', createdAt: 1 } },
      nodes: {
        ...state.nodes,
        ...Object.fromEntries(
          tabs.map((id, i) => [
            id,
            { kind: 'tab', id, chordId: big, section: 'pinned', parentId: null, rank: `a${String(i).padStart(3, '0')}`, url: `https://t${i}.test/`, title: `T${i}`, pinnedUrl: `https://t${i}.test/`, customTitle: null, favicon: null, lastActiveAt: 1, createdAt: 1 },
          ]),
        ),
      },
    } as State;
    db.write(opsForState(state));
    db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk' });
    db.atomically(() => db.sync.addLocal('all'));
    // Another computer deletes the chord: its tombstone, and its 150 tabs', with 60 other changes in the same pass.
    const at: Stamp = [Date.now() + 1000, 0, OTHER];
    const records: DataRecord[] = [
      ...Array.from({ length: 60 }, (_, i): DataRecord => ({ type: 'theme', id: `t${i}`, at, set: { name: `T${i}`, stops: THEME.stops, grain: 0.2 } })),
      { type: 'chord', id: big, at, set: { deleted: true } },
      ...tabs.map((id): DataRecord => ({ type: 'tab', id, at, set: { deleted: true } })),
    ];
    const merged = db.atomically(() => db.sync.merge(records, Date.now()));
    const slices = db.sync.pushSlices(merged.changes, 100);
    expect(slices.length).toBeGreaterThan(1);
    const withChord = slices.find((slice) => slice.has(thingKey('chord', big)))!;
    expect(tabs.every((id) => withChord.has(thingKey('tab', id)))).toBe(true);
    // Applied push by push, as main does: the chord takes its tabs, and its one Undo brings every one back.
    for (const slice of slices) state = drive(state, [{ t: 'sync.apply', ...db.sync.planFor(slice) }], true);
    expect(state.chords[big]).toBeUndefined();
    expect(tabs.some((id) => state.nodes[id])).toBe(false);
    const windowId = Object.keys(state.windows)[0]!;
    state = drive(state, [{ t: 'sync.unreplace', windowId, chordIds: [big] }]);
    expect(tabs.every((id) => state.nodes[id]?.chordId === big)).toBe(true);
  });
});

describe('turning sync off with changes not yet in the folder', () => {
  it('keeps them, and turned on again, the first snapshot holds them', () => {
    const state = setUp();
    const id = chordId(state);
    drive(state, [{ t: 'chord.update', chordId: id, name: 'Unsent' }]);
    expect(db.sync.outboxSize()).toBe(1);
    db.sync.clear();
    expect(db.sync.outboxSize()).toBe(1);
    // On again: the copy from this computer's things, and what waited.
    db.sync.setMeta({ on: true, folder: '/sync', generation: 1, name: 'Desk' });
    db.atomically(() => {
      db.sync.addLocal('all');
      db.sync.readmitOutbox();
    });
    expect(db.sync.snapshot().some((r) => r.type === 'chord' && r.id === id && r.set['name'] === 'Unsent' && r.at![2] === db.device())).toBe(true);
  });
});

describe('what this computer hasn’t applied', () => {
  it('merged but never applied (a quit or a crash during a pass): it differs from what this computer has, and is found again', () => {
    let state = setUp();
    const id = chordId(state);
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { name: 'Renamed elsewhere' } }], Date.now()));
    const unapplied = () => new Map([...db.sync.unappliedPages()].flatMap((page) => [...page]));
    expect([...(unapplied().get(thingKey('chord', id)) ?? [])]).toEqual(['name']);
    // Applied, and written back: nothing left.
    state = drive(state, [{ t: 'sync.apply', ...db.sync.planFor(unapplied()) }], true);
    expect(state.chords[id]!.name).toBe('Renamed elsewhere');
    expect(unapplied().size).toBe(0);
  });

  it('mid-apply: what main applied and wrote is done; the rest is found again', () => {
    let state = setUp();
    const home = chordId(state);
    const at: Stamp = [Date.now() + 1000, 0, OTHER];
    db.atomically(() =>
      db.sync.merge(
        [
          { type: 'chord', id: home, at, set: { name: 'First part' } },
          { type: 'chord', id: 'new-one', at, set: { name: 'Second part', icon: 'S', theme: THEME, rank: 'z0', profile: 'default', created: 1 } },
        ],
        Date.now(),
      ),
    );
    const all = new Map([...db.sync.unappliedPages()].flatMap((page) => [...page]));
    expect(all.size).toBe(2);
    // Main applied the first part, then quit.
    state = drive(state, [{ t: 'sync.apply', ...db.sync.planFor(new Map([[thingKey('chord', home), all.get(thingKey('chord', home))!]])) }], true);
    const left = new Map([...db.sync.unappliedPages()].flatMap((page) => [...page]));
    expect([...left.keys()]).toEqual([thingKey('chord', 'new-one')]);
    void state;
  });

  it('what this computer never keeps or never takes isn’t a difference: a tab’s title off its home, a chord’s sign-ins', () => {
    let state = setUp();
    const id = chordId(state);
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: [Date.now() + 1000, 0, OTHER], set: { profile: 'their-own' } }], Date.now()));
    state = drive(state, [{ t: 'sync.apply', ...db.sync.planFor(new Map([[thingKey('chord', id), new Set(['profile'])]])) }], true);
    expect(new Map([...db.sync.unappliedPages()].flatMap((page) => [...page])).size).toBe(0);
    void state;
  });
});

describe('a chord deleted here', () => {
  it('its tombstone goes out before its tabs’ and folders’, so a computer that reads part of it takes the chord with everything', () => {
    let state = setUp();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [{ t: 'tab.pin', nodeId: tab }, { t: 'chord.create', windowId: Object.keys(state.windows)[0]!, name: 'Two', icon: 'T', theme: THEME }]);
    const first = chordId(state);
    const before = outbox().length;
    drive(state, [{ t: 'chord.delete', chordId: first }]);
    const tombstones = outbox().slice(before).filter((r) => r.set['deleted'] === true);
    expect(tombstones[0]).toMatchObject({ type: 'chord', id: first });
    expect(tombstones.map((r) => r.id)).toContain(tab);
  });
});

describe('pruning a removed computer’s folder', () => {
  it('only while everything read from it is in a snapshot of this computer’s that landed: a late frame waits for the next', () => {
    setUp();
    const gone = '00000000000000dd';
    const cursor = (offset: number) => ({ head: 'h', offset, frame: 2, snapshot: true });
    db.sync.saveCursor(1, gone, 1, cursor(100));
    db.sync.snapshotted({ generation: 1, device: db.device(), segment: 2, size: 10, frames: 1 }, Date.now(), Number.MAX_SAFE_INTEGER, db.sync.readPositions(1));
    expect(db.sync.readCovered(gone)).toBe(true);
    // A frame of it delivered late, read after that snapshot: in this computer's copy, but in none of its segments.
    db.sync.saveCursor(1, gone, 1, cursor(150));
    expect(db.sync.readCovered(gone)).toBe(false);
    db.sync.snapshotted({ generation: 1, device: db.device(), segment: 3, size: 10, frames: 1 }, Date.now(), Number.MAX_SAFE_INTEGER, db.sync.readPositions(1));
    expect(db.sync.readCovered(gone)).toBe(true);
  });
});

describe('explicit deletions and inferred ones', () => {
  /** Another computer's thing, merged here and not yet in chord.db (main applied it, and its write hasn't happened). */
  const theirs = (type: string, id: string, set: Record<string, unknown>) => db.atomically(() => db.sync.merge([{ type, id, at: [Date.now() + 1000, 0, OTHER], set }], Date.now()));
  const tombstoned = (id: string) => outbox().some((r) => r.id === id && r.set['deleted'] === true);
  const live = (type: string, id: string) => {
    const records = db.sync.snapshot().filter((r) => r.type === type && r.id === id);
    return records.length > 0 && !records.some((r) => r.set['deleted'] === true);
  };

  it('a theme another computer has and this one never had: saving this computer’s own list never deletes it (a deletion inferred from a list)', () => {
    const state = setUp();
    theirs('theme', 'their-theme', { name: 'Theirs', stops: THEME.stops, grain: 0.2 });
    drive(state, [{ t: 'theme.save', theme: { id: 'mine', name: 'Mine', stops: THEME.stops, grain: 0.2 } }]);
    expect(tombstoned('their-theme')).toBe(false);
    expect(live('theme', 'their-theme')).toBe(true);
  });

  it.each([
    ['a Favorite', 'favorite', 'favorite', 'their-fav', { url: 'https://theirs.test/', title: 'Theirs', rank: 'a0', created: 1 }],
    ['a route', 'route', 'linkRoute', 'theirs.test', { chord: 'their-chord', created: 1 }],
    ['a site’s Effects', 'effects', 'effect', 'theirs.test', { wet: true, css: 'h1 { color: red }', cssOn: true, hidden: [], presets: [], duet: [] }],
    ['a chord', 'chord', 'chord', 'their-chord', { name: 'Theirs', icon: 'T', theme: THEME, rank: 'z0', profile: 'default', created: 1 }],
    ['a folder', 'folder', 'node', 'their-folder', { title: 'Theirs', collapsed: false, created: 1 }],
  ])('%s deleted by id before its apply was written (the write that lands is the deletion): stamped gone, and it stays gone', (_what, type, k, id, set) => {
    setUp();
    theirs(type, id, set);
    // Main applied it and you deleted it before persistence wrote the apply: one write, the deletion, with no row and no local.
    db.write([{ k, id, value: null } as WriteOp]);
    expect(tombstoned(id)).toBe(true);
    expect(live(type, id)).toBe(false);
    expect(new Map([...db.sync.unappliedPages()].flatMap((page) => [...page])).has(thingKey(type, id))).toBe(false);
  });

  it('what this computer had and took away is stamped gone: a theme out of its list, a Favorite removed', () => {
    let state = setUp();
    state = drive(state, [{ t: 'theme.save', theme: { id: 'mine', name: 'Mine', stops: THEME.stops, grain: 0.2 } }]);
    state = drive(state, [{ t: 'theme.delete', id: 'mine' }]);
    expect(tombstoned('mine')).toBe(true);
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [{ t: 'favorite.add', favoriteId: 'fav-mine', nodeId: tab }]);
    state = drive(state, [{ t: 'favorite.remove', favoriteId: 'fav-mine' }]);
    expect(tombstoned('fav-mine')).toBe(true);
    void state;
  });
});

describe('one id, one thing', () => {
  it('a node record under another kind of node’s id (a folder over a pinned tab) is refused and counted; the tab’s edits and deletion stay the tab’s', () => {
    let state = setUp();
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [{ t: 'tab.pin', nodeId: tab }]);
    const result = db.atomically(() => db.sync.merge([{ type: 'folder', id: tab, at: [Date.now() + 1000, 0, OTHER], set: { title: 'Decoy', collapsed: false, created: 1 } }], Date.now()));
    expect(result.dropped).toBe(1);
    expect(db.sync.snapshot().some((r) => r.type === 'folder' && r.id === tab)).toBe(false);
    state = drive(state, [{ t: 'tab.mute', nodeId: tab, muted: true }]);
    expect(outbox().some((r) => r.type === 'tab' && r.id === tab && r.set['muted'] === true)).toBe(true);
    state = drive(state, [{ t: 'tab.unpin', nodeId: tab }]);
    expect(outbox().some((r) => r.type === 'tab' && r.id === tab && r.set['deleted'] === true)).toBe(true);
    expect(outbox().filter((r) => r.id === tab).every((r) => r.type === 'tab')).toBe(true);
    void state;
  });
});

describe('local checked against the rows', () => {
  const mendAll = () => {
    let mended = 0;
    for (const n of db.sync.driftRepairs()) mended += n;
    return mended;
  };

  it('after ordinary writes of every kind, nothing to mend: what stamping keeps is exactly what the rows project to', () => {
    let state = setUp();
    const windowId = Object.keys(state.windows)[0]!;
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    state = drive(state, [
      { t: 'tab.pin', nodeId: tab },
      { t: 'chord.create', windowId, name: 'Two', icon: 'T', theme: THEME },
      { t: 'folder.create', folderId: 'f-1', chordId: chordId(state), title: 'Reading' },
      { t: 'favorite.add', favoriteId: 'fav-1', nodeId: tab },
      { t: 'theme.save', theme: { id: 'mine', name: 'Mine', stops: THEME.stops, grain: 0.2 } },
      { t: 'settings.set', settings: { searchEngine: 'duckduckgo' } },
      { t: 'linkRoute.set', host: 'mail.test', chordId: chordId(state) },
    ]);
    // A site's Effects, as the Effects service writes them.
    db.write([{ k: 'effect', id: 'mail.test', value: { host: 'mail.test', wet: true, css: 'h1 { color: red }', cssOn: true, hidden: [{ selector: '.ad', label: 'Ad', on: true, at: 1 }], presets: ['reading-width'], duet: [], createdAt: 1, updatedAt: 2, compiled: '', sanitizer: 1 } } as WriteOp]);
    expect(db.atomically(() => mendAll())).toBe(0);
    void state;
  });

  /** chord-data's own statements, for a test that plays an older version of what's kept. */
  const raw = (text: string) => (db as unknown as { sql(text: string): StatementSync }).sql(text);

  it('a join’s window: only the ids written in it are read back, and stamped as the joins ends, as the hook would have', () => {
    let state = setUp();
    const id = chordId(state);
    const tab = Object.values(state.nodes).find((n) => n.kind === 'tab')!.id;
    db.sync.setMeta({ joining: true });
    state = drive(state, [
      { t: 'chord.update', chordId: id, name: 'Renamed meanwhile' },
      { t: 'favorite.add', favoriteId: 'fav-window', nodeId: tab },
    ]);
    expect(outbox()).toEqual([]);
    expect(db.sync.unstamped).toBe(true);
    const local = vi.spyOn(db.sync, 'localThings');
    expect(db.atomically(() => db.sync.stampJoinWindow('all', Date.now()))).toBeGreaterThanOrEqual(2);
    db.sync.setMeta({ joining: false });
    expect(local).not.toHaveBeenCalled();
    expect(db.sync.unstamped).toBe(false);
    expect(outbox().find((r) => r.id === id)?.set).toMatchObject({ name: 'Renamed meanwhile' });
    expect(outbox().some((r) => r.type === 'favorite' && r.id === 'fav-window')).toBe(true);
    // Nothing left over for the drift check.
    expect(db.atomically(() => mendAll())).toBe(0);
    void state;
  });

  it('a real edit that slipped past the hook: stamped at its row’s time, not now, and sent', () => {
    const state = setUp();
    const id = chordId(state);
    const later = Date.now() + 60_000;
    db.sync.setMeta({ on: false });
    db.write([{ k: 'chord', id, value: { ...state.chords[id]!, name: 'Renamed unstamped' } }], later);
    db.sync.setMeta({ on: true });
    expect(db.atomically(() => mendAll())).toBe(1);
    const sent = outbox().find((r) => r.id === id);
    expect(sent?.set).toMatchObject({ name: 'Renamed unstamped' });
    expect(sent?.at?.[0]).toBe(later);
    expect(db.atomically(() => mendAll())).toBe(0);
  });

  it('a difference older than its field’s stamp (another computer’s, newer) only refreshes local: no stamp, nothing sent', () => {
    const state = setUp();
    const id = chordId(state);
    db.atomically(() => db.sync.merge([{ type: 'chord', id, at: [Date.now() + 60_000, 0, OTHER], set: { name: 'Theirs, later' } }], Date.now()));
    raw(`UPDATE sync_record SET local = json_set(local, '$.name', 'Stale') WHERE type = 'chord' AND id = ?`).run(id);
    expect(db.atomically(() => mendAll())).toBe(1);
    expect(outbox()).toEqual([]);
    expect(db.sync.snapshot().find((r) => r.type === 'chord' && r.id === id && 'name' in r.set)?.set['name']).toBe('Theirs, later');
    expect(db.atomically(() => mendAll())).toBe(0);
    void state;
  });

  it('upgrading to a version that projects rows otherwise (an icon past the cap): local refreshed, nothing stamped, and after that, nothing to mend', () => {
    const state = setUp();
    const big = `data:image/png;base64,${Buffer.alloc(SYNC_LIMITS.iconChars, 3).toString('base64')}`;
    const tab = { kind: 'tab', id: 'pinned-big', chordId: chordId(state), section: 'pinned', parentId: null, rank: 'a9', url: 'https://big.test/', title: 'Big', pinnedUrl: 'https://big.test/', customTitle: null, favicon: big, lastActiveAt: 1, createdAt: 1 };
    db.write([{ k: 'node', id: tab.id, value: tab } as WriteOp]);
    const before = outbox().length;
    // As the version before the cap kept it: the icon named, under the projection before this one.
    raw(`UPDATE sync_record SET local = json_set(local, '$.icon', 'sha256-before-the-cap') WHERE type = 'tab' AND id = ?`).run(tab.id);
    db.sync.setMeta({ projection: 0 });
    expect(db.atomically(() => mendAll())).toBe(1);
    expect(outbox().length).toBe(before);
    expect(db.sync.meta.projection).toBeGreaterThan(0);
    expect(db.atomically(() => mendAll())).toBe(0);
    expect(outbox().length).toBe(before);
  });

  it('pages by bytes: Effects at their largest (60 KB of CSS) are read a few at a time', () => {
    setUp();
    const steps = () => [...db.sync.driftRepairs()].length;
    const empty = db.atomically(() => steps());
    const css = (i: number) => `/* ${i} */ ${'h1 { color: red } '.repeat(3500)}`;
    for (let i = 0; i < 24; i++) db.write([{ k: 'effect', id: `site${i}.test`, value: { host: `site${i}.test`, wet: true, css: css(i), cssOn: true, hidden: [], presets: [], duet: [], createdAt: 1, updatedAt: 2, compiled: '', sanitizer: 1 } } as WriteOp]);
    expect(db.atomically(() => steps())).toBeGreaterThanOrEqual(empty + 2);
  });
});

describe('icons and reconcile pages stay small', () => {
  it('an icon past what sync carries (128 KB) is refused at merge', () => {
    setUp();
    const big = Buffer.alloc(SYNC_LIMITS.iconChars, 1).toString('base64');
    const id = `sha256-${createHash('sha256').update(Buffer.from(big, 'base64')).digest('hex')}`;
    expect(db.atomically(() => db.sync.merge([{ type: 'icon', id, set: { mime: 'image/png', data: big } }], Date.now())).dropped).toBe(1);
  });

  it('a reconcile reads no icons, and pages of about a quarter of a megabyte at most', () => {
    setUp();
    const css = (i: number) => `/* ${i} */ ${'h1 { color: red } '.repeat(9000)}`;
    db.atomically(() => db.sync.merge(Array.from({ length: 8 }, (_, i): DataRecord => ({ type: 'effects', id: `site${i}.test`, at: [Date.now() + 1000, 0, OTHER], set: { wet: true, css: css(i), cssOn: true, hidden: [], presets: [], duet: [] } })), Date.now()));
    const pages = [...db.sync.unappliedPages()].filter((page) => page.size > 0);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.size).toBeLessThanOrEqual(4);
  });
});
