/**
 * The password generator, main's side (S17 §6, *Generating*): core's generator (`@chord/core/password-generator`)
 * with `crypto.randomInt`, and the rules for a field from what it says of itself and Apple's list for the frame's
 * origin (`@chord/core/password-quirks`). Both are loaded the first time a new password's field takes focus, never at
 * launch (performance rule 1). Nothing here keeps or logs a password.
 */
import { randomInt } from 'node:crypto';
import type * as Generator from '@chord/core/password-generator';
import type { FieldPasswordRules } from '@chord/core/password-generator';
import type * as Quirks from '@chord/core/password-quirks';

let modules: Promise<[typeof Generator, typeof Quirks]> | null = null;
const load = () => (modules ??= Promise.all([import('@chord/core/password-generator'), import('@chord/core/password-quirks')]));

/** What the menu shows: the password, and in plain words the rules that shaped it (null for Chord's default). */
export interface Generated {
  readonly password: string;
  readonly rule: string | null;
}

/** A strong password for a field on a page of `origin` (the frame's, as Chromium reports it), or null when its rules can't be met. */
export async function generatePasswordFor(origin: string, field: FieldPasswordRules): Promise<Generated | null> {
  const [{ describePasswordRules, generatePassword, passwordRulesFor }, { siteRulesFor }] = await load();
  const { source, rules } = passwordRulesFor(field, siteRulesFor(origin));
  const password = generatePassword(rules, (n) => randomInt(n));
  return password === null ? null : { password, rule: describePasswordRules(source, rules) };
}
