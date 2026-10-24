/**
 * Safe Browsing (ARCHITECTURE.md §14.5) against a stand-in for Google's v5
 * API (safe-browsing-server.ts): a flagged page, redirect or frame shows the
 * warning and "Visit anyway" holds for the session; a flagged download is
 * held until kept or deleted; with the setting off nothing is checked, and
 * in Google-free mode nothing is even asked. First run shows the notice.
 *
 * Captures of the warning and the setting, light and dark, go to
 * .qa/safe-browsing/ (DESIGN.md §12).
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { audit, expectClean } from './a11y-kit';
import { failOnMainErrors, watchForMainErrors } from './main-errors';
import { startSafeBrowsingServer, THREAT, type FakeSafeBrowsing } from './safe-browsing-server';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const captures = resolve(appDir, '../../.qa/safe-browsing');
const EVIL_BYTES = 3 * 1024 * 1024;

let site: { server: Server; origin: string };
let service: FakeSafeBrowsing;

test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/': '<title>Home</title><p>Home</p>',
    '/next.html': '<title>Next page</title><p>Next</p>',
    '/phish.html': '<title>Phish page</title><form><input name="password" type="password"></form>',
    '/framed.html': '<title>Framed page</title><p>A page with a frame</p><iframe src="/evil-frame.html"></iframe>',
    '/evil-frame.html': '<p>The frame</p>',
    // Download links start downloads without a navigation (a navigation to a listed address gets the page warning).
    '/files.html':
      '<title>Files</title><a id="ok" href="/ok.bin" download>ok</a> <a id="evil" href="/evil.bin" download>evil</a> <a id="via" href="/via-redirect.bin" download>via</a>',
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/redirect') {
      res.writeHead(302, { location: '/phish.html' });
      res.end();
    } else if (path === '/via-redirect.bin') {
      res.writeHead(302, { location: '/evil.bin' });
      res.end();
    } else if (path === '/evil.bin' || path === '/ok.bin') {
      const size = path === '/evil.bin' ? EVIL_BYTES : 1024;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size), 'content-disposition': `attachment; filename="${path.slice(1)}"` });
      res.end(Buffer.alloc(size, 7));
    } else {
      const body = pages[path];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body ?? 'not found');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  // A million random prefixes stand in for the rest of Google's lists, so lookups are timed at a real size.
  service = await startSafeBrowsingServer({ noise: 1_000_000 });
  service.flag('127.0.0.1/phish.html', THREAT.phishing);
  service.flag('127.0.0.1/evil-frame.html', THREAT.malware);
  service.flag('127.0.0.1/evil.bin', THREAT.malware);
  mkdirSync(captures, { recursive: true });
});
test.afterAll(async () => {
  site.server.close();
  await service.close();
});
test.beforeEach(() => {
  service.requests.length = 0;
});

async function launch({ profile = mkdtempSync(join(tmpdir(), 'chord-e2e-')), env = {}, firstRun = false }: { profile?: string; env?: Record<string, string>; firstRun?: boolean } = {}) {
  const downloads = mkdtempSync(join(tmpdir(), 'chord-downloads-'));
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: profile,
    CHORD_HOME_URL: `${site.origin}/`,
    CHORD_DOWNLOADS_DIR: downloads,
    CHORD_SAFE_BROWSING_URL: service.origin,
    CHORD_E2E_HOOKS: '1',
    ...env,
  };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  if (firstRun) childEnv['CHORD_FIRST_RUN'] = '1';
  // No other browsers (import.spec.ts brings its own), so first run never offers to import from the machine's.
  childEnv['CHORD_IMPORT_ROOT'] ??= join(profile, 'no-browsers');
  const app = watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
  return { app, profile, downloads };
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isPopover = (url: string) => url.startsWith('chord://popover') || url.includes('/popover/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');

type Hooks = { safeBrowsing(): { status: { active: boolean; entries: number; updatedAt: number | null }; timings: { local: number[]; worker: number[]; searched: number[] } } };
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.safeBrowsing());
const pageUrls = (app: ElectronApplication) => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));

/** Open an address from the command bar, the way a person does. */
async function visit(shell: Page, overlay: Page, url: string) {
  await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await overlay.getByRole('combobox').fill(url);
  await overlay.keyboard.press('Enter');
  await expect(overlay.getByRole('combobox')).toBeHidden();
}

/** The one-time offer, answered. Turning it on waits for the lists. */
async function answerOffer(app: ElectronApplication, on: boolean, capture = false) {
  const popover = await pageWhere(app, isPopover);
  const offer = popover.getByRole('dialog', { name: 'Warn you before risky sites?' });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Protection isn’t perfect');
  if (capture) {
    await setScheme(app, 'light');
    await popover.waitForTimeout(600);
    await offer.screenshot({ path: join(captures, 'offer.png') });
    expectClean(await audit(popover, 'Safe Browsing offer', { appearance: 'light' }));
  }
  await offer.getByRole('button', { name: on ? 'Turn on' : 'Not now', exact: true }).click();
  await expect(offer).toHaveCount(0);
  if (on) await expect.poll(async () => (await hooks(app)).status.entries, { timeout: 20_000 }).toBeGreaterThan(990_000);
}

async function openSettings(app: ElectronApplication, shell: Page): Promise<Page> {
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('button', { name: 'Privacy' }).click();
  return settings;
}

/** Light or dark for captures: the OS appearance Chord follows, set in main as Settings → Appearance does. */
async function setScheme(app: ElectronApplication, scheme: 'light' | 'dark') {
  await app.evaluate(({ nativeTheme }, s) => {
    nativeTheme.themeSource = s;
  }, scheme);
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(scheme === 'dark');
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? NaN;
};

test('a flagged page shows the warning; Visit anyway lets the site through for the session', async () => {
  const { app } = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Home');
    await answerOffer(app, true);
    // The lists, asked for by name only. A test server never gets an API key.
    const update = service.requests.find((r) => r.path === '/v5/hashLists:batchGet')!;
    expect(update.params.getAll('names')).toEqual(['se-4b', 'mw-4b', 'uws-4b']);
    expect(service.requests.every((r) => !r.headers['x-goog-api-key'] && !r.headers.cookie)).toBe(true);

    // Ordinary pages are checked locally and nothing is asked.
    await visit(shell, overlay, `${site.origin}/next.html`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Next page');
    expect(service.requests.filter((r) => r.path === '/v5/hashes:search')).toHaveLength(0);

    await visit(shell, overlay, `${site.origin}/phish.html`);
    const warning = shell.locator('[data-safe-browsing]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('This site may be trying to trick you.');
    await expect(warning).toContainText('127.0.0.1 is on Google’s list of suspected phishing sites.');
    await expect(warning.getByRole('button', { name: 'Learn more about phishing' })).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Advisory provided by Google' })).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Back to safety' })).toBeVisible();
    // "Visit anyway" waits behind Details.
    await expect(warning.getByRole('button', { name: 'Visit anyway' })).toBeHidden();
    // Only the 4-byte prefix went to the service, never the address; the page didn't stay loaded.
    const search = service.requests.find((r) => r.path === '/v5/hashes:search')!;
    expect(search.params.getAll('hashPrefixes').map((p) => Buffer.from(p, 'base64').length)).toEqual([4]);
    expect(search.params.toString()).not.toContain('phish');
    await expect.poll(() => pageUrls(app)).not.toContain(`${site.origin}/phish.html`);
    await setScheme(app, 'light');
    await shell.waitForTimeout(600);
    await shell.screenshot({ path: join(captures, 'warning-light.png') });
    expectClean(await audit(shell, 'Safe Browsing warning', { include: '[data-safe-browsing]', appearance: 'light' }));
    await setScheme(app, 'dark');
    await shell.waitForTimeout(600);
    await shell.screenshot({ path: join(captures, 'warning-dark.png') });
    expectClean(await audit(shell, 'Safe Browsing warning', { include: '[data-safe-browsing]', appearance: 'dark' }));

    await warning.getByText('Details', { exact: true }).click();
    await warning.getByRole('button', { name: 'Visit anyway' }).click();
    await expect(warning).toHaveCount(0);
    await expect.poll(() => pageUrls(app)).toContain(`${site.origin}/phish.html`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Phish page');
    // Remembered for the rest of the session: no warning the next time.
    await visit(shell, overlay, `${site.origin}/next.html`);
    await visit(shell, overlay, `${site.origin}/phish.html`);
    await expect.poll(() => pageUrls(app)).toContain(`${site.origin}/phish.html`);
    await shell.waitForTimeout(500);
    await expect(warning).toHaveCount(0);

    // How long a local check takes, against a million-entry list: main → worker → main, as a navigation's
    // does (each a different address, so nothing is cached), after a few to warm up.
    const before = (await hooks(app)).timings;
    await app.evaluate(async () => {
      const check = (globalThis as unknown as { chordTestHooks: { safeBrowsingCheck(urls: string[]): Promise<unknown> } }).chordTestHooks.safeBrowsingCheck;
      for (let i = 0; i < 520; i++) await check([`https://www.site-${i}.example/articles/${i}/page.html?id=${i}`]);
    });
    const { timings } = await hooks(app);
    const local = timings.local.slice(before.local.length + 20);
    const worker = timings.worker.slice(before.worker.length + 20);
    console.log(
      `[safe-browsing] local check, n=${local.length}: p50 ${percentile(local, 0.5).toFixed(3)} ms, p95 ${percentile(local, 0.95).toFixed(3)} ms, max ${Math.max(...local).toFixed(3)} ms;` +
        ` in the worker p50 ${percentile(worker, 0.5).toFixed(3)} ms, p95 ${percentile(worker, 0.95).toFixed(3)} ms; with hashes.search (local server) ${timings.searched.map((t) => t.toFixed(1)).join(', ')} ms`,
    );
    expect(percentile(local, 0.95)).toBeLessThan(20);
  } finally {
    await app.close();
  }
});

test('redirects and frames are checked too, and Back to safety goes back', async () => {
  const { app } = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await answerOffer(app, true);
    const warning = shell.locator('[data-safe-browsing]');

    // A redirect to a listed page: the warning, and back to where you were.
    await visit(shell, overlay, `${site.origin}/next.html`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Next page');
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('edit'));
    await overlay.getByRole('combobox').fill(`${site.origin}/redirect`);
    await overlay.keyboard.press('Enter');
    await expect(warning).toContainText('This site may be trying to trick you.');
    await warning.getByRole('button', { name: 'Back to safety' }).click();
    await expect(warning).toHaveCount(0);
    await expect.poll(() => pageUrls(app)).toContain(`${site.origin}/next.html`);

    // A page whose frame is on the malware list.
    await visit(shell, overlay, `${site.origin}/framed.html`);
    await expect(warning).toContainText('This site may harm your computer.');
    await expect(warning).toContainText('Part of this page comes from 127.0.0.1');
    await expect.poll(() => pageUrls(app)).not.toContain(`${site.origin}/framed.html`);
    // With nothing before it in its tab, Back to safety closes the tab.
    const tabs = await shell.getByRole('tree', { name: 'Today' }).getByRole('treeitem').count();
    await warning.getByRole('button', { name: 'Back to safety' }).click();
    await expect(shell.getByRole('tree', { name: 'Today' }).getByRole('treeitem')).toHaveCount(tabs - 1);
  } finally {
    await app.close();
  }
});

test('a private window is checked as well, and keeps nothing', async () => {
  const { app, profile } = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    await answerOffer(app, true);
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('window.newPrivate'));
    await expect.poll(() => app.windows().filter((p) => isShell(p.url())).length).toBe(2);
    // Its command bar loads after its shell.
    await expect.poll(() => app.windows().filter((p) => isOverlay(p.url())).length).toBe(2);
    const privateShell = app.windows().filter((p) => isShell(p.url()))[1]!;
    const privateOverlay = app.windows().filter((p) => isOverlay(p.url()))[1]!;
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('combobox').fill(`${site.origin}/phish.html`);
    await privateOverlay.keyboard.press('Enter');
    await expect(privateShell.locator('[data-safe-browsing]')).toContainText('This site may be trying to trick you.');
    // Only the lists are on disk; nothing about the private window's browsing is.
    await expect.poll(() => readdirSync(join(profile, 'Safe Browsing'))).toEqual(['lists.bin']);
  } finally {
    await app.close();
  }
});

test('a flagged download is held, never finished by itself, until you keep or delete it', async () => {
  const { app, downloads } = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await answerOffer(app, true);

    await visit(shell, overlay, `${site.origin}/files.html`);
    const files = await pageWhere(app, (url) => url === `${site.origin}/files.html`);

    // A file that isn't on a list downloads as usual.
    await files.locator('#ok').click();
    await expect.poll(() => readdirSync(downloads)).toContain('ok.bin');

    // One that is: the downloads panel opens on it, and it waits, paused.
    await files.locator('#evil').click();
    const panel = overlay.getByRole('dialog', { name: 'Downloads' });
    await expect(panel).toBeVisible();
    const held = panel.getByRole('group', { name: 'evil.bin' });
    await expect(held).toContainText('This file may be malware. Chord paused it.');
    await expect(held.getByRole('button', { name: 'Learn more about malware' })).toBeVisible();
    await expect(held.getByRole('button', { name: 'Advisory provided by Google' })).toBeVisible();
    // Never under its real name while it's held: it keeps Chrome's pending name, so it can't be opened by mistake.
    await overlay.waitForTimeout(1000);
    expect(readdirSync(downloads)).not.toContain('evil.bin');
    expect(readdirSync(downloads).filter((f) => f.startsWith('evil')).every((f) => f.endsWith('.crdownload'))).toBe(true);
    await setScheme(app, 'dark');
    await overlay.waitForTimeout(600);
    await panel.screenshot({ path: join(captures, 'download-held.png') });
    expectClean(await audit(overlay, 'held download', { include: '[aria-label="Downloads"]', appearance: 'dark' }));
    await held.getByRole('button', { name: 'Delete' }).click();
    await expect(held).toHaveCount(0);
    await expect.poll(() => readdirSync(downloads).filter((f) => f.startsWith('evil'))).toEqual([]);
    await overlay.keyboard.press('Escape');

    // The final address after redirects counts: held again, and this time kept.
    await files.locator('#via').click();
    await expect(panel.getByRole('group', { name: 'evil.bin' })).toBeVisible();
    expect(readdirSync(downloads)).not.toContain('evil.bin');
    await panel.getByRole('group', { name: 'evil.bin' }).getByRole('button', { name: 'Keep anyway' }).click();
    await expect.poll(() => readdirSync(downloads).filter((f) => f.startsWith('evil'))).toEqual(['evil.bin']);
    expect(statSync(join(downloads, 'evil.bin')).size).toBe(EVIL_BYTES);
    await expect(panel.getByRole('group', { name: 'evil.bin' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('with Safe Browsing off, nothing is checked and nothing is asked', async () => {
  const { app, downloads } = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await answerOffer(app, false, true);
    await visit(shell, overlay, `${site.origin}/phish.html`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Phish page');
    await visit(shell, overlay, `${site.origin}/evil.bin`);
    await expect.poll(() => readdirSync(downloads).filter((f) => f === 'evil.bin' && statSync(join(downloads, f)).size === EVIL_BYTES)).toEqual(['evil.bin']);
    await expect(shell.locator('[data-safe-browsing]')).toHaveCount(0);
    expect(service.requests).toEqual([]);
    expect((await hooks(app)).status.active).toBe(false);

    // The setting, off, with its notice beside it: what you read before turning it on.
    await overlay.keyboard.press('Escape');
    const settings = await openSettings(app, shell);
    const row = settings.getByRole('switch', { name: 'Safe Browsing' });
    await expect(row).toHaveAttribute('aria-checked', 'false');
    await expect(settings.getByText('Protection isn’t perfect: a dangerous site can be missed, and a safe one can be flagged by mistake.')).toBeVisible();
    await settings.getByRole('heading', { name: 'Safe Browsing' }).scrollIntoViewIfNeeded();
    await setScheme(app, 'light');
    await settings.waitForTimeout(600);
    await settings.screenshot({ path: join(captures, 'setting-light.png') });
    await setScheme(app, 'dark');
    await settings.waitForTimeout(600);
    await settings.screenshot({ path: join(captures, 'setting-dark.png') });
    expectClean(await audit(settings, 'Settings → Privacy', { appearance: 'dark' }));
    // Turning it on there starts it.
    await row.click();
    await expect.poll(async () => (await hooks(app)).status.active).toBe(true);
    await expect(settings.getByText('Google’s lists', { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test('Google-free mode turns it off and keeps it off: not one request', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let { app } = await launch({ profile });
  try {
    const shell = await pageWhere(app, isShell);
    await answerOffer(app, true);
    const settings = await openSettings(app, shell);
    await settings.getByRole('switch', { name: 'Google-free mode' }).click();
    await expect(settings.getByText('Off in Google-free mode, because its lists come from Google.')).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Safe Browsing' })).toHaveCount(0);
    await expect.poll(async () => (await hooks(app)).status.active).toBe(false);
  } finally {
    await app.close();
  }

  service.requests.length = 0;
  ({ app } = await launch({ profile }));
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await visit(shell, overlay, `${site.origin}/phish.html`);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Phish page');
    await shell.waitForTimeout(2000);
    await expect(shell.locator('[data-safe-browsing]')).toHaveCount(0);
    expect(service.requests).toEqual([]);
    // No offer either: Google-free mode said no.
    const popover = await pageWhere(app, isPopover);
    await expect(popover.getByRole('dialog', { name: 'Warn you before risky sites?' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('first run shows the notice as a step, and turns Safe Browsing on', async () => {
  const { app } = await launch({ firstRun: true });
  try {
    const shell = await pageWhere(app, isShell);
    const welcome = shell.getByRole('dialog', { name: 'Welcome to Chord' });
    await welcome.getByRole('button', { name: /Make your first chord/ }).click();
    await welcome.getByRole('textbox', { name: 'Chord name' }).press('Enter');
    await welcome.getByRole('button', { name: /Looks good/ }).click();
    await welcome.getByRole('button', { name: /^Next/ }).click();
    await expect(welcome.getByRole('heading', { name: 'Warn you before risky sites?' })).toBeVisible();
    await expect(welcome).toContainText('Only when one matches does it send Google a short partial fingerprint of the address, never the address itself.');
    // Nothing is fetched before the notice is answered.
    expect(service.requests).toEqual([]);
    await setScheme(app, 'light');
    await shell.waitForTimeout(600);
    await shell.screenshot({ path: join(captures, 'first-run.png') });
    expectClean(await audit(shell, 'first run: Safe Browsing', { include: '[role="dialog"]', appearance: 'light' }));
    await welcome.getByRole('button', { name: /Turn on warnings/ }).click();
    await expect(welcome.getByRole('heading', { name: 'Three things to know' })).toBeVisible();
    await expect.poll(async () => (await hooks(app)).status.entries, { timeout: 20_000 }).toBeGreaterThan(990_000);
    await welcome.getByRole('button', { name: /Start browsing/ }).click();
    // Answered: no offer afterwards.
    const popover = await pageWhere(app, isPopover);
    await shell.waitForTimeout(500);
    await expect(popover.getByRole('dialog', { name: 'Warn you before risky sites?' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
