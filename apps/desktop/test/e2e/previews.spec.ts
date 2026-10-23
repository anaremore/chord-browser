/**
 * Hover previews (DESIGN.md §7.6): a pinned tab shows the last picture of its
 * page, a folder its first tabs. Pictures live in `<userData>/Captures/`,
 * never for a private window, and Settings → Privacy can turn it all off.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title>',
    '/second': '<title>Second page</title>',
    '/third': '<title>Third page</title>',
    // A page with a picture worth previewing.
    '/colors': `<title>Colors</title><body style="margin:0;background:linear-gradient(90deg,#e64,#4ae)"><h1 style="color:white;font:700 48px sans-serif;margin:40px">Colors</h1></body>`,
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function launch(profile: string): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_HOME_URL: `${site.origin}/` };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ args: [appDir], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isPreview = (url: string) => url.startsWith('chord://preview') || url.includes('/preview/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** Whether the browser window's preview view is showing, and where (Settings is a window too, without one). */
const previewView = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => {
    for (const w of BaseWindow.getAllWindows()) {
      const view = w.contentView.children.find((v) => 'webContents' in v && /preview/.test((v as { webContents: { getURL(): string } }).webContents.getURL()));
      if (view) return { visible: view.getVisible(), ...view.getBounds() };
    }
    return null;
  });

const pictures = (profile: string) => {
  const dir = join(profile, 'Captures');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jpg')) : [];
};

async function open(shell: Page, overlay: Page, url: string) {
  await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await overlay.keyboard.type(url);
  await overlay.keyboard.press('Enter');
}

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test('a pinned tab previews the last picture of its page; Settings → Privacy turns that off and deletes the pictures', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile);
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const pinned = shell.getByRole('tree', { name: 'Pinned', exact: true });
    await open(shell, overlay, `${site.origin}/colors`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Colors');
    await runAction(shell, 'tab.pin');
    await expect(pinned).toContainText('Colors');

    // Leaving the pinned tab pictures it.
    await open(shell, overlay, `${site.origin}/second`);
    await expect.poll(() => pictures(profile).length, { timeout: 10_000 }).toBe(1);

    // Resting on its row shows the card beside the sidebar, after the hover delay.
    await pinned.getByRole('treeitem', { name: 'Colors', exact: true }).hover();
    const preview = await pageWhere(app, isPreview);
    const card = preview.getByRole('tooltip');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Colors');
    await expect(card).toContainText('127.0.0.1');
    await expect(card).toContainText(/Opened/);
    await expect.poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(true);
    const placed = (await previewView(app))!;
    // Beside the sidebar, never over it (the view would take the pointer from its rows and its edge).
    const sidebar = await shell.evaluate(() => document.querySelector('nav')!.getBoundingClientRect().right);
    expect(placed.x).toBeGreaterThanOrEqual(Math.floor(sidebar));
    const row = (await pinned.getByRole('treeitem', { name: 'Colors', exact: true }).boundingBox())!;
    expect(Math.abs(placed.y + 24 - row.y)).toBeLessThanOrEqual(2);

    // Moving off the row puts it away.
    await shell.mouse.move(700, 500);
    await expect.poll(async () => (await previewView(app))?.visible).toBe(false);

    // Settings → Privacy: off deletes the pictures, and resting on the row shows nothing.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    const toggle = settings.getByRole('switch', { name: 'Show page previews' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => pictures(profile).length).toBe(0);
    await pinned.getByRole('treeitem', { name: 'Colors', exact: true }).hover();
    await shell.waitForTimeout(900);
    expect((await previewView(app))?.visible).toBe(false);
  } finally {
    await app.close();
  }
});

test('a folder previews its first tabs; a page never pictured shows its icon on the chord’s tint', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile);
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const pinned = shell.getByRole('tree', { name: 'Pinned', exact: true });
    await open(shell, overlay, `${site.origin}/third`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Third page');
    await runAction(shell, 'folder.new');
    const folder = pinned.locator('[data-row="folder"]');
    await expect(folder).toHaveCount(1);
    await expect(pinned).toContainText('Third page');
    // Finish naming it as offered, so the row is a plain button again.
    await shell.keyboard.press('Enter');

    await folder.hover();
    const preview = await pageWhere(app, isPreview);
    const card = preview.getByRole('tooltip');
    await expect(card).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveCount(1);
    await expect(card).toContainText('Third page');

    // Straight on to the tab inside: the card swaps at once, without waiting again.
    await pinned.getByRole('treeitem', { name: 'Third page', exact: true }).hover();
    await expect(card).toContainText('Opened', { timeout: 400 });
    // It's on screen, so it hasn't been pictured yet: its icon stands in on the tint.
    if (pictures(profile).length === 0) await expect(card.locator('[data-fallback]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('a private window is never pictured', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile);
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('First page');
    await runAction(shell, 'window.newPrivate');
    await expect.poll(() => app.windows().filter((p) => isShell(p.url())).length).toBe(2);
    // Its command bar loads after its shell.
    await expect.poll(() => app.windows().filter((p) => isOverlay(p.url())).length).toBe(2);
    const privateShell = app.windows().filter((p) => isShell(p.url()))[1]!;
    const privateOverlay = app.windows().filter((p) => isOverlay(p.url()))[1]!;
    await open(privateShell, privateOverlay, `${site.origin}/colors`);
    await open(privateShell, privateOverlay, `${site.origin}/second`);
    await privateShell.waitForTimeout(2000);
    // Nothing in a private window can be pinned or pictured.
    await expect(privateShell.locator('[data-preview]')).toHaveCount(0);
    expect(pictures(profile)).toEqual([]);
  } finally {
    await app.close();
  }
});
