/**
 * Screenshots (DESIGN.md §7.12), end to end: ⌘⇧2's capture mode over the
 * page, every kind (an element, picked by pointer and by ↑, an element
 * taller than the screen, a dragged area, what's on screen, the whole page),
 * the clipboard, the toast's Save, the recent list in the downloads panel,
 * Esc, and a private window's screenshots staying in memory. The page is
 * made of plain colored boxes, so each picture's size and color say it's the
 * right one.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { isOverlay, isSettings, isShell, launch, newPage, pageWhere, runAction, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

let site: Site;
test.beforeAll(async () => {
  site = await startSite({
    '/shot':
      '<title>Boxes</title><style>body { margin: 0 } #box { position: absolute; left: 100px; top: 80px; width: 200px; height: 120px; background: rgb(220, 40, 40) }' +
      ' #inner { margin: 20px; width: 100px; height: 40px; background: rgb(40, 40, 220) }' +
      ' #tall { position: absolute; left: 400px; top: 300px; width: 120px; height: 2000px; background: rgb(40, 160, 40) }</style>' +
      '<div id="box"><div id="inner"></div></div><div id="tall"></div>',
  });
});
test.afterAll(() => site.server.close());

/** The clipboard's picture: its size and its first pixel (RGB), read in main. */
const clipboardImage = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard, nativeImage }) => {
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return null;
    const blob = (await item.getType('image/png')) as Blob;
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    const [b, g, r] = image.toBitmap();
    return { ...image.getSize(), rgb: [r, g, b] };
  });

/** Where the page is in the overlay (UI units), from capture mode's clear pane. */
const paneOf = (overlay: Page) =>
  overlay.evaluate(() => {
    const pane = document.querySelector('[role="dialog"][aria-label="Take a screenshot"] > div')!.getBoundingClientRect();
    return { x: pane.x, y: pane.y, width: pane.width, height: pane.height };
  });

async function startCapture(shell: Page, overlay: Page) {
  await runAction(shell, 'page.screenshot');
  const dialog = overlay.getByRole('dialog', { name: 'Take a screenshot' });
  await expect(dialog).toBeVisible();
  return { dialog, pane: await paneOf(overlay) };
}

test('⌘⇧2: an element by pointer or ↑, one taller than the screen, an area, what’s on screen, the whole page; the toast saves it, and the recent list copies and deletes', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'chord-downloads-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/shot`, CHORD_DOWNLOADS_DIR: downloads });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Boxes');
    const toast = shell.getByRole('region', { name: 'Notifications' }).getByRole('group', { name: 'Screenshot copied' });

    // Hover picks the element under the pointer; ↑ goes to its parent; a click takes it.
    let { dialog, pane } = await startCapture(shell, overlay);
    await overlay.mouse.move(pane.x + 150, pane.y + 110);
    await expect(dialog).toContainText('div#inner · 100 × 40');
    await overlay.keyboard.press('ArrowUp');
    await expect(dialog).toContainText('div#box · 200 × 120');
    await overlay.mouse.click(pane.x + 150, pane.y + 110);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => clipboardImage(app)).toMatchObject({ width: 200, height: 120, rgb: [220, 40, 40] });
    await expect(toast).toBeVisible();

    // The toast's Save puts it in Downloads, as a finished download.
    await toast.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => readdirSync(downloads).filter((f) => /^Screenshot .+\.png$/.test(f)).length).toBe(1);
    const saved = readdirSync(downloads).find((f) => f.endsWith('.png'))!;
    expect(readFileSync(join(downloads, saved)).subarray(1, 4).toString()).toBe('PNG');

    // An element taller than the screen: the whole of it, past the bottom.
    ({ dialog, pane } = await startCapture(shell, overlay));
    await overlay.mouse.move(pane.x + 450, pane.y + 350);
    await expect(dialog).toContainText('div#tall · 120 × 2000');
    await overlay.mouse.click(pane.x + 450, pane.y + 350);
    await expect.poll(() => clipboardImage(app)).toMatchObject({ width: 120, height: 2000, rgb: [40, 160, 40] });

    // A dragged area: just that.
    ({ dialog, pane } = await startCapture(shell, overlay));
    await overlay.mouse.move(pane.x + 110, pane.y + 90);
    await overlay.mouse.down();
    await overlay.mouse.move(pane.x + 170, pane.y + 130, { steps: 4 });
    await overlay.mouse.up();
    await expect.poll(() => clipboardImage(app)).toMatchObject({ width: 60, height: 40, rgb: [220, 40, 40] });

    // V: what's on screen, the page's viewport without its scrollbar (as Screenboard takes it).
    const page = await pageWhere(app, (url) => url === `${site.origin}/shot`);
    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    ({ dialog, pane } = await startCapture(shell, overlay));
    await overlay.keyboard.press('v');
    await expect.poll(async () => (await clipboardImage(app))?.width).toBe(viewport.width);
    expect((await clipboardImage(app))?.height).toBe(viewport.height);

    // F: the whole page, down to the bottom of the tall box.
    ({ dialog, pane } = await startCapture(shell, overlay));
    await overlay.keyboard.press('f');
    await expect.poll(async () => (await clipboardImage(app))?.height).toBe(2300);

    // Esc: nothing taken.
    ({ dialog } = await startCapture(shell, overlay));
    await overlay.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The recent list, newest first: copy one again, delete one, then clear them.
    await shell.getByRole('button', { name: /^Downloads/ }).click();
    const panel = overlay.getByRole('dialog', { name: 'Downloads' });
    const shots = panel.getByRole('region', { name: 'Screenshots' });
    await expect(shots.getByRole('listitem')).toHaveCount(5);
    await expect(shots.getByRole('listitem').first()).toContainText(/just now · \d+ × 2300/);
    await shots.getByRole('listitem').last().getByRole('button', { name: /^Copy screenshot/ }).click();
    await expect.poll(() => clipboardImage(app)).toMatchObject({ width: 200, height: 120 });
    await shots.getByRole('listitem').first().getByRole('button', { name: /^Delete screenshot/ }).click();
    await expect(shots.getByRole('listitem')).toHaveCount(4);
    await shots.getByRole('button', { name: 'Clear' }).click();
    await expect(shots).toHaveCount(0);
    await overlay.keyboard.press('Escape');

    // At 150% page zoom: the same element, under the pointer where it now is, at its zoomed size.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.setZoomFactor(1.5), `${site.origin}/shot`);
    ({ dialog, pane } = await startCapture(shell, overlay));
    await overlay.mouse.move(pane.x + 250, pane.y + 180);
    await expect(dialog).toContainText('div#inner · 100 × 40');
    await overlay.mouse.click(pane.x + 250, pane.y + 180);
    await expect.poll(() => clipboardImage(app)).toMatchObject({ width: 150, height: 60, rgb: [40, 40, 220] });

    // "Keep recent screenshots" off: none is kept, and the list is gone.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.evaluate(() => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ keepScreenshots: false }));
    await shell.getByRole('treeitem', { name: 'Boxes' }).click();
    ({ dialog } = await startCapture(shell, overlay));
    await overlay.keyboard.press('v');
    await expect(toast).toBeVisible();
    await shell.getByRole('button', { name: /^Downloads/ }).click();
    await expect(overlay.getByRole('dialog', { name: 'Downloads' })).toBeVisible();
    await expect(overlay.getByRole('region', { name: 'Screenshots' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('a private window’s screenshots stay in memory, listed only there, and none is written to the profile', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/shot` }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Boxes');
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, [shell]);
    const privateOverlay = await newPage(app, isOverlay, [overlay]);
    await expect(privateShell.getByText('This window is private.')).toBeVisible();
    await privateShell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await privateOverlay.keyboard.type(`${site.origin}/shot`);
    await privateOverlay.keyboard.press('Enter');
    await expect(privateShell.getByRole('tree', { name: 'Today' })).toContainText('Boxes');

    await runAction(privateShell, 'page.screenshot');
    await expect(privateOverlay.getByRole('dialog', { name: 'Take a screenshot' })).toBeVisible();
    await privateOverlay.keyboard.press('v');
    await expect(privateShell.getByRole('region', { name: 'Notifications' }).getByRole('group', { name: 'Screenshot copied' })).toBeVisible();

    // Listed in the private window's panel, not the normal one's; nothing on disk.
    await privateShell.getByRole('button', { name: /^Downloads/ }).click();
    await expect(privateOverlay.getByRole('region', { name: 'Screenshots' }).getByRole('listitem')).toHaveCount(1);
    await shell.getByRole('button', { name: /^Downloads/ }).click();
    await expect(overlay.getByRole('dialog', { name: 'Downloads' })).toBeVisible();
    await expect(overlay.getByRole('region', { name: 'Screenshots' })).toHaveCount(0);
    const dir = join(profile, 'Screenshots');
    expect(existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('index')) : []).toEqual([]);
  } finally {
    await app.close();
  }
});
