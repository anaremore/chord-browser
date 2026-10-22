/**
 * Motion tokens for React (DESIGN.md §6). Every animation goes through
 * `spring()`, so switching an animation off in Settings → Motion (§6.8)
 * makes it instant everywhere at once.
 */
import { springs, type SpringName } from '@chord/tokens';
import type { Transition } from 'motion/react';

export type MotionSwitch = 'commandBar' | 'chordSlide' | 'tabMoves' | 'sidebar' | 'colorBlend';

/** Defaults until Settings → Motion lands (M1.5); all on, per DESIGN.md §6.8. */
const enabled: Record<MotionSwitch, boolean> = {
  commandBar: true,
  chordSlide: true,
  tabMoves: true,
  sidebar: true,
  colorBlend: true,
};

export const INSTANT: Transition = { duration: 0 };

export function spring(name: SpringName, gate: MotionSwitch): Transition {
  if (!enabled[gate]) return INSTANT;
  const s = springs[name];
  return { type: 'spring', stiffness: s.stiffness, damping: s.damping, mass: s.mass };
}
