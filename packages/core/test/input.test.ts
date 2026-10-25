import { describe, expect, it } from 'vitest';
import { SEARCH_ENGINES, SITE_KEYWORDS, imageSearchFor, keywordFor, keywordSearchUrl, parseInput, parseSuggestions, resolveInput, searchUrl, suggestUrl } from '../src';

describe('parseInput', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['docs.example.co.uk/path?q=1', 'https://docs.example.co.uk/path?q=1'],
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com', 'http://example.com'],
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['192.168.1.10', 'http://192.168.1.10'],
    ['10.0.0.2:8080/admin', 'http://10.0.0.2:8080/admin'],
    ['8.8.8.8', 'https://8.8.8.8'],
    ['printer.local', 'http://printer.local'],
    ['chord://settings', 'chord://settings'],
    ['mailto:hi@example.com', 'mailto:hi@example.com'],
    ['about:blank', 'about:blank'],
  ])('treats %s as an address', (input, url) => {
    expect(parseInput(input)).toEqual({ kind: 'url', url });
  });

  it.each(['what is a chord', 'pasta al limone', '3.14', 'hello', 'javascript:alert(1)', 'file:///etc/passwd', 'https://', 'node.js tutorial'])(
    'treats %s as a search',
    (input) => {
      expect(parseInput(input)?.kind).toBe('search');
    },
  );

  it('ignores empty input', () => {
    expect(parseInput('   ')).toBeNull();
    expect(resolveInput('')).toBeNull();
  });

  it('searches Google by default', () => {
    expect(resolveInput('chord browser')).toBe('https://www.google.com/search?q=chord%20browser');
    expect(searchUrl('a&b')).toBe('https://www.google.com/search?q=a%26b');
    expect(resolveInput('chord browser', 'duckduckgo')).toBe('https://duckduckgo.com/?q=chord%20browser');
    expect(searchUrl('x', 'kagi')).toBe('https://kagi.com/search?q=x');
  });
});

describe('search suggestions', () => {
  it('asks the chosen engine for searches, never for addresses', () => {
    expect(suggestUrl('chord browser', 'duckduckgo')).toBe('https://duckduckgo.com/ac/?type=list&q=chord%20browser');
    expect(suggestUrl('kagi', 'kagi')).toBe('https://kagi.com/api/autosuggest?q=kagi');
    expect(suggestUrl('example.com/some/page')).toBeNull();
    expect(suggestUrl('localhost:3000')).toBeNull();
    expect(suggestUrl('   ')).toBeNull();
    expect(suggestUrl('x'.repeat(201))).toBeNull();
  });

  it('every engine has an endpoint', () => {
    for (const engine of SEARCH_ENGINES) expect(engine.suggest).toMatch(/^https:\/\/.+[?&](q|query)=$/);
  });

  it('reads OpenSearch replies: text only, distinct, without the query, at most five', () => {
    const reply = ['chord', ['chord', 'Chordify', 'chordify', 42, ' chord  energy ', 'chords', 'chord finder', 'chord chart', 'more'], [], {}];
    expect(parseSuggestions(reply, 'Chord')).toEqual(['Chordify', 'chord energy', 'chords', 'chord finder', 'chord chart']);
    expect(parseSuggestions({ not: 'an array' }, 'x')).toEqual([]);
    expect(parseSuggestions(['x'], 'x')).toEqual([]);
  });
});

describe('site keywords', () => {
  it('finds a keyword typed exactly, in any case', () => {
    expect(keywordFor('yt')?.name).toBe('YouTube');
    expect(keywordFor(' GH ')?.name).toBe('GitHub');
    expect(keywordFor('ddg')).toMatchObject({ name: 'DuckDuckGo', engine: 'duckduckgo', space: true });
    expect(keywordFor('ytt')).toBeUndefined();
    expect(keywordFor('')).toBeUndefined();
  });

  it('only abbreviations switch on Space; words need Tab', () => {
    expect(keywordFor('yt')?.space).toBe(true);
    expect(keywordFor('maps')?.space).toBe(false);
    expect(keywordFor('brave')?.space).toBe(false);
  });

  it('builds the site search', () => {
    expect(keywordSearchUrl(keywordFor('yt')!, ' lofi beats ')).toBe('https://www.youtube.com/results?search_query=lofi%20beats');
    expect(keywordSearchUrl(keywordFor('maps')!, 'coffee')).toBe('https://www.google.com/maps/search/coffee');
  });

  it('keywords are unique', () => {
    const words = SITE_KEYWORDS.map((k) => k.keyword);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe('imageSearchFor', () => {
  it.each([
    ['google', false, 'google', 'Google Lens'],
    ['bing', false, 'bing', 'Bing'],
    // Engines without image search: Google Lens, named on its row.
    ['duckduckgo', false, 'google', 'Google Lens'],
    ['brave', false, 'google', 'Google Lens'],
    ['kagi', false, 'google', 'Google Lens'],
    ['ecosia', false, 'google', 'Google Lens'],
    // Google-free mode never sends it to Google.
    ['google', true, 'bing', 'Bing'],
    ['duckduckgo', true, 'bing', 'Bing'],
  ] as const)('%s (Google-free %s) → %s', (engine, googleFree, expected, label) => {
    expect(imageSearchFor(engine, googleFree)).toEqual({ engine: expected, label });
  });
});
