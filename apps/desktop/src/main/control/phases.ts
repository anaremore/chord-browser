/**
 * Where an action's time goes (S18 M2g-1: measure first). Each tool call keeps a clock; each phase it passes is a lap.
 * Kept only when the E2E hooks are on (development and test builds), at most PHASES_MAX laps, read and cleared by the
 * budgets journey (index.ts' agentPhaseTimes). Off, a lap is a comparison and nothing else.
 */
export type PhaseLap = { tool: string; phase: string; ms: number };

const PHASES_MAX = 4000;
const kept: PhaseLap[] = [];
const on = process.env['CHORD_E2E_HOOKS'] === '1';

export interface PhaseClock {
  /** The time since the last lap (or the start), as this phase's. */
  lap(phase: string): void;
}

export function phaseClock(tool: string): PhaseClock {
  if (!on) return { lap: () => undefined };
  let last = performance.now();
  return {
    lap(phase) {
      const now = performance.now();
      kept.push({ tool, phase, ms: now - last });
      if (kept.length > PHASES_MAX) kept.shift();
      last = now;
    },
  };
}

/** The laps kept so far, cleared. */
export function takePhases(): PhaseLap[] {
  return kept.splice(0);
}

/**
 * What each tool call's result cost the agent (the owner, 2026-11-24: as effective, for as few tokens): its bytes, and
 * tokens at about 4 characters each. Kept as the phases are (the E2E hooks on).
 */
export type ResultSize = { tool: string; bytes: number; tokens: number };
const sizes: ResultSize[] = [];

/** About how many tokens a result of this many characters costs a model (4 characters each). */
export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

export function noteResult(tool: string, chars: number): void {
  if (!on) return;
  sizes.push({ tool, bytes: chars, tokens: tokensOf(chars) });
  if (sizes.length > PHASES_MAX) sizes.shift();
}

/** The result sizes kept so far, cleared. */
export function takeResults(): ResultSize[] {
  return sizes.splice(0);
}
