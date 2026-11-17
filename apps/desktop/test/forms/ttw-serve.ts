/**
 * Serves the built test-the-web site (ttw.ts) to Playwright's Chromium from the cache, at a
 * made-up origin, with the page's own scripts running (its React forms need them). Nothing
 * leaves the machine: every other request is aborted, and the form's posts to the site's API
 * (which the suite doesn't run) get an empty 200.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { BrowserContext } from '@playwright/test';

export const SITE_ORIGIN = 'https://ttw.test';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/** The file under `root` a path names (a folder's index.html), or null; never outside `root`. */
function fileFor(root: string, pathname: string): string | null {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, '');
  const full = join(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  const index = join(full, 'index.html');
  return existsSync(index) ? index : null;
}

export async function serveSite(context: BrowserContext, root: string): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== SITE_ORIGIN) return route.abort();
    if (request.method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    const file = fileFor(root, url.pathname);
    if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}
