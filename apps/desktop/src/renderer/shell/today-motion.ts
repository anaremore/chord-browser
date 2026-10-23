/**
 * How the sidebar's rows move, in Pinned and Today (DESIGN.md §6.5, §6.7).
 * They're plain elements, not Motion components: a Motion component costs
 * about as much to mount as the rest of a row, and a chord switch, an Undo or
 * a scroll mounts dozens of rows at once. Tabs.tsx animates them itself with
 * the Web Animations API, which runs on the compositor. Every row is one
 * height, so where a row was and where it is come from its index: nothing is
 * measured.
 *
 * - A row new to its list springs in from a little smaller (`smooth`); one
 *   pinned from Today lands with a little give (`bouncy`).
 * - A row whose place changed slides there from where it showed (`smooth`).
 *   Each move adds an animation on top of any still running, so a second move
 *   before the first settles carries on from where the row is, with its speed.
 * - A row leaving its list goes out where it was, in its own element
 *   (Tabs.tsx): closed, it drifts left and fades; pinned, it lifts toward
 *   Pinned and fades; archived, it shrinks and fades while its favicon flies
 *   to the Archive button (ArchiveArc.tsx). Close, pin and archive stay distinct.
 *
 * Only rows near the viewport animate. With "Animate tab moves" off (§6.8) or
 * reduced motion (§6.6), Tabs.tsx doesn't ask: rows change place at once.
 */
import { durations, easing, space, springs, springToCss } from '@chord/tokens';

const SMOOTH = springToCss(springs.smooth);
const smooth: KeyframeAnimationOptions = { duration: SMOOTH.durationMs, easing: SMOOTH.easing };
const BOUNCY = springToCss(springs.bouncy);
const bouncy: KeyframeAnimationOptions = { duration: BOUNCY.durationMs, easing: BOUNCY.easing };

/** How a row arrives: from a little smaller (DESIGN.md §6.5, as Pinned's rows do). */
const ENTER_SCALE = 0.96;
/** An archived row shrinks to this as it fades (DESIGN.md §6.5). */
export const ARCHIVED_SCALE = 0.92;

/** Slides a row to its place from `dy` px away (where it showed), on top of whatever it's doing. */
export function slideFrom(el: HTMLElement, dy: number): void {
  el.animate({ transform: [`translateY(${dy}px)`, 'translateY(0)'] }, { ...smooth, composite: 'add' });
}

/** Rows arriving together start 12 ms apart, up to 6; the rest start with the sixth (DESIGN.md §6.1 rule 7). */
const MAX_STAGGERED = 6;

/**
 * A row new to its list springs in; one that `lands` (pinned from Today) does
 * it with a little give (`bouncy`). `order`: its place among rows arriving together.
 */
export function enter(el: HTMLElement, lands = false, order = 0): void {
  const delay = Math.min(order, MAX_STAGGERED - 1) * durations.stagger;
  el.animate({ opacity: [0, 1] }, { ...smooth, delay, fill: 'backwards' });
  el.animate({ transform: [`scale(${ENTER_SCALE})`, 'scale(1)'] }, { ...(lands ? bouncy : smooth), delay, fill: 'backwards', composite: 'add' });
}

export type Leaving = 'close' | 'pin' | 'archive';

/** A leaving row's way out (DESIGN.md §6.5; exits are quicker than entrances, §6.1 rule 6). */
export function leave(el: HTMLElement, kind: Leaving): Animation {
  const fast: KeyframeAnimationOptions = { duration: durations.fadeFast, easing: easing.exit, fill: 'forwards' };
  if (kind === 'archive') return el.animate({ opacity: [1, 0], transform: ['scale(1)', `scale(${ARCHIVED_SCALE})`] }, { ...smooth, fill: 'forwards' });
  // Pinned: it lifts, toward Pinned above. Closed: it drifts left.
  const away = kind === 'pin' ? `translateY(${-space[2]}px)` : `translateX(${-space[2]}px)`;
  return el.animate({ opacity: [1, 0], transform: ['none', away] }, fast);
}
