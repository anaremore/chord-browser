/**
 * The sign-in box's keyboard (Popover.tsx `AuthCard`, #47): nothing answers it before its input delay, and a key
 * held through that delay never presses anything on its repeats or its release, whatever has the focus once it's past.
 */
import { describe, expect, it } from 'vitest';
import { PromptKeys } from '../../src/renderer/popover/prompt-keys';

/** `arm`: the delay is past. Then a key going down (`↓`), repeating (`…`) or up (`↑`): Enter, Space, Space in a text field, Tab. */
type Step = 'arm' | `${'enter' | 'space' | 'field-space' | 'tab'}${'↓' | '…' | '↑'}`;

const KEYS = { enter: 'Enter', space: ' ', 'field-space': ' ', tab: 'Tab' } as const;

describe('PromptKeys (the sign-in box’s keyboard)', () => {
  it.each<[string, Step[], boolean[]]>([
    ['Enter before the delay is past does nothing', ['enter↓'], [false]],
    ['a fresh Enter once it’s past signs in', ['arm', 'enter↓'], [true]],
    ['Enter held through the delay never signs in on its repeats', ['enter↓', 'enter…', 'arm', 'enter…', 'enter…'], [false, false, false, false]],
    ['Enter held from before the box appeared (only repeats reach it)', ['arm', 'enter…'], [false]],
    ['Enter let go and pressed again signs in', ['enter↓', 'arm', 'enter…', 'enter↑', 'enter↓'], [false, false, false, true]],
    ['a fresh Enter held after the delay may repeat', ['arm', 'enter↓', 'enter…'], [true, true]],
    ['Space held through the delay: its release presses nothing', ['space↓', 'space…', 'arm', 'space…', 'space↑'], [false, false, false, false]],
    ['Space held from before the box appeared: its repeats and release press nothing', ['arm', 'space…', 'space↑'], [false, false]],
    ['a fresh Space once it’s past presses', ['arm', 'space↓', 'space↑'], [true, true]],
    ['Space let go and pressed again presses', ['space↓', 'arm', 'space↑', 'space↓', 'space↑'], [false, false, true, true]],
    ['Space typed in a field is only typing, delay or not', ['field-space↓', 'field-space…', 'field-space↑', 'arm', 'field-space↓'], [true, true, true, true]],
    ['other keys are never held back', ['tab↓', 'tab…', 'tab↑'], [true, true, true]],
  ])('%s', (_name, steps, allowed) => {
    const keys = new PromptKeys();
    const results: boolean[] = [];
    for (const step of steps) {
      if (step === 'arm') {
        keys.arm();
        continue;
      }
      const name = step.slice(0, -1) as keyof typeof KEYS;
      const event = { key: KEYS[name], field: name === 'field-space' };
      const how = step.at(-1);
      results.push(how === '↑' ? keys.keyup(event) : keys.keydown({ ...event, repeat: how === '…' }));
    }
    expect(results).toEqual(allowed);
    expect(keys.ready).toBe(steps.includes('arm'));
  });
});
