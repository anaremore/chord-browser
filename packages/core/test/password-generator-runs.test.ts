/**
 * #60: a site's run limits (`max-repeating`, `max-consecutive`, `max-sequential`) and the generator. A password is
 * never shown as stronger than it is (the owner's rule: strength is never overcounted, and what run limits keep under
 * 40 bits is weak), a short password that meets the limits is offered rather than none, and rules without run limits
 * get exactly the passwords they got before.
 */
import { describe, expect, it } from 'vitest';
import sweep from './password-generator-sweep-main.json';
import { FILL_BUDGET, fillSteps, drawOnce, generatePassword, GENERATOR_CLASSES, isStrongPassword, LOOK_ALIKES, passwordBits, passwordRulesFor, passwordSatisfies, runsAllow, type PasswordRuleSet, type RandomInt } from '../src/password-generator';

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
  function outcomes(rules: PasswordRuleSet): { made: number; chances: Map<string, number>; total: number } {
    const chances = new Map<string, number>();
    let made = 0;
    let total = 0;
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
      total += chance;
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
    return { made, chances, total };
  }

  /** Every string of `pool` of `length` that meets the rules: whether a password exists at all. */
  const exists = (rules: PasswordRuleSet, pool: string, length: number): boolean => {
    const walk = (prefix: string): boolean => (prefix.length === length ? passwordSatisfies(prefix, rules) : [...pool].some((c) => walk(prefix + c)));
    return walk('');
  };

  const pools = ['[ab]', '[abc]', '[abcd]', '[2345]', '[ab-]'];
  const limits = ['', 'max-repeating: 1;', 'max-repeating: 2;', 'max-sequential: 1;', 'max-sequential: 2;', 'max-consecutive: 1;', 'max-repeating: 1; max-sequential: 2;'];
  const cases = [
    ...pools.flatMap((pool) =>
      limits.flatMap((limit) =>
        [2, 3, ...(pool.length <= 5 ? [4] : [])].flatMap((max) => [
          `allowed: ${pool}; maxlength: ${max}; ${limit}`,
          ...(pool === '[ab-]' ? [`allowed: ${pool}; required: [-]; maxlength: ${max}; ${limit}`] : []),
        ]),
      ),
    ),
    // Argon's counterexamples (design review of #60, B1): a small forced class among wider ones, and two side by side.
    'allowed: [abcde]; required: [b]; maxlength: 4; max-sequential: 1;',
    'allowed: [abcd]; required: [b]; required: [c]; maxlength: 4; max-sequential: 1;',
    'allowed: [ab01]; required: [01]; max-consecutive: 1;',
    // Neon's B1 on #286: a small forced class's chance of being left with nothing between 0 and 1.
    'allowed: [abcde]; required: [b]; maxlength: 3; max-repeating: 1;',
    'allowed: [abcdef]; required: [b]; maxlength: 3; max-sequential: 1;',
  ];

  /**
   * Whether no place of these rules' plan can be left with no character (Argon's B4): every class it draws from (the
   * clean pool, each required class, the default's classes within the pool) has more characters than the run limits
   * can rule out at a place. Then one try always makes a password.
   */
  const neverStuck = (rules: PasswordRuleSet): boolean => {
    if (rules.maxRepeating === null && rules.maxSequential === null) return true;
    const e = (rules.maxRepeating === null ? 0 : 1) + (rules.maxSequential === null ? 0 : rules.maxSequential <= 1 ? 2 : 1);
    const allowed = rules.allowed.replace(/ /g, '');
    const pool = [...allowed].filter((c) => !LOOK_ALIKES.includes(c)).join('') || allowed;
    const within = (cls: string, of: string) => [...new Set(cls)].filter((c) => of.includes(c));
    const classes = [pool, ...rules.required.map((cls) => within(cls, allowed).join('')), ...Object.values(GENERATOR_CLASSES).map((cls) => within(cls, pool).join(''))];
    return classes.filter(Boolean).every((cls) => new Set(cls).size > e);
  };

  it.each(cases)('%s', (site) => {
    const rules = rulesOf(site);
    const { made, chances, total } = outcomes(rules);
    // Every way a try can go, counted once (Neon's N1 on #286).
    expect(total).toBeCloseTo(1, 12);
    const allowed = rules.allowed.replace(/ /g, '');
    const anyAtMax = exists(rules, allowed, Math.min(rules.maxLength, 4));
    if (made === 0) {
      // A try that never makes one: only where no password of any length up to the maximum meets the rules.
      for (let n = rules.minLength || 1; n <= Math.min(rules.maxLength, 4); n++) expect(exists(rules, allowed, n), `length ${n}`).toBe(false);
      return;
    }
    // Most tries make one, or a focus could go without (a password offered on 99.9% of focuses at 300 tries); every
    // try, where no place can be left with nothing.
    if (anyAtMax) expect(made).toBeGreaterThan(0.02);
    if (neverStuck(rules)) expect(made).toBeCloseTo(1, 12);
    const likeliest = Math.max(...chances.values()) / made;
    const minEntropy = -Math.log2(likeliest);
    for (const p of chances.keys()) {
      expect(passwordSatisfies(p, rules), p).toBe(true);
      expect(passwordBits(p, rules), p).toBeLessThanOrEqual(minEntropy + 1e-9);
    }
  });
});

describe('the chance a small forced class is left with nothing, pinned (round 1 of #286: Neon’s B1, Opus’s SF2)', () => {
  /**
   * The strength shown, worked out by hand: each place's bits (its class less what the run limits rule out there),
   * less log2(1/(1 − q)), q the chance a try leaves the small class with nothing: for it, the characters that could
   * empty it as the one before it (B), over the other places the shuffle puts before it, each |B ∩ C| / (|C| − out).
   * And the exhaustive check above holds it under the true min-entropy; here it's also not far under.
   */
  it.each<[string, number, number]>([
    // out 1 (repeats); b's place 0 bits, two of [abcde] at log2 4. B = {b}: 1/4 a pool place, so q = (1/4 + 1/4)/2.
    ['allowed: [abcde]; required: [b]; maxlength: 3; max-repeating: 1;', 4 + Math.log2(1 - 0.25), 4],
    // out 2 (a, c next to b in order); two of [abcdef] at log2 4. B = {a, c}: 2/4 a pool place, so q = (1/2 + 1/2)/2.
    ['allowed: [abcdef]; required: [b]; maxlength: 3; max-sequential: 1;', 4 + Math.log2(1 - 0.5), 4],
    // Argon's first counterexample: three of [abcde] at log2 3; B = {a, c}: 2/3 a place, q = (3 · 2/3)/3.
    ['allowed: [abcde]; required: [b]; maxlength: 4; max-sequential: 1;', 3 * Math.log2(3) + Math.log2(1 - 2 / 3), 3 * Math.log2(3)],
  ])('%s', (site, expected, raw) => {
    const rules = rulesOf(site);
    const p = generatePassword(rules, seeded(2))!;
    expect(passwordBits(p, rules)).toBeCloseTo(expected, 9);
    expect(passwordBits(p, rules)).toBeGreaterThan(0);
    expect(passwordBits(p, rules)).toBeLessThan(raw);
  });
});

describe('strong where it is: a small forced class among wide ones (round 1 of #286: Opus’s SF1, Neon’s SF1 and N1)', () => {
  it.each([
    // Opus's scenario 1: main showed 99.3 bits, b7e41bfe 0, true about 99.
    'required: lower; required: upper; required: digit; required: [!]; required: [#]; max-consecutive: 2;',
    // Opus's scenario 2: main 70.3, b7e41bfe 0, true about 69.
    'allowed: digit, [abcdef]; required: [!]; max-consecutive: 1;',
    // Neon's: b7e41bfe stopped at 20, weak at 0 bits; it's strong made longer.
    'allowed: [abcdefghijk]; required: [!]; required: [@]; required: [#]; max-repeating: 1;',
  ])('%s', (site) => {
    const rules = rulesOf(site);
    const { rate, passwords } = focuses(rules, 100);
    expect(rate).toBe(1);
    for (const p of passwords) {
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(isStrongPassword(p, rules), `${p}: ${passwordBits(p, rules)}`).toBe(true);
    }
  });
});

describe('max-sequential: 1 rules out only the neighbours in order a character has (Opus’s N1 on #286)', () => {
  it('none in order (_, 2, c, x): the same bits as no limit at all', () => {
    const limited = rulesOf('allowed: [_2cx]; maxlength: 20; max-sequential: 1;');
    const free = rulesOf('allowed: [_2cx]; maxlength: 20;');
    const p = generatePassword(limited, seeded(4))!;
    expect(passwordBits(p, limited)).toBeCloseTo(passwordBits(p, free), 9);
  });

  it('[_y-2cx] (read as 2, _, c, x, y), max-repeating 2: one neighbour (x, y), so 3 of 5 a place, about 28 bits (17 before)', () => {
    const rules = rulesOf('allowed: [_y-2cx]; maxlength: 20; max-repeating: 2; max-sequential: 1;');
    const p = generatePassword(rules, seeded(4))!;
    expect(rules.allowed).toBe('2_cxy');
    expect(passwordBits(p, rules)).toBeGreaterThan(27.5);
    expect(passwordBits(p, rules)).toBeLessThanOrEqual(20 * Math.log2(3) + 1e-9);
  });
});

describe('round 2 of #286: the fallbacks’ regressions (Neon’s B1, B2; Opus’s weak path)', () => {
  // 1a: only max-sequential 1 (a step in order) or max-repeating 1 (the same again) bans two neighbours outright: strong
  // rules weren't to be cut to one character.
  it.each([
    'allowed: [abc]; required: [b]; max-sequential: 6;',
    'allowed: [ab]; required: [a]; max-sequential: 5;',
    'allowed: [abc]; required: [b]; max-sequential: 2;',
    'allowed: [abc]; required: [b]; max-repeating: 2; max-sequential: 6;',
  ])('1a, %s: as strong as before, never one character', (site) => {
    const rules = rulesOf(site);
    const p = generatePassword(rules, seeded(5))!;
    expect(p.length).toBeGreaterThan(8);
    expect(passwordSatisfies(p, rules)).toBe(true);
  });

  // 1b and 1c: the rules' minimum where a class can't stand beside the pool, or the pool can't fill: a password, of
  // what the class itself allows or, failing that, what the rules allow.
  it.each<[string, RegExp]>([
    ['allowed: [a0]; required: [a]; required: [0]; minlength: 4; maxlength: 4; max-repeating: 1;', /^(0a0a|a0a0)$/],
    ['allowed: [231]; required: [3]; minlength: 2; maxlength: 2; max-consecutive: 1;', /^(13|31)$/],
    ['allowed: [kl]; required: [k]; minlength: 2; maxlength: 2; max-repeating: 1;', /^(kl|lk)$/],
    ['allowed: [kl]; required: [l]; minlength: 4; maxlength: 4; max-repeating: 1; max-sequential: 2;', /^(klkl|lklk)$/],
    ['allowed: [ab01]; required: [b]; max-consecutive: 1; minlength: 3;', /^[ab01]{3}$/],
    ['allowed: [kl]; required: [l]; max-sequential: 1; minlength: 2;', /^l{2,}$/],
    ['allowed: [klm]; required: [l]; max-sequential: 1; minlength: 2;', /^l{2,}$/],
    ['allowed: [klm]; required: [l]; max-sequential: 1; minlength: 3;', /^l{3,}$/],
    ['allowed: [12]; required: [1]; max-repeating: 2; max-sequential: 1; minlength: 2;', /^11$/],
  ])('1b/1c, %s', (site, shape) => {
    const rules = rulesOf(site);
    const { rate, passwords } = focuses(rules, 200);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    for (const p of passwords) {
      expect(p).toMatch(shape);
      expect(passwordSatisfies(p, rules)).toBe(true);
    }
  });

  // 2: two separators never side by side where the others can go between them.
  it.each([
    'allowed: [a01]; required: [0]; required: [1]; max-consecutive: 1; maxlength: 3;',
    'allowed: [ab01]; required: [0]; required: [1]; max-consecutive: 1; maxlength: 3;',
    'allowed: [a01]; required: [0]; required: [1]; max-repeating: 2; max-sequential: 1; maxlength: 3;',
    'allowed: [a01]; required: [0]; required: [1]; max-repeating: 2; max-sequential: 1; maxlength: 4;',
    'allowed: [a01]; required: [0]; required: [1]; max-repeating: 3; max-sequential: 1; maxlength: 4;',
  ])('2, %s: a password on every focus', (site) => {
    const rules = rulesOf(site);
    const { rate, passwords } = focuses(rules, 200);
    expect(rate).toBe(1);
    for (const p of passwords) expect(passwordSatisfies(p, rules)).toBe(true);
  });

  // 3: a plan whose places count nothing is never stretched to the vault's limit.
  it.each(['allowed: [ab]; required: [4]; required: [5]; max-consecutive: 1;', 'allowed: [abcdef]; required: [b]; max-consecutive: 1;', 'allowed: [abc]; required: [!]; required: [@]; max-consecutive: 1;'])(
    '3, %s: a password on 99% of focuses, never stretched past what adds bits',
    (site) => {
      const rules = rulesOf(site);
      const { rate, passwords } = focuses(rules, 200);
      expect(rate).toBeGreaterThanOrEqual(0.99);
      for (const p of passwords) expect(p.length <= 20 || isStrongPassword(p, rules), `${p.length}`).toBe(true);
    },
  );

  // 4: the term for the place before a small class being another small class (q = 22/27; 16/27 without it).
  it('4, byOther pinned: [abcdefgh] with b and c required, max-sequential 1, 10 long', () => {
    const rules = rulesOf('allowed: [abcdefgh]; required: [b]; required: [c]; max-sequential: 1; maxlength: 10;');
    const p = generatePassword(rules, seeded(6))!;
    expect(p).toHaveLength(10);
    // Eight free places at log2(8 − 2); q = 2 · (8 · 2/6 + 1) / 9.
    expect(passwordBits(p, rules)).toBeCloseTo(8 * Math.log2(6) + Math.log2(1 - 22 / 27), 9);
  });

  // 4: stuck certain at 20 and 21 (twelve small classes, each beside two others in order), and not once made longer.
  it('4, grows pinned: lengthened past where the stuck chance is still 1, and strong', () => {
    const rules = rulesOf('required: lower; required: upper; required: digit; required: [a]; required: [b]; required: [c]; required: [d]; required: [e]; required: [f]; required: [g]; required: [h]; required: [i]; required: [j]; required: [k]; required: [l]; max-sequential: 1;');
    const p = generatePassword(rules, seeded(7))!;
    expect(passwordSatisfies(p, rules)).toBe(true);
    expect(p.length).toBeGreaterThan(21);
    expect(isStrongPassword(p, rules)).toBe(true);
  });
});

describe('round 3 of #286: a page can’t stall main (Neon’s B1), nor stretch a weak password (Neon’s B2)', () => {
  // Neon's inputs: a page's own passwordrules, worked out on Electron's main thread on every focus. Each stays inside its
  // walk's budget here; how long each takes is held in password-generator.perf.test.ts (pnpm test:perf).
  const SYMBOL_CLASSES = ['!@#', '$%^', '&*(', ')-_', '=+.', ',;:', '<>?', '/~!', '@#$', '%^&', '*()']
    .map((c) => `required: [${c}];`)
    .join(' ');
  const heavy = [
    'allowed: [ab01IOlo|]; max-repeating: 60; max-sequential: 1; minlength: 64;',
    'allowed: [ab01IOlo|]; required: [ab01IOlo|]; max-repeating: 60; max-sequential: 1; minlength: 64;',
    'allowed: [ab01IOlo|]; required: [ab01IOlo|]; required: [ab01IOlo|]; max-repeating: 60; max-sequential: 1; minlength: 64;',
    `allowed: [ab01IOlo|]; ${'required: [ab01IOlo|]; '.repeat(6)}max-repeating: 60; max-sequential: 1; minlength: 64;`,
    `allowed: [ab01IOlo|]; ${'required: [ab01IOlo|]; '.repeat(12)}max-repeating: 60; max-sequential: 1; minlength: 64;`,
    `allowed: [ab01IOlo|]; ${'required: [a]; required: [b]; required: [0]; required: [1]; '.repeat(3)}max-repeating: 60; max-sequential: 1; minlength: 64;`,
    // Many small required classes (each one character): the stuck chance's work grows with their square, at every
    // length tried (7.2 s and 2.6 s before).
    `allowed: lower, digit; ${'required: [a]; required: [b]; '.repeat(150)}max-repeating: 1; minlength: 400;`,
    `allowed: lower, digit; ${'required: [a]; '.repeat(90)}max-consecutive: 1; minlength: 200;`,
    `allowed: lower, digit; ${[...'abcdefghijkmnpqrstuvwxyz23456789'].map((c) => `required: [${c}];`).join(' ')} max-sequential: 1; minlength: 900;`,
    // Opus's (round 3 of #286): a two-letter pool in order, one letter required, and eleven classes of three symbols
    // (about 140 s at be3a5bda for generatePassword, as long again for isStrongPassword).
    `allowed: [ab]; required: [a]; ${SYMBOL_CLASSES} max-sequential: 1; minlength: 64;`,
    `allowed: [ab]; required: [a]; ${SYMBOL_CLASSES} max-sequential: 1; minlength: 40;`,
    `allowed: [kl]; required: [l]; ${SYMBOL_CLASSES} max-sequential: 1; minlength: 64;`,
  ];
  it.each(heavy)('B1, %s: its walk inside its budget, and a password or none (never a hang)', (site) => {
    const rules = rulesOf(site);
    expect(fillSteps(rules)).toBeLessThanOrEqual(FILL_BUDGET);
    const p = generatePassword(rules, seeded(9));
    if (p !== null) expect(passwordSatisfies(p, rules)).toBe(true);
  });

  it('B2: never stretched to where it’s weaker (Neon’s witness: 2.21 bits at 20, 3.00 at 21, 0 by 31)', () => {
    const rules = rulesOf(`allowed: [abcd0]; required: [b]; required: [c]; ${'required: [0]; '.repeat(15)}max-sequential: 1;`);
    const p = generatePassword(rules, seeded(10))!;
    expect(p).not.toBeNull();
    // Never stretched (it went to 1,000 at 0 bits). Its 15 [0]s are one class now, and its bits count as they are.
    expect(p.length).toBeLessThan(40);
    expect(passwordSatisfies(p, rules)).toBe(true);
  });

  it('[ab0] with a and b required, max-sequential 1: a0b (nothing at main or before)', () => {
    const rules = rulesOf('allowed: [ab0]; required: [a]; required: [b]; max-sequential: 1;');
    const { rate, passwords } = focuses(rules, 100);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    for (const p of passwords) expect(passwordSatisfies(p, rules)).toBe(true);
  });
});

describe('a regression sweep against main (round 2 of #286)', () => {
  /**
   * 400 seeded rule sets (run limits, required and allowed classes, half with a maxlength), each tried on 20 seeds by
   * main's generator before #286 (5e16d787; password-generator-sweep-main.json). Every one that made a password there
   * still does here, never longer than main's or 40, unless it's made longer to be strong: ten of these 400 are, at 41
   * to 43 characters, where main stopped at 20, weak (a pool the run limits leave a bit a place).
   */
  it('every rule set that made a password at main still makes one, as short', () => {
    const lost: string[] = [];
    for (const [i, { rules: site, made, length }] of (sweep as { rules: string; made: number; length: number | null }[]).entries()) {
      if (!made) continue;
      const rules = rulesOf(site);
      let now = 0;
      let longest = 0;
      let weakLong = false;
      for (let seed = 1; seed <= 20; seed++) {
        const p = generatePassword(rules, seeded(seed * 7919 + i));
        if (!p) continue;
        now++;
        longest = Math.max(longest, p.length);
        if (p.length > Math.max(length ?? 0, 40) && !isStrongPassword(p, rules)) weakLong = true;
        expect(passwordSatisfies(p, rules), site).toBe(true);
      }
      if (!now || (made === 20 && now < 19) || weakLong) lost.push(`${site} (main ${made}/20 at ${length}, now ${now}/20 at ${longest})`);
    }
    expect(lost).toEqual([]);
  });
});

describe('a password where one exists (round 1 of #286: Neon’s B2, Opus’s N2)', () => {
  it.each<[string, RegExp]>([
    // B2a: a separator beside only one of the pool's two characters.
    ['allowed: [231]; required: [1]; max-consecutive: 1; minlength: 3;', /^313$/],
    ['allowed: [231]; required: [1]; max-consecutive: 1; minlength: 2;', /^(31|13|313)$/],
    ['allowed: [jk]; required: [l]; max-consecutive: 1; minlength: 3;', /^jlj$/],
    ['allowed: [mn]; required: [o]; max-consecutive: 1; minlength: 3;', /^mom$/],
    ['allowed: [GH]; required: [I]; max-consecutive: 1; minlength: 3;', /^GIG$/],
    ['allowed: [MN]; required: [O]; max-consecutive: 1; minlength: 3;', /^MOM$/],
    // B2b: the clean pool can't reach the minimum: what the rules allow, look-alikes and all, as short as they let.
    ['allowed: [a0O]; max-repeating: 2; minlength: 5;', /^[a0O]{5}$/],
    ['allowed: [ab01]; max-consecutive: 1; minlength: 3;', /^[ab01]{3}$/],
    // B2c and Opus's N2: a required class that can't stand beside the pool's other characters: it alone.
    ['allowed: [kl]; required: [l]; max-repeating: 2; max-sequential: 1;', /^ll?$/],
    ['allowed: [kl]; required: [l]; max-sequential: 1; maxlength: 2;', /^ll?$/],
    ['allowed: [12]; required: [1]; max-repeating: 2; max-sequential: 1;', /^11?$/],
    ['allowed: [klm]; required: [l]; max-sequential: 1;', /^l+$/],
    // Opus's N2: four required look-alikes between a's (one try in 126 before; 91% of focuses).
    ['allowed: [a01lIOo|]; required: [0]; required: [1]; required: [l]; required: [I]; max-repeating: 1;', /^[a01lIOo|]+$/],
  ])('%s', (site, shape) => {
    const rules = rulesOf(site);
    const { rate, passwords } = focuses(rules, 300);
    expect(rate).toBeGreaterThanOrEqual(0.99);
    for (const p of passwords) {
      expect(p).toMatch(shape);
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(isStrongPassword(p, rules)).toBe(false);
    }
  });
});

describe('a pool the run limits can’t fill on its own (Argon’s B2)', () => {
  it('allowed: [ab01]; required: [01]; max-consecutive: 1: 3 long, a 0 or 1 between a and b', () => {
    const rules = rulesOf('allowed: [ab01]; required: [01]; max-consecutive: 1;');
    const { rate, passwords } = focuses(rules, 200);
    expect(rate).toBe(1);
    for (const p of passwords) {
      expect(p).toMatch(/^[ab][01][ab]$/);
      expect(isStrongPassword(p, rules)).toBe(false);
    }
  });

  it('a minimum the pool can’t reach: nothing, at once (no draws)', () => {
    let draws = 0;
    const counted: RandomInt = (n) => (draws++, seeded(5)(n));
    expect(generatePassword(rulesOf('allowed: [a]; max-repeating: 2; minlength: 5;'), counted)).toBeNull();
    expect(generatePassword(rulesOf('allowed: [ab]; max-consecutive: 1; minlength: 2;'), counted)).toBeNull();
    expect(draws).toBe(0);
  });
});

describe('a pool the run limits leave a single character a place (Argon’s B3)', () => {
  it.each(['allowed: [abcd]; max-consecutive: 1;', 'allowed: [ab]; max-repeating: 1;', 'allowed: [abc]; max-consecutive: 1;'])('%s: a finite length, never lengthened for nothing', (site) => {
    const rules = rulesOf(site);
    const p = generatePassword(rules, seeded(8));
    expect(p).not.toBeNull();
    expect(p!.length).toBeLessThanOrEqual(20);
    expect(passwordSatisfies(p!, rules)).toBe(true);
  });
});

/** main's runs() before #286 (b0c2b4e8), kept as the reference the new fold is checked against (Opus's N3). */
function referenceRuns(password: string): { repeating: number; sequential: number } {
  const ranges = ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'];
  const step = (a: string, b: string): number => {
    for (const r of ranges) {
      const i = r.indexOf(a);
      const j = r.indexOf(b);
      if (i >= 0 && j >= 0) return j - i;
    }
    return 0;
  };
  let repeating = password.length ? 1 : 0;
  let sequential = password.length ? 1 : 0;
  let rep = 1;
  let seq = 1;
  let dir = 0;
  for (let i = 1; i < password.length; i++) {
    rep = password[i] === password[i - 1] ? rep + 1 : 1;
    const d = step(password[i - 1]!, password[i]!);
    if ((d === 1 || d === -1) && (seq === 1 || d === dir)) {
      seq++;
      dir = d;
    } else if (d === 1 || d === -1) {
      seq = 2;
      dir = d;
    } else {
      seq = 1;
      dir = 0;
    }
    repeating = Math.max(repeating, rep);
    sequential = Math.max(sequential, seq);
  }
  return { repeating, sequential };
}

describe('the run check as a password is built: the same as checking it whole (Argon’s N1)', () => {
  it('random strings, random limits: the same as main’s old runs()', () => {
    const r = seeded(32);
    const chars = 'abcxyzABC0123-';
    for (let i = 0; i < 5000; i++) {
      const password = Array.from({ length: 1 + r(12) }, () => chars[r(chars.length)]).join('');
      const rules = { ...rulesOf(''), allowed: chars, maxRepeating: r(3) ? 1 + r(4) : null, maxSequential: r(3) ? 1 + r(4) : null };
      const { repeating, sequential } = referenceRuns(password);
      const expected = (rules.maxRepeating === null || repeating <= rules.maxRepeating) && (rules.maxSequential === null || sequential <= rules.maxSequential);
      expect(runsAllow(password, rules), `${password} ${rules.maxRepeating} ${rules.maxSequential}`).toBe(expected);
    }
  });

  it('random strings, random limits', () => {
    const r = seeded(31);
    const chars = 'abcxyzABC0123-';
    for (let i = 0; i < 5000; i++) {
      const password = Array.from({ length: 1 + r(12) }, () => chars[r(chars.length)]).join('');
      const rules = { ...rulesOf(''), allowed: chars, maxRepeating: r(3) ? 1 + r(4) : null, maxSequential: r(3) ? 1 + r(4) : null };
      const whole = passwordSatisfies(password, { ...rules, minLength: 0, maxLength: 100, required: [] });
      expect(runsAllow(password, rules), `${password} ${rules.maxRepeating} ${rules.maxSequential}`).toBe(whole);
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
