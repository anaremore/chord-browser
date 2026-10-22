/** Pure URL helpers for main (no Electron imports, so they're unit-testable). */
import { resolve, sep } from 'node:path';

export const CHORD_SCHEME = 'chord';

/** `chord://shell/x` → `chord://shell`. Node gives non-special schemes a "null" origin, so build it ourselves. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Maps a `chord://` URL to a file inside `root`, or null if it would escape it.
 * `chord://shell/` → root/shell/index.html; `chord://shell/assets/x.js` →
 * root/assets/x.js (Vite emits shared assets at the root).
 */
export function resolveChordUrl(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${CHORD_SCHEME}:` || !/^[a-z]+$/.test(parsed.hostname)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const relative = pathname === '/' || pathname === '/index.html' ? `${parsed.hostname}/index.html` : pathname.slice(1);
  const base = resolve(root);
  const file = resolve(base, relative);
  return file.startsWith(base + sep) ? file : null;
}
