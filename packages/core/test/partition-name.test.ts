/**
 * #315: a profile's partition. Electron keeps `persist:<name>` in `Partitions/<name in lower case>`, on every platform,
 * so the name is escaped one-to-one into lower case: `_` → `__`, an upper-case letter → `_` and its lower case. Ids with
 * neither (all of Chord's own: uuidv7 and `default`) keep the partition they always had.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE, profilePartition } from '../src';
import { restoreChord } from '../src/restore';

/** What Electron makes of a persistent partition's name, for its folder. */
const folder = (partition: string) => partition.replace(/^persist:/, '').toLowerCase();

/** Ids as `isId` allows them (letters, digits, `-`, `_`), built to hit every case and `_` mix. */
function ids(): string[] {
  const out = new Set<string>(['work', 'Work', 'WORK', 'wORK', 'a_b', 'a__b', 'A_b', 'a_B', '_a', '_A', '__', '_', 'a', 'A', '-', 'a-b', 'A-B']);
  const alphabet = ['a', 'A', 'b', 'B', '_', '-', '0'];
  // Every string of up to 4 of those: each pair that could collide after an escape and Electron's lowercasing.
  let level = [''];
  for (let n = 0; n < 4; n++) {
    level = level.flatMap((s) => alphabet.map((c) => s + c));
    for (const s of level) out.add(s);
  }
  out.add('x'.repeat(64));
  out.add('X'.repeat(64));
  out.add('_'.repeat(64));
  return [...out];
}

describe('profilePartition (#315)', () => {
  it('no two ids share a partition folder, after Electron lowercases it', () => {
    const seen = new Map<string, string>();
    for (const id of ids()) {
      const at = folder(profilePartition(id));
      expect(seen.get(at), `${JSON.stringify(id)} and ${JSON.stringify(seen.get(at))} share ${at}`).toBeUndefined();
      seen.set(at, id);
    }
  });

  it('the name is already lower case: Electron changes nothing in it', () => {
    for (const id of ids()) expect(profilePartition(id)).toBe(profilePartition(id).toLowerCase());
  });

  it.each(['01a21619-df80-7e66-9577-09ceec5d0a05', 'work', 'work-2', '0123'])('%j, an id as Chord makes them, keeps the partition it always had', (id) => {
    expect(profilePartition(id)).toBe(`persist:p-${id}`);
  });

  it('the default profile and a private window’s are as they were', () => {
    expect(profilePartition(DEFAULT_PROFILE)).toBe('persist:default');
    expect(profilePartition('private-w1')).toBe('chord-private-w1');
  });

  it('the escape, spelled out', () => {
    expect(profilePartition('Work')).toBe('persist:p-_work');
    expect(profilePartition('work_1')).toBe('persist:p-work__1');
    expect(profilePartition('Work_1')).toBe('persist:p-_work__1');
    expect(profilePartition('_work')).toBe('persist:p-__work');
  });
});

describe('restoreChord’s profile (#315: a partition’s folder assumes an id as `isId` allows)', () => {
  const chord = (profileId: string) => ({ id: 'c1', profileId, name: 'C', icon: 'i', theme: { stops: [], grain: 0, appearance: 'auto' as const }, rank: 'a', createdAt: 1 });
  it.each(['Work', 'work_1', '01a21619-df80-7e66-9577-09ceec5d0a05', DEFAULT_PROFILE])('%j stays', (id) => {
    expect(restoreChord(chord(id) as never).profileId).toBe(id);
  });
  it.each(['a/b', '..', '', 'é', 'x'.repeat(65), 'private-w1'])('%j (not an id, or a private window’s) restores as the default profile', (id) => {
    expect(restoreChord(chord(id) as never).profileId).toBe(DEFAULT_PROFILE);
  });
});
