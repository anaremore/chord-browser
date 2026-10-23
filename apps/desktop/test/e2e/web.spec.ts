/**
 * The web platform a daily browser needs (ARCHITECTURE.md §9): PDFs in a tab,
 * spelling suggestions, screen sharing through Chord's picker, Settings → Site
 * permissions, a page's fullscreen, and page zoom remembered per site.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

/** The smallest PDF Chromium's viewer opens: one blank page. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n',
);

function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title>',
    '/spell': '<title>Spell</title><textarea id="t" style="font: 32px monospace; width: 400px; height: 80px"></textarea>',
    '/share':
      '<title>Share</title><button id="share">Share</button><video id="v" autoplay muted></video>' +
      `<script>document.getElementById('share').onclick = () => navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => {` +
      `document.getElementById('v').srcObject = s;` +
      `s.getVideoTracks()[0].addEventListener('ended', () => { document.title = 'Share ended'; });` +
      `document.title = 'Sharing'; }, (e) => { document.title = 'Share refused: ' + e.name; });</script>`,
    '/fullscreen':
      '<title>Fullscreen</title><div id="stage">A video, say</div><button id="go">Go fullscreen</button>' +
      `<script>document.getElementById('go').onclick = () => document.getElementById('stage').requestFullscreen();</script>`,
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/doc.pdf' || path === '/dl.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', ...(path === '/dl.pdf' ? { 'content-disposition': 'attachment; filename="dl.pdf"' } : {}) });
      res.end(PDF);
      return;
    }
    if (path === '/zoom') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Zoom</title><p>Zoom me</p>');
      return;
    }
    const body = pages[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function launch(env: Record<string, string>, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  // A fresh profile per launch unless a test reuses one: tests never touch a developer's real data.
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isPopover = (url: string) => url.startsWith('chord://popover') || url.includes('/popover/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** Open an address from the command bar, the way a person does. */
async function visit(shell: Page, overlay: Page, url: string) {
  await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await overlay.getByRole('combobox').fill(url);
  await overlay.keyboard.press('Enter');
}

/** A page's WebContents in main, by its address. */
const contentsId = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.id ?? null, url);
const zoomOf = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.getZoomFactor() ?? null, url);

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test('a PDF opens in its tab with the PDF viewer, and one sent as an attachment downloads', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'chord-downloads-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/doc.pdf`, CHORD_DOWNLOADS_DIR: downloads });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('doc.pdf');
    // Chromium's viewer shows it: its extension's page is part of the tab.
    const viewer = () =>
      app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((w) => w.mainFrame.framesInSubtree.some((f) => f.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))),
      );
    await expect.poll(viewer).toBe(true);
    expect(readdirSync(downloads)).toEqual([]);

    // A server that says "attachment" means download it.
    await visit(shell, overlay, `${site.origin}/dl.pdf`);
    await expect.poll(() => readdirSync(downloads)).toContain('dl.pdf');
  } finally {
    await app.close();
  }
});

test('a misspelled word offers suggestions and Add to dictionary at the top of the right-click menu', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/spell`, CHORD_E2E_HOOKS: '1' });
  try {
    await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/spell`);
    await tab.locator('#t').click();
    await tab.keyboard.type('teh ');
    const id = (await contentsId(app, `${site.origin}/spell`))!;
    const menu = () => app.evaluate((_electron, contents) => (globalThis as unknown as { chordTestHooks: { contextMenu(id: number): string[] | null } }).chordTestHooks.contextMenu(contents), id);
    // Spelling is checked as you type, once the dictionary has loaded (the first time, it downloads).
    // Text typed before then isn't checked again: while the word isn't marked at all, type it again.
    await expect
      .poll(
        async () => {
          await tab.locator('#t').click({ button: 'right', position: { x: 24, y: 24 } });
          const labels = await menu();
          if (!labels?.includes('Add to dictionary')) {
            await tab.locator('#t').fill('');
            await tab.locator('#t').pressSequentially('teh ');
          }
          return labels;
        },
        { timeout: 30_000, intervals: [500, 1000] },
      )
      .toEqual(expect.arrayContaining(['the', 'Add to dictionary']))
      .catch(async (error: Error) => {
        const spelling = await app.evaluate(({ webContents }, contents) => {
          const ses = webContents.fromId(contents)!.session;
          return { enabled: ses.isSpellCheckerEnabled(), languages: ses.getSpellCheckerLanguages(), available: ses.availableSpellCheckerLanguages.length };
        }, id);
        throw new Error(`${error.message}\nSpelling in the tab's session: ${JSON.stringify(spelling)}`);
      });
    const labels = (await menu())!;
    expect(labels.indexOf('Add to dictionary')).toBeLessThan(labels.indexOf('Inspect'));
  } finally {
    await app.close();
  }
});

test('screen sharing goes through Chord’s picker, and Stop in the sidebar ends it', async () => {
  test.skip(process.platform === 'darwin', 'macOS 15+ uses the system picker, which a test can’t drive');
  test.skip(process.env['XDG_SESSION_TYPE'] === 'wayland', 'headless Weston has no screen to capture');
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/share` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/share`);
    const popover = await pageWhere(app, isPopover);
    const picker = popover.getByRole('alertdialog', { name: /wants to share your screen/ });

    // Refused: the page's request fails (Electron reports AbortError; Chrome says NotAllowedError).
    await tab.locator('#share').click();
    // Thumbnails of every screen and window take a moment to gather.
    await expect(picker)
      .toBeVisible({ timeout: 15_000 })
      .catch(async (error: Error) => {
        // Chord refuses when there's nothing to share: say what the OS offered.
        const offered = await app.evaluate(async ({ desktopCapturer }) => {
          const start = Date.now();
          const listed = desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then(
            (sources) => `${sources.length} sources [${sources.map((s) => s.id).join(', ')}]`,
            (e: unknown) => `getSources failed: ${String(e)}`,
          );
          const late = new Promise<string>((resolve) => setTimeout(() => resolve('getSources still pending'), 5000));
          return `${await Promise.race([listed, late])} after ${Date.now() - start} ms`;
        });
        throw new Error(`${error.message}\nThe page's title: ${await tab.title()}\ndesktopCapturer: ${offered}`);
      });
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => tab.title()).toBe('Share refused: AbortError');
    await expect(picker).toBeHidden();

    // Shared: the first screen.
    await tab.locator('#share').click();
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await picker.getByRole('option').first().click();
    await picker.getByRole('button', { name: 'Share', exact: true }).click();
    await expect.poll(() => tab.title()).toBe('Sharing');
    const stop = shell.locator('[aria-label="Stop sharing your screen"]');
    await expect(stop).toBeVisible();

    // Stop ends it the way the OS would: the page hears "ended".
    await stop.click();
    await expect.poll(() => tab.title()).toBe('Share ended');
    await expect(stop).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Settings → Site permissions: change an answer, ask again, or forget the site', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(site.origin));
    const popover = await pageWhere(app, isPopover);
    const prompt = popover.getByRole('alertdialog');
    // Settings shows a site as its origin, without "https://" (this one is plain http).
    const name = site.origin;
    const ask = () => tab.evaluate(() => Notification.requestPermission());
    const state = () => tab.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state);

    const first = ask();
    // DIAGNOSTIC (temporary): what the popover and the tab look like when the prompt doesn't come.
    first.catch(() => undefined);
    try {
      await prompt.getByRole('button', { name: 'Allow' }).click({ timeout: 10_000 });
    } catch (error) {
      const views = await app.evaluate(({ BaseWindow, webContents }) =>
        BaseWindow.getAllWindows()
          .flatMap((w) => w.contentView.children.map((v) => ({ v: v as unknown as { webContents?: Electron.WebContents; getVisible(): boolean; getBounds(): Electron.Rectangle }, w: w.getTitle() })))
          .map(({ v, w }) => `${w}|${v.webContents?.getURL().slice(0, 60)}|vis=${v.getVisible()}|${JSON.stringify(v.getBounds())}|focused=${v.webContents?.isFocused()}`)
          .concat(webContents.getAllWebContents().map((c) => `wc ${c.id} ${c.getType()} ${c.getURL().slice(0, 60)} destroyed=${c.isDestroyed()}`))
          .join('\n'),
      );
      const pop = await popover.evaluate(() => `vis=${document.visibilityState} html=${document.body.innerHTML.slice(0, 400)}`).catch((e: unknown) => String(e));
      const page = await tab.evaluate(() => `url=${location.href} vis=${document.visibilityState} perm=${Notification.permission}`).catch((e: unknown) => String(e));
      const snap = await shell.evaluate(async () => {
        const { windowId, state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string | null> }>; nodes: Record<string, { url?: string }> } }> } } }).chord.state.snapshot();
        const w = state.windows[windowId]!;
        const active = w.activeTab[w.activeChordId];
        return `active=${active} url=${active ? state.nodes[active]?.url : ''} nodes=${Object.keys(state.nodes).length}`;
      });
      throw new Error(`DIAGNOSTIC\n${String(error)}\n${views}\npopover: ${pop}\ntab: ${page}\nshell: ${snap}`, { cause: error });
    }
    expect(await first).toBe('granted');

    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Site permissions' }).click();
    const siteGroup = settings.getByRole('region', { name });
    const answers = siteGroup.getByRole('radiogroup', { name: `Notifications for ${name}` });
    await expect(answers.getByRole('radio', { name: 'Allow' })).toHaveAttribute('aria-checked', 'true');

    // Block: the page is told no without being asked.
    await answers.getByRole('radio', { name: 'Block' }).click();
    await expect.poll(state).toBe('denied');
    expect(await ask()).toBe('denied');

    // Ask: the decision goes, and the next request prompts again.
    await answers.getByRole('radio', { name: 'Ask' }).click();
    await expect(siteGroup).toHaveCount(0);
    const again = ask();
    await prompt.getByRole('button', { name: 'Allow' }).click();
    expect(await again).toBe('granted');

    // Forget: everything about the site goes.
    await expect(siteGroup).toBeVisible();
    await siteGroup.getByRole('button', { name: 'Forget' }).click();
    await expect(siteGroup).toHaveCount(0);
    await expect(settings.getByText('Sites you allow or block show up here.')).toBeVisible();
    const third = ask();
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await third;
  } finally {
    await app.close();
  }
});

test('a page in fullscreen covers the whole window, and leaving it brings Chord back', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/fullscreen` });
  try {
    await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/fullscreen`);
    const page = () =>
      app.evaluate(({ BaseWindow }, url) => {
        const w = BaseWindow.getAllWindows()[0]!;
        const children = w.contentView.children;
        const index = children.findIndex((v) => 'webContents' in v && (v as { webContents: { getURL(): string } }).webContents.getURL() === url);
        const { width, height } = w.getContentBounds();
        const b = children[index]!.getBounds();
        return { covers: b.x === 0 && b.y === 0 && b.width === width && b.height === height, onTop: index === children.length - 1 };
      }, `${site.origin}/fullscreen`);
    expect(await page()).toEqual({ covers: false, onTop: false });
    // Esc and the page's own exit act on a window that's fullscreen: wait out the OS's transition (an
    // animation on macOS). Without a window manager to grant it (bare Xvfb), it never comes.
    const windowFullScreen = () => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isFullScreen());
    // The page's own view of it: set once the browser has granted fullscreen and resized it.
    const documentFullScreen = () => tab.evaluate(() => document.fullscreenElement !== null);
    const fullScreened = () =>
      expect
        .poll(windowFullScreen, { timeout: 10_000 })
        .toBe(true)
        .catch((error: Error) => {
          throw new Error(`${error.message}\nThe window never went fullscreen; on X11 that takes a window manager to grant it.`);
        });

    await tab.locator('#go').click();
    await expect.poll(page).toEqual({ covers: true, onTop: true });
    await fullScreened();
    await expect.poll(documentFullScreen).toBe(true);

    // Esc leaves, as in Chrome. (Sent the way a real key arrives: Playwright's keys skip the browser's handling.)
    await app.evaluate(({ webContents }, url) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
      w.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      w.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, `${site.origin}/fullscreen`);
    await expect.poll(page).toEqual({ covers: false, onTop: false });
    // And the page knows: nothing of it stays fullscreen inside Chord's frame.
    await expect.poll(documentFullScreen).toBe(false);

    // So does the page itself.
    await expect.poll(windowFullScreen, { timeout: 10_000 }).toBe(false);
    await tab.locator('#go').click();
    await expect.poll(page).toEqual({ covers: true, onTop: true });
    await fullScreened();
    await expect.poll(documentFullScreen).toBe(true);
    // exitFullscreen can refuse while the window is still changing; ask until it goes.
    await expect
      .poll(() => tab.evaluate(() => (document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : true)))
      .toBe(true);
    await expect.poll(page).toEqual({ covers: false, onTop: false });
  } finally {
    await app.close();
  }
});

test('page zoom is remembered for the site: in its other tabs, from the wheel, and after a relaunch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/zoom?a` }, profile);
  const a = `${site.origin}/zoom?a`;
  const b = `${site.origin}/zoom?b`;
  let wheeled: number;
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await pageWhere(app, (url) => url === a);
    await runAction(shell, 'view.zoomIn');
    await runAction(shell, 'view.zoomIn');
    await expect.poll(() => zoomOf(app, a)).toBeCloseTo(1.25, 2);

    // Another tab on the same site opens at the same zoom.
    await visit(shell, overlay, b);
    await pageWhere(app, (url) => url === b);
    await expect.poll(() => zoomOf(app, b)).toBeCloseTo(1.25, 2);

    // Ctrl + wheel: Electron only reports it ("zoom-changed"), and Chord zooms. Chromium sends
    // that report for real wheels only, so the test sends Electron's report itself.
    await app.evaluate(({ webContents }, u) => {
      webContents.getAllWebContents().find((c) => c.getURL() === u)!.emit('zoom-changed', {}, 'out');
    }, b);
    await expect.poll(() => zoomOf(app, b)).toBeCloseTo(1.1, 2);
    wheeled = (await zoomOf(app, b))!;
  } finally {
    await app.close();
  }

  // Saved for the site: a relaunch opens its tabs at that zoom.
  app = await launch({}, profile);
  try {
    await pageWhere(app, isShell);
    await expect.poll(() => zoomOf(app, b), { timeout: 20_000 }).toBeCloseTo(wheeled, 2);
  } finally {
    await app.close();
  }
});
