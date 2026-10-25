/**
 * The streaming services that need Widevine (ARCHITECTURE.md §16, D4), and
 * the navigation lock that keeps Chord Player to them (spike S14,
 * docs/decisions/S14-widevine-player.md §3).
 *
 * One list for both sides. Chord's DRM notice recognizes a service by the
 * pages that play (`plays`: Spotify's player, not its store). Chord Player may
 * show a service's own pages, its sign-in and account pages (`pages`, from
 * S14's census), and the other sign-ins it offers (`identity`), as pages and
 * popups. Everything else it hands to Chord.
 *
 * Only documents are locked: top-level pages, popups and frames. Subresources
 * (CDNs, APIs, licence servers, media) load freely: they run, if at all,
 * inside a service's own page, as that page chose. Locking them would mean
 * tracking every CDN.
 *
 * A host matches itself and its subdomains (`www.netflix.com` matches
 * `netflix.com`; `netflix.com.evil.example` and `evilnetflix.com` don't), over
 * HTTPS on the default port, without a username or password in the address.
 * Pure: no Electron, no DOM.
 */

export type IdentityId = 'google' | 'apple' | 'facebook';

/** Hosts (and their subdomains), optionally only some paths on them. */
export interface HostRule {
  hosts: readonly string[];
  /** Path prefixes, matched whole: `/gp/video` covers `/gp/video` and `/gp/video/…`, not `/gp/videos`. */
  paths?: readonly string[];
}

export interface Service {
  name: string;
  /** Where Chord Player starts when it's opened for the service without a page. */
  start: string;
  /** The pages that play: where Chord's DRM notice appears. */
  plays: readonly HostRule[];
  /** The service's own pages, sign-in and account pages: what Chord Player may show. */
  pages: readonly HostRule[];
  /** Other accounts the service lets you sign in with (popups and pages, never frames). */
  identity: readonly IdentityId[];
}

const AMAZON = ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.in', 'amazon.com.br', 'amazon.com.mx'];

/** Sign-in with another account, offered by several services. */
export const IDENTITY: Record<IdentityId, readonly string[]> = {
  google: ['accounts.google.com'],
  apple: ['appleid.apple.com', 'idmsa.apple.com'],
  facebook: ['www.facebook.com', 'm.facebook.com'],
};

/**
 * Frames sign-in and checkout pages embed, for every service: captchas, bot
 * checks, and Disney's account frame (MyDisney, on Disney+ and Hulu). A path
 * after the host limits it to that path (reCAPTCHA, not all of www.google.com).
 */
export const FRAMES = [
  'www.google.com/recaptcha',
  'recaptcha.google.com/recaptcha',
  'www.recaptcha.net',
  'challenges.cloudflare.com',
  'hcaptcha.com',
  'arkoselabs.com',
  'funcaptcha.com',
  'captcha-delivery.com',
  'login.disney.com',
  'registerdisney.go.com',
] as const;

/** The services, from S14's census (2026-10-25). */
export const SERVICES: readonly Service[] = [
  { name: 'Netflix', start: 'https://www.netflix.com/', plays: [{ hosts: ['netflix.com'] }], pages: [{ hosts: ['netflix.com'] }], identity: [] },
  {
    name: 'Spotify',
    start: 'https://open.spotify.com/',
    plays: [{ hosts: ['open.spotify.com'] }],
    pages: [{ hosts: ['open.spotify.com', 'accounts.spotify.com', 'challenge.spotify.com', 'www.spotify.com'] }],
    identity: ['google', 'apple', 'facebook'],
  },
  { name: 'Disney+', start: 'https://www.disneyplus.com/', plays: [{ hosts: ['disneyplus.com'] }], pages: [{ hosts: ['disneyplus.com', 'login.disney.com'] }], identity: [] },
  {
    name: 'Prime Video',
    start: 'https://www.primevideo.com/',
    plays: [{ hosts: ['primevideo.com'] }, { hosts: AMAZON, paths: ['/gp/video'] }],
    // Amazon's own stores: Prime Video's pages and Amazon's sign-in (/ap/), nothing else of the store.
    pages: [{ hosts: ['primevideo.com'] }, { hosts: AMAZON, paths: ['/gp/video', '/ap'] }],
    identity: [],
  },
  { name: 'HBO Max', start: 'https://play.hbomax.com/', plays: [{ hosts: ['hbomax.com', 'max.com'] }], pages: [{ hosts: ['hbomax.com', 'max.com'] }], identity: ['google', 'apple'] },
  { name: 'Hulu', start: 'https://www.hulu.com/', plays: [{ hosts: ['hulu.com'] }], pages: [{ hosts: ['hulu.com', 'login.disney.com', 'disneyplus.com'] }], identity: [] },
  {
    name: 'Apple Music',
    start: 'https://music.apple.com/',
    plays: [{ hosts: ['music.apple.com'] }],
    pages: [{ hosts: ['music.apple.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com'] }],
    identity: [],
  },
  { name: 'Apple TV', start: 'https://tv.apple.com/', plays: [{ hosts: ['tv.apple.com'] }], pages: [{ hosts: ['tv.apple.com', 'idmsa.apple.com', 'appleid.apple.com'] }], identity: [] },
  { name: 'Peacock', start: 'https://www.peacocktv.com/', plays: [{ hosts: ['peacocktv.com'] }], pages: [{ hosts: ['peacocktv.com'] }], identity: [] },
  { name: 'Paramount+', start: 'https://www.paramountplus.com/', plays: [{ hosts: ['paramountplus.com'] }], pages: [{ hosts: ['paramountplus.com'] }], identity: [] },
  // Logged out, listen.tidal.com goes to tidal.com; sign-in is login.tidal.com.
  { name: 'Tidal', start: 'https://listen.tidal.com/', plays: [{ hosts: ['listen.tidal.com'] }], pages: [{ hosts: ['tidal.com'] }], identity: ['google', 'apple', 'facebook'] },
];

/** Whether `host` is one of `hosts` or a subdomain of one. */
export function hostMatches(host: string, hosts: readonly string[]): boolean {
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function pathMatches(path: string, paths: readonly string[] | undefined): boolean {
  if (!paths) return true;
  const lower = path.toLowerCase();
  return paths.some((p) => lower === p || lower.startsWith(`${p}/`));
}

const ruleMatches = (u: URL, rules: readonly HostRule[]) => rules.some((r) => hostMatches(u.hostname, r.hosts) && pathMatches(u.pathname, r.paths));

function parse(url: string): URL | null {
  if (typeof url !== 'string' || url.length > 8192) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The service whose playing pages these are, by address (http or https, any
 * port): where Chord's DRM notice shows. Null for anything else.
 */
export function servicePlaying(url: string, services: readonly Service[] = SERVICES): Service | null {
  const u = parse(url);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  return services.find((s) => ruleMatches(u, s.plays)) ?? null;
}

export interface LockOptions {
  /**
   * Tests only: plain HTTP and any port for the same hosts (a local test
   * server standing in for a service). Chord sends it only from a
   * development build that a test asked for it (ARCHITECTURE.md §9, Chord Player).
   */
  allowHttp?: boolean;
}

/** An address the lock may consider at all: HTTPS on the default port, no credentials (or the test relaxation). */
function lockable(url: string, options: LockOptions): URL | null {
  const u = parse(url);
  if (!u || u.username || u.password) return null;
  if (u.protocol === 'https:' && u.port === '') return u;
  if (options.allowHttp && (u.protocol === 'http:' || u.protocol === 'https:')) return u;
  return null;
}

export interface Lock {
  /** The service a page belongs to (its own pages, sign-in and account pages), if any. */
  service(url: string): Service | null;
  /** May the player show this as a page or a popup? */
  page(url: string): boolean;
  /** May a page embed this as a frame? */
  frame(url: string): boolean;
}

/** The lock for a set of services. Everything it refuses goes to Chord. */
export function makeLock(services: readonly Service[] = SERVICES, options: LockOptions = {}): Lock {
  const identity = [...new Set(services.flatMap((s) => s.identity).flatMap((id) => IDENTITY[id]))];
  const service = (url: string) => {
    const u = lockable(url, options);
    return u ? (services.find((s) => ruleMatches(u, s.pages)) ?? null) : null;
  };
  const page = (url: string) => {
    if (service(url)) return true;
    const u = lockable(url, options);
    return Boolean(u && hostMatches(u.hostname, identity));
  };
  // Frames: a service's own pages and the shared frames above. Not the other sign-ins, which are popups:
  // on a service's page their hosts are tracking pixels (the census saw facebook.com on Netflix and Hulu).
  const frame = (url: string) => {
    if (url === 'about:blank' || url.startsWith('about:srcdoc') || url.startsWith('blob:') || url.startsWith('data:')) return true;
    if (service(url)) return true;
    const u = lockable(url, options);
    if (!u) return false;
    return FRAMES.some((f) => {
      const [host, ...path] = f.split('/');
      return hostMatches(u.hostname, [host!]) && pathMatches(u.pathname, path.length ? [`/${path.join('/')}`] : undefined);
    });
  };
  return { service, page, frame };
}
