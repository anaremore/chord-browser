/*
 * The data is Apple's password-manager-resources, MIT.
 * Copyright (c) 2019 - 2026 Apple Inc. (LICENSES/MIT-Apple-password-manager-resources.txt).
 */

/**
 * Apple's lists of sites' quirks (S17 §6, §9), vendored at
 * apple/password-manager-resources@410bea26abe112dc3fe161a35e936e824316afdb (main, 2026-11-17), unchanged, in
 * `vendor/apple-password-manager-resources` (its README says how to update):
 *
 * - `password-rules.json`: a site's password rules, for the generator when the field has none of its own;
 * - `change-password-URLs.json`: where a site changes a password, for Settings → Passwords.
 *
 * About 125 KB together, so this is a subpath of core (`@chord/core/password-quirks`) that main imports the first time
 * it needs one, never at launch and never in a renderer (performance rule 1).
 *
 * A host is looked up as itself, then each parent domain down to two labels (`login.example.co.uk`,
 * `example.co.uk`, `co.uk`): the lists name sites by host or registrable domain, never a public suffix.
 */
import changeUrls from '../vendor/apple-password-manager-resources/change-password-URLs.json';
import rules from '../vendor/apple-password-manager-resources/password-rules.json';

/** Core has no DOM or Node types: the WHATWG URL, as main and chord-data have it (as in password-sites.ts). */
declare const URL: new (url: string, base?: string) => { protocol: string; hostname: string; href: string };

const RULES = rules as Record<string, { 'password-rules'?: string }>;
const CHANGE_URLS = changeUrls as Record<string, string>;

/** The host and its parents, longest first, down to two labels. */
function hostsOf(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

const hostOf = (origin: string): string | null => {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : null;
  } catch {
    return null;
  }
};

const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Apple's password rules for a page's origin, or null when its list has none. */
export function siteRulesFor(origin: string): string | null {
  const host = hostOf(origin);
  if (!host) return null;
  for (const h of hostsOf(host)) {
    const entry = own(RULES, h)?.['password-rules'];
    if (typeof entry === 'string') return entry;
  }
  return null;
}

/**
 * Where a sign-in's password is changed (S17 §9, *Change password on the site*): Apple's address for its site when
 * the list has one, else the site's `/.well-known/change-password` (W3C's draft), which a site that supports it
 * redirects to its own page. `https` only (the owner's design 6A): null for any other address, an `http` site's too.
 */
export function changePasswordUrlFor(origin: string): string | null {
  const host = hostOf(origin);
  if (!host || !/^https:/i.test(origin)) return null;
  for (const h of hostsOf(host)) {
    const listed = own(CHANGE_URLS, h);
    if (typeof listed === 'string' && /^https:\/\//.test(listed)) return listed;
  }
  try {
    return new URL('/.well-known/change-password', origin).href;
  } catch {
    return null;
  }
}
