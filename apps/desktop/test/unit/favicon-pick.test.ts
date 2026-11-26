/** Which favicon a tab fetches, and how (#115, B1 and M1): an agent's tab never makes Chord send to an address it picks. */
import { describe, expect, it } from 'vitest';
import { pickFavicon } from '../../src/main/favicon-pick';

const PAGE = 'https://shop.test/orders';
const never = (sites: string[]) => (url: string) => sites.some((s) => new URL(url).hostname.endsWith(s));

describe('which favicon is fetched, and how (#115)', () => {
  it('a tab of yours: the first http(s) or data: icon, as before, with nothing changed in how', () => {
    expect(pickFavicon(['chrome://x', 'https://cdn.test/a.png', 'https://shop.test/b.png'], PAGE, { agent: false, never: never([]) })).toEqual({ url: 'https://cdn.test/a.png', init: {} });
    expect(pickFavicon(['data:image/png;base64,AAAA'], PAGE, { agent: false, never: never([]) })).toEqual({ url: 'data:image/png;base64,AAAA', init: {} });
    expect(pickFavicon(['ftp://x'], PAGE, { agent: false, never: never([]) })).toBeNull();
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
