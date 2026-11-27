/**
 * Tab icons (DESIGN.md §7.4): once a tab has its site's icon, it keeps it.
 * A page that names no icon, an icon that won't load, or a navigation that
 * never arrives (a 204, a download) leaves it as it is. On another site the tab
 * shows that site's icon if Chord has one, or the monogram until the page's
 * own arrives; never the last site's.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

/** A 1 × 1 PNG: the site's icon. */
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** #324: the Cookie header each icon request came with, by path ('' for none). */
const iconCookies: Record<string, string[]> = {};

function startSite(): Promise<{ server: Server; port: number }> {
  const pages: Record<string, string> = {
    // #324: a page whose icon is on another site (other.test), and one whose icon is its own.
    '/cross': '<title>Cross icon</title><link rel="icon" href="http://other.test:{port}/x.png"><p>Cross</p>',
    '/own': '<title>Own icon</title><link rel="icon" href="/own.png"><p>Own</p>',
    // #324: an icon of the page's own site that redirects: on to another site (other.test), or within its own.
    '/hops-away': '<title>Hops away</title><link rel="icon" href="/hop-away.png"><p>Away</p>',
    '/hops-home': '<title>Hops home</title><link rel="icon" href="/hop-home.png"><p>Home</p>',
    // Names its icon.
    '/a': '<title>Page A</title><link rel="icon" href="/a.png"><p>A</p>',
    // Names none: Chromium asks for /favicon.ico, which isn't there.
    '/b': '<title>Page B</title><p>B</p>',
    // Names one that isn't there.
    '/broken': '<title>Broken icon</title><link rel="icon" href="/missing.png"><p>Broken</p>',
    // Another site's page (localhost rather than 127.0.0.1), with no icon of its own.
    '/c': '<title>Page C</title><p>C</p>',
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/hop-away.png' || path === '/hop-home.png') {
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: path === '/hop-away.png' ? `http://other.test:${port}/x.png` : '/own.png' });
      res.end();
    } else if (path === '/x.png' || path === '/own.png') {
      (iconCookies[path] ??= []).push(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ICON);
    } else if (path === '/set') {
      // other.test's own page, as you'd visit it: its cookies, the strictest and the usual.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['strict=1; Path=/; SameSite=Strict', 'lax=1; Path=/; SameSite=Lax'] });
      res.end('<title>Other</title><p>Signed in</p>');
    } else if (path === '/a.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ICON);
    } else if (path === '/nothing') {
      // A navigation that never arrives: the tab stays on its page.
      res.writeHead(204);
      res.end();
    } else if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[path].replaceAll('{port}', String((server.address() as AddressInfo).port)));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port })));
}

async function launch(home: string, args: string[] = []): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), CHORD_HOME_URL: home };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run', ...args], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');

/** The tab on screen, as the store has it. */
const shown = (shell: Page) =>
  shell.evaluate(async () => {
    type Snapshot = { windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string | null> }>; nodes: Record<string, Record<string, { id: string; url: string; title: string; favicon: string | null }>> } };
    const { windowId, state } = await (window as unknown as { chord: { state: { snapshot(): Promise<Snapshot> } } }).chord.state.snapshot();
    const win = state.windows[windowId]!;
    const tab = Object.values(state.nodes).flatMap((b) => Object.values(b)).find((n) => n.id === (win.activeTab[win.activeChordId]!))!;
    return { url: tab.url, title: tab.title, favicon: tab.favicon };
  });

let site: { server: Server; port: number };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test("a tab keeps its site's icon: through pages without one, a broken one and a navigation that never arrives; another site never wears it", async () => {
  const origin = `http://127.0.0.1:${site.port}`;
  const app = await launch(`${origin}/a`);
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await shown(shell)).favicon ?? '', { timeout: 20_000 }).toMatch(/^data:image\/png;base64,/);
    const icon = (await shown(shell)).favicon;
    const tab = await pageWhere(app, (url) => url.startsWith(origin));
    const row = shell.getByRole('tree', { name: 'Unpinned tabs' }).getByRole('treeitem').first();

    // The same site, by pages that name no icon, or one that's missing: the icon stays, in the store and in the row.
    for (const [path, title] of [['/b', 'Page B'], ['/broken', 'Broken icon']] as const) {
      await tab.goto(`${origin}${path}`);
      await expect.poll(async () => (await shown(shell)).title).toBe(title);
      // Long enough for the page's own icon request to fail.
      await tab.waitForTimeout(600);
      expect((await shown(shell)).favicon, `on ${path}`).toBe(icon);
      await expect(row.locator('img')).toHaveAttribute('src', icon!);
    }

    // A navigation that starts and never arrives (a 204): nothing changes.
    await tab.evaluate(() => {
      location.href = '/nothing';
    });
    await tab.waitForTimeout(600);
    expect(await shown(shell)).toMatchObject({ title: 'Broken icon', favicon: icon });

    // Another site with no icon: the monogram, never the last site's icon.
    await tab.goto(`http://localhost:${site.port}/c`);
    await expect.poll(async () => (await shown(shell)).title).toBe('Page C');
    await tab.waitForTimeout(600);
    expect((await shown(shell)).favicon).toBeNull();
    await expect(row.locator('img')).toHaveCount(0);

    // Back to the first site, on a page that names no icon: Chord has the site's, at once.
    await tab.goto(`${origin}/b`);
    await expect.poll(async () => (await shown(shell)).url).toBe(`${origin}/b`);
    expect((await shown(shell)).favicon).toBe(icon);
  } finally {
    await app.close();
  }
});

test('#324: a tab of yours whose page names another site’s icon fetches it without that site’s cookies', async () => {
  // Two sites on this machine: page.test (the page) and other.test (the icon's), each its own site.
  const app = await launch(`http://other.test:${site.port}/set`, ['--host-resolver-rules=MAP page.test 127.0.0.1, MAP other.test 127.0.0.1']);
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.includes('other.test'));
    await expect.poll(async () => (await shown(shell)).title, { timeout: 20_000 }).toBe('Other');

    // On other.test, its own icon: what an icon of the page's own site sends (the probe's other half).
    await tab.goto(`http://other.test:${site.port}/own`);
    await expect.poll(() => iconCookies['/own.png']?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

    // On page.test, an icon on other.test: Chord's fetch of it.
    await tab.goto(`http://page.test:${site.port}/cross`);
    await expect.poll(() => iconCookies['/x.png']?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    console.log(`#324 probe: same-site icon sent [${iconCookies['/own.png']!.join(' | ')}]; cross-site icon sent [${iconCookies['/x.png']!.join(' | ')}]`);
    expect(iconCookies['/x.png']).toEqual(['']);
    // Its own site's icon keeps its cookies, as before.
    expect(iconCookies['/own.png']).toEqual(['strict=1; lax=1']);

    // page.test's own icon redirecting to other.test: other.test gets none of its cookies.
    await tab.goto(`http://page.test:${site.port}/hops-away`);
    await expect.poll(() => iconCookies['/x.png']!.length, { timeout: 10_000 }).toBe(2);
    expect(iconCookies['/x.png']![1]).toBe('');
    // other.test's own icon redirecting within its site: fetched again without cookies too (Electron's fetch can't
    // follow a redirect a hop at a time, so a same-site icon that redirects never carries them on).
    await tab.goto(`http://other.test:${site.port}/hops-home`);
    await expect.poll(() => iconCookies['/own.png']!.length, { timeout: 10_000 }).toBe(2);
    expect(iconCookies['/own.png']![1]).toBe('');
  } finally {
    await app.close();
  }
});

