import { describe, expect, it } from 'vitest';
import { firstGrapheme } from '../src';

describe('firstGrapheme', () => {
  it('keeps whole emoji, including skin tones, families and flags', () => {
    expect(firstGrapheme('👍🏽 nice')).toBe('👍🏽');
    expect(firstGrapheme('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
    expect(firstGrapheme('🇯🇵🇫🇷')).toBe('🇯🇵');
    expect(firstGrapheme('❤️')).toBe('❤️');
  });

  it('capitalizes a letter and ignores surrounding space', () => {
    expect(firstGrapheme('  work')).toBe('W');
    expect(firstGrapheme('é')).toBe('É');
    expect(firstGrapheme('♪')).toBe('♪');
  });

  it('returns nothing for blank input', () => {
    expect(firstGrapheme('   ')).toBe('');
  });
});
