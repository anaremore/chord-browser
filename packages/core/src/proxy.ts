/**
 * Proxies (ARCHITECTURE.md §9, *Proxies*): one for every chord, in Settings,
 * and a chord's own. Electron sets a proxy per session, and chords that share
 * sign-ins share a session, so only a chord that keeps its own sign-ins can
 * have a proxy of its own. Pure: what a typed proxy may be, the config
 * Electron's `session.setProxy` takes, and which proxy a profile's session uses.
 */
import { DEFAULT_PROFILE, type ProfileId, type State } from './model';

// Core compiles without DOM types; URL is a global in Node and every browser.
declare const URL: new (url: string) => { protocol: string; host: string; hostname: string; port: string; pathname: string; href: string };

/** The system's proxy (Electron's default, untouched), none at all, a proxy server, or an automatic configuration (PAC) file. */
export type ProxyMode = 'system' | 'none' | 'server' | 'pac';
/**
 * The proxies Chord offers. SOCKS5 sends sites' names to the proxy, which
 * looks them up; Chromium's SOCKS4 looks them up on this computer first, so
 * it isn't offered.
 */
export const PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

export interface ProxyServer {
  scheme: ProxyScheme;
  /** A host name, an IPv4 address, or an IPv6 one in brackets, as `proxyHost` gives it. */
  host: string;
  port: number;
  /** Addresses that skip the proxy, as Chromium reads them (`*.example.com`, `10.0.0.0/8`, `<local>`). */
  bypass: string[];
}

/**
 * A proxy, for every chord or a chord's own. The server and the file's
 * address are kept while another mode is chosen, so choosing theirs again
 * finds them; the mode that uses one always has it.
 */
export type ProxySettings =
  | { mode: 'system' | 'none'; server: ProxyServer | null; pac: string | null }
  | { mode: 'server'; server: ProxyServer; pac: string | null }
  | { mode: 'pac'; server: ProxyServer | null; pac: string };

/** What `session.setProxy` takes (Electron's ProxyConfig, for the modes Chord uses). */
export interface ProxyConfig {
  mode: 'system' | 'direct' | 'fixed_servers' | 'pac_script';
  proxyRules?: string;
  proxyBypassRules?: string;
  pacScript?: string;
}

/** What every Electron session starts with: the system's proxy. */
export const DEFAULT_PROXY_CONFIG: ProxyConfig = { mode: 'system' };

/** At most this many addresses skip a proxy. */
export const MAX_PROXY_BYPASS = 100;
const MAX_HOST = 253;
const MAX_PAC = 8192;

/** Four octets, none with a leading zero (Chromium would read `010` as octal). */
const IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const LABELS = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const isIpv4 = (text: string): boolean => {
  const m = IPV4.exec(text);
  return Boolean(m && m.slice(1).every((octet) => Number(octet) <= 255));
};

/** An IPv6 address, with or without its brackets, as `[…]`; null when it isn't one. */
function ipv6(text: string): string | null {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (!bare.includes(':') || !/^[0-9a-f:.]+$/i.test(bare)) return null;
  try {
    const host = new URL(`http://[${bare}]/`).hostname;
    return host.startsWith('[') ? host : null;
  } catch {
    return null;
  }
}

/**
 * A typed host as Chromium will read it: lower case, an IPv6 address in
 * brackets, an international name in punycode. Null when it isn't a host
 * (a port, a path, a password or a scheme with it, or anything a URL can't hold).
 */
export function proxyHost(text: string): string | null {
  const host = text.trim();
  if (!host || host.length > MAX_HOST || /[\s/?#@\\]/.test(host)) return null;
  if (host.includes(':')) return ipv6(host);
  // Dotted numbers are an IPv4 address or nothing: a URL would read "10.1" as 10.0.0.1.
  if (/^[\d.]+$/.test(host)) return isIpv4(host) ? host : null;
  try {
    const url = new URL(`http://${host}/`);
    if (url.port || url.pathname !== '/') return null;
    return LABELS.test(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}

/** A typed port, 1 to 65535; null otherwise. */
export function proxyPort(text: string | number): number | null {
  const value = typeof text === 'number' ? text : /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/** The automatic configuration file's address, if Chromium can fetch one from it (http, https, file; data for a script itself). */
export function proxyPac(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > MAX_PAC) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return value;
    if (url.protocol === 'file:' || ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname)) return url.href;
    return null;
  } catch {
    return null;
  }
}

/**
 * One address that skips the proxy, as Chromium's bypass rules take it:
 * `<local>` (names without a dot), a host pattern with `*` wildcards and maybe
 * a scheme and a port (`*.example.com`, `https://intranet:8443`), or a range
 * of IP addresses (`10.0.0.0/8`, `[fd00::]/8`).
 */
export function bypassRule(text: string): string | null {
  let rule = text.trim().toLowerCase();
  if (!rule || rule.length > MAX_HOST) return null;
  if (rule === '<local>' || rule === '<-loopback>') return rule;
  const cidr = /^(.+)\/(\d{1,3})$/.exec(rule);
  if (cidr) {
    const [, address, bits] = cidr as unknown as [string, string, string];
    if (isIpv4(address) && Number(bits) <= 32) return rule;
    // Chromium reads an IPv6 range without brackets: fd00::/8.
    const v6 = ipv6(address);
    return v6 && Number(bits) <= 128 ? `${v6.slice(1, -1)}/${bits}` : null;
  }
  const scheme = SCHEME.exec(rule)?.[0] ?? '';
  rule = rule.slice(scheme.length);
  const port = /:(\d{1,5})$/.exec(rule);
  if (port && !rule.endsWith(']')) {
    if (!proxyPort(port[1]!)) return null;
    rule = rule.slice(0, port.index);
  }
  const host = rule.startsWith('[') ? ipv6(rule) : /^[a-z0-9*._-]+$/.test(rule) && /[a-z0-9*]/.test(rule) ? rule : null;
  return host ? `${scheme}${host}${port ? `:${port[1]}` : ''}` : null;
}

/** The addresses typed in one field, split on commas, semicolons and spaces, as Chromium splits them; repeats dropped. */
export function splitBypass(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((rule) => rule.trim()).filter(Boolean))];
}

/* ---------- In Chord's words: what's wrong with what was typed (null when nothing is) ---------- */

export function proxyHostProblem(text: string): string | null {
  const host = text.trim();
  if (!host) return 'Enter the proxy’s address.';
  if (/^socks4a?:\/\//i.test(host)) return 'Chord connects to SOCKS proxies with SOCKS5, so the proxy looks up the sites’ names. Choose SOCKS5 above.';
  if (SCHEME.test(host)) return 'Just the address, without http:// or socks5://. Choose the type above.';
  if (host.includes('@')) return 'Just the address. Chord never keeps a proxy’s password: if the proxy asks for one, Chord asks you.';
  if (/^[^:\s[\]]+:\d+$/.test(host) || /^\[[^\]]+\]:\d+$/.test(host)) return 'Put the port in the box beside it.';
  return proxyHost(host) ? null : 'That isn’t an address Chord can use. Try a name like proxy.example or an address like 10.0.0.2.';
}

export function proxyPortProblem(text: string): string | null {
  if (!text.trim()) return 'Enter the port.';
  return proxyPort(text) === null ? 'A port is a whole number from 1 to 65535.' : null;
}

export function proxyBypassProblem(text: string): string | null {
  const rules = splitBypass(text);
  if (rules.length > MAX_PROXY_BYPASS) return `At most ${MAX_PROXY_BYPASS} addresses.`;
  const bad = rules.find((rule) => !bypassRule(rule));
  return bad ? `Chord can’t read “${bad}”. Use names like *.example.com, addresses like 10.0.0.0/8, or <local>.` : null;
}

export function proxyPacProblem(text: string): string | null {
  if (!text.trim()) return 'Enter the file’s address.';
  return proxyPac(text) ? null : 'Enter the file’s full address, starting with http://, https:// or file://.';
}

/**
 * A proxy's address pasted in one piece (`socks5://10.0.0.2:1080`,
 * `proxy.example:3128`), split into the form's fields. Null when it isn't
 * one, or carries a password (Chord keeps none).
 */
export function splitProxyAddress(text: string): { scheme?: ProxyScheme; host: string; port?: number } | null {
  const m = /^(?:(https?|socks5h?|socks):\/\/)?([^/@\s]+?)\/?$/i.exec(text.trim());
  if (!m) return null;
  const named = m[1]?.toLowerCase();
  const scheme: ProxyScheme | undefined = !named ? undefined : named.startsWith('socks') ? 'socks5' : (named as ProxyScheme);
  const hostPort = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(m[2]!);
  const host = hostPort ? proxyHost(hostPort[1]!) : proxyHost(m[2]!);
  if (!host) return null;
  const port = hostPort?.[2] ? proxyPort(hostPort[2]) : null;
  if (hostPort?.[2] && port === null) return null;
  return { ...(scheme ? { scheme } : {}), host, ...(port ? { port } : {}) };
}

/* ---------- The setting itself ---------- */

function cleanServer(value: unknown): ProxyServer | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const scheme = PROXY_SCHEMES.find((x) => x === s['scheme']);
  const host = typeof s['host'] === 'string' ? proxyHost(s['host']) : null;
  const port = typeof s['port'] === 'number' ? proxyPort(s['port']) : null;
  if (!scheme || !host || !port) return null;
  const rules = Array.isArray(s['bypass']) ? s['bypass'].filter((r): r is string => typeof r === 'string') : [];
  const bypass = [...new Set(rules.map(bypassRule).filter((r): r is string => r !== null))].slice(0, MAX_PROXY_BYPASS);
  return { scheme, host, port, bypass };
}

/**
 * A proxy that can be used, from anything saved or sent: hosts and addresses
 * in Chromium's form, unreadable bypass rules dropped. Null when it can't be
 * (an unknown mode, or the server or file its mode needs missing or unreadable).
 */
export function cleanProxy(value: unknown): ProxySettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const server = v['server'] === null || v['server'] === undefined ? null : cleanServer(v['server']);
  const pac = typeof v['pac'] === 'string' ? proxyPac(v['pac']) : null;
  switch (v['mode']) {
    case 'system':
    case 'none':
      return { mode: v['mode'], server, pac };
    case 'server':
      return server ? { mode: 'server', server, pac } : null;
    case 'pac':
      return pac ? { mode: 'pac', server, pac } : null;
    default:
      return null;
  }
}

export function sameProxy(a: ProxySettings | null | undefined, b: ProxySettings | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Pages go through a proxy Chord set (a server, or a configuration file): WebRTC then sends nothing past it. */
export const proxied = (proxy: ProxySettings): boolean => proxy.mode === 'server' || proxy.mode === 'pac';

const hostPort = (server: ProxyServer): string => `${server.host}:${server.port}`;

/** What `session.setProxy` takes. A PAC file Chromium can't load fails the page rather than going direct (Electron sets it mandatory). */
export function proxyConfig(proxy: ProxySettings): ProxyConfig {
  switch (proxy.mode) {
    case 'system':
      return { ...DEFAULT_PROXY_CONFIG };
    case 'none':
      return { mode: 'direct' };
    case 'server':
      return { mode: 'fixed_servers', proxyRules: `${proxy.server.scheme}://${hostPort(proxy.server)}`, proxyBypassRules: proxy.server.bypass.join(',') };
    case 'pac':
      return { mode: 'pac_script', pacScript: proxy.pac };
  }
}

const SCHEME_NAMES: Record<ProxyScheme, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' };

/** A proxy in a few words, for Settings' rows and the chord menu: "SOCKS5 proxy at 10.0.0.2:1080". */
export function proxyLabel(proxy: ProxySettings): string {
  switch (proxy.mode) {
    case 'system':
      return 'The system’s proxy';
    case 'none':
      return 'No proxy';
    case 'server':
      return `${SCHEME_NAMES[proxy.server.scheme]} proxy at ${hostPort(proxy.server)}`;
    case 'pac': {
      const url = new URL(proxy.pac);
      const from = url.protocol === 'file:' ? 'a file on this computer' : url.protocol === 'data:' ? 'a script' : url.host;
      return `Automatic configuration from ${from}`;
    }
  }
}

/**
 * The proxy a session uses. A profile's (`profileId`): its chord's own, if
 * that chord keeps its own sign-ins and has one; otherwise, and for Chord's
 * own sessions (null), the proxy for every chord. Private windows' profiles
 * have no chord with a proxy, so they use the one for every chord.
 */
export function proxyFor(state: Pick<State, 'settings' | 'chords'>, profileId: ProfileId | null): ProxySettings {
  if (profileId && profileId !== DEFAULT_PROFILE) {
    for (const chord of Object.values(state.chords)) if (chord.profileId === profileId && chord.proxy && !chord.private) return chord.proxy;
  }
  return state.settings.proxy;
}
