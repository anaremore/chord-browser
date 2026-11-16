/**
 * Development builds only: the made-up browsing a performance run starts from
 * (test/e2e/perf.spec.ts). A brand-new profile gets `CHORD_PERF_TABS` sleeping
 * Today tabs and `CHORD_PERF_VISITS` history entries, so the run measures a
 * full sidebar and a used history. Pages are on the home page's site,
 * `/perf/1` and up: one per visit, or `CHORD_PERF_PAGES` of them visited in
 * turn (an export's run: 50,000 visits on 15,000 pages, as S15 sizes a profile).
 * `CHORD_PERF_PINNED` pinned tabs, each with an icon of its own (4 KB), the
 * last of them in `CHORD_PERF_FOLDERS` folders of 20 (every other one open), and
 * `CHORD_PERF_EFFECTS` sites with Effects at their largest (64 KB of CSS, 50
 * hidden elements): a setup that's big for sync to read.
 */
import { createHash } from 'node:crypto';
import { addSleepingTabs, EFFECTS_LIMITS, nodeOf, setNode, nodeIds, type SavedEffects, type State, type TabNode } from '@chord/core';
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
    folders = 0,
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
    /** Folders of 20 at the end of Pinned, holding its last tabs; every other one open. */
    folders?: number;
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
    const before = new Set(nodeIds(state));
    addSleepingTabs(state, chordId, Array.from({ length: pinned }, (_, i) => page(tabs + i + 1)), { now: at, newId });
    let i = 0;
    for (const id of nodeIds(state)) {
      if (before.has(id)) continue;
      const tab = nodeOf(state, id) as TabNode;
      const icon = Buffer.concat(Array.from({ length: 94 }, (_, k) => createHash('sha256').update(`${i}:${k}`).digest()));
      setNode(state, { ...tab, section: 'pinned', pinnedUrl: tab.url, favicon: `data:image/png;base64,${icon.toString('base64')}` });
      i++;
    }
    // The last pinned tabs, 20 to a folder, in folders after the rest.
    const seeded = nodeIds(state).filter((id) => !before.has(id));
    const last = seeded.reduce((r, id) => (nodeOf(state, id)!.rank > r ? nodeOf(state, id)!.rank : r), '');
    const count = Math.min(folders, Math.floor(seeded.length / 20));
    for (let f = 0; f < count; f++) {
      const folderId = newId();
      // Ranks after every seeded one (a key followed by more characters sorts after it), in order.
      setNode(state, { kind: 'folder', id: folderId, chordId, section: 'pinned', parentId: null, rank: `${last}V${String(f).padStart(5, '0')}`, title: `Folder ${f + 1}`, collapsed: f % 2 === 1, createdAt: at });
      seeded.slice(seeded.length - (count - f) * 20, seeded.length - (count - f - 1) * 20).forEach((id, k) => {
        setNode(state, { ...(nodeOf(state, id) as TabNode), parentId: folderId, rank: `a${String(k).padStart(3, '0')}` });
      });
    }
  }
  for (let i = 0; i < effects; i++) {
    const host = `effects${i}.perf.test`;
    const css = `/* ${host} */\n${'main article p { color: rgb(20, 20, 20); line-height: 1.6 }\n'.repeat(EFFECTS_LIMITS.css)}`.slice(0, EFFECTS_LIMITS.css);
    const hidden = Array.from({ length: 50 }, (_, h) => ({ selector: `.perf-${i}-${h}`, label: `div.perf-${h}`, on: true, at }));
    effect(host, { host, wet: true, css, cssOn: true, hidden, presets: [], assistant: [], createdAt: at, updatedAt: at, compiled: '', sanitizer: 0 });
  }
  // Oldest first, five minutes apart, as a few weeks of browsing would leave them.
  for (let i = visits; i >= 1; i--) history({ k: 'visit', ...page(((i - 1) % Math.max(1, pages)) + 1), at: at - i * 5 * 60_000 });
}
