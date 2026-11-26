/**
 * The generator on a page's rules built to be slow (round 3 of #286, Neon's B1): a page's `passwordrules` attribute is
 * untrusted, and Chord works it out on Electron's main thread at every focus. Each input is held to 50 ms (the fastest
 * of three, so a busy machine's pause isn't counted). Before the fix they took 0.8 s to well over 30 s.
 * password-generator-runs.test.ts holds each to its walk's budget in the unit suite; budgets run alone, in
 * `pnpm test:perf`.
 */
import { describe, expect, it } from 'vitest';
import { generatePassword, passwordBits, passwordRulesFor, type RandomInt } from '../src/password-generator';

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
  ];
  it.each(heavy)(`%s: under ${BUDGET_MS} ms`, (site) => {
    const rules = passwordRulesFor({}, site).rules;
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      generatePassword(rules, seeded(9 + i));
      passwordBits('a'.repeat(64), rules);
      fastest = Math.min(fastest, performance.now() - started);
    }
    console.log(`${site.slice(0, 60)}…: ${fastest.toFixed(1)} ms`);
    expect(fastest).toBeLessThan(BUDGET_MS);
  });
});
