/**
 * The control channel's messages (ARCHITECTURE.md §9, Chord Player): what
 * Chord and Chord Player say to each other once the handshake is done
 * (channel.ts), and the checks each side runs on what it hears. Neither side
 * trusts the other's bytes: the player runs a weeks-older engine on
 * third-party pages, and Chord's answers come over a pipe.
 *
 * Versioning: both sides say which protocol version they speak in the
 * handshake. Chord accepts players from PROTOCOL_MIN to PROTOCOL; a newer
 * Chord can tell an older player by `peer.protocol` and send it only what that
 * version knows, and asks for an update below PROTOCOL_MIN. Within a version,
 * an unknown message type is ignored (a request gets `unknown` back) and
 * unknown fields are dropped, so additions don't need a new version.
 *
 * Chord → player:
 * - `open {url}` (request): show this page (a service's, or the player refuses) and come to the front.
 * - `focus` (request): come to the front.
 * - `play`, `pause` (requests); `mute {muted}` (request).
 * - `theme {appearance, vars}`: the chord's colors for the bar.
 * - `close` (request): quit.
 * - `debug`, `test {do}` (requests, tests only; refused unless launched for tests).
 *
 * Player → Chord:
 * - `status {cdm}`: Widevine's state (`installing`, `ready`, `failed`).
 * - `media {…}`: what plays (MediaReport), when it changes; `artwork {data}` when the picture changes.
 * - `link {url, why}`: a page or popup the lock refused, for Chord to open.
 * - `back`: the bar's Back to Chord.
 * - `bye {why}`: the player is quitting (the window closed).
 */

/** The protocol version this code speaks. */
export const PROTOCOL = 1;
/** The oldest player protocol Chord accepts. */
export const PROTOCOL_MIN = 1;

const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** An http(s) address no longer than `max`, or null. */
export function parseUrl(value: unknown, max = 8192): string | null {
  if (!isString(value, max)) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** What plays in the player, for Chord's Now playing card (DESIGN.md §7.10). */
export interface MediaReport {
  /** The service whose page it is ("Netflix"). */
  service: string;
  /** From the page's Media Session; empty when it gives none. */
  title: string;
  artist: string;
  album: string;
  /** The page's title, for when the Media Session says nothing. */
  page: string;
  playing: boolean;
  muted: boolean;
  /** Something can be played or paused from outside (a media element in the page). */
  pausable: boolean;
}

export function parseMedia(value: unknown): MediaReport | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['playing'] !== 'boolean' || typeof v['muted'] !== 'boolean') return null;
  return {
    service: text(v['service'], 60),
    title: text(v['title']),
    artist: text(v['artist']),
    album: text(v['album']),
    page: text(v['page']),
    playing: v['playing'],
    muted: v['muted'],
    pausable: v['pausable'] === true,
  };
}

/** Artwork: a small image as a data URL (PNG, JPEG, WebP, GIF or AVIF; never SVG), at most this many characters. */
export const MAX_ARTWORK_CHARS = 360_000;
const ARTWORK = /^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function parseArtwork(value: unknown): string | null {
  return isString(value, MAX_ARTWORK_CHARS) && ARTWORK.test(value) ? value : null;
}

/**
 * The chord's colors for the player's bar: CSS custom properties from
 * Chord's theme (DESIGN.md §5). Only the names below, and only values made of
 * color functions, numbers and gradients: never `url(`, `image(`, `var(`,
 * quotes, semicolons or braces, so nothing can load or escape its property.
 */
export const THEME_VARS = [
  '--color-base',
  '--color-tint',
  '--color-fg',
  '--color-fg-muted',
  '--color-item-hover',
  '--color-item-active-bg',
  '--color-divider',
  '--color-accent',
  '--color-accent-fg',
  '--color-focus-ring',
] as const;
export type ThemeVar = (typeof THEME_VARS)[number];

export interface Theme {
  appearance: 'light' | 'dark';
  vars: Partial<Record<ThemeVar, string>>;
}

const SAFE_CSS_VALUE = /^[a-z0-9 .,%()#/+-]*$/i;

export function parseTheme(value: unknown): Theme | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const appearance = v['appearance'];
  if (appearance !== 'light' && appearance !== 'dark') return null;
  const raw = v['vars'];
  if (!raw || typeof raw !== 'object') return null;
  const vars: Theme['vars'] = {};
  for (const name of THEME_VARS) {
    const css = (raw as Record<string, unknown>)[name];
    if (!isString(css, 600) || !SAFE_CSS_VALUE.test(css) || /url|image|var|expression|attr/i.test(css)) continue;
    vars[name] = css;
  }
  return { appearance, vars };
}

/** Why a page went to Chord. */
export type LinkReason = 'navigation' | 'redirect' | 'popup' | 'download' | 'external';

export function parseLink(value: unknown): { url: string; why: LinkReason } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const url = parseUrl(v['url']);
  const why = v['why'];
  const reasons: LinkReason[] = ['navigation', 'redirect', 'popup', 'download', 'external'];
  return url && typeof why === 'string' && (reasons as string[]).includes(why) ? { url, why: why as LinkReason } : null;
}

/**
 * At most `limit` events in `windowMs`: links handed to Chord, so a page in
 * the player can't open tabs in Chord by the hundred. Both sides keep it.
 */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now): () => boolean {
  const times: number[] = [];
  return () => {
    const t = now();
    while (times.length && t - times[0]! > windowMs) times.shift();
    if (times.length >= limit) return false;
    times.push(t);
    return true;
  };
}

export type CdmState = 'installing' | 'ready' | 'failed';

export function parseStatus(value: unknown): { cdm: CdmState } | null {
  const cdm = value && typeof value === 'object' ? (value as Record<string, unknown>)['cdm'] : undefined;
  return cdm === 'installing' || cdm === 'ready' || cdm === 'failed' ? { cdm } : null;
}
