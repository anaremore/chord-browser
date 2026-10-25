// The navigation lock: which pages the Widevine player may show. Only
// documents are locked (top-level navigations, popups and frames), because
// only a document runs code of its own origin in the player's old engine.
// Subresources (CDNs, APIs, licence servers) load freely: they run, if at all,
// inside a service's own page, as that page chose.
//
// Hosts match themselves and their subdomains. Anything else is handed to
// Chord. Revised from the census (census/main.mjs) and the services' docs;
// see docs/decisions/S14-widevine-player.md, "Navigation lock".

const AMAZON = ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.in', 'amazon.com.br', 'amazon.com.mx'];

/** Sign-in with another account, offered by several services: allowed as popups and pages, never as a start. */
export const IDENTITY = {
  google: ['accounts.google.com'],
  apple: ['appleid.apple.com', 'idmsa.apple.com'],
  facebook: ['www.facebook.com', 'm.facebook.com'],
};

/** Frames sign-in and checkout pages embed: captchas, bot checks and card fields. */
export const FRAMES = [
  'www.google.com/recaptcha', 'recaptcha.google.com/recaptcha', 'www.recaptcha.net', 'challenges.cloudflare.com',
  'hcaptcha.com', 'arkoselabs.com', 'funcaptcha.com', 'captcha-delivery.com',
  // Disney's account frame (MyDisney), on Disney+ and Hulu sign-in.
  'login.disney.com', 'registerdisney.go.com',
];

/**
 * Per service: `start` is what Chord opens; `pages` are the hosts its own pages, sign-in and
 * account pages live on; `paths` limits a host to some paths; `identity` the other sign-ins it offers.
 */
export const SERVICES = [
  { name: 'Netflix', start: 'https://www.netflix.com/', pages: ['netflix.com'], identity: [] },
  { name: 'Spotify', start: 'https://open.spotify.com/', pages: ['open.spotify.com', 'accounts.spotify.com', 'challenge.spotify.com', 'www.spotify.com'], identity: ['google', 'apple', 'facebook'] },
  { name: 'Disney+', start: 'https://www.disneyplus.com/', pages: ['disneyplus.com', 'login.disney.com'], identity: [] },
  { name: 'Prime Video', start: 'https://www.primevideo.com/', pages: ['primevideo.com'], identity: [] },
  { name: 'Prime Video', start: null, pages: AMAZON, paths: ['/gp/video', '/ap/'], identity: [] },
  { name: 'HBO Max', start: 'https://play.hbomax.com/', pages: ['hbomax.com', 'max.com'], identity: ['google', 'apple'] },
  { name: 'Hulu', start: 'https://www.hulu.com/', pages: ['hulu.com', 'login.disney.com', 'disneyplus.com'], identity: [] },
  { name: 'Apple Music', start: 'https://music.apple.com/', pages: ['music.apple.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com'], identity: [] },
  { name: 'Apple TV', start: 'https://tv.apple.com/', pages: ['tv.apple.com', 'idmsa.apple.com', 'appleid.apple.com'], identity: [] },
  { name: 'Peacock', start: 'https://www.peacocktv.com/', pages: ['peacocktv.com'], identity: [] },
  { name: 'Paramount+', start: 'https://www.paramountplus.com/', pages: ['paramountplus.com'], identity: [] },
  { name: 'Tidal', start: 'https://listen.tidal.com/', pages: ['tidal.com'], identity: ['google', 'apple', 'facebook'] },
];

const matches = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** The service a page belongs to, if any (https only). */
export function serviceFor(url, services = SERVICES) {
  const u = parse(url);
  if (!u) return null;
  const onPath = (p) => u.pathname === p.replace(/\/$/, '') || u.pathname.startsWith(p.endsWith('/') ? p : `${p}/`);
  return services.find((s) => matches(u.hostname, s.pages) && (!s.paths || s.paths.some(onPath))) ?? null;
}

/**
 * A lock for a set of services. `page(url)`: may the player show it as a page or popup?
 * `frame(url)`: may a page embed it? Everything else goes to Chord.
 */
export function makeLock(services = SERVICES, frames = FRAMES) {
  const identity = [...new Set(services.flatMap((s) => s.identity ?? []).flatMap((id) => IDENTITY[id] ?? []))];
  const page = (url) => {
    if (serviceFor(url, services)) return true;
    const u = parse(url);
    return Boolean(u && matches(u.hostname, identity));
  };
  // Frames: a service's own pages and the shared frames above. Not the other sign-ins, which are
  // popups; on a service's page their hosts are tracking pixels (the census saw facebook.com on Netflix and Hulu).
  const frame = (url) => {
    if (url === 'about:blank' || url.startsWith('about:srcdoc') || url.startsWith('blob:') || url.startsWith('data:')) return true;
    if (serviceFor(url, services)) return true;
    const u = parse(url);
    if (!u) return false;
    return frames.some((f) => {
      const [host, ...path] = f.split('/');
      return matches(u.hostname, [host]) && (!path.length || u.pathname.startsWith(`/${path.join('/')}`));
    });
  };
  return { page, frame };
}

/** A lock for tests: these hosts, http allowed (the local test server). */
export function testLock(pages, frames = []) {
  const host = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };
  return {
    page: (url) => pages.includes(host(url)),
    frame: (url) => url === 'about:blank' || pages.includes(host(url)) || frames.includes(host(url)),
  };
}
