/**
 * F6 and ⇧F6 (DESIGN.md §10, §14.2): the keyboard moves between the
 * window's regions: sidebar → page → (find bar or permission prompt) → Duet
 * → top strip, and round again. Main says where the keyboard is; the shell
 * knows which regions show, picks the next one, and asks main to put the
 * keyboard there (a page and the popover are views of their own).
 *
 * Coming back to a region lands where you left it; the first time, on its
 * natural start: the tab on screen, Duet's message field, the address.
 */
import type { FocusRegionEvent } from '@chord/ipc';
import { api } from './api';

type Region = 'sidebar' | 'page' | 'popover' | 'duet' | 'bar';

const TABBABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]';
const last = new Map<Region, HTMLElement>();

const regionRoot = (region: Region) => document.querySelector<HTMLElement>(`[data-region="${region}"]`);
const visible = (el: Element) => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]');
const tabbable = (el: HTMLElement) => el.tabIndex >= 0 && visible(el);

/** The first control a Tab press would reach inside `root`. */
const firstTabbable = (root: ParentNode | null) => [...(root?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])].find(tabbable) ?? null;

/** Remember where the keyboard was in each region. */
export function trackRegions(): () => void {
  const onFocus = (event: FocusEvent) => {
    const el = event.target as HTMLElement;
    const region = el.closest<HTMLElement>('[data-region]')?.dataset['region'] as Region | undefined;
    if (region) last.set(region, el);
  };
  document.addEventListener('focusin', onFocus);
  return () => document.removeEventListener('focusin', onFocus);
}

/** Where the keyboard lands in a region of the shell, or null if it has nothing to focus. */
function entry(region: Region): HTMLElement | null {
  const root = regionRoot(region);
  if (!root || !visible(root)) return null;
  // The page's region is the web page itself, unless the frame shows Chord's own content instead
  // (first run, an empty chord, a page that couldn't load or crashed).
  if (region === 'page') return firstTabbable(root.querySelector('[data-page-state]'));
  const remembered = last.get(region);
  if (remembered?.isConnected && root.contains(remembered) && tabbable(remembered)) return remembered;
  const start =
    region === 'sidebar'
      ? root.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
      : region === 'duet'
        ? root.querySelector<HTMLElement>('textarea')
        : root.querySelector<HTMLElement>('[data-address]');
  return start && visible(start) ? start : firstTabbable(root);
}

function regionsShown(popover: boolean): Region[] {
  const shown: Region[] = [];
  if (entry('sidebar')) shown.push('sidebar');
  shown.push('page');
  if (popover) shown.push('popover');
  if (entry('duet')) shown.push('duet');
  if (entry('bar')) shown.push('bar');
  return shown;
}

/** Move the keyboard to the next region (or the previous one, with ⇧F6). */
export function cycleRegion({ direction, from, popover }: FocusRegionEvent): void {
  const regions = regionsShown(popover);
  const here =
    from === 'shell' ? ((document.activeElement?.closest<HTMLElement>('[data-region]')?.dataset['region'] as Region | undefined) ?? null) : from;
  const at = here ? regions.indexOf(here) : -1;
  const next = regions[at < 0 ? (direction === 1 ? 0 : regions.length - 1) : (at + direction + regions.length) % regions.length]!;
  if (next === 'popover') return void api.focus.move('popover');
  const el = entry(next);
  if (el) {
    el.focus();
    void api.focus.move('shell');
  } else {
    void api.focus.move('page');
  }
}
