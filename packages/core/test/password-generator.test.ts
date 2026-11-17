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
  GENERATED_LENGTH,
  GENERATOR_CLASSES,
  generatePassword,
  passwordRulesFor,
  passwordSatisfies,
  ruleSetOf,
  type PasswordRuleSet,
  type RandomInt,
} from '../src/password-generator';
import { changePasswordUrlFor, siteRulesFor } from '../src/password-quirks';
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
      const digits = generatePassword(passwordRulesFor({}, 'allowed: digit; minlength: 6; maxlength: 6;').rules, random)!;
      expect(digits).toMatch(/^[2-9]{6}$/);
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
