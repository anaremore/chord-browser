/**
 * What did the user type into the address bar: an address or a search?
 * Rules learned the hard way by other browsers (and Crest's bug list):
 * local and private-network hosts keep http, custom schemes stay addresses,
 * script-like schemes are never navigated to, and anything with a space is a search.
 */

import type { SearchEngineId } from './model';

export type ParsedInput = { kind: 'url'; url: string } | { kind: 'search'; query: string };

/** Typed URLs with these schemes are searched instead of opened. */
const BLOCKED_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:', 'file:']);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const m = IPV4.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** `example.com`, `localhost:3000/x`, `192.168.1.10`, `xn--…` hosts, with optional port and path. */
function hostOf(text: string): string | null {
  const authority = text.split(/[/?#]/)[0]!;
  const host = authority.replace(/:\d{1,5}$/, '');
  if (host === 'localhost' || IPV4.test(host)) return host;
  return /^([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/i.test(host) ? host.toLowerCase() : null;
}

export function parseInput(raw: string): ParsedInput | null {
  const text = raw.trim();
  if (!text) return null;
  if (/\s/.test(text)) return { kind: 'search', query: text };

  const host = hostOf(text);
  if (host) return { kind: 'url', url: `${isPrivateHost(host) ? 'http' : 'https'}://${text}` };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme) {
    if (BLOCKED_SCHEMES.has(`${scheme}:`)) return { kind: 'search', query: text };
    if ((scheme === 'http' || scheme === 'https') && !/^https?:\/\/[^/\s]/i.test(text)) return { kind: 'search', query: text };
    return { kind: 'url', url: text };
  }
  return { kind: 'search', query: text };
}

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /** The results page; the query is appended URL-encoded. */
  prefix: string;
  /**
   * Its OpenSearch suggestion endpoint, the query appended URL-encoded. Each
   * was checked with a real request through Chromium's network stack; it
   * answers `["text", ["suggestion", …]]`.
   */
  suggest: string;
}

/** Google is the default (decided 2026-10-22). Order is the order Settings lists them. */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'google', name: 'Google', prefix: 'https://www.google.com/search?q=', suggest: 'https://www.google.com/complete/search?client=firefox&q=' },
  { id: 'duckduckgo', name: 'DuckDuckGo', prefix: 'https://duckduckgo.com/?q=', suggest: 'https://duckduckgo.com/ac/?type=list&q=' },
  { id: 'bing', name: 'Bing', prefix: 'https://www.bing.com/search?q=', suggest: 'https://www.bing.com/osjson.aspx?query=' },
  { id: 'brave', name: 'Brave Search', prefix: 'https://search.brave.com/search?q=', suggest: 'https://search.brave.com/api/suggest?q=' },
  { id: 'kagi', name: 'Kagi', prefix: 'https://kagi.com/search?q=', suggest: 'https://kagi.com/api/autosuggest?q=' },
  { id: 'ecosia', name: 'Ecosia', prefix: 'https://www.ecosia.org/search?q=', suggest: 'https://ac.ecosia.org/autocomplete?type=list&q=' },
];

export const searchEngine = (id: SearchEngineId): SearchEngine => SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!;

export function searchUrl(query: string, engine: SearchEngineId = 'google'): string {
  return `${searchEngine(engine).prefix}${encodeURIComponent(query)}`;
}

/** How many suggestions the command bar shows. */
export const MAX_SUGGESTIONS = 5;

/** Where to ask an engine for suggestions; null for an address, which never leaves Chord. */
export function suggestUrl(query: string, engine: SearchEngineId = 'google'): string | null {
  const text = query.trim();
  if (!text || text.length > 200 || parseInput(text)?.kind !== 'search') return null;
  return `${searchEngine(engine).suggest}${encodeURIComponent(text)}`;
}

/** Suggestions from an OpenSearch reply (`["text", ["a", "b"], …]`): text only, distinct, not the query itself. */
export function parseSuggestions(reply: unknown, query: string): string[] {
  if (!Array.isArray(reply) || !Array.isArray(reply[1])) return [];
  const typed = query.trim().toLocaleLowerCase();
  const out: string[] = [];
  for (const item of reply[1] as unknown[]) {
    if (typeof item !== 'string') continue;
    const text = item.trim().replace(/\s+/g, ' ').slice(0, 200);
    const folded = text.toLocaleLowerCase();
    if (!text || folded === typed || out.some((s) => s.toLocaleLowerCase() === folded)) continue;
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** The URL to open for typed input, or null for empty input. */
export function resolveInput(raw: string, engine: SearchEngineId = 'google'): string | null {
  const parsed = parseInput(raw);
  if (!parsed) return null;
  return parsed.kind === 'url' ? parsed.url : searchUrl(parsed.query, engine);
}
