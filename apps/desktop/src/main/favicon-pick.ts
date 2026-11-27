/**
 * Which favicon a tab fetches, and how (#115, B1 and M1). A tab of yours: the first http(s) or data: icon its page
 * names, as ever, but another site's is fetched without cookies (#324: a page could name any site's address as its icon
 * and have Chord send that site its cookies, `SameSite=Strict` ones too, which Chrome's own favicon fetch never sends).
 * Its own site's keeps them, with no redirect: one that redirects (even within its site) is fetched again without
 * cookies (tabs.ts' loadFavicon), so a same-site address can't send on to another site with that site's cookies.
 * (Electron's session.fetch has no manual redirect to follow a hop at a time: `redirect: 'manual'` throws.) An agent's tab: Chord's own fetch is
 * outside the hold (sends.ts), so an icon address the page picks would be a send no card asks about, with the agent
 * session's cookies, possibly to a Never site. So only a data: icon, or one of the page's own origin (the first such,
 * never shadowed by another origin's named before it), fetched with no credentials and no redirect (a redirect would go
 * wherever the page's server says), and none at all on a Never site.
 */
import { hostOf, siteOf } from '@chord/core';

export type FaviconFetch = { url: string; init: { credentials?: 'omit'; redirect?: 'error' } };

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** Whether `url` is the page's own site, schemefully (http and https of one domain are two sites, as for cookies). */
function sameSite(page: string, url: string): boolean {
  const from = hostOf(page);
  const to = hostOf(url);
  if (from === null || to === null) return false;
  return new URL(page).protocol === new URL(url).protocol && siteOf(from) === siteOf(to);
}

export function pickFavicon(favicons: readonly string[], page: string, tab: { agent: boolean; never: (url: string) => boolean }): FaviconFetch | null {
  if (!tab.agent) {
    const url = favicons.find((u) => /^(https?|data):/i.test(u));
    if (!url) return null;
    if (/^data:/i.test(url)) return { url, init: {} };
    // Its own site's: its cookies, as today, but no redirect (fetched again without them). Any other: none (#324).
    return { url, init: sameSite(page, url) ? { redirect: 'error' } : { credentials: 'omit' } };
  }
  if (tab.never(page)) return null;
  const own = originOf(page);
  for (const url of favicons) {
    if (/^data:/i.test(url)) return { url, init: {} };
    if (/^https?:/i.test(url) && own !== null && own !== 'null' && originOf(url) === own) return { url, init: { credentials: 'omit', redirect: 'error' } };
  }
  return null;
}
