/**
 * Development builds only: the made-up browsing a performance run starts from
 * (test/e2e/perf.spec.ts). A brand-new profile gets `CHORD_PERF_TABS` sleeping
 * Today tabs and `CHORD_PERF_VISITS` history entries, so the run measures a
 * full sidebar and a used history. Pages are on the home page's site,
 * `/perf/1` and up: one per visit, or `CHORD_PERF_PAGES` of them visited in
 * turn (an export's run: 50,000 visits on 15,000 pages, as S15 sizes a profile).
 * `CHORD_PERF_PINNED` pinned tabs, each with an icon of its own (4 KB), and
 * `CHORD_PERF_EFFECTS` sites with Effects at their largest (64 KB of CSS, 50
 * hidden elements): a setup that's big for sync to read.
 */
import { createHash } from 'node:crypto';
import { addSleepingTabs, EFFECTS_LIMITS, type SavedEffects, type State, type TabNode } from '@chord/core';
import type { HistoryEvent } from '@chord/data';

/** Titles varied enough that typing narrows the results. */
const WORDS = ['Chord', 'Harmony', 'Melody', 'Rhythm', 'Tempo', 'Scale', 'Octave', 'Cadence', 'Interval', 'Arpeggio', 'Bridge', 'Chorus', 'Verse', 'Groove', 'Timbre', 'Pitch', 'Measure', 'Phrase', 'Motif', 'Coda'];

export function seedForPerformance(
  state: State,
  {
    tabs,
    visits,
    pages = visits,
    pinned = 0,
    effects = 0,
    homeUrl,
    newId,
    history,
    effect = () => undefined,
  }: {
    tabs: number;
    visits: number;
    pages?: number;
    pinned?: number;
    effects?: number;
    homeUrl: string;
    newId: () => string;
    history: (event: HistoryEvent) => void;
    effect?: (host: string, value: SavedEffects) => void;
  },
): void {
  const at = Date.now();
  const page = (i: number) => ({ url: new URL(`/perf/${i}`, homeUrl).href, title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} ${i}` });
  const chordId = Object.values(state.windows)[0]?.activeChordId;
  if (chordId && tabs > 0) addSleepingTabs(state, chordId, Array.from({ length: tabs }, (_, i) => page(i + 1)), { now: at, newId });
  if (chordId && pinned > 0) {
    const before = new Set(Object.keys(state.nodes));
    addSleepingTabs(state, chordId, Array.from({ length: pinned }, (_, i) => page(tabs + i + 1)), { now: at, newId });
    let i = 0;
    for (const id of Object.keys(state.nodes)) {
      if (before.has(id)) continue;
      const tab = state.nodes[id] as TabNode;
      const icon = Buffer.concat(Array.from({ length: 94 }, (_, k) => createHash('sha256').update(`${i}:${k}`).digest()));
      state.nodes[id] = { ...tab, section: 'pinned', pinnedUrl: tab.url, favicon: `data:image/png;base64,${icon.toString('base64')}` };
      i++;
    }
  }
  for (let i = 0; i < effects; i++) {
    const host = `effects${i}.perf.test`;
    const css = `/* ${host} */\n${'main article p { color: rgb(20, 20, 20); line-height: 1.6 }\n'.repeat(EFFECTS_LIMITS.css)}`.slice(0, EFFECTS_LIMITS.css);
    const hidden = Array.from({ length: 50 }, (_, h) => ({ selector: `.perf-${i}-${h}`, label: `div.perf-${h}`, on: true, at }));
    effect(host, { host, wet: true, css, cssOn: true, hidden, presets: [], duet: [], createdAt: at, updatedAt: at, compiled: '', sanitizer: 0 });
  }
  // Oldest first, five minutes apart, as a few weeks of browsing would leave them.
  for (let i = visits; i >= 1; i--) history({ k: 'visit', ...page(((i - 1) % Math.max(1, pages)) + 1), at: at - i * 5 * 60_000 });
}
