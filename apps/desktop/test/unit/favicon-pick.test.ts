/** Which favicon a tab fetches, and how (#115, B1 and M1): an agent's tab never makes Chord send to an address it picks. */
import { describe, expect, it } from 'vitest';
import { loginSite } from '@chord/core/password-sites';
import { pickFavicon } from '../../src/main/favicon-pick';

const PAGE = 'https://shop.test/orders';
const never = (sites: string[]) => (url: string) => sites.some((s) => new URL(url).hostname.endsWith(s));

describe('which favicon is fetched, and how (#115)', () => {
  it('a tab of yours: the first http(s) or data: icon, as before', () => {
    expect(pickFavicon(['chrome://x', 'https://cdn.test/a.png', 'https://shop.test/b.png'], PAGE, { agent: false, never: never([]), site: loginSite })?.url).toBe('https://cdn.test/a.png');
    expect(pickFavicon(['data:image/png;base64,AAAA'], PAGE, { agent: false, never: never([]), site: loginSite })).toEqual({ url: 'data:image/png;base64,AAAA', init: {} });
    expect(pickFavicon(['ftp://x'], PAGE, { agent: false, never: never([]), site: loginSite })).toBeNull();
  });

  it.each([
    ['another site’s icon', 'https://cdn.test/a.png', { credentials: 'omit' }],
    ['the page’s own origin', 'https://shop.test/b.png', { redirect: 'error' }],
    ['another origin of the same site (a subdomain)', 'https://img.shop.test/c.png', { redirect: 'error' }],
    ['the same domain over http, from an https page (another site, schemefully)', 'http://shop.test/d.png', { credentials: 'omit' }],
  ])('a tab of yours, %s (#324): %j', (_, url, init) => {
    expect(pickFavicon([url], PAGE, { agent: false, never: never([]), site: loginSite })).toEqual({ url, init });
  });

  it.each([
    ['https://evil.blogspot.com/', 'https://victim.blogspot.com/i.png'],
    ['https://evil.com.pl/', 'https://bank.com.pl/i.png'],
    ['https://evil.co.id/', 'https://bank.co.id/i.png'],
    ['https://evil.appspot.com/', 'https://victim.appspot.com/i.png'],
    ['https://evil.s3.amazonaws.com/', 'https://victim.s3.amazonaws.com/i.png'],
    ['https://evil.workers.dev/', 'https://victim.workers.dev/i.png'],
  ])('a page on %s naming %s: two sites by the Public Suffix List, private suffixes too (Opus’s B1 on #337): no cookies', (page, url) => {
    expect(pickFavicon([url], page, { agent: false, never: never([]), site: loginSite })).toEqual({ url, init: { credentials: 'omit' } });
  });

  it.each([
    ['https://www.bank.com.pl/', 'https://static.bank.com.pl/i.png'],
    ['https://victim.blogspot.com/', 'https://victim.blogspot.com/i.png'],
  ])('a page on %s naming %s: one site, its cookies (no redirect)', (page, url) => {
    expect(pickFavicon([url], page, { agent: false, never: never([]), site: loginSite })).toEqual({ url, init: { redirect: 'error' } });
  });

  it('a tab of yours on a page that isn’t a web page (#324): an icon with no cookies', () => {
    expect(pickFavicon(['https://shop.test/b.png'], 'file:///C:/notes.html', { agent: false, never: never([]), site: loginSite })).toEqual({ url: 'https://shop.test/b.png', init: { credentials: 'omit' } });
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
