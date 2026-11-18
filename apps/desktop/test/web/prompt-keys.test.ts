/**
 * The sign-in box's keyboard (Popover.tsx `AuthCard`, #47): nothing answers it before its input delay, and a key
 * held through that delay never signs in on its repeats, whatever has the focus once it's past.
 */
import { describe, expect, it } from 'vitest';
import { PromptKeys } from '../../src/renderer/popover/prompt-keys';

describe('PromptKeys (the sign-in box’s keyboard)', () => {
  type Step = 'arm' | 'enter' | 'repeat' | 'tab';
  it.each<[string, Step[], boolean[]]>([
    ['Enter before the delay is past does nothing', ['enter'], [false]],
    ['a fresh Enter once it’s past signs in', ['arm', 'enter'], [true]],
    ['Enter held through the delay never signs in on its repeats', ['enter', 'repeat', 'arm', 'repeat', 'repeat'], [false, false, false, false]],
    ['a key held from before the box appeared (only repeats reach it)', ['arm', 'repeat'], [false]],
    ['let go and pressed again, it signs in', ['enter', 'arm', 'repeat', 'enter'], [false, false, true]],
    ['a fresh Enter held after the delay may repeat', ['arm', 'enter', 'repeat'], [true, true]],
    ['other keys are never held back', ['tab'], [true]],
  ])('%s', (_name, steps, allowed) => {
    const keys = new PromptKeys();
    const results: boolean[] = [];
    for (const step of steps) {
      if (step === 'arm') keys.arm();
      else results.push(keys.keydown({ key: step === 'tab' ? 'Tab' : 'Enter', repeat: step === 'repeat' }));
    }
    expect(results).toEqual(allowed);
    expect(keys.ready).toBe(steps.includes('arm'));
  });
});
