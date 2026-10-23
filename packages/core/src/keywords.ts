/**
 * Site keywords (DESIGN.md §7.3): `yt`, then Tab, searches YouTube instead
 * of the default engine, shown as a chip in the command bar. Short
 * abbreviations also switch on Space, as Chrome's keywords do. Whole words
 * ("maps", "brave") need Tab, so a search that starts with one stays a search.
 */
import { SEARCH_ENGINES } from './input';
import type { SearchEngineId } from './model';

export interface SiteKeyword {
  keyword: string;
  name: string;
  /** The site's search page; the query is appended URL-encoded. Each was checked with a real request. */
  prefix: string;
  /** Pages on the site, as the start of their placeKey: tabs and history there rank with the search. */
  place: string;
  /** Space after the keyword switches too, not only Tab. */
  space: boolean;
  /** When the keyword is a search engine, its suggestions apply. */
  engine?: SearchEngineId;
}

const ENGINE_KEYWORDS: Record<SearchEngineId, { keyword: string; place: string; space: boolean }> = {
  google: { keyword: 'google', place: 'google.com/search', space: false },
  duckduckgo: { keyword: 'ddg', place: 'duckduckgo.com', space: true },
  bing: { keyword: 'bing', place: 'bing.com/search', space: false },
  brave: { keyword: 'brave', place: 'search.brave.com', space: false },
  kagi: { keyword: 'kagi', place: 'kagi.com/search', space: false },
  ecosia: { keyword: 'ecosia', place: 'ecosia.org/search', space: false },
};

export const SITE_KEYWORDS: readonly SiteKeyword[] = [
  { keyword: 'yt', name: 'YouTube', prefix: 'https://www.youtube.com/results?search_query=', place: 'youtube.com', space: true },
  { keyword: 'gh', name: 'GitHub', prefix: 'https://github.com/search?q=', place: 'github.com', space: true },
  { keyword: 'wiki', name: 'Wikipedia', prefix: 'https://en.wikipedia.org/w/index.php?search=', place: 'en.wikipedia.org', space: true },
  { keyword: 'maps', name: 'Google Maps', prefix: 'https://www.google.com/maps/search/', place: 'google.com/maps', space: false },
  { keyword: 'reddit', name: 'Reddit', prefix: 'https://www.reddit.com/search/?q=', place: 'reddit.com', space: false },
  ...SEARCH_ENGINES.map((e) => ({ ...ENGINE_KEYWORDS[e.id], name: e.name, prefix: e.prefix, engine: e.id })),
];

/** The keyword the text is, exactly (any case), if any. */
export function keywordFor(text: string): SiteKeyword | undefined {
  const typed = text.trim().toLowerCase();
  return typed ? SITE_KEYWORDS.find((k) => k.keyword === typed) : undefined;
}

export function keywordSearchUrl(keyword: SiteKeyword, query: string): string {
  return `${keyword.prefix}${encodeURIComponent(query.trim())}`;
}
