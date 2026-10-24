/**
 * Where links go (DESIGN.md §7.9, §8.5; ROADMAP Phase 2–3): what counts as
 * "another site" for Peek, and link routes (from Crest) that send a site's
 * links to a chord.
 */
import type { ChordId, LinkRoute, State } from './model';

// Core compiles without DOM types; URL is a global in Node and every browser.
declare const URL: new (url: string) => { protocol: string; hostname: string; pathname: string };

/**
 * Two-part public suffixes common enough to matter, so `a.co.uk` and
 * `b.co.uk` count as different sites. Not the whole Public Suffix List: a
 * miss only means two sites under an unlisted suffix count as one, and a
 * link between them opens in place instead of in Peek.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn',
  'com.mx', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'com.ar', 'co.in', 'net.in', 'org.in', 'co.za', 'co.il', 'com.ua',
  // Hosting where every subdomain is someone else's site.
  'github.io', 'gitlab.io', 'pages.dev', 'netlify.app', 'vercel.app', 'herokuapp.com', 'web.app', 'firebaseapp.com',
]);

/** A web address's host, lowercased; null for anything that isn't http(s). */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The site a host belongs to: its registrable domain (`docs.google.com` → `google.com`), or the host itself for IPs and `localhost`. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const labels = h.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;
}

/** Whether a link leaves the site of the page it's on (Peek's rule). Non-web addresses never count. */
export function isCrossSite(fromUrl: string, toUrl: string): boolean {
  const from = hostOf(fromUrl);
  const to = hostOf(toUrl);
  return from !== null && to !== null && siteOf(from) !== siteOf(to);
}

/**
 * What someone typed as a route's site, as the host Chord matches: no
 * scheme, path, port or `www.`. Null when it isn't a plausible host.
 */
export function routeHost(text: string): string | null {
  let value = text.trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  const host = hostOf(value);
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  const bare = host.replace(/^www\./, '');
  return bare.includes('.') || bare === 'localhost' ? bare : null;
}

/**
 * What someone typed as a route, as Chord keys it: the host (`routeHost`), and
 * the path when one was given, so `github.com/acme/*` covers only that
 * organization's pages. Paths are matched without case, a trailing slash or
 * `*`, query or fragment. Null when it isn't a plausible site.
 */
export function routeKey(text: string): string | null {
  const host = routeHost(text);
  if (!host) return null;
  let value = text.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let path: string;
  try {
    path = new URL(value).pathname.toLowerCase().replace(/\*$/, '').replace(/\/+$/, '');
  } catch {
    return host;
  }
  return path ? `${host}${path}` : host;
}

/**
 * Whether a route (`routeKey`) covers a page at `host` and `path`: the same
 * host, `www.` of it, or a subdomain; and, for a route with a path, that path
 * or one under it (`/acme` covers `/acme/chord`, not `/acmecorp`).
 */
export function routeCovers(route: string, host: string, path = '/'): boolean {
  const slash = route.indexOf('/');
  const routeSite = slash < 0 ? route : route.slice(0, slash);
  const h = host.replace(/^www\./, '');
  if (h !== routeSite && !h.endsWith(`.${routeSite}`)) return false;
  if (slash < 0) return true;
  const prefix = route.slice(slash);
  const p = path.toLowerCase();
  return p === prefix || p.startsWith(`${prefix}/`);
}

/**
 * The chord a link should open in by its route, if any: the most specific
 * route (the longest, so a path's beats its site's) that covers it and points
 * at a chord that still exists (and isn't a private window's).
 */
export function routeFor(state: State, url: string): ChordId | null {
  const host = hostOf(url);
  if (!host) return null;
  const path = new URL(url).pathname;
  let best: LinkRoute | null = null;
  for (const route of Object.values(state.linkRoutes)) {
    const chord = state.chords[route.chordId];
    if (!chord || chord.private || !routeCovers(route.host, host, path)) continue;
    if (!best || route.host.length > best.host.length) best = route;
  }
  return best?.chordId ?? null;
}
