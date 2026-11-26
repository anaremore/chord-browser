/**
 * #60: a site's run limits (`max-repeating`, `max-consecutive`, `max-sequential`) and the generator. A password is
 * never shown as stronger than it is (the owner's rule: strength is never overcounted, and what run limits keep under
 * 40 bits is weak), a short password that meets the limits is offered rather than none, and rules without run limits
 * get exactly the passwords they got before.
 */
import { describe, expect, it } from 'vitest';
import { drawOnce, generatePassword, isStrongPassword, passwordBits, passwordRulesFor, passwordSatisfies, type PasswordRuleSet, type RandomInt } from '../src/password-generator';

/** A seeded generator (mulberry32), as password-generator.test.ts has it. */
function seeded(seed: number): RandomInt {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const rulesOf = (site: string) => passwordRulesFor({}, site).rules;

/** How often a focus gets a password, over `n` seeds; and the passwords. */
function focuses(rules: PasswordRuleSet, n: number): { rate: number; passwords: string[] } {
  const passwords: string[] = [];
  for (let seed = 1; seed <= n; seed++) {
    const p = generatePassword(rules, seeded(seed));
    if (p !== null) passwords.push(p);
  }
  return { rate: passwords.length / n, passwords };
}

describe('run limits: a password on (nearly) every focus, never overcounted (#60)', () => {
  // The passwords [abcd] with max-repeating: 1 allow at a length: 4 · 3^(n−1). Never counted as more.
  const abcdBits = (n: number) => Math.log2(4) + (n - 1) * Math.log2(3);

  it('allowed: [abcd]; max-repeating: 1; maxlength: 20: about 32 bits, so weak (40 before); a password every time', () => {
    const rules = rulesOf('allowed: [abcd]; max-repeating: 1; maxlength: 20;');
    const { rate, passwords } = focuses(rules, 2000);
    expect(rate).toBeGreaterThanOrEqual(0.999);
    for (const p of passwords) {
      expect(p).toHaveLength(20);
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(passwordBits(p, rules)).toBeLessThanOrEqual(abcdBits(p.length) + 1e-9);
      expect(isStrongPassword(p, rules)).toBe(false);
    }
  });

  it('allowed: [abcd]; max-repeating: 1, room to grow: made long enough to be strong, and truly so', () => {
    const rules = rulesOf('allowed: [abcd]; max-repeating: 1;');
    const { rate, passwords } = focuses(rules, 500);
    expect(rate).toBe(1);
    for (const p of passwords) {
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(passwordBits(p, rules)).toBeLessThanOrEqual(abcdBits(p.length) + 1e-9);
      expect(isStrongPassword(p, rules)).toBe(true);
      expect(abcdBits(p.length)).toBeGreaterThanOrEqual(40);
    }
  });

  it.each<[string, string, number, boolean]>([
    // Two letters, at most 2 in a row: the limits can rule out both at a place, so nothing is counted, nor lengthened.
    ['two letters and look-alikes, at most 2 in a row', 'allowed: [ab01lI]; max-consecutive: 2;', 20, false],
    // Three letters, at most 2 repeated: a bit a place at least, 30 at most: weak, as long as allowed.
    ['three letters and look-alikes, at most 2 repeated, at most 30', 'allowed: [abc01O]; maxlength: 30; max-repeating: 2;', 30, false],
    // Runs in order of 6 can't be made of a, b and c: only repeats are ruled out, a bit a place, so 40 long.
    ['three letters, loose limits', 'allowed: [abc01]; max-repeating: 5; max-sequential: 6;', 40, true],
  ])('%s: %i long, strong %s', (_name, site, length, strong) => {
    const rules = rulesOf(site);
    const { rate, passwords } = focuses(rules, 300);
    expect(rate).toBe(1);
    for (const p of passwords) {
      expect(p).toHaveLength(length);
      expect(p).not.toMatch(/[01IOlo|]/);
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(isStrongPassword(p, rules)).toBe(strong);
    }
  });

  it('allowed: digit; max-repeating: 1; max-sequential: 1: a password on 99.9% of focuses (11% before)', () => {
    const rules = rulesOf('allowed: digit; max-repeating: 1; max-sequential: 1;');
    const { rate, passwords } = focuses(rules, 2000);
    expect(rate).toBeGreaterThanOrEqual(0.999);
    for (const p of passwords) expect(passwordSatisfies(p, rules)).toBe(true);
  });

  it('allowed: [ab01]; required: [01]; max-consecutive: 1: a short password, not none', () => {
    const rules = rulesOf('allowed: [ab01]; required: [01]; max-consecutive: 1;');
    const { rate, passwords } = focuses(rules, 200);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    for (const p of passwords) {
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(isStrongPassword(p, rules)).toBe(false);
    }
  });

  it('allowed: [a0O]; max-repeating: 2: aa, weak', () => {
    const rules = rulesOf('allowed: [a0O]; max-repeating: 2;');
    const p = generatePassword(rules, seeded(3));
    expect(p).toBe('aa');
    expect(isStrongPassword(p!, rules)).toBe(false);
  });

  it('roomy rules with run limits stay strong: lower, upper, digit, max-consecutive: 2', () => {
    const rules = rulesOf('allowed: lower, upper, digit; max-consecutive: 2;');
    const { rate, passwords } = focuses(rules, 500);
    expect(rate).toBe(1);
    for (const p of passwords) expect(isStrongPassword(p, rules)).toBe(true);
  });
});

describe('the strength shown is a lower bound: every outcome of the random numbers, on tiny rules (#60)', () => {
  /**
   * Every way one try can go: `randomInt`'s answers enumerated like an odometer, each run's chance the product of
   * 1/n over its draws. A password's chance given that the try made one is P(it) / P(any); the strength shown for it
   * must be at most the min-entropy of that, −log2 of the likeliest.
   */
  function outcomes(rules: PasswordRuleSet): { made: number; chances: Map<string, number> } {
    const chances = new Map<string, number>();
    let made = 0;
    const choices: number[] = [];
    for (;;) {
      const ranges: number[] = [];
      let i = 0;
      const scripted: RandomInt = (n) => {
        ranges.push(n);
        return i < choices.length ? choices[i++]! : (choices.push(0), i++, 0);
      };
      const p = drawOnce(rules, scripted);
      const chance = ranges.reduce((c, n) => c / n, 1);
      if (p !== null) {
        made += chance;
        chances.set(p, (chances.get(p) ?? 0) + chance);
      }
      // Next run: the last choice that can go up does, and what came after it starts again.
      choices.length = ranges.length;
      let k = ranges.length - 1;
      while (k >= 0 && choices[k]! + 1 >= ranges[k]!) k--;
      if (k < 0) break;
      choices[k]!++;
      choices.length = k + 1;
    }
    return { made, chances };
  }

  /** Every string of `pool` of `length` that meets the rules: whether a password exists at all. */
  const exists = (rules: PasswordRuleSet, pool: string, length: number): boolean => {
    const walk = (prefix: string): boolean => (prefix.length === length ? passwordSatisfies(prefix, rules) : [...pool].some((c) => walk(prefix + c)));
    return walk('');
  };

  const pools = ['[ab]', '[abc]', '[abcd]', '[2345]', '[ab-]'];
  const limits = ['', 'max-repeating: 1;', 'max-repeating: 2;', 'max-sequential: 1;', 'max-sequential: 2;', 'max-consecutive: 1;', 'max-repeating: 1; max-sequential: 2;'];
  const cases = pools.flatMap((pool) =>
    limits.flatMap((limit) =>
      [2, 3, ...(pool.length <= 5 ? [4] : [])].flatMap((max) => [
        `allowed: ${pool}; maxlength: ${max}; ${limit}`,
        ...(pool === '[ab-]' ? [`allowed: ${pool}; required: [-]; maxlength: ${max}; ${limit}`] : []),
      ]),
    ),
  );

  it.each(cases)('%s', (site) => {
    const rules = rulesOf(site);
    const { made, chances } = outcomes(rules);
    const allowed = rules.allowed.replace(/ /g, '');
    const anyAtMax = exists(rules, allowed, Math.min(rules.maxLength, 4));
    if (made === 0) {
      // A try that never makes one: only where no password of any length up to the maximum meets the rules.
      for (let n = rules.minLength || 1; n <= Math.min(rules.maxLength, 4); n++) expect(exists(rules, allowed, n), `length ${n}`).toBe(false);
      return;
    }
    // Most tries make one, or a focus could go without (a password offered on 99.9% of focuses at 300 tries).
    if (anyAtMax) expect(made).toBeGreaterThan(0.02);
    const likeliest = Math.max(...chances.values()) / made;
    const minEntropy = -Math.log2(likeliest);
    for (const p of chances.keys()) {
      expect(passwordSatisfies(p, rules), p).toBe(true);
      expect(passwordBits(p, rules), p).toBeLessThanOrEqual(minEntropy + 1e-9);
    }
  });
});

describe('rules without run limits: the same passwords as before (#60)', () => {
  // generatePassword at main b0c2b4e8, seeds 1, 2, 3.
  const GOLDEN: Array<[string, string[]]> = [
    ['', ['ABhdizyVAqLD69D-Tr-s', 'cgWZMwAiQ3wmWEKt-4H9', 'SsRr5Due-AjDQDVXtH4m']],
    ['maxlength: 8; allowed: lower, upper, digit;', ['8SArr6L8', 'wG4MH3tD', 'UDCjtAe5']],
    ['allowed: digit; required: [-]; maxlength: 12;', ['536479-95592', '8585-4384226', '-25--2755253']],
    ['allowed: ascii-printable; required: [!@#$%];', ['ABhdizyVaqLDN-D-T%9s', 'cgWZMwAiQ-wmWEK%6Gh9', 'SsRrLDue2ajDQD-X%H4m']],
    ['allowed: [ab]; required: [0]; maxlength: 10;', ['bbaa0bbabb', 'baba0abbaa', 'aaababaa0a']],
  ];
  it.each(GOLDEN)('%s', (site, expected) => {
    const rules = passwordRulesFor({}, site || null).rules;
    expect([1, 2, 3].map((seed) => generatePassword(rules, seeded(seed)))).toEqual(expected);
  });
});
