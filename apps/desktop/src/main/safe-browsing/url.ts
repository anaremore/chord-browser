/**
 * Safe Browsing's address rules (developers.google.com/safe-browsing/v4/urls-hashing,
 * which v5 keeps): canonicalize an address, then expand it into the host-suffix /
 * path-prefix expressions whose SHA-256 prefixes Google's lists hold. Pure (no
 * Electron), so it's unit-tested against Google's published vectors.
 *
 * Bytes, not characters: an address is unescaped to its bytes and escaped
 * again, so a character the vectors write as `\x80` is the byte 0x80.
 */
import { domainToASCII } from 'node:url';

export interface CanonicalUrl {
  scheme: string;
  /** Lowercase, escaped; an IPv4 address as four decimal numbers. */
  host: string;
  /** Starts with `/`, with `.` and `..` resolved and runs of `/` collapsed. */
  path: string;
  /** Without the `?`; null when there was no `?` at all (an empty one is kept). */
  query: string | null;
}

/** The canonical form as one string, as Google's vectors write it. */
export const canonicalString = (c: CanonicalUrl): string => `${c.scheme}://${c.host}${c.path}${c.query === null ? '' : `?${c.query}`}`;

const PERCENT = 0x25;

/** Characters under 256 are one byte each (that's how the vectors are written); anything else is its UTF-8. */
function toBytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x100) out.push(code);
    else out.push(...new TextEncoder().encode(ch));
  }
  return out;
}

const hexValue = (b: number | undefined): number => {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  return -1;
};

function unescapeOnce(bytes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const hi = bytes[i] === PERCENT ? hexValue(bytes[i + 1]) : -1;
    const lo = hi >= 0 ? hexValue(bytes[i + 2]) : -1;
    if (lo >= 0) {
      out.push(hi * 16 + lo);
      i += 2;
    } else {
      out.push(bytes[i]!);
    }
  }
  return out;
}

/** "Repeatedly percent-unescape … until it has no more percent-escapes." Each pass that changes anything shortens it. */
function unescapeFully(bytes: readonly number[]): number[] {
  let current = [...bytes];
  for (;;) {
    const next = unescapeOnce(current);
    if (next.length === current.length) return next;
    current = next;
  }
}

/** Escape what's ≤ 0x20, ≥ 0x7f, `#` or `%`, in uppercase hex. */
function escapeBytes(bytes: readonly number[]): string {
  let out = '';
  for (const b of bytes) {
    out += b <= 0x20 || b >= 0x7f || b === 0x23 || b === PERCENT ? `%${b.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(b);
  }
  return out;
}

/** Bytes back to one character each, in chunks (an address can be longer than an argument list may be). */
function latin1(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.slice(i, i + 8192));
  return out;
}

/** inet_aton's forms: 1–4 parts, each decimal, octal (leading 0) or hex (0x); the last fills the bytes left. */
export function parseIPv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (/^0[xX][0-9a-fA-F]*$/.test(part)) numbers.push(part.length === 2 ? 0 : parseInt(part.slice(2), 16));
    else if (/^0[0-7]*$/.test(part)) numbers.push(parseInt(part, 8));
    else if (/^[1-9][0-9]*$/.test(part)) numbers.push(parseInt(part, 10));
    else return null;
  }
  const last = numbers.pop()!;
  if (numbers.some((n) => n > 255)) return null;
  const left = 4 - numbers.length;
  if (!Number.isSafeInteger(last) || last >= 256 ** left) return null;
  const bytes = [...numbers];
  for (let i = left - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes.join('.');
}

const isDottedQuad = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function canonicalHost(raw: string): string | null {
  let host = latin1(unescapeFully(toBytes(raw)));
  host = host.replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.');
  if (!host) return null;
  const ip = parseIPv4(host);
  if (ip) return ip;
  host = host.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  // An internationalized name goes to Punycode (Chromium hands Chord Punycode already). Its bytes are
  // read as UTF-8 when they are; a name that still isn't a valid domain is escaped byte by byte below.
  if ([...host].some((ch) => ch.charCodeAt(0) > 0x7f)) {
    let decoded = host;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(toBytes(host)));
    } catch {
      // Not UTF-8: each byte is the character it stands for.
    }
    const ascii = domainToASCII(decoded);
    if (ascii) host = ascii;
  }
  return escapeBytes(toBytes(host));
}

function canonicalPath(raw: string): string {
  const segments = latin1(unescapeFully(toBytes(raw))).split('/');
  const kept: string[] = [];
  let trailing = false;
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '' || segment === '.' || segment === '..') {
      if (segment === '..') kept.pop();
      if (last) trailing = true;
      return;
    }
    kept.push(segment);
  });
  const path = kept.length === 0 ? '/' : `/${kept.join('/')}${trailing ? '/' : ''}`;
  return escapeBytes(toBytes(path));
}

/** Leading and trailing spaces and control characters go, as a browser's address parser drops them. */
function trimControls(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

/**
 * Google's canonical form of an address, or null when it has no host.
 * Tabs, CR and LF go; then surrounding spaces and the fragment; a missing
 * scheme is `http`; user info and port are dropped. Host, path and query are
 * each unescaped until nothing changes and escaped again.
 */
export function canonicalize(input: string): CanonicalUrl | null {
  let url = trimControls(input.replace(/[\t\r\n]/g, ''));
  const fragment = url.indexOf('#');
  if (fragment >= 0) url = url.slice(0, fragment);
  let scheme = 'http';
  const withScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  if (withScheme) {
    scheme = withScheme[1]!.toLowerCase();
    url = url.slice(withScheme[0].length);
  } else if (url.startsWith('//')) {
    url = url.slice(2);
  }
  let end = url.search(/[/?]/);
  if (end < 0) end = url.length;
  let authority = url.slice(0, end);
  const rest = url.slice(end);
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  authority = authority.replace(/:\d*$/, '');
  const q = rest.indexOf('?');
  const rawPath = q >= 0 ? rest.slice(0, q) : rest;
  const rawQuery = q >= 0 ? rest.slice(q + 1) : null;
  const host = canonicalHost(authority);
  if (!host) return null;
  return {
    scheme,
    host,
    path: canonicalPath(rawPath || '/'),
    query: rawQuery === null ? null : escapeBytes(unescapeFully(toBytes(rawQuery))),
  };
}

/** The exact host, then up to four suffixes from its last five labels, longest first; never the top-level domain alone, nor an IP's. */
export function hostSuffixes(host: string): string[] {
  if (isDottedQuad(host) || host.startsWith('[')) return [host];
  const labels = host.split('.');
  const out = [host];
  for (let i = Math.max(1, labels.length - 5); i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return [...new Set(out)];
}

/** The exact path with its query, then without, then `/` and up to three more directories below it. */
export function pathPrefixes(path: string, query: string | null): string[] {
  const out: string[] = [];
  if (query !== null) out.push(`${path}?${query}`);
  out.push(path);
  let prefix = '/';
  out.push(prefix);
  for (const dir of path.split('/').slice(1, -1).slice(0, 3)) {
    prefix += `${dir}/`;
    out.push(prefix);
  }
  return [...new Set(out)];
}

/** Every host-suffix × path-prefix expression (at most 30), in Google's order. */
export function expressionsFor(c: CanonicalUrl): string[] {
  const out = new Set<string>();
  const paths = pathPrefixes(c.path, c.query);
  for (const host of hostSuffixes(c.host)) for (const path of paths) out.add(host + path);
  return [...out];
}

/** The expressions to look up for an address, or none for one that isn't a web page. */
export function urlExpressions(url: string): string[] {
  if (!/^https?:\/\//i.test(url)) return [];
  const c = canonicalize(url);
  return c ? expressionsFor(c) : [];
}
