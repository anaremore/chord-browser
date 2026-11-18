/**
 * The password generator and its rules (S17 §6, *Generating*): Apple's parser against Apple's own test cases
 * (`apple-password-rules-cases.json`, from `PasswordRulesParserTest.js` at the vendored commit, MIT); the default;
 * which source wins; rules that can't be met; and the property that every password made meets its rules, over every
 * site in Apple's list and over random rules.
 */
import { describe, expect, it } from 'vitest';
import rulesList from '../vendor/apple-password-manager-resources/password-rules.json';
import changeList from '../vendor/apple-password-manager-resources/change-password-URLs.json';
import {
  DEFAULT_RULE_SET,
  describePasswordRules,
  describeWeakPassword,
  GENERATED_LENGTH,
  LOOK_ALIKES,
  isStrongPassword,
  passwordBits,
  GENERATOR_CLASSES,
  generatePassword,
  passwordRulesFor,
  passwordSatisfies,
  ruleSetOf,
  type PasswordRuleSet,
  type RandomInt,
} from '../src/password-generator';
import { changePasswordUrlFor, siteRulesFor } from '../src/password-quirks';
import { PASSWORD_LIMITS } from '../src/passwords';
import { CustomCharacterClass, NamedCharacterClass, parsePasswordRules, passwordRulesSaySomething, type CharacterClass } from '../src/password-rules-parser';
import apple from './apple-password-rules-cases.json';

/** A seeded generator (mulberry32), so a failure can be run again. */
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

const describeClass = (c: CharacterClass) => (c instanceof NamedCharacterClass ? c.name : c instanceof CustomCharacterClass ? `[${c.characters.join('')}]` : c);
const describeRules = (input: string) => parsePasswordRules(input).map((r) => ({ name: r.name, value: Array.isArray(r.value) ? r.value.map(describeClass) : r.value }));

describe("Apple's parser, against Apple's test cases", () => {
  it.each(apple.cases)('$name', ({ input, expected }) => {
    expect(describeRules(input)).toEqual(expected);
  });
  it.each(apple.malformed)('malformed %j degrades to allowed: ascii-printable', (input) => {
    expect(describeRules(input)).toEqual([{ name: 'allowed', value: ['ascii-printable'] }]);
  });
  it('says whether rules say anything', () => {
    expect(passwordRulesSaySomething('')).toBe(false);
    expect(passwordRulesSaySomething('   ')).toBe(false);
    expect(passwordRulesSaySomething('dummy: upper')).toBe(false);
    expect(passwordRulesSaySomething('minlength: 0;')).toBe(false);
    expect(passwordRulesSaySomething('minlength: 8;')).toBe(true);
    // As Apple's parser has it: a statement it can't read throws the whole string away.
    expect(passwordRulesSaySomething('required: lower; nonsense')).toBe(false);
    expect(passwordRulesSaySomething('required: lower; maxlength: ;')).toBe(true);
  });
});

describe('the default', () => {
  const lookAlikes = /[lIoO01]/;
  it('is 20 characters of letters, digits and -, one of each class at least, and no look-alikes', () => {
    const random = seeded(1);
    for (let i = 0; i < 2000; i++) {
      const p = generatePassword(DEFAULT_RULE_SET, random)!;
      expect(p).toHaveLength(GENERATED_LENGTH);
      expect(p).not.toMatch(lookAlikes);
      expect(p).toMatch(/^[A-Za-z0-9-]+$/);
      for (const cls of Object.values(GENERATOR_CLASSES)) expect([...p].some((c) => cls.includes(c))).toBe(true);
      expect(passwordSatisfies(p, DEFAULT_RULE_SET)).toBe(true);
    }
  });
  it("doesn't repeat (main's crypto.randomInt is tested in the desktop's unit tests)", () => {
    const seen = new Set<string>();
    const random = seeded(11);
    for (let i = 0; i < 500; i++) seen.add(generatePassword(DEFAULT_RULE_SET, random)!);
    expect(seen.size).toBe(500);
  });
});

describe('which rules count (S17 §6: the field, then the site, then minlength and maxlength)', () => {
  const site = 'minlength: 8; maxlength: 12; required: digit;';
  it.each([
    { name: 'nothing: the default', field: {}, site: null, source: 'default', min: 0, max: 1000 },
    { name: "the site's", field: {}, site, source: 'site', min: 8, max: 12 },
    { name: "the field's own over the site's", field: { passwordrules: 'minlength: 30; required: upper;' }, site, source: 'field', min: 30, max: 1000 },
    { name: "a field's rules that say nothing pass to the site's", field: { passwordrules: 'nonsense: 3' }, site, source: 'site', min: 8, max: 12 },
    { name: "site rules that say nothing pass to the default's", field: {}, site: '  ', source: 'default', min: 0, max: 1000 },
    { name: 'maxlength narrows', field: { maxLength: 16 }, site: null, source: 'default', min: 0, max: 16 },
    { name: 'minlength narrows', field: { minLength: 24 }, site: null, source: 'default', min: 24, max: 1000 },
    { name: "maxlength narrows the site's within its range", field: { maxLength: 10 }, site, source: 'site', min: 8, max: 10 },
    { name: "a maxlength under the site's minlength is ignored", field: { maxLength: 6 }, site, source: 'site', min: 8, max: 12 },
    { name: "a minlength over the site's maxlength is ignored", field: { minLength: 40 }, site, source: 'site', min: 8, max: 12 },
    { name: '-1 is no attribute', field: { minLength: -1, maxLength: -1 }, site: null, source: 'default', min: 0, max: 1000 },
  ])('$name', ({ field, site, source, min, max }) => {
    const got = passwordRulesFor(field, site);
    expect(got.source).toBe(source);
    expect([got.rules.minLength, got.rules.maxLength]).toEqual([min, max]);
  });

  it('makes passwords of the length the rules leave', () => {
    const random = seeded(2);
    expect(generatePassword(passwordRulesFor({}, 'minlength: 8; maxlength: 12;').rules, random)).toHaveLength(12);
    expect(generatePassword(passwordRulesFor({ minLength: 32 }, null).rules, random)).toHaveLength(32);
    expect(generatePassword(passwordRulesFor({ maxLength: 8 }, null).rules, random)).toHaveLength(8);
  });

  it("keeps the default's style where the rules allow it, and takes a required class's own characters where they don't", () => {
    const random = seeded(3);
    for (let i = 0; i < 300; i++) {
      const p = generatePassword(passwordRulesFor({}, 'required: lower; required: upper; required: digit; required: [!#$];').rules, random)!;
      expect(p).toMatch(/[!#$]/);
      expect(p.replace(/[!#$]/g, '')).toMatch(/^[A-Za-z2-9-]+$/);
      // Six digits are under the floor: drawn from all ten, the strongest the rules allow (review round 2 of #53).
      const digits = generatePassword(passwordRulesFor({}, 'allowed: digit; minlength: 6; maxlength: 6;').rules, random)!;
      expect(digits).toMatch(/^[0-9]{6}$/);
      // Fourteen are over it: drawn from 2–9, as the default's alphabet is.
      const more = generatePassword(passwordRulesFor({}, 'allowed: digit; minlength: 14; maxlength: 14;').rules, random)!;
      expect(more).toMatch(/^[2-9]{14}$/);
    }
  });
});

describe('the rules in plain words (the owner’s design 3A)', () => {
  it.each<[string, Parameters<typeof passwordRulesFor>[0], string | null, string | null]>([
    ['the default: nothing to say', {}, null, null],
    ['the site’s letters and digits, 12–16', {}, 'minlength: 12; maxlength: 16; allowed: lower, upper, digit;', 'Letters and digits, 12–16, as this site asks'],
    ['digits only, exactly 6', {}, 'allowed: digit; minlength: 6; maxlength: 6;', 'Digits, 6, as this site asks'],
    ['any characters, 8 to 20', {}, 'minlength: 8; maxlength: 20;', '8–20 characters, as this site asks'],
    // Apple's language: what's required is all that's allowed, unless `allowed` says more.
    ['a symbol required', {}, 'minlength: 10; required: lower, upper, digit; required: [!#$];', 'Letters, digits and symbols, at least 10, with a symbol, as this site asks'],
    ['a symbol required, anything allowed', {}, 'minlength: 10; required: [!#$]; allowed: ascii-printable;', 'At least 10 characters, with a symbol, as this site asks'],
    ['the field’s own maxlength on the default', { maxLength: 16 }, null, 'Up to 16 characters, as this site asks'],
    ['the field’s own passwordrules', { passwordrules: 'allowed: lower; maxlength: 30;' }, null, 'Letters, up to 30, as this site asks'],
  ])('%s', (_name, field, site, words) => {
    const { source, rules } = passwordRulesFor(field, site);
    expect(describePasswordRules(source, rules)).toBe(words);
  });
});

describe("rules that can't be met: nothing is offered", () => {
  it.each([
    ['a maxlength shorter than the classes it requires', 'maxlength: 2; required: lower; required: upper; required: digit;'],
    ['minlength over maxlength', 'minlength: 12; maxlength: 8;'],
    ['longer than the vault keeps', 'minlength: 1001;'],
    ['only a space allowed', 'allowed: [ ];'],
    ['two characters, never repeated or in order, for 20', 'allowed: [ab]; max-repeating: 1; max-sequential: 1; minlength: 20;'],
  ])('%s', (_name, rules) => {
    expect(generatePassword(passwordRulesFor({}, rules).rules, seeded(4))).toBeNull();
  });
});

describe('the work a page can ask of main (security review)', () => {
  it('rules that can’t be met, at 1,000 characters, cost a bounded number of draws', () => {
    let draws = 0;
    const random = seeded(9);
    const counted: RandomInt = (n) => (draws++, random(n));
    const { rules } = passwordRulesFor({ passwordrules: 'required: [ab]; allowed: [ab]; max-consecutive: 1;', minLength: 1000 }, null);
    expect(generatePassword(rules, counted)).toBeNull();
    expect(draws).toBeLessThanOrEqual(25_000);
  });
});

describe('passwordSatisfies', () => {
  const set = (over: Partial<PasswordRuleSet>): PasswordRuleSet => ({ ...DEFAULT_RULE_SET, allowed: 'abcdefghijklmnopqrstuvwxyz0123456789', ...over });
  it.each([
    ['aab', { maxRepeating: 2 }, true],
    ['aaab', { maxRepeating: 2 }, false],
    ['abd', { maxSequential: 2 }, true],
    ['abcx', { maxSequential: 2 }, false],
    ['x321', { maxSequential: 2 }, false],
    ['abab', { maxSequential: 2 }, true],
    ['aba', { maxSequential: 2 }, true],
    ['9ab', { maxSequential: 2 }, true],
    ['abc', { required: ['0123456789'] }, false],
    ['ab', { minLength: 3 }, false],
    ['abcd', { maxLength: 3 }, false],
    ['ab!', {}, false],
  ] as const)('%s with %j: %s', (password, over, ok) => {
    expect(passwordSatisfies(password, set(over))).toBe(ok);
  });
});

describe('every site in Apple’s list (property)', () => {
  const entries = Object.entries(rulesList as Record<string, { 'password-rules': string }>);
  it('has its rules read', () => {
    expect(entries.length).toBeGreaterThan(400);
  });
  it('gets a password that meets its rules, ten times over, or none: and none is rare', () => {
    const random = seeded(5);
    const unmet: string[] = [];
    for (const [host, { 'password-rules': rules }] of entries) {
      const set = ruleSetOf(parsePasswordRules(rules));
      for (let i = 0; i < 10; i++) {
        const p = generatePassword(passwordRulesFor({}, rules).rules, random);
        if (p === null) {
          unmet.push(host);
          break;
        }
        expect(passwordSatisfies(p, set), `${host}: ${rules}`).toBe(true);
      }
    }
    // Sites whose rules can't be met as written (Apple's list has a few with no character allowed by them).
    expect(unmet.length).toBeLessThanOrEqual(3);
  });
});

describe('random rules (property)', () => {
  const classes = ['lower', 'upper', 'digit', 'special', 'ascii-printable', 'unicode', '[-_.]', '[!@#$%]', '[abc]', '[0123]'];
  function randomRules(r: RandomInt): string {
    const parts: string[] = [];
    const n = 1 + r(5);
    for (let i = 0; i < n; i++) {
      const kind = r(7);
      const cls = () => classes[r(classes.length)]!;
      if (kind === 0) parts.push(`minlength: ${r(40)}`);
      else if (kind === 1) parts.push(`maxlength: ${r(40)}`);
      else if (kind === 2) parts.push(`required: ${cls()}${r(2) ? `, ${cls()}` : ''}`);
      else if (kind === 3) parts.push(`allowed: ${cls()}`);
      else if (kind === 4) parts.push(`max-consecutive: ${1 + r(4)}`);
      else if (kind === 5) parts.push(`max-repeating: ${1 + r(4)}`);
      else parts.push(`max-sequential: ${1 + r(4)}`);
    }
    return parts.join('; ');
  }
  it('never makes a password that breaks its rules, and meets roomy rules', () => {
    const r = seeded(6);
    let made = 0;
    for (let i = 0; i < 3000; i++) {
      const rules = randomRules(r);
      const field = { minLength: r(3) ? -1 : r(30), maxLength: r(3) ? -1 : r(30), ...(r(2) ? { passwordrules: randomRules(r) } : {}) };
      const { rules: set } = passwordRulesFor(field, rules);
      const p = generatePassword(set, r);
      if (p === null) continue;
      made++;
      expect(passwordSatisfies(p, set), JSON.stringify({ rules, field })).toBe(true);
    }
    expect(made).toBeGreaterThan(1500);
  });
  it('meets any rules with room: 12 characters or more, the classes allowed', () => {
    const r = seeded(7);
    for (let i = 0; i < 500; i++) {
      const req = ['lower', 'upper', 'digit', '[!@#$%]'].filter(() => r(2));
      const rules = `minlength: ${12 + r(10)}; ${req.map((c) => `required: ${c};`).join(' ')}`;
      const set = passwordRulesFor({}, rules).rules;
      const p = generatePassword(set, r);
      expect(p, rules).not.toBeNull();
      expect(passwordSatisfies(p!, set)).toBe(true);
    }
  });
});

describe("Apple's lists, by host", () => {
  const [ruleHost, ruleEntry] = Object.entries(rulesList as Record<string, { 'password-rules': string }>).find(([h]) => h.split('.').length === 2)!;
  const [changeHost, changeUrl] = Object.entries(changeList as Record<string, string>).find(([h]) => h.split('.').length === 2)!;
  it("finds a site's rules for it and its subdomains", () => {
    expect(siteRulesFor(`https://${ruleHost}`)).toBe(ruleEntry['password-rules']);
    expect(siteRulesFor(`https://login.${ruleHost}:8443`)).toBe(ruleEntry['password-rules']);
    expect(siteRulesFor('https://example.com')).toBeNull();
    expect(siteRulesFor('https://com')).toBeNull();
    expect(siteRulesFor('not a url')).toBeNull();
  });
  it("names a listed site's own page, else its /.well-known/change-password", () => {
    expect(changePasswordUrlFor(`https://www.${changeHost}`)).toBe(changeUrl);
    expect(changePasswordUrlFor('https://example.com')).toBe('https://example.com/.well-known/change-password');
    // https only: Chord doesn't open an http site's pages for you (the owner's design 6A).
    expect(changePasswordUrlFor('http://router.test:8080')).toBeNull();
    expect(changePasswordUrlFor('file:///etc')).toBeNull();
    expect(changePasswordUrlFor('javascript:alert(1)')).toBeNull();
  });
  it("doesn't take an object's own properties for a site", () => {
    expect(siteRulesFor('https://constructor.toString')).toBeNull();
    expect(changePasswordUrlFor('https://__proto__.example')).toBe('https://__proto__.example/.well-known/change-password');
  });
});

/* ---------- review round 1 of #53 ---------- */

describe('Apple’s rules read as written: hand-written rule sets, apart from the generator', () => {
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = LOWER.toUpperCase();
  const DIGITS = '0123456789';
  const sorted = (s: string) => [...s].sort().join('');
  it.each<[string, string, Partial<PasswordRuleSet>]>([
    ['bounds and two classes', 'minlength: 8; maxlength: 12; required: lower; required: digit;', { minLength: 8, maxLength: 12, allowed: sorted(LOWER + DIGITS), required: [DIGITS, LOWER] }],
    ['a class of either kind', 'required: lower, upper;', { allowed: sorted(LOWER + UPPER), required: [sorted(LOWER + UPPER)] }],
    ['allowed beyond what’s required', 'required: digit; allowed: [-_];', { allowed: sorted(DIGITS + '-_'), required: [DIGITS] }],
    ['max-consecutive is both run limits', 'max-consecutive: 2;', { maxRepeating: 2, maxSequential: 2 }],
    ['the strictest of each limit', 'minlength: 6; minlength: 9; maxlength: 30; maxlength: 20; max-repeating: 3; max-repeating: 2;', { minLength: 9, maxLength: 20, maxRepeating: 2, maxSequential: null }],
    ['nothing said: anything printable, any length', '', { minLength: 0, maxLength: 1000, required: [], maxRepeating: null }],
    ['a custom class keeps its dash', 'required: [-!];', { allowed: sorted('-!'), required: [sorted('-!')] }],
  ])('%s: %s', (_name, input, want) => {
    const got = ruleSetOf(parsePasswordRules(input));
    const { allowed, required, ...rest } = want;
    expect(got).toMatchObject(rest);
    if (allowed !== undefined) expect(got.allowed).toBe(allowed);
    if (required !== undefined) expect([...got.required].sort()).toEqual([...required].sort());
  });
});

describe('the floor under “strong” (review round 1 of #53)', () => {
  it.each<[string, Parameters<typeof passwordRulesFor>[0], string | null, boolean, RegExp | null]>([
    ['the default', {}, null, true, null],
    ['four digits, by the field', { passwordrules: 'maxlength: 4; allowed: digit;' }, null, false, /^Only 4 digits, as this site asks$/],
    ['maxlength=4 alone', { maxLength: 4 }, null, false, /^Only 4 letters, digits and symbols, as this site asks$/],
    ['seven characters, however varied', { maxLength: 7 }, null, false, /^Only 7 /],
    ['eight letters and digits: strong enough (about 46 bits)', {}, 'maxlength: 8; allowed: lower, upper, digit;', true, null],
    ['ten digits: long enough, too few bits (about 33)', {}, 'minlength: 10; maxlength: 10; allowed: digit;', false, /^Only 10 digits, as this site asks$/],
    // In Apple's language what's required is allowed too: 0–9 and `-`, 11 to draw from, 12 places: about 41.5 bits.
    ['twelve of digits and a required dash: drawn from all eleven', {}, 'allowed: digit; required: [-]; maxlength: 12;', true, null],
  ])('%s', (_name, field, site, strong, words) => {
    const { rules } = passwordRulesFor(field, site);
    const p = generatePassword(rules, seeded(12))!;
    expect(isStrongPassword(p, rules)).toBe(strong);
    if (words) expect(describeWeakPassword(p, rules)).toMatch(words);
  });

  /**
   * The pools written out, apart from the code (review round 2 of #53): each alphabet's characters without
   * look-alikes, and all of them, which a password under the floor is drawn from instead.
   */
  const POOLS: Record<string, { lean: number; full: number; chars: RegExp }> = {
    digit: { lean: 8, full: 10, chars: /^[0-9]+$/ },
    lower: { lean: 24, full: 26, chars: /^[a-z]+$/ },
    'lower, digit': { lean: 32, full: 36, chars: /^[a-z0-9]+$/ },
    'lower, upper, digit': { lean: 56, full: 62, chars: /^[A-Za-z0-9]+$/ },
    '[ab]': { lean: 2, full: 2, chars: /^[ab]+$/ },
    'ascii-printable': { lean: 57, full: 94, chars: /^[!-~]+$/ },
  };
  it('as a property: strong exactly at 8 characters and 40 bits, counted from the pool written out, and the longest the rules allow', () => {
    const r = seeded(13);
    for (let i = 0; i < 2000; i++) {
      const max = 1 + r(30);
      const allowed = Object.keys(POOLS)[r(6)]!;
      const { lean, full, chars } = POOLS[allowed]!;
      const { rules } = passwordRulesFor({ maxLength: max }, `allowed: ${allowed};`);
      const p = generatePassword(rules, r);
      if (p === null) continue;
      const length = Math.min(GENERATED_LENGTH, max);
      expect(p.length).toBe(length);
      expect(p).toMatch(chars);
      // Lean where that's strong enough; otherwise everything allowed.
      const pool = length * Math.log2(lean) >= 40 || lean === full ? lean : full;
      const bits = length * Math.log2(pool);
      expect(passwordBits(p, rules)).toBeCloseTo(bits, 6);
      const strong = length >= 8 && bits >= 40;
      expect(isStrongPassword(p, rules), `${allowed} × ${length}`).toBe(strong);
      if (!strong) expect(describeWeakPassword(p, rules)).toMatch(new RegExp(`^Only ${length} .+, as this site asks$`));
    }
  });
  it('counts the drawn pool only: a required class outside it adds nothing (review round 2 of #53)', () => {
    const digits = { ...DEFAULT_RULE_SET, allowed: '0123456789', required: ['-'], maxLength: 12 };
    expect(passwordBits('123456789012', digits)).toBeCloseTo(12 * Math.log2(10), 6);
    expect(isStrongPassword('123456789012', digits)).toBe(false);
    // Such rules can't be met: nothing is made.
    expect(generatePassword(digits, seeded(15))).toBeNull();
  });
  it.each<[string, string, number]>([
    ['8 letters and digits', 'allowed: lower, upper, digit; maxlength: 8;', 8 * Math.log2(56)],
    ['6 letters and digits, under the floor: all 62', 'allowed: lower, upper, digit; maxlength: 6;', 6 * Math.log2(62)],
    ['4 digits: all 10', 'allowed: digit; maxlength: 4;', 4 * Math.log2(10)],
    ['16 digits: 2–9', 'allowed: digit; maxlength: 16;', 16 * Math.log2(8)],
    ['the default', '', 20 * Math.log2(57)],
  ])('bits: %s', (_name, site, bits) => {
    const { rules } = passwordRulesFor({}, site);
    expect(passwordBits(generatePassword(rules, seeded(14))!, rules)).toBeCloseTo(bits, 6);
  });
});

describe('Apple’s lists by registrable domain (review round 1 of #53)', () => {
  it('never takes a public suffix for a site', () => {
    // Whatever Apple's lists hold, `co.uk` and `github.io` are suffixes: a page there looks itself up and its own site.
    expect(changePasswordUrlFor('https://shop.example.co.uk')).toBe('https://shop.example.co.uk/.well-known/change-password');
    expect(siteRulesFor('https://co.uk')).toBeNull();
    expect(siteRulesFor('https://someone.github.io')).toBeNull();
    expect(siteRulesFor('https://127.0.0.1:8080')).toBeNull();
  });
});

/* ---------- no look-alikes (the owner's decision of 2026-11-18) ---------- */

describe('never a look-alike where the rules allow anything else', () => {
  // None of the list is special inside a character class.
  const lookAlike = new RegExp(`[${LOOK_ALIKES}]`, 'g');
  const N = 200;
  it('is the one documented list', () => {
    expect([...LOOK_ALIKES].sort().join('')).toBe([...'01IOlo|'].sort().join(''));
    // The default's alphabet has none of them.
    expect(Object.values(GENERATOR_CLASSES).join('')).not.toMatch(lookAlike);
  });

  /**
   * Rule shapes, with the pool and length written out apart from the code: the alphabet the password's drawn from
   * (look-alikes left out) and how long it is, and the sizes of required classes drawn wholly from outside it (one
   * place each, at their own bits). Every one reaches the floor without a look-alike.
   */
  it.each<{ name: string; field?: Parameters<typeof passwordRulesFor>[0]; site: string | null; length: number; pool: number; outside?: number[] }>([
    { name: 'the default', site: null, length: 20, pool: 57 },
    { name: 'the default, a field’s maxlength', field: { maxLength: 10 }, site: null, length: 10, pool: 57 },
    { name: 'letters and digits, 12–16, each required', site: 'minlength: 12; maxlength: 16; required: lower; required: upper; required: digit;', length: 16, pool: 56 },
    { name: 'a required symbol class with a look-alike in it', site: 'required: lower; required: upper; required: digit; required: [!#$|];', length: 20, pool: 56, outside: [3] },
    { name: 'symbols only: all but |', site: 'allowed: special;', length: 20, pool: 31 },
    { name: 'digits only: 2–9', site: 'allowed: digit;', length: 20, pool: 8 },
    { name: 'fourteen digits: 2–9 reach the floor', site: 'allowed: digit; minlength: 14; maxlength: 14;', length: 14, pool: 8 },
    { name: 'eight capitals and digits: 40 bits exactly', site: 'allowed: upper, digit; maxlength: 8;', length: 8, pool: 32 },
    { name: 'digits and a required dash', site: 'allowed: digit; required: [-]; maxlength: 16;', length: 16, pool: 9 },
    // 8 from the default's lower case and -, 25, are under the floor: drawn from all lower case and symbols but l, o, |.
    { name: 'eight of letters and symbols: the wider pool, look-alikes left out', site: 'allowed: lower, special; maxlength: 8;', length: 8, pool: 55 },
    // Too few bits without look-alikes at 20: made longer, within the maximum.
    { name: 'two letters and look-alikes: 40 long', site: 'allowed: [ab01lI];', length: 40, pool: 2 },
    { name: 'three letters and look-alikes, at most 30: 26 long', site: 'allowed: [abc01O]; maxlength: 30;', length: 26, pool: 3 },
    { name: 'a field’s maxlength leaves room to lengthen', field: { maxLength: 50 }, site: 'allowed: [xy];', length: 40, pool: 2 },
    { name: 'lengthened to exactly the maximum', site: 'allowed: [xy]; maxlength: 40;', length: 40, pool: 2 },
    // Run limits that a longer password still meets easily (review round 1 of #56).
    { name: 'three letters, lengthened under loose run limits', site: 'allowed: [abc01]; max-repeating: 5; max-sequential: 6;', length: 26, pool: 3 },
  ])('$name', ({ field, site, length, pool, outside = [] }) => {
    const { rules } = passwordRulesFor(field ?? {}, site);
    const random = seeded(21);
    for (let i = 0; i < N; i++) {
      const p = generatePassword(rules, random)!;
      expect(p, site ?? '').not.toBeNull();
      expect(p).not.toMatch(lookAlike);
      expect(p).toHaveLength(length);
      // Every required class is there, and the rest of the rules are met.
      expect(passwordSatisfies(p, rules)).toBe(true);
      for (const cls of rules.required) expect([...p].some((c) => cls.includes(c))).toBe(true);
      // The bits, from the actual alphabet: at least the floor.
      const bits = (length - outside.length) * Math.log2(pool) + outside.reduce((sum, n) => sum + Math.log2(n), 0);
      expect(passwordBits(p, rules)).toBeCloseTo(bits, 6);
      expect(passwordBits(p, rules)).toBeGreaterThanOrEqual(40);
      expect(isStrongPassword(p, rules)).toBe(true);
    }
  });

  /**
   * A required class of look-alikes alone: one of them, one place at its own bits, not the pool's (review round 1 of
   * #56); the password made longer to make up for it, within the maximum.
   */
  it.each<[string, string, number, number, number]>([
    // 16 letters: 10 places at 4 bits, and the `0` at none: exactly the floor.
    ['at exactly the floor', 'allowed: [abcdefghijkmnpqr]; required: [0]; maxlength: 11;', 11, 16, 1],
    ['two letters and a required 0: one longer than 40', 'allowed: [ab]; required: [0];', 41, 2, 1],
    ['the same, the maximum exactly what it needs', 'allowed: [ab]; required: [0]; maxlength: 41;', 41, 2, 1],
    ['a class of two look-alikes', 'required: lower; required: [lI]; maxlength: 10;', 10, 24, 2],
  ])('%s', (_name, site, length, pool, forced) => {
    const { rules } = passwordRulesFor({}, site);
    const random = seeded(25);
    for (let i = 0; i < N; i++) {
      const p = generatePassword(rules, random)!;
      expect(p).toHaveLength(length);
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(p.match(lookAlike)).toHaveLength(1);
      const bits = (length - 1) * Math.log2(pool) + Math.log2(forced);
      expect(passwordBits(p, rules)).toBeCloseTo(bits, 6);
      expect(bits).toBeGreaterThanOrEqual(40);
      expect(isStrongPassword(p, rules)).toBe(true);
    }
  });

  it('a required class of look-alikes alone gets one of them, for that class only', () => {
    const { rules } = passwordRulesFor({}, 'required: lower; required: [lI];');
    const random = seeded(22);
    for (let i = 0; i < N; i++) {
      const p = generatePassword(rules, random)!;
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(p.match(lookAlike)).toHaveLength(1);
      expect(p).toMatch(/[lI]/);
      expect(passwordBits(p, rules)).toBeGreaterThanOrEqual(40);
    }
  });

  /**
   * Rules that can't reach the floor without look-alikes at any length they allow: everything they allow, look-alikes
   * too, made longer to reach the floor where the maximum lets it (review round 1 of #56), else at the default's length
   * within theirs. Its bits are counted from that alphabet.
   */
  it.each<[string, string, number, number, boolean]>([
    ['only look-alikes allowed: 40 of them', 'allowed: [0O];', 40, 2, true],
    ['one letter and two look-alikes: 26', 'allowed: [a0O];', 26, 3, true],
    ['only look-alikes, at most 30: 30 can’t reach it, 20 as before', 'allowed: [0O]; maxlength: 30;', 20, 2, false],
    // The review's case: 8 from 32 is 40 bits, but the required 0 or O is one place at 1 bit: 36. All 36 reach it.
    ['capitals and digits, 8, a required 0 or O', 'allowed: upper, digit; maxlength: 8; required: [0O];', 8, 36, true],
    ['six digits: 0–9', 'allowed: digit; minlength: 6; maxlength: 6;', 6, 10, false],
    ['thirteen digits: 2–9 fall short, 0–9 reach it', 'allowed: digit; maxlength: 13;', 13, 10, true],
    ['anything printable, 6', 'allowed: ascii-printable; maxlength: 6;', 6, 94, false],
  ])('%s', (_name, site, length, pool, strong) => {
    const { rules } = passwordRulesFor({}, site);
    const random = seeded(23);
    for (let i = 0; i < N; i++) {
      const p = generatePassword(rules, random)!;
      expect(p).toHaveLength(length);
      expect(passwordSatisfies(p, rules)).toBe(true);
      expect(passwordBits(p, rules)).toBeCloseTo(length * Math.log2(pool), 6);
      expect(isStrongPassword(p, rules)).toBe(strong);
    }
  });

  /**
   * Run limits and lengthening (review round 1 of #56): a password is made longer only while the run limits are met
   * easily, so nearly every focus gets one. Each over N_RUNS draws: at least 99% made, every one meeting its rules.
   */
  const N_RUNS = 1000;
  it.each<[string, string, number]>([
    ['two letters, at most 2 in a row: not lengthened', 'allowed: [xy]; max-consecutive: 2;', 20],
    ['two letters and look-alikes, at most 2 in a row: all six at 20', 'allowed: [ab01lI]; max-consecutive: 2;', 20],
    ['three letters, at most 3 repeated: not lengthened', 'allowed: [abc]; max-repeating: 3;', 20],
    ['three letters and look-alikes, at most 2 repeated: all six at 20', 'allowed: [abc01O]; maxlength: 30; max-repeating: 2;', 20],
    ['three letters, loose limits: lengthened to 26', 'allowed: [abc]; max-repeating: 5; max-sequential: 6;', 26],
    ['two letters, at most 2 repeated, room for 40: not lengthened', 'allowed: [xy]; max-repeating: 2; maxlength: 40;', 20],
  ])('%s', (_name, site, length) => {
    const { rules } = passwordRulesFor({}, site);
    const random = seeded(26);
    let made = 0;
    for (let i = 0; i < N_RUNS; i++) {
      const p = generatePassword(rules, random);
      if (p === null) continue;
      made++;
      expect(p).toHaveLength(length);
      expect(passwordSatisfies(p, rules), site).toBe(true);
    }
    expect(made / N_RUNS, site).toBeGreaterThanOrEqual(0.99);
  });

  it('lengthens within the vault’s limit, whatever the rules’ maximum', () => {
    const over = { ...DEFAULT_RULE_SET, allowed: 'xy', maxLength: PASSWORD_LIMITS.password * 5 };
    expect(generatePassword(over, seeded(27))).toHaveLength(40);
    const longest = { ...over, minLength: PASSWORD_LIMITS.password };
    expect(generatePassword(longest, seeded(27))).toHaveLength(PASSWORD_LIMITS.password);
    // One short of what it needs: not lengthened at all.
    const short = passwordRulesFor({}, 'allowed: [xy]; maxlength: 39;').rules;
    const p = generatePassword(short, seeded(27))!;
    expect(p).toHaveLength(20);
    expect(isStrongPassword(p, short)).toBe(false);
  });

  it('as a property over random rules: a look-alike only where the plan had to allow them', () => {
    const r = seeded(24);
    const shapes = ['lower', 'upper', 'digit', 'special', 'ascii-printable', '[ab0O]', '[xyz1l]', '[!|-]'];
    for (let i = 0; i < 1500; i++) {
      const allowed = shapes.filter(() => r(3) === 0);
      const req = shapes.filter(() => r(5) === 0);
      const site = `${allowed.length ? `allowed: ${allowed.join(', ')};` : ''} ${req.map((c) => `required: ${c};`).join(' ')} maxlength: ${8 + r(60)};`;
      const { rules } = passwordRulesFor({}, site);
      const p = generatePassword(rules, r);
      if (p === null) continue;
      expect(passwordSatisfies(p, rules), site).toBe(true);
      // One look-alike per required class with nothing else allowed; more only where the rules can't reach the floor
      // without them at any length they allow.
      const forced = rules.required.filter((cls) => ![...cls].some((c) => rules.allowed.includes(c) && !LOOK_ALIKES.includes(c))).length;
      if ((p.match(lookAlike) ?? []).length > forced) {
        const clean = new Set([...rules.allowed.replace(/ /g, '')].filter((c) => !LOOK_ALIKES.includes(c))).size;
        expect(clean <= 1 || Math.ceil(40 / Math.log2(clean)) > rules.maxLength, site).toBe(true);
      }
    }
  });
});
