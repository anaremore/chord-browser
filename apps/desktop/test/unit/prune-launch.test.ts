/**
 * #330: a profile no chord uses any more (its chord shares sign-ins again) is pruned at launch with the extensions
 * installed in it, so launch makes no session for it (launchProfiles: the chords' and the extensions', what index.ts
 * and extensions.start make sessions for), and its sign-ins on disk go as unused (removeUnusedPartitions). A profile
 * still in use keeps its extensions and its sign-ins.
 *
 * With the real database (chord-data's), as launch opens it: pruned, then loaded, then restored.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, profilePartition, restoreState, seedState, type Command, type Context, type State } from '@chord/core';
import { opsForState, opsFromPatches } from '@chord/data';
import { ChordDatabase } from '@chord/data/db';
import { afterEach, describe, expect, it } from 'vitest';
import { foldersInUse, launchProfiles, partitionFolder } from '../../src/main/partitions';
import { removeUnusedPartitions } from '../../src/main/persistence';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const ctx: Context = { now: 5000, newId: () => `id-${++n}` };
const THEME = { stops: [{ l: 0.72, c: 0.12, h: 270 }], grain: 0.2, appearance: 'auto' as const };

/** Commands applied to the state and written to the database, as main and chord-data do. */
function drive(db: ChordDatabase, state: State, commands: Command[]): State {
  for (const command of commands) {
    const result = apply(state, command, ctx);
    db.write(opsFromPatches(result.patches, result.state));
    state = result.state;
  }
  return state;
}

const extension = (profileId: string) => ({
  id: 'ddkjiahejlhfcafbddmgiahcphecmpfh',
  profileId,
  name: 'uBlock Origin Lite',
  version: '2026.1013.1',
  source: 'store' as const,
  path: `C:/Chord/Extensions/${profileId}/ubol/2026.1013.1_0`,
  notifiedVersion: null,
  pinned: true,
  installedAt: 1,
  updatedAt: 2,
});

describe('a profile no chord uses any more, at the next launch (#330)', () => {
  it('pruned with its extensions: no session made for it, and its sign-ins on disk go; one in use keeps both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chord-prune-launch-'));
    dirs.push(dir);
    const file = join(dir, 'chord.db');
    const userData = join(dir, 'userData');
    const folder = (profileId: string) => join(userData, 'Partitions', partitionFolder(profilePartition(profileId)));
    for (const id of ['gone', 'kept']) {
      mkdirSync(folder(id), { recursive: true });
      writeFileSync(join(folder(id), 'Cookies'), 'signed in');
    }

    // Two chords with sign-ins of their own, an extension installed in each; then the first shares sign-ins again.
    let db = new ChordDatabase(file);
    let state = seedState({ now: 1000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });
    db.write(opsForState(state));
    // A second chord: seedState makes one (Neon's B2 on #335).
    state = drive(db, state, [{ t: 'chord.create', windowId: Object.keys(state.windows)[0]!, name: 'Two', icon: 'T', theme: THEME }]);
    const [first, second] = Object.keys(state.chords);
    expect(second).toBeDefined();
    drive(db, state, [
      { t: 'chord.profile', chordId: first!, profileId: 'gone' },
      { t: 'chord.profile', chordId: second!, profileId: 'kept' },
      { t: 'extension.record', extension: extension('gone') },
      { t: 'extension.record', extension: extension('kept') },
      { t: 'chord.profile', chordId: first!, profileId: 'default' },
    ]);
    db.close();

    // The next launch: chord-data opens it with prune, then main restores what it loaded.
    db = new ChordDatabase(file);
    db.pruneProfiles();
    const saved = db.load();
    db.close();
    const initial = restoreState(saved, { now: 9000, newId: ctx.newId, theme: THEME, homeUrl: 'https://home.test/' });

    const sessions = launchProfiles(initial);
    expect(sessions).not.toContain('gone');
    expect(sessions).toContain('kept');
    expect(Object.values(initial.extensions).map((e) => e.profileId)).toEqual(['kept']);
    await removeUnusedPartitions(userData, foldersInUse(sessions, new Map(), []));
    expect(existsSync(folder('gone'))).toBe(false);
    expect(existsSync(folder('kept'))).toBe(true);
  });
});

describe('launchProfiles (#330)', () => {
  it('every chord’s profile, and every one an extension is installed in, once each (Neon’s SF2 on #335)', () => {
    const state = {
      chords: { a: { profileId: 'default' }, b: { profileId: 'work' }, c: { profileId: 'work' } },
      extensions: { 'ext-only:x': { profileId: 'ext-only' }, 'work:x': { profileId: 'work' } },
    } as unknown as Pick<State, 'chords' | 'extensions'>;
    expect(launchProfiles(state).sort()).toEqual(['default', 'ext-only', 'work']);
  });
});
