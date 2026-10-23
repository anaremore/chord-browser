/** Display helpers for page addresses. */

/** Hosts already worked out: a list of tabs asks for the same few again on every redraw, and parsing a URL isn't free. */
const hosts = new Map<string, string>();
const MAX_HOSTS = 1000;

/** `https://www.example.com/a` → `example.com`. */
export function displayHost(url: string): string {
  let host = hosts.get(url);
  if (host !== undefined) return host;
  try {
    host = new URL(url).hostname;
    if (host.startsWith('www.')) host = host.slice(4);
  } catch {
    host = '';
  }
  if (hosts.size >= MAX_HOSTS) hosts.clear();
  hosts.set(url, host);
  return host;
}

/**
 * Stable hue per site for fallback favicons (DESIGN.md §7.4). Uses the host
 * minus `www.`; registrable-domain grouping arrives with the public suffix list.
 */
export function siteHue(host: string): number {
  let hash = 2166136261;
  for (let i = 0; i < host.length; i++) {
    hash ^= host.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

const IP_OR_EMPTY = /^[\d.:[\]]*$/;

/** The monogram letter: the site name's initial, or the title's for IP addresses and blank pages. */
export function monogram(host: string, title: string): string {
  const source = IP_OR_EMPTY.test(host) ? title : host.split('.')[0] || title;
  return (source.trim()[0] ?? '•').toUpperCase();
}

/**
 * The title worth showing: a custom title, else the page title, unless that is
 * just the address (Chromium titles untitled pages with their URL).
 */
export function pageTitle(tab: { url: string; title: string; customTitle: string | null }): string {
  if (tab.customTitle) return tab.customTitle;
  const title = tab.title.trim();
  if (!title || title === tab.url || /^[a-z][a-z0-9+.-]*:\/\//i.test(title)) return '';
  return title;
}
