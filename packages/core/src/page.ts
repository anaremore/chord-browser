/** Small pure helpers for page actions (zoom, copy as link) and load-error copy. */

/** Chromium's zoom presets, so ⌘+ / ⌘− land where Chrome users expect. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

/** The next preset above (1) or below (-1) the current factor; stays put at either end. */
export function zoomStep(factor: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > factor + epsilon) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((z) => z < factor - epsilon) ?? ZOOM_LEVELS[0];
}

/** `[title](url)`, with brackets in the title escaped and parentheses in the URL encoded. */
/**
 * Whether a page's `data:` icon is worth showing: an image type with some
 * bytes, under the size limit. Pages use `data:,` to mean "no icon"
 * (example.com does), which would otherwise show as a broken image.
 */
export function usableDataIcon(url: string, maxBytes: number): boolean {
  const match = /^data:(image\/[\w.+-]+)(;[^,]*)?,(.+)$/is.exec(url);
  if (!match) return false;
  const base64 = /;base64/i.test(match[2] ?? '');
  const size = base64 ? Math.floor((match[3]!.length * 3) / 4) : match[3]!.length;
  return size > 0 && size <= maxBytes;
}

export function markdownLink(title: string, url: string): string {
  const text = (title.trim() || url).replace(/([\\[\]])/g, '\\$1');
  const href = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${text}](${href})`;
}

export interface LoadErrorCopy {
  /** `proxy`: the proxy Chord sends pages through failed (the frame offers its settings too). */
  kind: 'offline' | 'not-found' | 'unreachable' | 'insecure' | 'blocked' | 'proxy' | 'failed';
  title: string;
  body: string;
  /** Certificate errors offer a way back, not a retry: retrying an insecure connection doesn't make it safe. */
  action: 'retry' | 'back';
}

/**
 * Friendly copy for a Chromium net error (net/base/net_error_list.h): the
 * frame shows this instead of a blank page. `name` is the ERR_ code, shown
 * small for people who want it.
 */
export function describeLoadError(code: number, host: string): LoadErrorCopy & { name: string } {
  const name = NET_ERROR_NAMES[code] ?? `ERR_${Math.abs(code)}`;
  const site = host || 'This site';
  if (code === -106 || code === -21) {
    return { kind: 'offline', name, title: 'You’re offline.', body: 'Pages you have open will keep working; new ones will load when you’re back.', action: 'retry' };
  }
  if (code === -105 || code === -137) {
    return { kind: 'not-found', name, title: `Can’t find ${site}.`, body: 'Check the address for a typo, or search for it instead.', action: 'retry' };
  }
  // The proxy (ARCHITECTURE.md §9, Proxies): its own failures, never a reason to load the page without it.
  if (code === -130) {
    return { kind: 'proxy', name, title: 'Can’t reach the proxy.', body: 'Chord sends this page through a proxy, and the proxy isn’t answering. Check that it’s running, or change it in Proxy settings.', action: 'retry' };
  }
  if (code === -111 || code === -120 || code === -121 || code === -186) {
    return { kind: 'proxy', name, title: `The proxy couldn’t reach ${host || 'this site'}.`, body: 'The proxy answered, but couldn’t connect to the site. The site may be down, or the proxy may not allow it.', action: 'retry' };
  }
  if (code === -336) {
    return { kind: 'proxy', name, title: 'Chord can’t use this proxy.', body: 'It isn’t a kind of proxy Chord can connect to. Check it in Proxy settings.', action: 'retry' };
  }
  if (code === -131 || code === -327 || code === -367) {
    return {
      kind: 'proxy',
      name,
      title: 'Can’t load the proxy’s configuration file.',
      body: 'Chord finds its proxy in a file it couldn’t load, so it didn’t open the page without one. Check the file’s address in Proxy settings.',
      action: 'retry',
    };
  }
  if (code === -136) {
    return { kind: 'proxy', name, title: 'The proxy’s certificate isn’t valid.', body: 'Someone could be reading or changing what goes through it, so Chord didn’t connect.', action: 'back' };
  }
  if (code === -115 || code === -127 || code === -364) {
    return {
      kind: 'proxy',
      name,
      title: 'The proxy needs you to sign in.',
      body: code !== -115 ? 'Try again, and sign in when the proxy asks.' : 'It asks for a kind of sign-in Chord can’t do. Try another proxy, or ask whoever runs it.',
      action: 'retry',
    };
  }
  if (code <= -200 && code > -300) {
    return {
      kind: 'insecure',
      name,
      title: 'This connection isn’t private.',
      body: `${site} sent a certificate Chord can’t trust, so someone could be reading or changing what you see. Chord didn’t open it.`,
      action: 'back',
    };
  }
  if (code === -20 || code === -27 || code === -301 || code === -312) {
    return { kind: 'blocked', name, title: `${site} was blocked.`, body: 'Something on this computer or network stopped it from loading.', action: 'back' };
  }
  if ([-7, -100, -101, -102, -104, -109, -118, -324].includes(code)) {
    return { kind: 'unreachable', name, title: `${site} can’t be reached.`, body: 'It may be down or slow right now. Trying again in a moment often works.', action: 'retry' };
  }
  return { kind: 'failed', name, title: 'This page didn’t load.', body: 'Something went wrong on the way. Trying again often works.', action: 'retry' };
}

const NET_ERROR_NAMES: Record<number, string> = {
  [-7]: 'ERR_TIMED_OUT',
  [-20]: 'ERR_BLOCKED_BY_CLIENT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-27]: 'ERR_BLOCKED_BY_RESPONSE',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-111]: 'ERR_TUNNEL_CONNECTION_FAILED',
  [-115]: 'ERR_PROXY_AUTH_UNSUPPORTED',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-120]: 'ERR_SOCKS_CONNECTION_FAILED',
  [-121]: 'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  [-127]: 'ERR_PROXY_AUTH_REQUESTED',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-131]: 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  [-136]: 'ERR_PROXY_CERTIFICATE_INVALID',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED',
  [-186]: 'ERR_PROXY_UNABLE_TO_CONNECT_TO_DESTINATION',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-207]: 'ERR_CERT_INVALID',
  [-301]: 'ERR_DISALLOWED_URL_SCHEME',
  [-312]: 'ERR_UNSAFE_PORT',
  [-324]: 'ERR_EMPTY_RESPONSE',
  [-327]: 'ERR_PAC_SCRIPT_FAILED',
  [-336]: 'ERR_NO_SUPPORTED_PROXIES',
  [-364]: 'ERR_PROXY_AUTH_REQUESTED_WITH_NO_CONNECTION',
  [-367]: 'ERR_PAC_SCRIPT_TERMINATED',
};
