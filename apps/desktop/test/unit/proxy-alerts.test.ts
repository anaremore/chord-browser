/**
 * #325: what Settings lists for the proxies that can't be set (a chord's own by its chord, the one for every chord
 * once), and the toast: once when a proxy starts failing, in the windows of the chords it holds, never again while it
 * goes on failing; again if it fails again after it took.
 */
import { describe, expect, it } from 'vitest';
import { ProxyAlerts, proxyStatus, type ProxyChord } from '../../src/main/proxy-alerts';

const chords: ProxyChord[] = [
  { id: 'c1', name: 'Work', profileId: 'p1', own: true },
  { id: 'c2', name: 'Home', profileId: 'default', own: false },
  { id: 'c3', name: 'School', profileId: 'p3', own: false },
];

describe('proxyStatus (#325)', () => {
  it('a chord’s own proxy failing: by its chord', () => {
    expect(proxyStatus([{ owner: 'p1', reason: 'net::ERR_FAILED' }], chords)).toEqual({ failing: [{ owner: 'p1', own: true, chordIds: ['c1'], reason: 'net::ERR_FAILED' }] });
  });

  it('the proxy for every chord failing in several sessions (default, a chord’s sign-ins, Chord’s own): one entry, its chords in order', () => {
    expect(
      proxyStatus(
        [
          { owner: 'p3', reason: 'net::ERR_FAILED' },
          { owner: null, reason: 'net::ERR_FAILED' },
          { owner: 'default', reason: 'net::ERR_FAILED' },
        ],
        chords,
      ),
    ).toEqual({ failing: [{ owner: null, own: false, chordIds: ['c2', 'c3'], reason: 'net::ERR_FAILED' }] });
  });

  it('nothing failing: nothing listed', () => {
    expect(proxyStatus([], chords)).toEqual({ failing: [] });
  });
});

describe('ProxyAlerts: one toast per failure, per window (#325; Neon’s N-SF5 and Opus’s SF3 on #331)', () => {
  const work = proxyStatus([{ owner: 'p1', reason: 'x' }], chords);

  it('a chord’s own proxy failing: named by the chord; its Settings opens that chord’s proxy, never the active one', () => {
    expect(new ProxyAlerts().due(work, chords)).toEqual([
      { key: 'own:p1', chordIds: ['c1'], chordId: 'c1', privateToo: false, message: 'Work’s proxy isn’t working. Its pages are waiting.' },
    ]);
  });

  it('the proxy for every chord: its Settings opens that one (null), and private windows get it too', () => {
    expect(new ProxyAlerts().due(proxyStatus([{ owner: 'default', reason: 'x' }], chords), chords)).toEqual([
      { key: 'all', chordIds: ['c2'], chordId: null, privateToo: true, message: 'The proxy isn’t working. Pages are waiting.' },
    ]);
  });

  it('counted per window, only once a window got it: none open yet, then the first window gets it; a second window too; never twice', () => {
    const alerts = new ProxyAlerts();
    alerts.showed('own:p1', []);
    expect(alerts.shownIn('own:p1', 'w1')).toBe(false);
    alerts.showed('own:p1', ['w1']);
    expect(alerts.due(work, chords)).toHaveLength(1);
    expect(alerts.shownIn('own:p1', 'w1')).toBe(true);
    expect(alerts.shownIn('own:p1', 'w2')).toBe(false);
  });

  it('taken (or gone), then failing again: every window gets it again', () => {
    const alerts = new ProxyAlerts();
    alerts.due(work, chords);
    alerts.showed('own:p1', ['w1']);
    alerts.due({ failing: [] }, chords);
    alerts.due(work, chords);
    expect(alerts.shownIn('own:p1', 'w1')).toBe(false);
  });

  it('Chord’s own requests only (no chord on it): still due, for private windows', () => {
    expect(new ProxyAlerts().due(proxyStatus([{ owner: null, reason: 'x' }], chords), chords)).toEqual([
      { key: 'all', chordIds: [], chordId: null, privateToo: true, message: 'The proxy isn’t working. Pages are waiting.' },
    ]);
  });
});
