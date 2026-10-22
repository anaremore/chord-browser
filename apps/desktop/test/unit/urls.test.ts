import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { originOf, resolveChordUrl } from '../../src/main/urls';

const root = resolve('/app/out/renderer');

describe('resolveChordUrl', () => {
  it('maps a surface root to its index.html', () => {
    expect(resolveChordUrl('chord://shell/', root)).toBe(resolve(root, 'shell', 'index.html'));
    expect(resolveChordUrl('chord://shell/index.html', root)).toBe(resolve(root, 'shell', 'index.html'));
  });

  it('maps shared assets to the renderer root', () => {
    expect(resolveChordUrl('chord://shell/assets/shell-abc.js', root)).toBe(resolve(root, 'assets', 'shell-abc.js'));
  });

  it.each([
    'chord://shell/../../main/index.js',
    'chord://shell/%2e%2e/%2e%2e/main/index.js',
    'chord://shell/..%2f..%2fmain%2findex.js',
    'chord://shell/%2e%2e%5c%2e%2e%5cmain%5cindex.js',
    'chord://shell/assets/%00.js',
    'chord://shell/%E0%A4%A',
    'chord://she.ll/',
    'https://shell/index.html',
    'file:///etc/passwd',
    'not a url',
  ])('never escapes the renderer root for %s', (url) => {
    // Dot segments may normalize to a harmless path inside the root; the
    // invariant is that nothing outside it is ever reachable.
    const file = resolveChordUrl(url, root);
    expect(file === null || file.startsWith(root + sep)).toBe(true);
  });
});

describe('originOf', () => {
  it('builds origins for custom schemes, which Node reports as "null"', () => {
    expect(originOf('chord://shell/index.html')).toBe('chord://shell');
    expect(originOf('http://localhost:5173/shell/index.html')).toBe('http://localhost:5173');
    expect(originOf('nope')).toBeNull();
  });
});
