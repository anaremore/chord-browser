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

function startSite(): Promise<{ server: Server; port: number }> {
  const pages: Record<string, string> = {
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
    if (path === '/a.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ICON);
    } else if (path === '/nothing') {
      // A navigation that never arrives: the tab stays on its page.
      res.writeHead(204);
      res.end();
    } else if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[path]);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port })));
}

async function launch(home: string): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), CHORD_HOME_URL: home };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');

/** The tab on screen, as the store has it. */
const shown = (shell: Page) =>
  shell.evaluate(async () => {
    type Snapshot = { windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string | null> }>; nodes: Record<string, { url: string; title: string; favicon: string | null }> } };
    const { windowId, state } = await (window as unknown as { chord: { state: { snapshot(): Promise<Snapshot> } } }).chord.state.snapshot();
    const win = state.windows[windowId]!;
    const tab = state.nodes[win.activeTab[win.activeChordId]!]!;
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
    const row = shell.getByRole('tree', { name: 'Today' }).getByRole('treeitem').first();

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
