/**
 * Motion for React (DESIGN.md §6). Every animation goes through a `spring`
 * function made from the user's Settings → Motion switches (§6.8), so
 * switching one off makes it instant everywhere at once, with no restart.
 */
import { motionEnabled, type MotionSettings, type Settings } from '@chord/core';
import { springs, type SpringName } from '@chord/tokens';
import type { Transition } from 'motion/react';

export type MotionGate = Exclude<keyof MotionSettings, 'followSystem'>;
export type SpringFor = (name: SpringName, gate: MotionGate) => Transition;

export const INSTANT: Transition = { duration: 0 };

const GATES: readonly MotionGate[] = ['commandBar', 'chordSlide', 'tabMoves', 'sidebar', 'colorBlend'];

/** Springs as the user's settings and the OS allow: a spring, or instant. */
export function springsFor(settings: Settings, osReducedMotion: boolean): SpringFor {
  return (name, gate) => {
    if (!motionEnabled(settings, gate, osReducedMotion)) return INSTANT;
    const s = springs[name];
    return { type: 'spring', stiffness: s.stiffness, damping: s.damping, mass: s.mass };
  };
}

/**
 * How a group animates: fully; `reduced` when the OS asks for reduced motion
 * (DESIGN.md §6.6: no spatial springs, a short highlight on the destination
 * instead); or `off`, switched off in Settings (§6.8: instant, no animation at all).
 */
export type MotionMode = 'on' | 'reduced' | 'off';

export function motionMode(settings: Settings, osReducedMotion: boolean, gate: MotionGate): MotionMode {
  if (!settings.motion[gate]) return 'off';
  return settings.motion.followSystem && osReducedMotion ? 'reduced' : 'on';
}

/**
 * The same switches for CSS: `data-reduced-motion` turns every transition
 * off (global.css), and `data-motion-off` lists the switched-off groups.
 */
export function applyMotion(settings: Settings, osReducedMotion: boolean): void {
  const root = document.documentElement;
  root.toggleAttribute('data-reduced-motion', settings.motion.followSystem && osReducedMotion);
  root.dataset['motionOff'] = GATES.filter((gate) => !settings.motion[gate]).join(' ');
}

/** Motion's own reduced-motion handling follows the same "Follow system" switch. */
export const reducedMotionMode = (settings: Settings): 'user' | 'never' => (settings.motion.followSystem ? 'user' : 'never');
