/**
 * #325: Settings → Privacy → Proxy's rows for a proxy that can't be set (the owner's pick, 2026-11-26): "Can't use
 * Work's proxy." under the chord whose own it is, "Can't use this proxy." under the one for every chord, why, and Try
 * again. Only while it's true.
 */
import { describe, expect, it } from 'vitest';
import { proxyFailingRows } from '../../src/renderer/settings/proxy-row';

const chords = [
  { id: 'c1', name: 'Work' },
  { id: 'c2', name: 'Home' },
];

describe('the rows for a proxy that can’t be set (#325)', () => {
  it('nothing failing (or not heard yet): no rows', () => {
    expect(proxyFailingRows(null, chords)).toEqual({ all: null, own: new Map() });
    expect(proxyFailingRows({ failing: [] }, chords)).toEqual({ all: null, own: new Map() });
  });

  it('a chord’s own proxy: named by its chord, under it, with why; Try again tries its sign-ins’', () => {
    const rows = proxyFailingRows({ failing: [{ owner: 'p1', own: true, chordIds: ['c1'], reason: 'net::ERR_INVALID_ARGUMENT' }] }, chords);
    expect(rows.all).toBeNull();
    expect(rows.own.get('c1')).toEqual({
      owner: 'p1',
      chordId: 'c1',
      label: 'Can’t use Work’s proxy.',
      description: 'Its pages wait until Chord can, and Chord keeps trying. Chromium said net::ERR_INVALID_ARGUMENT.',
    });
    expect(rows.own.has('c2')).toBe(false);
  });

  it('the proxy for every chord: one row, under it; Try again tries every one failing', () => {
    const rows = proxyFailingRows({ failing: [{ owner: null, own: false, chordIds: ['c1', 'c2'], reason: 'net::ERR_FAILED' }] }, chords);
    expect(rows.all).toEqual({ owner: null, chordId: null, label: 'Can’t use this proxy.', description: 'Pages wait until Chord can, and Chord keeps trying. Chromium said net::ERR_FAILED.' });
    expect(rows.own.size).toBe(0);
  });

  it('a chord that’s gone meanwhile: no row for it', () => {
    expect(proxyFailingRows({ failing: [{ owner: 'p9', own: true, chordIds: ['gone'], reason: 'x' }] }, chords).own.size).toBe(0);
  });
});
