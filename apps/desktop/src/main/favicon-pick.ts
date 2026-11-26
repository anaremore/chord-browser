/**
 * Which favicon a tab fetches, and how (#115, B1 and M1). A tab of yours: the first http(s) or data: icon its page
 * names, as ever. An agent's tab: Chord's own fetch is outside the hold (sends.ts), so an icon address the page picks
 * would be a send no card asks about, with the agent session's cookies, possibly to a Never site. So only a data: icon,
 * or one of the page's own origin (the first such, never shadowed by another origin's named before it), fetched with
 * no credentials and no redirect (a redirect would go wherever the page's server says), and none at all on a Never
 * site.
 */
export type FaviconFetch = { url: string; init: { credentials?: 'omit'; redirect?: 'error' } };

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export function pickFavicon(favicons: readonly string[], page: string, tab: { agent: boolean; never: (url: string) => boolean }): FaviconFetch | null {
  if (!tab.agent) {
    const url = favicons.find((u) => /^(https?|data):/i.test(u));
    return url ? { url, init: {} } : null;
  }
  if (tab.never(page)) return null;
  const own = originOf(page);
  for (const url of favicons) {
    if (/^data:/i.test(url)) return { url, init: {} };
    if (/^https?:/i.test(url) && own !== null && own !== 'null' && originOf(url) === own) return { url, init: { credentials: 'omit', redirect: 'error' } };
  }
  return null;
}
