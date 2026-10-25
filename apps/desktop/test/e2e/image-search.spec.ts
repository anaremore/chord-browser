/**
 * Searching by an image from the command bar (DESIGN.md §7.3): paste or drop
 * one, and the row searches your engine by it: Google Lens or Bing, each sent
 * the form Chrome sends, as the new tab's first page. Engines that can't search
 * by image get Google Lens, named on the row; Google-free mode gets Bing. The
 * engines' endpoints are this machine's (CHORD_IMAGE_SEARCH_ORIGIN, development
 * builds only), which records each upload.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { isOverlay, isSettings, isShell, launch, pageWhere, runAction } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

interface Upload {
  path: string;
  contentType: string;
  body: Buffer;
}

let server: Server;
let origin: string;
const uploads: Upload[] = [];

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks)));
  });

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'POST') {
      uploads.push({ path, contentType: req.headers['content-type'] ?? '', body: await read(req) });
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Results from ${path}</title>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(path === '/' ? '<title>Home</title>' : `<title>${path}</title>`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

/** A 1,600 × 900 red-and-blue PNG on the clipboard, as a copied screenshot is. */
const copyImage = (app: ElectronApplication) =>
  app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const [width, height] = [1600, 900];
    const bitmap = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) bitmap.set(i % width < width / 2 ? [40, 40, 220, 255] : [220, 40, 40, 255], i * 4);
    const png = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
  });

async function openBar(shell: Page, overlay: Page) {
  await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog', { name: 'New tab' })).toBeVisible();
  return overlay.getByRole('combobox');
}

async function setSettings(app: ElectronApplication, shell: Page, settings: Record<string, unknown>) {
  await runAction(shell, 'app.settings');
  const page = await pageWhere(app, isSettings);
  await page.evaluate((s) => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set(s), settings);
  // Back to the browser window, so a paste reaches its command bar.
  await shell.bringToFront();
}

test('paste or drop an image in the command bar: it searches Google Lens or Bing by it, each sent as Chrome sends it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${origin}/`, CHORD_IMAGE_SEARCH_ORIGIN: origin });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('tree', { name: 'Today' });
    await expect(today).toContainText('Home');
    const paste = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+V`;

    // Pasted: the image is a chip in the field, and the one row searches Google Lens (Google is the default engine).
    await copyImage(app);
    let field = await openBar(shell, overlay);
    await field.press(paste);
    await expect(overlay.getByTestId('image-chip')).toBeVisible();
    await expect(overlay.getByRole('option')).toHaveCount(1);
    await expect(overlay.getByRole('option')).toContainText('Search Google Lens for this image');
    await field.press('Enter');
    await expect(today).toContainText('Results from /google-upload');
    const lens = uploads.find((u) => u.path === '/google-upload')!;
    expect(lens.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = lens.body.toString('latin1');
    // A JPEG at most 1,000 px a side, and the original's size.
    expect(text).toMatch(/name="encoded_image"; filename="image.jpg"\r\nContent-Type: image\/jpeg\r\n\r\n\xff\xd8/);
    expect(text).toContain('name="processed_image_dimensions"\r\n\r\n1000,563');
    expect(text).toContain('name="original_width"\r\n\r\n1600');

    // Backspace on the empty field takes the image out; the usual rows come back.
    field = await openBar(shell, overlay);
    await field.press(paste);
    await expect(overlay.getByTestId('image-chip')).toBeVisible();
    await field.press('Backspace');
    await expect(overlay.getByTestId('image-chip')).toHaveCount(0);
    await field.fill('chords');
    await expect(overlay.getByRole('option').first()).toContainText('chords');
    await field.press('Escape');

    // Bing: its Visual Search, the image base64-encoded as imageBin.
    await setSettings(app, shell, { searchEngine: 'bing' });
    field = await openBar(shell, overlay);
    await field.press(paste);
    await expect(overlay.getByTestId('image-chip')).toBeVisible();
    await expect(overlay.getByRole('option')).toContainText('Search Bing for this image');
    await field.press('Enter');
    await expect.poll(() => uploads.some((u) => u.path === '/bing-upload')).toBe(true);
    expect(uploads.find((u) => u.path === '/bing-upload')!.body.toString('latin1')).toMatch(/name="imageBin"\r\n\r\n\/9j\//);

    // An engine that can't search by image: Google Lens, named on its row. Dropped this time, not pasted.
    await setSettings(app, shell, { searchEngine: 'duckduckgo' });
    field = await openBar(shell, overlay);
    await overlay.evaluate(async () => {
      const canvas = new OffscreenCanvas(40, 40);
      canvas.getContext('2d')!.fillRect(0, 0, 40, 40);
      const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'dropped.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      const row = document.querySelector('[role="combobox"]')!.parentElement!;
      row.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      row.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(overlay.getByTestId('image-chip')).toBeVisible();
    await expect(overlay.getByRole('option')).toContainText('Search Google Lens for this image');
    await field.press('Escape');

    // Google-free mode: never Google; Bing instead.
    await setSettings(app, shell, { googleFree: true });
    field = await openBar(shell, overlay);
    await field.press(paste);
    await expect(overlay.getByTestId('image-chip')).toBeVisible();
    await expect(overlay.getByRole('option')).toContainText('Search Bing for this image');
  } finally {
    await app.close();
  }
});
