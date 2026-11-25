/**
 * An acting card's first moment, the assistant's in the chat or an outside agent's in the popover (promptInputDelay, DESIGN.md §7.17): no click or key counts in it, so one aimed at what
 * was there before the card can't answer it. It's counted from when the card was first shown, by its message, never
 * again from a redraw of it or of the panel: on Windows a card drawn anew right before your Allow kept dropping it (the
 * release check, 2026-11-25).
 */

/** How many cards' first showings are kept at most. */
const KEPT = 200;

/** When each card still waiting was first shown (performance.now()), by its message's id. */
const firstShown = new Map<string, number>();

/** How long (ms) until the card with this message's id takes a click, `now` being performance.now(). */
export function cardWait(id: string, now: number, delay: number): number {
  let first = firstShown.get(id);
  if (first === undefined) {
    firstShown.set(id, (first = now));
    // Cards that went without saying so (an agent's, taken down when answered): only the latest few are kept.
    if (firstShown.size > KEPT) firstShown.delete(firstShown.keys().next().value!);
  }
  return Math.max(0, delay - (now - first));
}

/** The card was answered (or went): nothing kept for it. */
export function forgetCard(id: string): void {
  firstShown.delete(id);
}
