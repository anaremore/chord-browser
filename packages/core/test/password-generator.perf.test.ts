/**
 * The generator on a page's rules built to be slow (round 3 of #286, Neon's B1): a page's `passwordrules` attribute is
 * untrusted, and Chord works it out on Electron's main thread at every focus. Each input is held to 50 ms for a whole
 * focus (the password, its strength, the words for a weak one), from rules read afresh each time, as a page's are: the
 * slowest of three, never a run that found its plan already worked out (round 4 of #286, Neon). Before the fixes they
 * took 0.8 s to well over 30 s.
 * password-generator-runs.test.ts holds each to its walk's budget in the unit suite; budgets run alone, in
 * `pnpm test:perf`.
 */
import { describe, expect, it } from 'vitest';
import { describeWeakPassword, generatePassword, isStrongPassword, passwordBits, passwordRulesFor, type RandomInt } from '../src/password-generator';

// Core compiles without DOM or Node types; both are globals where the tests run.
declare const performance: { now(): number };
declare const console: { log(...args: unknown[]): void };

const BUDGET_MS = 50;

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

describe('the generator on a page’s rules built to be slow', () => {
  // One character each (letters, then digits), two next to each other in order, and two of sixteen letters each pair.
  const ONE = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ23456789'];
  const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ADJACENT = [...LETTERS].slice(0, -1).map((c, i) => c + LETTERS[i + 1]).filter((pair) => pair !== 'zA');
  const DISTINCT = [...'abcdefghijklmnop'].flatMap((a, i) => [...'abcdefghijklmnop'].slice(i + 1).map((b) => a + b));
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
    // Neon's (round 4 of #286): many small required classes beside a wide pool, each length's count of bits once
    // worked out from the whole set again (up to 1.34 s a focus).
    `allowed: ascii-printable; ${ONE.slice(0, 30).map((c) => `required: [${c}];`).join(' ')} required: [01IOlo|]; max-consecutive: 1; minlength: 31;`,
    `allowed: ascii-printable; ${ONE.slice(0, 60).map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1; minlength: 61;`,
    `allowed: ascii-printable; ${ADJACENT.slice(0, 45).map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1; minlength: 46;`,
    `allowed: ascii-printable; ${DISTINCT.slice(0, 120).map((c) => `required: [${c}];`).join(' ')} max-sequential: 1;`,
    `allowed: ascii-printable; ${DISTINCT.slice(0, 120).map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1;`,
    `allowed: lower, upper; ${ONE.slice(0, 19).map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1;`,
    `allowed: lower, digit; ${ONE.slice(0, 15).map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1;`,
    `allowed: ascii-printable; ${DISTINCT.slice(0, 120).map((c) => `required: [${c}];`).join(' ')} max-repeating: 1; max-sequential: 2; minlength: 121;`,
  ];
  // Opus's (round 5 of #286): long passwords from wide classes, where drawing each place checked every character of its
  // class against the run limits (50-90 ms a focus).
  const SYMBOLS = [...'-!#$%&*+.:;=?@^_~'];
  const TRIPLES = SYMBOLS.flatMap((a, i) => SYMBOLS.slice(i + 1).flatMap((b, j) => SYMBOLS.slice(i + j + 2).map((c) => a + b + c))).slice(0, 80);
  const LETTERS_DIGITS = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
  const drawn = [
    `allowed: lower, upper, digit, [-!#$%&*+.:;=?@^_~]; ${LETTERS_DIGITS.map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1; minlength: 1000;`,
    `allowed: ascii-printable; ${LETTERS_DIGITS.map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1;`,
    `allowed: [ab]; required: [a]; ${TRIPLES.map((t) => `required: [${t}];`).join(' ')} max-sequential: 1; minlength: 64;`,
    `allowed: ascii-printable; ${LETTERS_DIGITS.map((c) => `required: [${c}];`).join(' ')} max-consecutive: 1; minlength: 1000;`,
    // Neon's N4-1 (round 4's first witness): thirty single letters, b to G, and the look-alikes.
    `allowed: ascii-printable; ${[...'bcdefghijklmnopqrstuvwxyzABCDEFG'].slice(0, 30).map((c) => `required: [${c}];`).join(' ')} required: [01IOlo|]; max-consecutive: 1; minlength: 31;`,
  ];
  /** A random source as Chord's is (crypto.randomInt in main): not seeded. */
  const anyRandom: RandomInt = (n) => Math.floor(Math.random() * n);
  it.each(drawn)(`%s: a focus under ${BUDGET_MS} ms, fifteen times`, (site) => {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const started = performance.now();
      const rules = passwordRulesFor({}, site).rules;
      const password = generatePassword(rules, anyRandom);
      if (password !== null && !isStrongPassword(password, rules)) describeWeakPassword(password, rules);
      times.push(performance.now() - started);
    }
    const slowest = Math.max(...times);
    console.log(`${site.slice(0, 60)}…: slowest ${slowest.toFixed(1)} ms of 15`);
    expect(slowest).toBeLessThan(BUDGET_MS);
  });

  it.each(heavy)(`%s: a focus under ${BUDGET_MS} ms`, (site) => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      // As a focus does it (passwords/generator.ts): the rules read afresh, so nothing of an earlier run is kept.
      const rules = passwordRulesFor({}, site).rules;
      const password = generatePassword(rules, seeded(9 + i));
      if (password !== null && !isStrongPassword(password, rules)) describeWeakPassword(password, rules);
      if (password === null) passwordBits('a'.repeat(64), rules);
      times.push(performance.now() - started);
    }
    const slowest = Math.max(...times);
    console.log(`${site.slice(0, 60)}…: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
    expect(slowest).toBeLessThan(BUDGET_MS);
  });
});
