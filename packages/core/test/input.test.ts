import { describe, expect, it } from 'vitest';
import { parseInput, resolveInput, searchUrl } from '../src';

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
