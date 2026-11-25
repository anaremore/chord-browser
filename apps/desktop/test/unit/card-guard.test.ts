/**
 * An acting card's first moment (promptInputDelay): no click counts in it, so one aimed at what was there before the card
 * can't answer it. Counted from when the card was first shown, by its message, never again from a redraw: on Windows a
 * card drawn anew right before your Allow kept dropping it, and the download it asked about never came (the release
 * check, 2026-11-25: runs 45680947659 and 45681411597, the Save card still waiting 20 s after its Allow).
 */
import { describe, expect, it } from 'vitest';
import { cardWait, forgetCard } from '../../src/renderer/shell/card-guard';

describe('An acting card’s first moment', () => {
  it('counts from its first showing, by its message: a redraw (or the panel drawn anew) never starts it again', () => {
    expect(cardWait('m1', 1000, 500)).toBe(500);
    // Drawn again 300 ms later (a remount): 200 ms left, not 500.
    expect(cardWait('m1', 1300, 500)).toBe(200);
    expect(cardWait('m1', 1600, 500)).toBe(0);
    // Another card has its own.
    expect(cardWait('m2', 1600, 500)).toBe(500);
    // Answered: forgotten (nothing kept for it after).
    forgetCard('m1');
    expect(cardWait('m1', 5000, 500)).toBe(500);
  });
});
