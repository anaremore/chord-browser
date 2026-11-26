/**
 * Each profile's ad-blocking folders (`Extension/<name>`) are its own (#283): a profile id that differs from another only
 * in case, or in characters a file name can't hold, never shares one, on any file system (Windows' and macOS' ignore
 * case). A Windows reserved name or an empty id never names one. Profiles Chord made itself (uuidv7 ids, `default`) keep
 * the folder they had: their blocking isn't applied again.
 */
import { describe, expect, it } from 'vitest';
import { folderName, stays } from '../../src/main/ad-blocking/folders';

const sameOnDisk = (a: string, b: string) => folderName(a).toLowerCase() === folderName(b).toLowerCase();

describe('folderName: one folder per profile', () => {
  it.each([
    ['Work', 'work'],
    ['WORK', 'Work'],
    ['a.b', 'a b'],
    ['a.b', 'a_b'],
    ['a/b', 'a\\b'],
    ['x', 'X'],
    ['', '_'],
  ])('%j and %j never share a folder', (a, b) => {
    expect(sameOnDisk(a, b)).toBe(false);
  });

  it.each(['con', 'CON', 'nul', 'aux', 'prn', 'com1', 'lpt9', ''])('%j never names a folder itself (Windows reserved, or empty)', (id) => {
    const name = folderName(id);
    expect(name.length).toBeGreaterThan(0);
    expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)).toBe(false);
  });

  it.each(['default', '01a21619-df80-7e66-9577-09ceec5d0a05', 'work-2'])('%j, as Chord makes ids: the folder it always had', (id) => {
    expect(folderName(id)).toBe(id);
  });

  it('only characters a folder name can hold, and never longer than an id can be', () => {
    for (const id of ['Work', 'a.b', 'é', 'x'.repeat(64), 'X'.repeat(64), '']) expect(folderName(id)).toMatch(/^[a-z0-9_-]{1,64}$/);
  });
});

describe('stays: forgetProfiles never removes a folder a profile in use has', () => {
  // A profile 'work' in use (a kept name), and 'Work' from before #283 (whose folder was 'Work').
  const inUse = new Set([folderName('work'), folderName('Work')]);

  it.each(['win32', 'darwin'] as const)('on %s (case ignored): the old "Work" folder is the same as "work"’s, and stays', (platform) => {
    expect(stays('Work', inUse, platform)).toBe(true);
    expect(stays('work', inUse, platform)).toBe(true);
    expect(stays('gone', inUse, platform)).toBe(false);
  });

  it('on Linux (case kept): only the names in use stay; the old "Work" folder is another one, and goes', () => {
    expect(stays('work', inUse, 'linux')).toBe(true);
    expect(stays(folderName('Work'), inUse, 'linux')).toBe(true);
    expect(stays('Work', inUse, 'linux')).toBe(false);
  });
});
