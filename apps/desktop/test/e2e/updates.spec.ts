/**
 * In-app updates (ARCHITECTURE.md §14.4), up to "ready to install": a local
 * feed stands in for GitHub Releases and its download folder. Installing
 * itself can't be tested here, so the tests never press Restart.
 *
 * The download path is the Windows installer's (electron-updater's NSIS
 * updater). Development builds elsewhere aren't an installer or an AppImage,
 * so these run on Windows only.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();
test.skip(process.platform !== 'win32', 'the dev build downloads through the Windows installer path only');

const appDir = resolve(import.meta.dirname, '../..');
const TAG = 'v99.0.0';
const installer = `Chord-99.0.0-win-${process.arch}-setup.exe`;
const manifestName = `latest-win-${process.arch}.yml`;
const payload = Buffer.alloc(200_000, 7);

const signingKey = generateKeyPairSync('ed25519');
const publicPem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();

function manifest(): string {
  const sha512 = createHash('sha512').update(payload).digest('base64');
  return [
    'version: 99.0.0',
    'files:',
    `  - url: ${installer}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    `path: ${installer}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-01T00:00:00.000Z'",
    '',
  ].join('\n');
}

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const body = manifest();
  const files: Record<string, string | Buffer> = {
    [`/download/${TAG}/${manifestName}`]: body,
    [`/download/${TAG}/${manifestName}.sig`]: sign(null, Buffer.from(body), signingKey.privateKey).toString('base64'),
    [`/download/${TAG}/${installer}`]: payload,
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/releases')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ tag_name: TAG, name: 'Chord 99.0.0', draft: false, html_url: `https://github.com/anaremore/chord-browser/releases/tag/${TAG}` }]));
      return;
    }
    const file = files[req.url ?? ''];
    res.writeHead(file === undefined ? 404 : 200);
    res.end(file ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

async function launch(publicKey: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')),
    // electron-updater keeps downloads under LOCALAPPDATA: a throwaway one, never the real cache.
    LOCALAPPDATA: mkdtempSync(join(tmpdir(), 'chord-e2e-cache-')),
    CHORD_HOME_URL: 'about:blank',
    CHORD_UPDATE_FEED: `${site.origin}/releases`,
    CHORD_UPDATE_DOWNLOADS: `${site.origin}/download/`,
    CHORD_UPDATE_PUBLIC_KEY: publicKey,
  };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

test('a signed update downloads in the background and waits for a restart', async () => {
  const app = await launch(publicPem(signingKey.publicKey));
  try {
    const shell = await pageWhere(app, isShell);
    // The toast offers the restart; it isn't pressed, since that would run the installer.
    const toast = shell.getByRole('group').filter({ hasText: 'Chord 99.0.0 is ready' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast.getByRole('button', { name: 'Restart to update' })).toBeVisible();

    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'About' }).click();
    await expect(settings.getByText('Chord 99.0.0 is ready')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Restart to update' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('a manifest signed with another key is never installed: Chord only says the version is out', async () => {
  const stranger = generateKeyPairSync('ed25519');
  const app = await launch(publicPem(stranger.publicKey));
  try {
    const shell = await pageWhere(app, isShell);
    const toast = shell.getByRole('group').filter({ hasText: 'Chord 99.0.0 is out' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast.getByRole('button', { name: 'What’s new' })).toBeVisible();
    await expect(shell.getByText('Chord 99.0.0 is ready')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
