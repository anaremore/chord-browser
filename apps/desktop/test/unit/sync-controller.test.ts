/**
 * Sync on chord-data's thread (src/data/sync.ts), with a stand-in for its
 * worker: what it does when writing goes wrong. A snapshot under a new id that
 * fails leaves everything as it was, says so, and tries again; nothing waiting
 * is lost. A profile whose key couldn't be read here (a copy of another
 * computer's) takes a new id as soon as it's unlocked, writing or not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, seedState, type State } from '@chord/core';
import { ChordDatabase } from '@chord/data/db';
import { opsForState, opsFromPatches, type DataPush } from '@chord/data';
import { SyncController } from '../../src/data/sync';

const worker = join(import.meta.dirname, 'fixtures', 'fake-sync-worker.mjs');
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };
const INFO = { name: 'Desk', os: 'Linux', app: '0.5.0' };
let n = 0;
const ctx = { now: 5000, newId: () => `id-${++n}` };

let dir: string;
let db: ChordDatabase;
let controller: SyncController | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chord-sync-controller-'));
  db = new ChordDatabase(join(dir, 'chord.db'), 'linux');
});
afterEach(() => {
  controller?.close();
  controller = null;
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env['CHORD_FAKE_SYNC'];
});

/** A profile with sync on, its log at segment 1, and a controller whose worker answers as \`plan\` says. */
function on(plan: Record<string, string[]>): { state: State; pushes: DataPush[] } {
  process.env['CHORD_FAKE_SYNC'] = JSON.stringify(plan);
  const state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
  db.write(opsForState(state));
  db.sync.setMeta({ on: true, folder: dir, generation: 1, name: 'Desk', own: { generation: 1, device: db.device(), segment: 1, size: 100, frames: 1 } });
  db.atomically(() => db.sync.addLocal('all'));
  const pushes: DataPush[] = [];
  controller = new SyncController(() => db, (push) => pushes.push(push), worker);
  return { state, pushes };
}

function rename(state: State, name: string): State {
  const result = apply(state, { t: 'chord.update', chordId: Object.keys(state.chords)[0]!, name }, ctx);
  db.write(opsFromPatches(result.patches, result.state));
  return result.state;
}

describe('writing, when it goes wrong', () => {
  it('a snapshot under a new id that fails (its log gone): nothing changes here, it says so, the change waits, and the next try lands it', async () => {
    const { state } = on({ write: ['gone', 'gone'], snapshot: ['io', 'ok'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Waiting');
    const before = db.device();
    await controller!.handle({ type: 'sync.flush' });
    // The new id's snapshot failed: the old id and its segment stand, the change waits, and Settings says so.
    expect(db.device()).toBe(before);
    expect(db.sync.meta.own).toMatchObject({ device: before, segment: 1 });
    expect(db.sync.outboxSize()).toBe(1);
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'unwritable' });
    // The next try (here at once; on its own, later and later): the snapshot lands, the id is the new one, and nothing waits.
    await controller!.handle({ type: 'sync.flush' });
    expect(db.device()).not.toBe(before);
    expect(db.sync.meta.own).toMatchObject({ device: db.device() });
    expect(db.sync.outboxSize()).toBe(0);
    expect(controller!.status().problem).toBeNull();
  });

  it('after a relaunch, writing goes on where it was: nothing was cleared', async () => {
    const { state } = on({ write: ['gone'], snapshot: ['io'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Waiting');
    await controller!.handle({ type: 'sync.flush' });
    controller!.close();
    process.env['CHORD_FAKE_SYNC'] = JSON.stringify({ write: ['ok'] });
    controller = new SyncController(() => db, () => undefined, worker);
    await controller.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    await controller.handle({ type: 'sync.flush' });
    expect(db.sync.outboxSize()).toBe(0);
  });

  it('another computer writing as this one again and again: past three new ids a day, it stops writing and says so', async () => {
    const { state } = on({ write: ['copied', 'copied', 'copied', 'copied'], snapshot: ['ok', 'ok', 'ok', 'ok'] });
    await controller!.handle({ type: 'sync.start', key: new Uint8Array(32), info: INFO });
    rename(state, 'Again');
    await controller!.handle({ type: 'sync.flush' });
    expect(db.sync.meta.newIds).toHaveLength(3);
    expect(controller!.status()).toMatchObject({ state: 'problem', problem: 'copies' });
    expect(db.sync.outboxSize()).toBeGreaterThan(0);
  });
});

describe('a copy of a profile that never writes', () => {
  it('its key couldn’t be read here: unlocked, it takes a new id at once, and reads the other’s log as another computer’s', async () => {
    on({ snapshot: ['ok'] });
    const before = db.device();
    const reply = await controller!.handle({ type: 'sync.unlock', passphrase: 'correct horse battery staple', info: INFO, rebind: true });
    expect(reply.key).toBeDefined();
    expect(db.device()).not.toBe(before);
    expect(db.sync.meta.rebind).toBe(false);
  });
});
