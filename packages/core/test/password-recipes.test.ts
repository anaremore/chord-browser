/**
 * Phase 3D's pieces in core (S17): providers' recipes by host (packages/core/src/password-recipes.ts; the agent applies
 * them, apps/desktop/test/forms/recipes.spec.ts), and Apple's sites that take a one-time code typed after the password
 * (password-quirks.ts, passwords.ts; chord-data's compare uses them, packages/data/test/passwords.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { appendsCodeToPassword } from '../src/password-quirks';
import { PASSWORD_RECIPES, recipeFor, recipeHostMatches } from '../src/password-recipes';
import { trimAppendedCode, withAppendedCode } from '../src/passwords';

describe('recipes by host', () => {
  it.each([
    ['accounts.google.com', 'Google'],
    ['ACCOUNTS.GOOGLE.COM.', 'Google'],
    ['login.microsoftonline.com', 'Microsoft'],
    ['login.live.com', 'Microsoft'],
    ['ada.okta.com', 'Okta'],
    ['ada.okta-emea.com', 'Okta'],
    ['dev-ada.us.auth0.com', 'Auth0'],
    // Never the provider's other hosts, a look-alike, or one that only ends like it.
    ['google.com', null],
    ['mail.google.com', null],
    ['accounts.google.com.example', null],
    ['notaccounts.google.com', null],
    ['okta.com', null],
    ['evilokta.com', null],
    ['auth0.com.example', null],
    ['login.microsoftonline.com.example', null],
    ['', null],
  ])('%s → %s', (host, name) => {
    expect(recipeFor(host)?.name ?? null).toBe(name);
  });

  it.each([
    ['*.okta.com', 'a.okta.com', true],
    ['*.okta.com', 'a.b.okta.com', true],
    ['*.okta.com', 'okta.com', false],
    ['*.okta.com', '.okta.com', false],
    ['*.okta.com', 'aokta.com', false],
    ['accounts.google.com', 'accounts.google.com', true],
    ['accounts.google.com', 'x.accounts.google.com', false],
  ])('pattern %s, host %s → %s', (pattern, host, want) => {
    expect(recipeHostMatches(pattern, host)).toBe(want);
  });

  it('every recipe says when it was checked, names lower-case hosts, and has selectors that parse as CSS', () => {
    for (const r of PASSWORD_RECIPES) {
      expect(r.verified, r.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(r.verified)), r.name).toBe(false);
      for (const h of r.hosts) expect(h, r.name).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      // Core has no DOM: a selector a provider's page names is plain enough to check by shape (the agent's rows parse them).
      for (const s of [...(r.username ?? []), ...(r.password ?? []), ...(r.submits ?? [])]) expect(s, r.name).toMatch(/^[\w#.\-[\]="'* :>]+$/);
    }
  });
});

describe('a one-time code typed after the password', () => {
  it.each([
    // Apple's list, by its hosts and their subdomains, down to the registrable domain.
    ['https://usaa.com', true],
    ['https://www.usaa.com', true],
    ['https://auth.redhat.com', true],
    ['https://sso.auth.redhat.com', true],
    // Not a listed host's parent, another site, a look-alike, or no web address.
    ['https://redhat.com', false],
    ['https://www.redhat.com', false],
    ['https://example.com', false],
    ['https://usaa.com.example', false],
    ['https://notusaa.com', false],
    ['file:///usaa.com', false],
    ['not a url', false],
  ])('%s → %s', (origin, want) => {
    expect(appendsCodeToPassword(origin)).toBe(want);
  });

  it.each([
    ['Sekrit-pass', 'Sekrit-pass123456', true],
    ['Sekrit-pass', 'Sekrit-pass1234567', true],
    ['Sekrit-pass', 'Sekrit-pass12345678', true],
    // A saved password that ends in digits of its own.
    ['pass2024', 'pass2024123456', true],
    // 5 or 9 digits, letters, or nothing after it: a new password.
    ['Sekrit-pass', 'Sekrit-pass12345', false],
    ['Sekrit-pass', 'Sekrit-pass123456789', false],
    ['Sekrit-pass', 'Sekrit-pass12345a', false],
    ['Sekrit-pass', 'Sekrit-pass', false],
    ['Sekrit-pass', 'Other-pass123456', false],
    ['', '123456', false],
  ])('saved %s, submitted %s → %s', (saved, submitted, want) => {
    expect(withAppendedCode(saved, submitted)).toBe(want);
  });

  it.each([
    ['Sekrit-pass123456', 'Sekrit-pass'],
    // 7 or 8 trailing digits: the password ends in some of them, the code is 6.
    ['pass1123456', 'pass1'],
    ['pass12123456', 'pass12'],
    // 5 or 9 trailing digits, none, or nothing but the digits: unchanged.
    ['Sekrit-pass12345', 'Sekrit-pass12345'],
    ['Sekrit-pass123456789', 'Sekrit-pass123456789'],
    ['Sekrit-pass', 'Sekrit-pass'],
    ['123456', '123456'],
  ])('a new password %s is saved as %s', (password, want) => {
    expect(trimAppendedCode(password)).toBe(want);
  });
});
