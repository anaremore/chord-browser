/**
 * #284: Settings → Privacy's row for the chords whose ad blocking didn't come on (the owner's pick of
 * mocks/ad-blocking-failed-284.html, 2026-11-26): "Not blocking in Work", why, and Try again, which says "Trying…" while
 * it runs. Only while it's true, only for chords (a private window's blocking can't fail this way).
 */
import { describe, expect, it } from 'vitest';
import { notBlockingRow } from '../../src/renderer/settings/ad-blocking-row';

const chords = [
  { id: 'c1', name: 'Work', profileId: 'p-work' },
  { id: 'c2', name: 'Home', profileId: 'p-home' },
  { id: 'c3', name: 'School', profileId: 'p-school' },
  // Two chords on one profile's sign-ins: both named.
  { id: 'c4', name: 'Side project', profileId: 'p-work' },
];

describe('the row for chords whose ad blocking didn’t come on (#284)', () => {
  it('nothing listed: no row', () => {
    expect(notBlockingRow([], chords)).toBeNull();
  });

  it('one chord: its name, this chord, its pages; Try again', () => {
    expect(notBlockingRow([{ profileId: 'p-home', state: 'failed' }], chords)).toEqual({
      label: 'Not blocking in Home',
      description: 'Ad blocking couldn’t start for this chord, so its pages load without it.',
      trying: false,
      profiles: ['p-home'],
    });
  });

  it('two chords: joined with and; these chords, their pages', () => {
    expect(notBlockingRow([{ profileId: 'p-home', state: 'failed' }, { profileId: 'p-school', state: 'failed' }], chords)).toMatchObject({
      label: 'Not blocking in Home and School',
      description: 'Ad blocking couldn’t start for these chords, so their pages load without it.',
    });
  });

  it('a profile two chords share: both named; three or more joined with commas', () => {
    expect(notBlockingRow([{ profileId: 'p-work', state: 'failed' }, { profileId: 'p-home', state: 'failed' }], chords)?.label).toBe('Not blocking in Work, Side project and Home');
  });

  it('trying again for any of them: Trying…; only the failed ones are tried again', () => {
    const row = notBlockingRow([{ profileId: 'p-home', state: 'retrying' }, { profileId: 'p-school', state: 'failed' }], chords);
    expect(row?.trying).toBe(true);
    expect(row?.profiles).toEqual(['p-school']);
  });

  it('a profile no chord uses (an agent’s, a private window’s): not named, and no row for it alone', () => {
    expect(notBlockingRow([{ profileId: 'p-gone', state: 'failed' }], chords)).toBeNull();
  });
});
