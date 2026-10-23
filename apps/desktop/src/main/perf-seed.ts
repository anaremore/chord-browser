/**
 * Development builds only: the made-up browsing a performance run starts from
 * (test/e2e/perf.spec.ts). A brand-new profile gets `CHORD_PERF_TABS` sleeping
 * Today tabs and `CHORD_PERF_VISITS` history entries, so the run measures a
 * full sidebar and a used history. Pages are on the home page's site,
 * `/perf/1` and up.
 */
import { addSleepingTabs, type State } from '@chord/core';
import type { HistoryEvent } from '@chord/data';

/** Titles varied enough that typing narrows the results. */
const WORDS = ['Chord', 'Harmony', 'Melody', 'Rhythm', 'Tempo', 'Scale', 'Octave', 'Cadence', 'Interval', 'Arpeggio', 'Bridge', 'Chorus', 'Verse', 'Groove', 'Timbre', 'Pitch', 'Measure', 'Phrase', 'Motif', 'Coda'];

export function seedForPerformance(
  state: State,
  { tabs, visits, homeUrl, newId, history }: { tabs: number; visits: number; homeUrl: string; newId: () => string; history: (event: HistoryEvent) => void },
): void {
  const at = Date.now();
  const page = (i: number) => ({ url: new URL(`/perf/${i}`, homeUrl).href, title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} ${i}` });
  const chordId = Object.values(state.windows)[0]?.activeChordId;
  if (chordId && tabs > 0) addSleepingTabs(state, chordId, Array.from({ length: tabs }, (_, i) => page(i + 1)), { now: at, newId });
  // Oldest first, five minutes apart, as a few weeks of browsing would leave them.
  for (let i = visits; i >= 1; i--) history({ k: 'visit', ...page(i), at: at - i * 5 * 60_000 });
}
