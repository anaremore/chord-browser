/** Which favicon a tab fetches, and how (#115, B1 and M1): an agent's tab never makes Chord send to an address it picks. */
import { describe, expect, it } from 'vitest';
import { pickFavicon } from '../../src/main/favicon-pick';

const PAGE = 'https://shop.test/orders';
const never = (sites: string[]) => (url: string) => sites.some((s) => new URL(url).hostname.endsWith(s));

describe('which favicon is fetched, and how (#115)', () => {
  it('a tab of yours: the first http(s) or data: icon, as before', () => {
    expect(pickFavicon(['chrome://x', 'https://cdn.test/a.png', 'https://shop.test/b.png'], PAGE, { agent: false, never: never([]) })?.url).toBe('https://cdn.test/a.png');
    expect(pickFavicon(['data:image/png;base64,AAAA'], PAGE, { agent: false, never: never([]) })).toEqual({ url: 'data:image/png;base64,AAAA', init: {} });
    expect(pickFavicon(['ftp://x'], PAGE, { agent: false, never: never([]) })).toBeNull();
  });

  it.each([
    ['another site’s icon', 'https://cdn.test/a.png', { credentials: 'omit' }],
    ['the page’s own origin', 'https://shop.test/b.png', { redirect: 'error' }],
    ['another origin of the same site (a subdomain)', 'https://img.shop.test/c.png', { redirect: 'error' }],
    ['the same domain over http, from an https page (another site, schemefully)', 'http://shop.test/d.png', { credentials: 'omit' }],
  ])('a tab of yours, %s (#324): %j', (_, url, init) => {
    expect(pickFavicon([url], PAGE, { agent: false, never: never([]) })).toEqual({ url, init });
  });

  it('a tab of yours on a page that isn’t a web page (#324): an icon with no cookies', () => {
    expect(pickFavicon(['https://shop.test/b.png'], 'file:///C:/notes.html', { agent: false, never: never([]) })).toEqual({ url: 'https://shop.test/b.png', init: { credentials: 'omit' } });
  });

  it('an agent’s tab: the first data: or own-origin icon (another origin’s never shadows it), sent with no credentials and no redirect', () => {
    const agent = { agent: true, never: never([]) };
    expect(pickFavicon(['https://cdn.test/a.png', 'https://shop.test/b.png'], PAGE, agent)).toEqual({ url: 'https://shop.test/b.png', init: { credentials: 'omit', redirect: 'error' } });
    expect(pickFavicon(['http://localhost:9/x.png'], PAGE, agent)).toBeNull();
    // Another origin of the same site (a subdomain) is another origin.
    expect(pickFavicon(['https://img.shop.test/c.png'], PAGE, agent)).toBeNull();
    expect(pickFavicon(['https://cdn.test/a.png', 'data:image/png;base64,AAAA'], PAGE, agent)).toEqual({ url: 'data:image/png;base64,AAAA', init: {} });
  });

  it('an agent’s tab on a Never site: no icon fetched at all', () => {
    expect(pickFavicon(['https://shop.test/b.png'], PAGE, { agent: true, never: never(['shop.test']) })).toBeNull();
  });
});
