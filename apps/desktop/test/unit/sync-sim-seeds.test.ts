/**
 * Seeds of the sync simulation (test/sim, `pnpm test:sim`) that each found a
 * bug, run with every `pnpm test`: each keeps every invariant now. A seed is
 * a whole run (three computers, 120 steps, faults), so a change to the
 * simulation itself (what it picks, in what order) can move what a seed
 * exercises; the bug each found also has a test of its own, beside the code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('../sim/electron')).electron);
const { runSeed } = await import('../sim/sim');

/** Each seed, and what it found (S15 §13, the ninth review). */
const SEEDS: [number, string][] = [
  [19, 'a push read before your write was taken, put off and asked for again for ever'],
  [22, 'a join on a full disk threw, and Settings never said why'],
  [71, 'a chord that was to make way, lost to a crash, stayed and never synced; the drift check took a set-aside row for an edit'],
  [92, 'a copy of a profile turning sync off removed the computer it was copied from'],
  [108, 'a computer joining again wrote under its old id, at a segment number another had pruned, and no one read it'],
  [136, 'what you changed while a join waited was stamped as new, every field, bringing back what another computer deleted'],
  [152, 'a log put back to an old version, its computer off, lost what others had read of it'],
  [174, 'a snapshot owed for a log put back was forgotten in a crash'],
  [188, 'an edit of a tab another computer had unpinned brought it back'],
  [213, 'a route set again after another computer removed it lost to that removal'],
  [436, 'a route made and removed here, before another computer’s arrived, wasn’t removed'],
  [447, 'a reader went on in one copy’s history of a segment the sync app had replaced with another’s, and stopped for good'],
  [499, 'an apply read before your change was written put the older value back over it'],
  [621, 'a change made while an apply’s parts were going in was overwritten by a later part'],
  [771, 'an edit of what sync applied, not yet written, was stamped as a whole new tab'],
  [667, 'a route waiting for its chord (deleted here) was taken for gone by the drift check, so an edit of it brought back what another computer deleted'],
  [2193, 'a chord with no rank in the copy was given one no rank can follow, and the next chord made threw'],
  [2809, 'a setting changed while a join waited, to what the copy had already, was never stamped, and an older value elsewhere won'],
  [2929, 'a change a full disk put off was stamped above another computer’s later deletion, which it had never shown'],
  [3403, 'two changes of a tab a full disk put off went as one, as of the later, over a move made elsewhere between them'],
  [3869, 'a tab unpinned while a join refused partway waited, which the copy hadn’t read yet, came back'],
  [4788, 'joining with the synced setup, a chord both had was never noted here, so renaming it brought back another computer’s deletion'],
  [4837, 'another computer’s change applied after one of yours, both waiting on a full disk, was written first, and yours brought back a theme it deleted'],
  [5195, 'a chord made and deleted on a full disk was written gone first, then made'],
  [5732, 'joining with the synced setup before the other logs came: no chord to make way for, and this computer’s was left out of sync'],
  [5906, 'two copies of a profile each wrote a segment of its own under one id, and neither found the other'],
  [588, 'a tab put off with its chord’s deletion was asked for again, and put off again, every millisecond'],
  [685, 'a tab an Undo brought back to Today while a join waited was stamped as a deletion'],
  [1604, 'a route made and removed while a join waited, the copy not having read it, was never stamped gone'],
  [5071, 'joining with the synced setup, whose chords this computer had deleted (not yet written): no chord to make way for, and its own left out of sync'],
  [5666, 'the other copy’s version of a segment, kept under its name, was as long as the one read, and its last frame was never read'],
  [6215, 'a deletion while a join waited was stamped above another computer’s later bringing back'],
  [9993, 'an edit of a route waiting for its chord, never written here, brought back another computer’s deletion'],
  [207, 'another computer’s chord applied and taken away by you in one write was taken away first, and its Undo made it again, every field, over a rename'],
  [10110, 'a copy of a profile compacted past the segment the original wrote on, and never read what the original wrote there after'],
  [10370, 'a theme the copy had only renames of (the record that made it gone with a log put back) was never applied'],
  [10400, 'a crash just after joining with the synced setup: this computer’s chord was asked to make way before the synced chord was there, and never did'],
  [11547, 'a removed computer’s log, put back to an old version, was pruned before the computers that had read past it saw it, so they never wrote what was past it again'],
  [12601, 'a deletion made while sync was off, its write put off by a full disk until a join had begun, was stamped as one of the join’s, and went everywhere'],
  [15192, 'the simulation’s own: a pinned tab the copy had only a change of, its making lost with a log put back and never on this computer, has nothing to make it from, and waits'],
  [15431, 'a pinned tab the copy had only changes of (its making gone with a log put back) was never applied, though this computer had the rest'],
  [15440, 'a removed computer’s log, put back to an old version, was pruned by its new id before the others that had read past it saw it, and the copies never agreed again'],
  [17767, 'the simulation’s own: as 15192, a tab moved elsewhere whose making no one has any more'],
  [8856, 'a Today tab closed in a join’s window, unpinned earlier in it, retimed the unpinning’s deletion past another computer’s pinning it again'],
  [11137, 'joining with the synced setup, its last synced chord deleted here while the join waited: no chord to make way for, and this computer’s left out of sync'],
  [11738, 'the simulation’s own: a name typed with sync off is as old as that, though an Undo brings it into sync later'],
  [12186, 'the simulation’s own: what chord-data kept of a route before it went came from the join, not a write here'],
  [14148, 'as 11137, the synced chord deleted here in the join’s window'],
  [22193, 'a route deleted here that the copy hadn’t read yet (waiting for its chord as this computer joined) was never stamped gone, and came back'],
  [25987, 'a route set and deleted again in a join’s window, one write, was never stamped gone, and came back'],
  [24181, 'a folder deleted and brought back by Undo in a join’s window lost to another computer’s earlier deletion'],
  [25410, 'a rename and a move of one folder a moment apart, written together, stamped the rename as of the move, over a later rename elsewhere'],
  [39439, 'a pinned tab deleted in a join’s window, before the copy had read it, got no tombstone, and a log put back brought it back'],
  [33660, 'the simulation’s own: a folder deleted in a join’s window, made in Turn off’s Undo, is in the chord the outbox and its window say'],
  [38763, 'the simulation’s own: as 33660'],
  [34719, 'the simulation’s own: a value dropped as no change, or set aside by a join, made nothing that syncs, for I4'],
];

describe('the sync simulation’s seeds that found bugs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SEEDS)('seed %i: %s', async (seed) => {
    const result = await runSeed({ seed, steps: 120 });
    expect(result.violations, result.trace.slice(-80).join('\n')).toEqual([]);
  }, 120_000);
});
