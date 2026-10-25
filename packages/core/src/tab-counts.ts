/**
 * Counts on tabs (ARCHITECTURE.md §9, DESIGN.md §7.2): the number a page
 * gives itself with the web's Badging API (`navigator.setAppBadge`), the one
 * an installed web app shows on its icon. Telegram, WhatsApp and Slack set it
 * for unread messages. Chord shows each page's on its tab, and puts the total
 * on its own icon. A site's count can be hidden (an inbox's unread mail), or
 * every count with Settings → General.
 */
import { hostOf, routeHost } from './links';
import type { ChordId, LiveTab, NodeId, State, TabCountsSettings } from './model';

/** What a tab shows: a number, a dot (the page set a badge with no number), or nothing. */
export type TabCount = number | 'dot' | null;

/** How many hosts counts can be hidden for. */
export const MAX_COUNT_OFF_SITES = 500;

/** The biggest number shown; more reads "99+", as on an app's icon. */
export const COUNT_SHOWN_MAX = 99;

/**
 * A page's badge, as Chord's page preload reports it: a whole number (0
 * clears it, as the Badging API says), 'dot' for `setAppBadge()` with no
 * number, or null for `clearAppBadge()`. Anything else (a page can't send
 * this directly, but a compromised renderer could) is undefined: ignored.
 */
export function pageBadge(raw: unknown): TabCount | undefined {
  if (raw === null || raw === 0) return null;
  if (raw === 'dot') return 'dot';
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return undefined;
  return raw;
}

/** The host a count is hidden by: the page's own (`mail.google.com`, so Google Chat's still shows), without `www.`. */
export function countSite(input: string): string | null {
  const host = hostOf(input) ?? routeHost(input);
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host.replace(/^www\./, '');
}

/** Whether a page's count shows: counts are on, and its host (or one it's under) isn't hidden. */
export function countShows(url: string, settings: TabCountsSettings): boolean {
  if (!settings.enabled) return false;
  const host = countSite(url);
  return !host || !settings.offSites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** A list of hosts as saved: each one normalized, no repeats, at most MAX_COUNT_OFF_SITES. */
export function cleanCountSites(sites: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const site of sites) {
    const clean = typeof site === 'string' && site.length <= 300 ? countSite(site) : null;
    if (clean) out.add(clean);
    if (out.size >= MAX_COUNT_OFF_SITES) break;
  }
  return [...out];
}

/** Several tabs' counts as one (a closed folder, a split, the app's icon): their sum, or a dot if they only have dots. */
export function sumCounts(counts: Iterable<TabCount | undefined>): TabCount {
  let sum = 0;
  let dot = false;
  for (const count of counts) {
    if (count === 'dot') dot = true;
    else if (typeof count === 'number') sum += count;
  }
  return sum > 0 ? sum : dot ? 'dot' : null;
}

/** The count's text on a tab ("3", "99+"), empty for a dot. */
export function countText(count: TabCount): string {
  if (count === null || count === 'dot') return '';
  return count > COUNT_SHOWN_MAX ? `${COUNT_SHOWN_MAX}+` : String(count);
}

/** What a screen reader hears after the tab's name: "3 unread", "unread". */
export function unreadWords(count: TabCount): string {
  if (count === null) return '';
  return count === 'dot' ? 'unread' : `${count > COUNT_SHOWN_MAX ? `more than ${COUNT_SHOWN_MAX}` : count} unread`;
}

/** The app icon's count: every tab's, as shown. */
export function appCount(live: Readonly<Record<string, Pick<LiveTab, 'badge'>>>): TabCount {
  return sumCounts(Object.values(live).map((l) => l.badge));
}

/** The counts of the tabs inside a folder or a split, any depth down: what it shows closed. */
export function countWithin(state: State, ancestorId: NodeId): TabCount {
  const counts: TabCount[] = [];
  for (const [id, live] of Object.entries(state.live)) {
    if (live.badge === null) continue;
    for (let node = state.nodes[id]; node?.parentId; node = state.nodes[node.parentId]) {
      if (node.parentId === ancestorId) {
        counts.push(live.badge);
        break;
      }
    }
  }
  return sumCounts(counts);
}

/** The chords with a tab showing a count: the switcher marks them with a dot. */
export function chordsWithCounts(state: State): Set<ChordId> {
  const chords = new Set<ChordId>();
  for (const [id, live] of Object.entries(state.live)) {
    const node = state.nodes[id];
    if (live.badge !== null && node) chords.add(node.chordId);
  }
  return chords;
}
