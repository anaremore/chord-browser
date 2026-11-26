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
    // These guard the kept-name pattern (/^[a-z0-9-]{1,64}$/), not regressions of #283: Windows drops a name's
    // trailing dots and spaces, so these would be `work`'s folder (Neon's N1 on #290), and `..` / `../x` are path steps.
    // (Opus's N3 on #290.)
    ['work.', 'work'],
    ['work ', 'work'],
    ['..', '.'],
    ['../x', 'x'],
    // An id that's another's folder name is never that folder.
    [folderName('Work'), 'Work'],
  ])('%j and %j never share a folder', (a, b) => {
    expect(sameOnDisk(a, b)).toBe(false);
  });

  it.each(['con', 'CON', 'nul', 'aux', 'prn', 'com0', 'com1', 'lpt0', 'lpt9', '', '..', '.'])('%j never names a folder itself (Windows reserved, a path step, or empty)', (id) => {
    const name = folderName(id);
    expect(name.length).toBeGreaterThan(0);
    expect(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)).toBe(false);
    expect(name).not.toMatch(/[./\\]/);
  });

  it('a hashed name is `_` and 32 hex digits; an id longer than any Chord makes (65) is hashed', () => {
    expect(folderName('Work')).toMatch(/^_[0-9a-f]{32}$/);
    expect(folderName('a'.repeat(64))).toBe('a'.repeat(64));
    expect(folderName('a'.repeat(65))).toMatch(/^_[0-9a-f]{32}$/);
    expect(folderName(folderName('Work'))).not.toBe(folderName('Work'));
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

  it('case ignored, on every platform (a Linux mount can ignore it too): the old "Work" folder may be "work"’s, and stays', () => {
    expect(stays('Work', inUse)).toBe(true);
    expect(stays('work', inUse)).toBe(true);
    expect(stays('WORK', inUse)).toBe(true);
    expect(stays(folderName('Work'), inUse)).toBe(true);
    expect(stays(folderName('Work').toUpperCase(), inUse)).toBe(true);
    expect(stays('gone', inUse)).toBe(false);
  });

  it('an old "Work" folder goes when only Work is in use (its folder is the hashed one)', () => {
    expect(stays('Work', new Set([folderName('Work')]))).toBe(false);
  });
});
