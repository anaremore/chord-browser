/**
 * Reader view (DESIGN.md §7.11, ARCHITECTURE.md §9): offered on articles and
 * not elsewhere; opening and closing it (its button, its shortcut's action,
 * the command bar, Esc) leaves the page and its scroll as they were; nothing
 * from the article runs; its images come through the tab's own session (a
 * picture that needs the page's cookie shows); its links go where the tab's
 * would; its text controls are remembered; a private window's uses that
 * window's sign-ins; and axe finds nothing in light and dark.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ARTWORK_PNG } from '../fixtures/media';
import { audit, dispatch, expectClean, isOverlay, isShell, launch, newPage, pageWhere, runAction, setReducedMotion, where } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const isReader = (url: string) => url.startsWith('chord://reader') || url.includes('/reader/index.html');

const paragraph = (n: number) =>
  `<p>Paragraph ${n} of the long read, which goes on as long reads do, with enough words in every sentence that nobody would mistake it for a menu, a caption or a list of links to the rest of the site.</p>`;

const ARTICLE = `<!doctype html><html lang="en"><head><title>The Long Read · Fixture News</title>
<meta property="og:title" content="The Long Read"><meta property="og:site_name" content="Fixture News">
<script>window.__marker = 'page'; document.documentElement.dataset.marker = 'page';</script>
</head><body>
<nav><a href="/">Home</a> <a href="/plain">Plain</a></nav>
<article>
<h1>The Long Read</h1>
${[1, 2, 3, 4].map(paragraph).join('')}
<figure><img src="/secret.png" alt="The secret picture" width="320" height="200"><figcaption>Only for readers with the cookie</figcaption></figure>
${[5, 6, 7, 8].map(paragraph).join('')}
<p>Read <a href="/second" id="second">the second story</a>, or skip to <a href="#notes" id="to-notes">the notes</a>.</p>
<p>Hostile bits: <a href="javascript:window.__marker='link'">a script link</a>, <img src="/nothing.png" onerror="window.__marker='onerror'" alt="Broken">
<script>window.__marker = 'inline'; document.documentElement.dataset.marker = 'inline';</script>
<iframe srcdoc="<script>parent.__marker = 'frame'</script>"></iframe></p>
${[9, 10, 11, 12, 13, 14, 15, 16].map(paragraph).join('')}
<h2 id="notes">Notes</h2>
${[17, 18, 19, 20, 21, 22].map(paragraph).join('')}
</article>
<footer>© Fixture News</footer>
</body></html>`;

let site: { server: Server; origin: string; secretRequests: string[] };
test.beforeAll(async () => {
  const secretRequests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/secret.png') {
      // Only with the cookie the article set: the picture shows only if it's fetched as the page would.
      const cookie = req.headers.cookie ?? '';
      secretRequests.push(cookie);
      if (!/(^|;\s*)pass=1(;|$)/.test(cookie)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ARTWORK_PNG);
      return;
    }
    const pages: Record<string, string> = {
      // No SameSite attribute: Chromium treats the cookie as Lax, as most sites' are.
      '/article': ARTICLE,
      '/second': `<title>Second story</title>${[1, 2, 3, 4, 5, 6].map(paragraph).join('')}`,
      '/plain': '<title>Plain page</title><p>Nothing to read here.</p><button>Buy</button>',
    };
    const body = pages[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', ...(path === '/article' ? { 'set-cookie': 'pass=1; Path=/' } : {}) });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secretRequests };
});
test.afterAll(() => site.server.close());

const readerButton = (shell: Page) => shell.getByRole('button', { name: 'Reader view', exact: true });

/** The page at an address (the tab's own, behind any reader view). */
const pageAt = (app: ElectronApplication, path: string) => pageWhere(app, (url) => url === `${site.origin}${path}`);

/** The reader view that's open, once its article is on its page. */
async function openedReader(app: ElectronApplication): Promise<Page> {
  const reader = await pageWhere(app, isReader);
  await expect(reader.getByRole('heading', { level: 1 })).toHaveText('The Long Read');
  return reader;
}

/** The address of the tab on screen. */
async function activeUrl(shell: Page): Promise<string | undefined> {
  const { tabId } = await where(shell);
  return shell.evaluate(async (id) => {
    const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { nodes: Record<string, { url?: string }> } }> } } }).chord.state.snapshot();
    return id ? state.nodes[id]?.url : undefined;
  }, tabId);
}

/** Click in a reader view the way the mouse does, from main (Playwright would wait for the navigation main cancels). */
async function clickInReader(app: ElectronApplication, selector: string, modifiers: string[] = []): Promise<void> {
  await app.evaluate(
    async ({ webContents }, [sel, mods]) => {
      const c = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith('chord://reader'))!;
      const at = (await c.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      )) as { x: number; y: number };
      c.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers: mods as never });
      c.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1, modifiers: mods as never });
    },
    [selector, modifiers] as const,
  );
}

/** A custom property of the reader view's document (its theme and type are set there). */
const readerVar = (reader: Page, name: string) => reader.evaluate((n) => document.documentElement.style.getPropertyValue(n), name);
/** Esc closes reader view as the key goes down, which can close its page before Playwright hears the key went down. */
const escapeCloses = (reader: Page) => reader.keyboard.down('Escape').catch((error: unknown) => {
  if (!reader.isClosed()) throw error;
});

test('offers reader view on an article only; opening and closing it keeps the page where it was', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/article` });
  try {
    const shell = await pageWhere(app, isShell);
    const page = await pageAt(app, '/article');
    await expect(readerButton(shell)).toBeVisible();
    await expect(readerButton(shell)).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => window.scrollTo(0, 900));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);

    // Its button: the article shows in place of the page.
    await readerButton(shell).click();
    let reader = await openedReader(app);
    await expect(readerButton(shell)).toHaveAttribute('aria-pressed', 'true');
    // The keyboard scrolls it.
    await reader.keyboard.press('PageDown');
    await expect.poll(() => reader.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    // Esc closes it: the page is back, scrolled where it was. (It goes as the key goes down.)
    await escapeCloses(reader);
    await expect.poll(() => reader.isClosed()).toBe(true);
    await expect(readerButton(shell)).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    // The shortcut's action opens and closes it.
    await runAction(shell, 'view.reader');
    reader = await openedReader(app);
    await runAction(shell, 'view.reader');
    await expect.poll(() => reader.isClosed()).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    // So does the command bar.
    const overlay = await pageWhere(app, isOverlay);
    await runAction(shell, 'tab.new');
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('reader view');
    await overlay.getByRole('option', { name: /^Show reader view/ }).click();
    reader = await openedReader(app);
    await runAction(shell, 'tab.new');
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('reader view');
    await overlay.getByRole('option', { name: /^Leave reader view/ }).click();
    await expect.poll(() => reader.isClosed()).toBe(true);

    // A page that isn't an article isn't offered it, even after its second look; asked anyway, it says why not.
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/plain` });
    await expect(shell.getByRole('treeitem', { name: 'Plain page', exact: true })).toBeVisible();
    await shell.waitForTimeout(3600);
    await expect(readerButton(shell)).toHaveCount(0);
    await runAction(shell, 'view.reader');
    await expect(shell.getByText('Chord couldn’t find an article on this page.')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('nothing from the article runs; its images come through the tab’s session; its links go where the tab’s would', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/article` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(readerButton(shell)).toBeVisible();
    await readerButton(shell).click();
    const reader = await openedReader(app);

    // No script, frame, handler or script link from the article; the page's own script ran only in the page.
    const leftovers = await reader.evaluate(() => ({
      marker: (window as unknown as { __marker?: string }).__marker ?? null,
      dataset: document.documentElement.dataset['marker'] ?? null,
      elements: document.querySelectorAll('article script, article iframe, article form, article svg, article style, article object, article embed').length,
      handlers: document.querySelectorAll('article [onerror], article [onclick], article [onload], article [style]').length,
      scriptLinks: document.querySelectorAll('article a[href^="javascript:"], article a[href^="data:"]').length,
    }));
    expect(leftovers).toEqual({ marker: null, dataset: null, elements: 0, handlers: 0, scriptLinks: 0 });
    expect(await reader.getByRole('link', { name: 'a script link' }).count()).toBe(0);
    await expect(reader.locator('article')).toContainText('a script link');

    // The picture that needs the page's cookie loads, from main, through the tab's session.
    const picture = reader.getByRole('img', { name: 'The secret picture' });
    await expect(picture).toHaveAttribute('src', /^chord:\/\/reader\/image\/[0-9a-f]{32}\/\d+$/);
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
    expect(site.secretRequests.some((cookie) => cookie.includes('pass=1'))).toBe(true);
    // Its key opens nothing else: another number, or another key, is nothing.
    const src = await picture.getAttribute('src');
    const other = await reader.evaluate(async (url) => {
      const probe = (address: string) =>
        new Promise<boolean>((done) => {
          const img = new Image();
          img.onload = () => done(true);
          img.onerror = () => done(false);
          img.src = address;
        });
      return { next: await probe(url.replace(/\d+$/, '99')), stranger: await probe(url.replace(/[0-9a-f]{32}/, '0'.repeat(32))) };
    }, src!);
    expect(other).toEqual({ next: false, stranger: false });

    // A link to a place in the article stays in reader view: the heading comes up just under the bar.
    await clickInReader(app, '#r-to-notes');
    await expect.poll(() => reader.evaluate(() => Math.round(document.getElementById('r-notes')!.getBoundingClientRect().top))).toBeLessThan(120);
    expect(await reader.evaluate(() => document.getElementById('r-notes')!.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
    expect(reader.isClosed()).toBe(false);

    // Ctrl/⌘-click opens a tab behind; reader view stays.
    await clickInReader(app, '#r-second', [process.platform === 'darwin' ? 'meta' : 'control']);
    await expect(shell.getByRole('treeitem', { name: 'Second story', exact: true })).toBeVisible();
    expect(await activeUrl(shell)).toBe(`${site.origin}/article`);
    expect(reader.isClosed()).toBe(false);

    // A plain click goes there in the tab, as it would from the page: reader view closes with the page it showed.
    await clickInReader(app, '#r-second');
    await expect.poll(() => activeUrl(shell)).toBe(`${site.origin}/second`);
    await expect.poll(() => reader.isClosed()).toBe(true);
  } finally {
    await app.close();
  }
});

test('remembers its text controls, for every page and after a restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/article` }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(readerButton(shell)).toBeVisible();
    await readerButton(shell).click();
    const reader = await openedReader(app);
    expect(await readerVar(reader, '--reader-body')).toContain('19px');

    await reader.getByRole('button', { name: 'Text and colors' }).click();
    const controls = reader.getByRole('group', { name: 'Text and colors' });
    await expect(controls).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Smaller text' })).toBeFocused();
    await controls.getByRole('button', { name: 'Larger text' }).click();
    await controls.getByRole('button', { name: 'Larger text' }).click();
    await expect(controls.getByText('24 px')).toBeVisible();
    await controls.getByRole('radio', { name: 'Serif' }).click();
    await controls.getByRole('radio', { name: 'Wide' }).click();
    await controls.getByRole('radio', { name: 'Sepia' }).click();
    await expect(controls.getByRole('radio', { name: 'Sepia' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => readerVar(reader, '--reader-body')).toContain('24px');
    expect(await readerVar(reader, '--reader-font')).toContain('serif');
    expect(await readerVar(reader, '--reader-measure')).toBe('44em');
    expect(await readerVar(reader, '--color-surface')).toBe('oklch(0.94 0.03 80)');

    // Esc puts the controls away first, then closes reader view.
    await reader.keyboard.press('Escape');
    await expect(controls).toHaveCount(0);
    expect(reader.isClosed()).toBe(false);
    // The zoom keys change the text size in reader view.
    await runAction(shell, 'view.zoomOut');
    await expect.poll(() => readerVar(reader, '--reader-body')).toContain('21px');
    await escapeCloses(reader);
    await expect.poll(() => reader.isClosed()).toBe(true);
  } finally {
    await app.close();
  }

  app = await launch({}, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(readerButton(shell)).toBeVisible();
    await readerButton(shell).click();
    const reader = await openedReader(app);
    expect(await readerVar(reader, '--reader-body')).toContain('21px');
    expect(await readerVar(reader, '--reader-font')).toContain('serif');
    expect(await readerVar(reader, '--reader-measure')).toBe('44em');
    expect(await readerVar(reader, '--color-surface')).toBe('oklch(0.94 0.03 80)');
  } finally {
    await app.close();
  }
});

test("in a private window, reader view uses that window's sign-ins and the article stays in it", async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/plain` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('treeitem', { name: 'Plain page', exact: true })).toBeVisible();
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, [shell]);
    const privateOverlay = await newPage(app, isOverlay, [overlay]);
    await expect(privateOverlay.getByRole('combobox')).toBeFocused();
    await privateOverlay.keyboard.type(`${site.origin}/article`);
    await privateOverlay.keyboard.press('Enter');
    await expect(readerButton(privateShell)).toBeVisible();
    await readerButton(privateShell).click();
    const reader = await openedReader(app);
    // The private window's cookie (set as its page loaded) brings the picture: its session, in memory, fetched it.
    const picture = reader.getByRole('img', { name: 'The secret picture' });
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
    // The normal window's sign-ins never got that cookie, and the private window's never touch the disk.
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:default').cookies.get({ name: 'pass' })).length);
    expect(cookies).toBe(0);
    // Its look is the private window's: graphite, always dark.
    expect(await reader.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    // The normal window's reader button never showed for the private window's article.
    await expect(readerButton(shell)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

for (const mode of ['light', 'dark'] as const) {
  test(`is accessible: landmarks, headings, reduced motion, and axe finds nothing (${mode})`, async () => {
    const app = await launch({ CHORD_HOME_URL: `${site.origin}/article`, CHORD_APPEARANCE: mode });
    try {
      const shell = await pageWhere(app, isShell);
      await expect(readerButton(shell)).toBeVisible();
      await readerButton(shell).click();
      const reader = await openedReader(app);
      await expect(reader.getByRole('banner')).toBeVisible();
      await expect(reader.getByRole('main')).toBeVisible();
      await expect(reader.getByRole('heading', { level: 2, name: 'Notes' })).toBeVisible();
      expect(await reader.getByRole('heading', { level: 1 }).count()).toBe(1);
      expect(await reader.evaluate(() => document.documentElement.style.colorScheme)).toBe(mode);

      const findings = await audit(reader, `reader view (${mode})`, { appearance: mode });
      await reader.getByRole('button', { name: 'Text and colors' }).click();
      findings.push(...(await audit(reader, `reader view's text controls (${mode})`, { appearance: mode })));
      // Each of its color themes, while the controls are open.
      for (const theme of mode === 'light' ? ['Sepia', 'Light'] : ['Dark']) {
        await reader.getByRole('radio', { name: theme }).click();
        findings.push(...(await audit(reader, `reader view, ${theme} (${mode})`, { appearance: mode })));
      }
      expectClean(findings);

      // Reduced motion reaches it, as it does Chord's other views.
      await setReducedMotion(app, shell, true);
      await expect.poll(() => reader.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(true);
    } finally {
      await app.close();
    }
  });
}
