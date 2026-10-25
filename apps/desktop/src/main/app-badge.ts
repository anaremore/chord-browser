/**
 * Chord's own icon shows its tabs' counts added up (counts on tabs,
 * ARCHITECTURE.md §9): the number in the Dock (macOS), on the taskbar button
 * (Windows, where Electron draws it over the icon of each window), or on the
 * launcher (Linux, where the desktop supports it). Pages no longer set it
 * themselves: Chord's page preload sends each page's count to its tab.
 */
import { appCount, type State, type TabCount } from '@chord/core';
import { app } from 'electron';

interface Store {
  readonly state: State;
  subscribe(listener: (change: { patches: readonly { path: readonly (string | number)[] }[] }) => void): unknown;
}

/** What the icon shows now, for tests (a Linux desktop without a launcher shows nothing). */
let shown: TabCount = null;
export const appBadgeShown = (): TabCount => shown;

export function watchAppBadge(store: Store): void {
  let windows = 0;
  let scheduled = false;
  const apply = () => {
    scheduled = false;
    const count = appCount(store.state.live);
    const windowCount = Object.keys(store.state.windows).length;
    // On Windows the count is drawn on each window's button, so a new window needs it again.
    if (count === shown && windowCount === windows) return;
    shown = count;
    windows = windowCount;
    // A dot (counts with no number) shows on macOS and Windows; Linux launchers only show numbers.
    if (count === 'dot') app.setBadgeCount(process.platform === 'linux' ? 0 : undefined);
    else app.setBadgeCount(count ?? 0);
  };
  store.subscribe((change) => {
    if (scheduled || !change.patches.some((p) => p.path[0] === 'live' || (p.path[0] === 'windows' && p.path.length <= 2))) return;
    // Once per turn, however many tabs changed: after the window's own view is made.
    scheduled = true;
    setImmediate(apply);
  });
}
