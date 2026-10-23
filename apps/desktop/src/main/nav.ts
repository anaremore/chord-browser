/** Saved tab history (no Electron imports, so it's unit-testable). */
import type { NavState } from '@chord/data';

/** Saved history per tab: this many entries around the current one, and at most this much page state. */
const MAX_NAV_ENTRIES = 50;
const MAX_NAV_BYTES = 1024 * 1024;

const restorable = (url: string) => /^https?:/i.test(url);

/**
 * A tab's history, trimmed to what's worth keeping: web pages only, up to 50
 * entries around the current one, and page state (scroll, form fields)
 * dropped from the others if it's unusually large. Null when there's nothing
 * to restore.
 */
export function trimNavState(entries: readonly NavState['entries'][number][], index: number): NavState | null {
  const current = entries[index];
  if (!current || !restorable(current.url)) return null;
  const start = Math.max(0, Math.min(index - Math.floor(MAX_NAV_ENTRIES / 2), entries.length - MAX_NAV_ENTRIES));
  const kept = entries.slice(start, start + MAX_NAV_ENTRIES).map((e) => ({ url: e.url, title: e.title, ...(e.pageState ? { pageState: e.pageState } : {}) }));
  const web = kept.filter((e) => restorable(e.url));
  let nav: NavState = { entries: web, index: web.indexOf(kept[index - start]!) };
  if (JSON.stringify(nav).length > MAX_NAV_BYTES) {
    nav = { ...nav, entries: nav.entries.map((e, i) => (i === nav.index ? e : { url: e.url, title: e.title })) };
    if (JSON.stringify(nav).length > MAX_NAV_BYTES) return null;
  }
  return nav;
}
