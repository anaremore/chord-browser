/**
 * #325 / #331: Settings → Privacy → Proxy's rows for a proxy that can't be set (the owner's pick, 2026-11-26), and what
 * a screen reader hears about them (Carbon's B2 on #331): each row by its key ('all', or a chord's id), said once when
 * it shows, "Still can't use …" when a try ends and it's still failing, and "… works again" only while it's still used.
 */
import { describe, expect, it } from 'vitest';
import { proxyAnnouncement, proxyFailingRows, type RowSeen } from '../../src/renderer/settings/proxy-row';

const chords = [
  { id: 'c1', name: 'Work' },
  { id: 'c2', name: 'Home' },
];

describe('the rows for a proxy that can’t be set (#325)', () => {
  it('nothing failing (or not heard yet): no rows', () => {
    expect(proxyFailingRows(null, chords)).toEqual({ all: null, own: new Map() });
    expect(proxyFailingRows({ failing: [] }, chords)).toEqual({ all: null, own: new Map() });
  });

  it('a chord’s own proxy: named by its chord, under it, in words for people (Carbon’s SF5): an address or file that won’t do', () => {
    const rows = proxyFailingRows({ failing: [{ owner: 'p1', own: true, chordIds: ['c1'], reason: 'net::ERR_INVALID_ARGUMENT' }] }, chords);
    expect(rows.all).toBeNull();
    expect(rows.own.get('c1')).toEqual({
      key: 'c1',
      owner: 'p1',
      chordId: 'c1',
      label: 'Can’t use Work’s proxy.',
      description: 'Its pages wait until Chord can. Check the proxy’s address or its configuration file (ERR_INVALID_ARGUMENT).',
    });
  });

  it('the proxy for every chord: one row; any other reason says Chord keeps trying, with its code in parentheses', () => {
    const rows = proxyFailingRows({ failing: [{ owner: null, own: false, chordIds: ['c1', 'c2'], reason: 'net::ERR_FAILED' }] }, chords);
    expect(rows.all).toEqual({ key: 'all', owner: null, chordId: null, label: 'Can’t use this proxy.', description: 'Pages wait until Chord can, and Chord keeps trying (ERR_FAILED).' });
  });

  it('a reason that isn’t an ERR_ code: no code shown, never "Chromium said" or "net::"', () => {
    const rows = proxyFailingRows({ failing: [{ owner: null, own: false, chordIds: ['c1'], reason: 'closing failed' }] }, chords);
    expect(rows.all!.description).toBe('Pages wait until Chord can, and Chord keeps trying.');
  });

  it('a chord that’s gone meanwhile: no row for it', () => {
    expect(proxyFailingRows({ failing: [{ owner: 'p9', own: true, chordIds: ['gone'], reason: 'x' }] }, chords).own.size).toBe(0);
  });
});

describe('what a screen reader hears (Carbon’s B2 on #331)', () => {
  const seen = (rows: Record<string, { label: string; trying?: boolean }>): Map<string, RowSeen> =>
    new Map(Object.entries(rows).map(([key, r]) => [key, { label: r.label, trying: r.trying ?? false }]));
  const uses = () => true;

  it('a row showing: said once, by its key; the same row again (a poll, a rename) says nothing', () => {
    expect(proxyAnnouncement(seen({}), seen({ c1: { label: 'Can’t use Work’s proxy.' } }), uses)).toBe('Can’t use Work’s proxy.');
    expect(proxyAnnouncement(seen({ c1: { label: 'Can’t use Work’s proxy.' } }), seen({ c1: { label: 'Can’t use Office’s proxy.' } }), uses)).toBeNull();
  });

  it('Try again: the text clears when it starts (so a repeat is said again), and “Still …” when it ends still failing', () => {
    expect(proxyAnnouncement(seen({ all: { label: 'Can’t use this proxy.' } }), seen({ all: { label: 'Can’t use this proxy.', trying: true } }), uses)).toBe('');
    expect(proxyAnnouncement(seen({ all: { label: 'Can’t use this proxy.', trying: true } }), seen({ all: { label: 'Can’t use this proxy.' } }), uses)).toBe('Still can’t use this proxy.');
  });

  it('a row gone: “works again” for that one, only while it still uses a proxy (never after you turned it off)', () => {
    const before = seen({ all: { label: 'Can’t use this proxy.' }, c1: { label: 'Can’t use Work’s proxy.' } });
    expect(proxyAnnouncement(before, seen({ c1: { label: 'Can’t use Work’s proxy.' } }), uses)).toBe('The proxy works again.');
    expect(proxyAnnouncement(before, seen({ all: { label: 'Can’t use this proxy.' } }), (key) => key !== 'c1', { c1: 'Work' })).toBeNull();
    expect(proxyAnnouncement(before, seen({ all: { label: 'Can’t use this proxy.' } }), uses, { c1: 'Work' })).toBe('Work’s proxy works again.');
  });
});
