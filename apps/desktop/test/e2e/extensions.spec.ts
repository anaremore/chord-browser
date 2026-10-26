/**
 * Chrome extensions end to end (ARCHITECTURE.md §12), with no network: an
 * unpacked test extension (test/fixtures/extension), and a stand-in Chrome
 * Web Store that serves packages signed with keys made on the spot.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { crx3, extensionIdOf, folderFiles, keyPair, sha256Hex, spki, zip } from '../fixtures/crx';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

const appDir = resolve(import.meta.dirname, '../..');
const FIXTURE = resolve(appDir, 'test/fixtures/extension');
/** The fixture's ID, from the public key in its manifest. */
const FIXTURE_ID = 'ofclpclncfjjgjdhlgdfpcfolkjfpiag';

/** Pages, plus a stand-in Web Store: /update answers like Google's update service, /crx/<id>.crx serves packages. */
function startSite(packages: Map<string, Buffer> = new Map()): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.pathname === '/update') {
      const apps = url.searchParams.getAll('x').map((x) => {
        const id = new URLSearchParams(x).get('id') ?? '';
        const crx = packages.get(id);
        return crx
          ? `<app appid="${id}" status="ok"><updatecheck status="ok" version="1.0" codebase="${origin}/crx/${id}.crx" hash_sha256="${sha256Hex(crx)}"/></app>`
          : `<app appid="${id}" status="error-unknownApplication"><updatecheck status="noupdate"/></app>`;
      });
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">${apps.join('')}</gupdate>`);
      return;
    }
    const crx = url.pathname.startsWith('/crx/') ? packages.get(url.pathname.slice(5, -4)) : undefined;
    if (crx) {
      res.writeHead(200, { 'content-type': 'application/x-chrome-extension' });
      res.end(crx);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(url.pathname === '/' ? '<title>First page</title><p>A chord is three notes.</p>' : '<title>Other</title>');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function launch(env: Record<string, string>, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_E2E_HOOKS: '1', ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir], env: childEnv, cwd: appDir }));
}

failOnMainErrors();

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
const isPopup = (url: string) => url === `chrome-extension://${FIXTURE_ID}/popup.html`;

async function openSettings(app: ElectronApplication, shell: Page): Promise<Page> {
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('button', { name: 'Extensions', exact: true }).click();
  return settings;
}

test('an extension: told it was installed once, its scripts and rules run, and its button lives in the sidebar shelf', async () => {
  const { server, origin } = await startSite();
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${origin}/`, CHORD_LOAD_EXTENSION: FIXTURE }, profile);
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url === `${origin}/`);
    const shelf = shell.locator('[data-placement="sidebar"]');
    // Pinned by default, in the shelf, with its badge; nothing extension-related in the header.
    await expect(shelf.getByRole('button', { name: 'Chord Test, 7' })).toBeVisible({ timeout: 20_000 });
    await expect(shell.locator('[data-placement="bar"]')).toHaveCount(0);
    // The icon its service worker drew (setIcon with imageData), not the puzzle piece buttons show without one.
    const icon = shelf.getByRole('button', { name: 'Chord Test, 7' }).locator('img');
    await expect(icon).toHaveAttribute('src', /^data:image\/png/, { timeout: 10_000 });
    const middle = await icon.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const g = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d')!;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(img.naturalWidth >> 1, img.naturalHeight >> 1, 1, 1).data];
    });
    expect(middle).toEqual([30, 160, 90, 255]);

    // The content script ran, and the rule the manifest enables blocks (Chord's install step turns it on).
    await expect.poll(() => tab.evaluate(() => document.documentElement.dataset['chordTestExtension'])).toBe('injected');
    const fetchFrom = (path: string) => tab.evaluate((p) => fetch(p).then(() => 'loaded', () => 'blocked'), path);
    await expect.poll(() => fetchFrom('/blocked-by-extension'), { timeout: 20_000 }).toBe('blocked');
    expect(await fetchFrom('/other')).toBe('loaded');

    // Its context-menu item (made in runtime.onInstalled) joins a page's right-click menu.
    const tabId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.id, `${origin}/`);
    const menuLabels = () =>
      app.evaluate(
        (_electron, [id, page]) =>
          (globalThis as unknown as { chordTestHooks: { extensionMenuLabels(id: number, params: object): string[] } }).chordTestHooks.extensionMenuLabels(id as number, {
            selectionText: 'chord',
            pageURL: page,
            frameURL: '',
            linkURL: '',
            srcURL: '',
            mediaType: 'none',
            isEditable: false,
          }),
        [tabId, `${origin}/`] as const,
      );
    await expect.poll(menuLabels, { timeout: 20_000 }).toContain('Chord test: “chord”');

    // The popup opens from the button, sized to its page, and closes when the page closes it.
    await shelf.getByRole('button', { name: 'Chord Test, 7' }).click();
    const popup = await pageWhere(app, isPopup);
    await expect(popup.locator('#installs')).toHaveText('Installed 1 time(s), reason install');
    await expect(popup.locator('#tab')).toHaveText('Active tab: First page');
    // Sized to its page once the page reports its size; a page slow to report shows at full size first.
    await expect.poll(() => popup.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(300);
    expect(await popup.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(260);
    await popup.locator('#close').click();
    await expect.poll(() => app.windows().some((p) => isPopup(p.url()))).toBe(false);
    // The keyboard moving elsewhere in Chord (here to the page) closes it too. Headless Weston
    // never activates a window, and the popup stays open while Chord isn't the active app.
    if (process.env['XDG_SESSION_TYPE'] !== 'wayland') {
      await shelf.getByRole('button', { name: 'Chord Test, 7' }).click();
      await pageWhere(app, isPopup);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id!)?.focus(), tabId);
      await expect.poll(() => app.windows().some((p) => isPopup(p.url()))).toBe(false);
    }

    // The puzzle piece lists every extension; unpinning takes the button off the shelf but not off the list.
    const overlay = await pageWhere(app, isOverlay);
    await shelf.getByRole('button', { name: 'Extensions', exact: true }).click();
    const list = overlay.getByRole('dialog', { name: 'Extensions' });
    await list.getByRole('button', { name: 'Unpin Chord Test' }).click();
    await expect(shelf.getByRole('button', { name: 'Chord Test, 7' })).toHaveCount(0);
    await expect(list.getByRole('button', { name: 'Pin Chord Test' })).toBeVisible();
    await expect(list.getByRole('button', { name: /^Chord Test/ })).toBeVisible();
    await list.getByRole('button', { name: 'Pin Chord Test' }).click();
    await overlay.keyboard.press('Escape');
    await expect(shelf.getByRole('button', { name: 'Chord Test, 7' })).toBeVisible();

    // Settings can move the buttons to the title bar.
    const settings = await openSettings(app, shell);
    await settings.getByRole('radio', { name: 'In the title bar' }).click();
    await expect(shell.locator('[data-placement="sidebar"]')).toHaveCount(0);
    await expect(shell.locator('[data-placement="bar"]').getByRole('button', { name: 'Chord Test, 7' })).toBeVisible();
    await settings.getByRole('radio', { name: 'In the sidebar' }).click();
    await expect(shelf.getByRole('button', { name: 'Chord Test, 7' })).toBeVisible();

    // Collapsed, with the buttons in the sidebar: the minimal bar keeps only the puzzle piece.
    await shell.getByRole('button', { name: 'Hide sidebar' }).click();
    const bar = shell.locator('[data-placement="bar"]');
    await expect(bar.getByRole('button', { name: 'Extensions', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Chord Test, 7' })).toHaveCount(0);
    await shell.getByRole('button', { name: 'Show sidebar' }).click();
  } finally {
    await app.close();
  }

  // Next launch: it loads from what was saved, and isn't told it was installed again.
  app = await launch({ CHORD_HOME_URL: `${origin}/` }, profile);
  try {
    const shell = await pageWhere(app, isShell);
    const shelf = shell.locator('[data-placement="sidebar"]');
    await shelf.getByRole('button', { name: 'Chord Test, 7' }).click({ timeout: 20_000 });
    const popup = await pageWhere(app, isPopup);
    await expect(popup.locator('#installs')).toHaveText('Installed 1 time(s), reason install');
  } finally {
    await app.close();
    server.close();
  }
});

test('the Web Store: a verified package installs, a tampered one is refused, and Remove takes it out', async () => {
  const developer = keyPair('rsa');
  const publisher = keyPair('ec');
  const id = extensionIdOf(developer.publicKey);
  const files = folderFiles(FIXTURE);
  const good = crx3(zip(files), developer, [developer, publisher]);
  const otherDeveloper = keyPair('rsa');
  const otherId = extensionIdOf(otherDeveloper.publicKey);
  const tampered = crx3(zip(files), otherDeveloper, [otherDeveloper, publisher]);
  tampered[tampered.length - 200]! ^= 0x01;
  const { server, origin } = await startSite(
    new Map([
      [id, good],
      [otherId, tampered],
    ]),
  );
  const app = await launch({
    CHORD_HOME_URL: `${origin}/`,
    CHORD_WEBSTORE_UPDATE_URL: `${origin}/update`,
    CHORD_WEBSTORE_PUBLISHER_KEY_HASH: sha256Hex(spki(publisher.publicKey)),
  });
  try {
    const shell = await pageWhere(app, isShell);
    // No extensions: no shelf.
    await expect(shell.locator('[data-placement="sidebar"]')).toHaveCount(0);
    const settings = await openSettings(app, shell);
    const field = settings.getByRole('textbox', { name: 'Chrome Web Store link or extension ID' });
    const status = settings.locator('#extension-add-status');

    await field.fill(`https://chromewebstore.google.com/detail/chord-test/${id}`);
    await settings.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(status).toHaveText('Added Chord Test Extension.', { timeout: 20_000 });
    await expect(settings.getByRole('listitem', { name: 'Chord Test Extension' })).toBeVisible();
    await expect(shell.locator('[data-placement="sidebar"]').getByRole('button', { name: /^Chord Test/ })).toBeVisible();

    await field.fill(otherId);
    await settings.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(status).toHaveText(/signature/, { timeout: 20_000 });
    await expect(settings.getByRole('listitem')).toHaveCount(1);

    // Remove asks a second time, in place.
    await settings.getByRole('button', { name: 'Remove Chord Test Extension', exact: true }).click();
    await settings.getByRole('button', { name: 'Remove Chord Test Extension for good' }).click();
    await expect(settings.getByText('No extensions yet.')).toBeVisible();
    await expect(shell.locator('[data-placement="sidebar"]')).toHaveCount(0);
  } finally {
    await app.close();
    server.close();
  }
});
