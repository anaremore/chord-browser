/**
 * #315 (Argon's B1): `profile.partition` is `UNIQUE`, and each row holds the partition its profile had when written.
 * Once `profilePartition` escapes ids one-to-one (`Work` → `persist:p-_work`), an old row could hold a new name: `_work`'s
 * `persist:p-_work`. Writing chord `Work` would then skip its profile row (INSERT OR IGNORE) and fail the chord's foreign
 * key, dropping the whole batch. A migration rewrites every row's partition to the new name, in two phases, in SQL that
 * must agree with `profilePartition`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profilePartition, seedState } from '@chord/core';
import { ChordDatabase } from '../src/db';
import { opsForState } from '../src';
import { oldDatabase } from './old-version';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-data-'));
  file = join(dir, 'chord.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The version before #315's migration: the last one whose rows hold `persist:p-${id}` as it was. */
const BEFORE = 24;

/** A database at BEFORE with a profile row (and a chord on it) for each id, as that build wrote them. */
function before(ids: readonly string[]): void {
  const db = oldDatabase(file, BEFORE);
  for (const id of ids) {
    db.prepare('INSERT INTO profile (id, name, partition, is_default, created_at) VALUES (?, ?, ?, 0, 1)').run(id, id, `persist:p-${id}`);
    db.prepare("INSERT INTO chord (id, profile_id, name, icon, theme, rank, created_at, updated_at) VALUES (?, ?, ?, 'i', '{}', 'a', 1, 1)").run(`c-${id}`, id, id);
  }
  db.close();
}

function partitions(): Record<string, string> {
  const db = new DatabaseSync(file);
  try {
    return Object.fromEntries((db.prepare('SELECT id, partition FROM profile').all() as { id: string; partition: string }[]).map((r) => [r.id, r.partition]));
  } finally {
    db.close();
  }
}

describe('profile partitions after #315 (migration)', () => {
  it('every row holds the partition profilePartition gives it now: the SQL escape and the TypeScript one agree', () => {
    const ids = ['01a21619-df80-7e66-9577-09ceec5d0a05', 'work', 'Work', 'WORK', 'wORK', 'a_b', 'a__b', 'A_b', '_a', '_A', '__', 'x-Y_z', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Z'.repeat(64)];
    before(ids);
    new ChordDatabase(file).close();
    const rows = partitions();
    for (const id of ids) expect(rows[id], id).toBe(profilePartition(id));
    // The default profile's row is as it was.
    expect(rows['default']).toBe('persist:default');
  });

  it('a private window’s profile row, should an old database hold one, keeps its in-memory partition', () => {
    const db = oldDatabase(file, BEFORE);
    db.prepare("INSERT INTO profile (id, name, partition, is_default, created_at) VALUES ('private-w1', 'P', 'chord-private-w1', 0, 1)").run();
    db.prepare("INSERT INTO profile (id, name, partition, is_default, created_at) VALUES ('Private-W2', 'P', 'persist:p-Private-W2', 0, 1)").run();
    db.close();
    new ChordDatabase(file).close();
    const rows = partitions();
    expect(rows['private-w1']).toBe('chord-private-w1');
    // Not a private window's (case counts, as isPrivateProfile's): escaped like any other.
    expect(rows['Private-W2']).toBe(profilePartition('Private-W2'));
  });

  it('an old `_work` row no longer holds `Work`’s new partition: writing chord `Work` lands, and its batch isn’t dropped', () => {
    before(['_work']);
    const db = new ChordDatabase(file);
    try {
      let n = 0;
      const state = seedState({ now: 1000, newId: () => `id-${++n}`, theme: { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' }, homeUrl: 'https://home.test/' });
      const chordId = Object.keys(state.chords)[0]!;
      state.chords[chordId] = { ...state.chords[chordId]!, profileId: 'Work' };
      expect(() => db.write(opsForState(state))).not.toThrow();
    } finally {
      db.close();
    }
    const rows = partitions();
    expect(rows['_work']).toBe('persist:p-__work');
    expect(rows['Work']).toBe('persist:p-_work');
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare("SELECT count(*) AS n FROM chord WHERE profile_id = 'Work'").get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });

  it('nothing is left half-way (`migrating:`), and a database already migrated is unchanged when opened again', () => {
    before(['Work', 'work']);
    new ChordDatabase(file).close();
    const once = partitions();
    new ChordDatabase(file).close();
    expect(partitions()).toEqual(once);
    expect(Object.values(once).some((p) => p.startsWith('migrating:'))).toBe(false);
  });

  it('lists the profiles whose folder must move: profile rows and extensions’ profiles with upper case or `_`; never Chord’s own, the default or a private window’s (Opus on #329)', () => {
    before(['Work', 'a_b', '01a21619-df80-7e66-9577-09ceec5d0a05', 'plain']);
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = OFF');
    old.prepare("INSERT INTO profile (id, name, partition, is_default, created_at) VALUES ('private-W1', 'P', 'chord-private-W1', 0, 1)").run();
    const ext = old.prepare("INSERT INTO extension (profile_id, id, name, version, source, path, notified_version, pinned, installed_at, updated_at) VALUES (?, ?, 'E', '1', 'store', '/x', NULL, 1, 0, 0)");
    ext.run('Ext_Only', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    ext.run('default', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    ext.run('Work', 'cccccccccccccccccccccccccccccccc');
    old.close();
    const db = new ChordDatabase(file);
    try {
      expect(db.partitionMoves()).toEqual(['Ext_Only', 'Work', 'a_b']);
      // Moved: off the list, for good.
      db.partitionMoved(['Work', 'a_b']);
      expect(db.partitionMoves()).toEqual(['Ext_Only']);
    } finally {
      db.close();
    }
    // Opened again: the migration doesn't run twice, so nothing comes back on the list.
    const again = new ChordDatabase(file);
    try {
      expect(again.partitionMoves()).toEqual(['Ext_Only']);
    } finally {
      again.close();
    }
  });

  it('a new database lists nothing: no profile was ever in a folder of the old naming', () => {
    const db = new ChordDatabase(file);
    try {
      expect(db.partitionMoves()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
