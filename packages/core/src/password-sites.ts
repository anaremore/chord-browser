/**
 * Which saved sign-ins a page may be offered (docs/decisions/S17-passwords.md
 * §5). A subpath of its own (`@chord/core/password-sites`), never re-exported
 * from core's index: it carries the Public Suffix List (through `tldts`),
 * which main and chord-data need and no renderer does.
 *
 * A sign-in has an origin (scheme, host, port) and a site: its registrable
 * domain with private suffixes on, so `a.github.io` and `b.github.io` are
 * different sites, as in Chromium. An IP address, `localhost` or a
 * single-label host is its own site, with its port when it isn't the default.
 */
import { parse } from 'tldts';
import type { LoginSummary } from './passwords';

declare const URL: new (url: string) => { protocol: string; host: string; hostname: string; port: string; origin: string; username: string; password: string };

/** A page's or a sign-in's origin, for `http:` and `https:` only: `https://github.com`, `http://10.0.0.1:8080`. Null for anything else. */
export function loginOrigin(url: string): string | null {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.origin;
}

/** The site a sign-in's tag is made from: `github.com` for `https://login.github.com`, `10.0.0.1:8080` for an address. Null for what can't be saved. */
export function loginSite(origin: string): string | null {
  const clean = loginOrigin(origin);
  if (!clean) return null;
  const { port } = new URL(clean);
  // One site however it's written: a fully qualified name's trailing dot goes (`bank.example.`, `localhost.`).
  const hostname = new URL(clean).hostname.replace(/\.+$/, '');
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const result = parse(host, { allowPrivateDomains: true });
  if (result.domain && !result.isIp) return result.domain;
  return port ? `${hostname}:${port}` : hostname;
}

/**
 * How a saved sign-in matches the page (S17 §5's table):
 * - `origin`: the same origin, listed first (on `http`, with *This page isn't secure*);
 * - `upgrade`: saved on `http` for the same host, the page on `https` (Firefox's `schemeUpgrades`);
 * - `site`: the same site on another host or port, both on `https`, listed below with its host;
 * - null: never offered, but through *Other passwords…* (phase 1 has none) and its question.
 * A page on `http` is never offered what was saved on `https`.
 */
export type LoginMatch = 'origin' | 'upgrade' | 'site';

export function matchLogin(pageOrigin: string, savedOrigin: string): LoginMatch | null {
  const page = loginOrigin(pageOrigin);
  const saved = loginOrigin(savedOrigin);
  if (!page || !saved) return null;
  if (page === saved) return 'origin';
  const p = new URL(page);
  const s = new URL(saved);
  if (p.protocol === 'http:') return null;
  if (s.protocol === 'http:') return p.hostname === s.hostname && p.port === s.port ? 'upgrade' : null;
  const site = loginSite(page);
  return site !== null && site === loginSite(saved) ? 'site' : null;
}

/** Whether a page's origin is plain HTTP off this computer: the menu says *This page isn't secure*. */
export function insecureOrigin(origin: string): boolean {
  const clean = loginOrigin(origin);
  if (!clean) return true;
  const { protocol, hostname } = new URL(clean);
  return protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]';
}

/** An account the menu under the field may list: a username and where it's from, never a password. */
export interface LoginOffer {
  id: string;
  username: string;
  /** The saved sign-in's host, shown under the username when it isn't the page's (`gist.github.com`). */
  host: string;
  match: LoginMatch;
}

/**
 * The sign-ins a page is offered, in the menu's order: the page's own origin
 * (and `http` ones it upgrades) first, then the rest of its site. Within each,
 * the ones the asking chord used, most recent first (S17 §7, *One vault,
 * every chord*), then the rest by when this computer last used them, then by
 * username.
 */
export function offersFor(pageOrigin: string, logins: readonly LoginSummary[]): LoginOffer[] {
  const pageHost = loginOrigin(pageOrigin) ? new URL(pageOrigin).host : '';
  const matched: { login: LoginSummary; match: LoginMatch }[] = [];
  for (const login of logins) {
    const match = matchLogin(pageOrigin, login.origin);
    if (match) matched.push({ login, match });
  }
  const tier = (m: LoginMatch) => (m === 'site' ? 1 : 0);
  matched.sort(
    (a, b) =>
      tier(a.match) - tier(b.match) ||
      (b.login.chordUsed ?? -1) - (a.login.chordUsed ?? -1) ||
      (b.login.lastUsed ?? -1) - (a.login.lastUsed ?? -1) ||
      a.login.username.localeCompare(b.login.username) ||
      a.login.id.localeCompare(b.login.id),
  );
  return matched.map(({ login, match }) => {
    const host = new URL(login.origin).host;
    return { id: login.id, username: login.username, host: host === pageHost ? '' : host, match };
  });
}
