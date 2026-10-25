import { describe, expect, it } from 'vitest';
import { makeLock, servicePlaying, SERVICES } from '../src/services.ts';

const lock = makeLock();

describe('the navigation lock (S14 census)', () => {
  it('shows each service’s own pages, sign-in and account pages, over HTTPS', () => {
    const allowed = [
      'https://www.netflix.com/browse',
      'https://www.netflix.com/login',
      'https://open.spotify.com/',
      'https://accounts.spotify.com/en/login',
      'https://challenge.spotify.com/c/abc',
      'https://www.spotify.com/account/overview/',
      'https://www.disneyplus.com/identity/login',
      'https://login.disney.com/',
      'https://www.primevideo.com/',
      'https://www.amazon.com/gp/video/storefront',
      'https://www.amazon.co.uk/ap/signin?openid.return_to=x',
      'https://play.hbomax.com/',
      'https://auth.hbomax.com/login',
      'https://play.max.com/',
      'https://www.hulu.com/welcome',
      'https://auth.hulu.com/web/login',
      'https://music.apple.com/us/browse',
      'https://authorize.music.apple.com/woa',
      'https://idmsa.apple.com/appleauth/auth/signin',
      'https://tv.apple.com/',
      'https://www.peacocktv.com/signin',
      'https://www.paramountplus.com/account/signin/',
      'https://listen.tidal.com/',
      'https://login.tidal.com/authorize',
      'https://tidal.com/',
    ];
    for (const url of allowed) expect(lock.page(url), url).toBe(true);
  });

  it('allows the other sign-ins only for services that offer them, and never as frames', () => {
    expect(lock.page('https://accounts.google.com/o/oauth2/auth')).toBe(true); // Spotify, HBO Max, Tidal
    expect(lock.frame('https://accounts.google.com/o/oauth2/auth')).toBe(false);
    expect(lock.frame('https://www.facebook.com/tr?id=1')).toBe(false);
    const netflixOnly = makeLock(SERVICES.filter((s) => s.name === 'Netflix'));
    expect(netflixOnly.page('https://accounts.google.com/')).toBe(false);
    expect(netflixOnly.page('https://www.facebook.com/login')).toBe(false);
  });

  it('refuses look-alike hosts, other schemes, ports and credentials', () => {
    const refused = [
      'https://netflix.com.evil.example/',
      'https://evilnetflix.com/',
      'https://www.netflix.co/',
      'https://netflix.com@evil.example/',
      'https://user:pass@www.netflix.com/',
      'https://www.netflix.com:8443/',
      'http://www.netflix.com/',
      'https://www.netflix.com./',
      'https://www.nеtflix.com/', // a Cyrillic е: the parser makes it punycode, which matches nothing
      'https://spotify.com/', // the store root, not the player or account pages
      'https://open.spotify.com.example.org/',
      'https://www.amazon.com/', // Amazon's store, outside Prime Video's paths
      'https://www.amazon.com/gp/videos', // a path that only starts like /gp/video
      'https://www.amazon.com.evil.example/gp/video/',
      'https://amazon.com.mx.evil.example/ap/signin',
      'https://example.com/',
      'https://127.0.0.1/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chord://settings',
      'not a url',
      '',
    ];
    for (const url of refused) expect(lock.page(url), url).toBe(false);
  });

  it('lets pages embed captchas and Disney’s account frame, and blocks ad and tracking frames', () => {
    for (const url of ['https://www.google.com/recaptcha/api2/anchor?k=x', 'https://challenges.cloudflare.com/turnstile/v0', 'https://newassets.hcaptcha.com/captcha/v1', 'https://geo.captcha-delivery.com/captcha/', 'https://login.disney.com/frame', 'about:blank', 'about:srcdoc', 'https://www.netflix.com/frame']) {
      expect(lock.frame(url), url).toBe(true);
    }
    for (const url of ['https://www.google.com/maps', 'https://googleads.g.doubleclick.net/pagead', 'https://tr.snapchat.com/', 'https://match.adsrvr.org/', 'https://www.google.com/recaptchas', 'http://www.google.com/recaptcha/api2/anchor']) {
      expect(lock.frame(url), url).toBe(false);
    }
  });

  it('names the service a page belongs to', () => {
    expect(lock.service('https://accounts.spotify.com/login')?.name).toBe('Spotify');
    expect(lock.service('https://www.amazon.de/gp/video/detail/x')?.name).toBe('Prime Video');
    expect(lock.service('https://accounts.google.com/')).toBeNull();
  });

  it('relaxes only the scheme and port for tests, never the hosts', () => {
    const test = makeLock(SERVICES, { allowHttp: true });
    expect(test.page('http://www.netflix.com:41234/watch')).toBe(true);
    expect(test.page('http://127.0.0.1:41234/watch')).toBe(false);
    expect(test.page('http://evilnetflix.com:80/')).toBe(false);
  });
});

describe('where the DRM notice shows', () => {
  it('recognizes the pages that play, by address', () => {
    expect(servicePlaying('https://www.netflix.com/watch/1')?.name).toBe('Netflix');
    expect(servicePlaying('http://www.netflix.com:8080/watch')?.name).toBe('Netflix');
    expect(servicePlaying('https://open.spotify.com/track/1')?.name).toBe('Spotify');
    expect(servicePlaying('https://www.amazon.com/gp/video/detail/1')?.name).toBe('Prime Video');
    expect(servicePlaying('https://listen.tidal.com/album/1')?.name).toBe('Tidal');
  });

  it('leaves the services’ other pages alone', () => {
    expect(servicePlaying('https://www.spotify.com/us/premium/')).toBeNull();
    expect(servicePlaying('https://accounts.spotify.com/login')).toBeNull();
    expect(servicePlaying('https://tidal.com/')).toBeNull();
    expect(servicePlaying('https://www.amazon.com/dp/B0')).toBeNull();
    expect(servicePlaying('ftp://www.netflix.com/')).toBeNull();
  });
});
