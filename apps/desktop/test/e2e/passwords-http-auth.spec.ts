/**
 * Chord's passwords in the browser's own sign-in box (docs/decisions/S17-passwords.md §10, HTTP sign-in), end to
 * end against a small site with HTTP Basic auth at a fake address (`router.test`, mapped to this computer). One
 * journey, in order, with a fresh profile and no keyring (so the vault starts with no passphrase):
 *
 * 1. **A wrong password isn't saved.** Typed with *Remember* ticked, the site says no and the box comes back.
 * 2. **Type, Remember, sign in, saved.** The right one, with *Remember*: the site takes it, and the save card
 *    chooses the first passphrase. Settings → Passwords lists it with its realm.
 * 3. **Reload, and the box opens filled**: the username, the password masked (the popover never has it), *Remember*
 *    ticked. Sign in, and the site takes the saved password.
 * 4. **A private window fills but doesn't save**: filled there too, no *Remember*, and a sign-in typed there
 *    leaves Settings as it was.
 *
 * And apart: a **proxy's** box has no *Remember*, and isn't filled.
 *
 * axe checks the filled box, and the box and *Remember* are captured for the PR.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { audit, capturesDir, closeSettings, expectClean, isOverlay, isPopover, isSettings, isShell, launch, newPage, pageWhere, runAction, type Finding } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@example.com';
const PASSWORD = 'Zq9-router-Sekrit';
const OTHER_USER = 'grace@example.com';
const OTHER_PASSWORD = 'Zq9-staff-Sekrit';
const PASSPHRASE = 'correct horse battery staple';
const REALM = 'Router admin';
const MAP = '--host-resolver-rules=MAP router.test 127.0.0.1, MAP site.test 127.0.0.1';

const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Router {
  server: Server;
  origin: string;
  host: string;
  /** Every Authorization header the site was sent, as `username:password`. */
  tried: string[];
}

const basic = (req: IncomingMessage) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : null;
};

/** The router's admin pages: /admin for ada (realm *Router admin*), /staff for grace (realm *Staff*). */
function startRouter(): Promise<Router> {
  const tried: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const area = path === '/staff' ? { realm: 'Staff', expected: `${OTHER_USER}:${OTHER_PASSWORD}`, title: 'Staff page' } : { realm: REALM, expected: `${USER}:${PASSWORD}`, title: 'Router admin page' };
    const sent = basic(req);
    if (sent !== null) tried.push(sent);
    if (sent !== area.expected) {
      res.writeHead(401, { 'www-authenticate': `Basic realm="${area.realm}"`, 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Unauthorized</title><p>No entry.</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<title>${area.title}</title><h1>${area.title}</h1>`);
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ server, origin: `http://router.test:${port}`, host: `router.test:${port}`, tried });
    }),
  );
}

let router: Router;
test.beforeAll(async () => {
  router = await startRouter();
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => router.server.close());

/** Settings → Passwords: the saved sign-ins' rows, as text. */
async function savedRows(app: ElectronApplication, shell: Page): Promise<string[]> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
  const list = settings.getByRole('main').getByRole('list', { name: 'Saved passwords' });
  await expect(list).toBeVisible();
  const rows = await list.getByRole('listitem').allInnerTexts();
  await closeSettings(app);
  return rows;
}

/** Chromium keeps a sign-in that worked until Chord quits: forgotten here, so the site asks again. */
const forgetSignIns = (app: ElectronApplication) =>
  app.evaluate(async ({ webContents }) => {
    await Promise.all([...new Set(webContents.getAllWebContents().map((w) => w.session))].map((s) => s.clearAuthCache()));
  });

test('the sign-in box: a wrong password isn’t saved, Remember saves the right one, a reload fills it, a private window fills and never saves', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-http-'));
  const app = await launch({ CHORD_HOME_URL: `${router.origin}/admin`, CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile, args: [MAP] });
  const findings: Finding[] = [];
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const popover = await pageWhere(app, isCards);
    const box = popover.getByRole('alertdialog', { name: `Sign in to ${router.origin}` });
    await expect(box).toBeVisible();
    await expect(box.locator('q')).toHaveText(REALM);
    // Nothing saved here: Remember is offered, unticked, and nothing is filled.
    const remember = box.getByRole('checkbox', { name: 'Remember' });
    await expect(remember).not.toBeChecked();
    await expect(box.getByLabel('Username')).toHaveValue('');
    await expect(box.getByRole('button', { name: 'Unlock passwords' })).toHaveCount(0);

    // 1. A wrong password, with Remember: the site says no, and the box comes back.
    await box.getByLabel('Username').fill(USER);
    await box.getByLabel('Password').fill('not-the-password');
    await remember.check();
    await popover.screenshot({ path: resolve(capturesDir, 'passwords-http-remember-light.png'), omitBackground: true });
    await box.getByRole('button', { name: 'Sign in' }).click();
    await expect(box).toContainText("That username and password didn't work.");
    expect(router.tried).toContain(`${USER}:not-the-password`);

    // 2. The right one: the site takes it, and the first save chooses the passphrase.
    await box.getByLabel('Username').fill(USER);
    await box.getByLabel('Password').fill(PASSWORD);
    await expect(remember).toBeChecked();
    await box.getByRole('button', { name: 'Sign in' }).click();
    const tab = await pageWhere(app, (u) => u === `${router.origin}/admin`);
    await expect.poll(() => tab.title()).toBe('Router admin page');
    const firstSave = popover.getByRole('dialog', { name: `Save this password for ${router.host}?` });
    await expect(firstSave).toBeVisible({ timeout: 15_000 });
    await expect(firstSave.getByLabel('Username')).toHaveValue(USER);
    await firstSave.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await firstSave.getByLabel('Again').fill(PASSPHRASE);
    await firstSave.getByRole('button', { name: 'Save' }).click();
    await expect(firstSave).toHaveCount(0);
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible();
    // One sign-in, the right one, with its realm under the site.
    const rows = await savedRows(app, shell);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(router.host);
    expect(rows[0]).toContain(`Realm: ${REALM}`);
    expect(rows[0]).toContain(USER);

    // 3. Reload: the box opens filled, the password masked and never the popover's, Remember ticked.
    await forgetSignIns(app);
    const triedBefore = router.tried.length;
    await tab.reload().catch(() => undefined);
    await expect(box).toBeVisible();
    await expect(box.getByLabel('Username')).toHaveValue(USER);
    const masked = await box.getByLabel('Password').inputValue();
    expect(masked).not.toBe('');
    expect(masked).not.toContain(PASSWORD);
    expect(await popover.content()).not.toContain(PASSWORD);
    await expect(remember).toBeChecked();
    // Chord sends nothing until Sign in.
    await popover.waitForTimeout(500);
    expect(router.tried.length).toBe(triedBefore);
    findings.push(...(await audit(popover, 'the filled sign-in box', { appearance: 'light' })));
    await popover.screenshot({ path: resolve(capturesDir, 'passwords-http-filled-light.png'), omitBackground: true });
    await box.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => tab.title()).toBe('Router admin page');
    expect(router.tried.at(-1)).toBe(`${USER}:${PASSWORD}`);
    await expect(box).toBeHidden();

    // 4. A private window: filled from the vault, no Remember; a sign-in typed there isn't saved.
    const before = app.windows();
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, before);
    const privateOverlay = await newPage(app, isOverlay, [overlay]);
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('combobox').fill(`${router.origin}/admin`);
    await privateOverlay.keyboard.press('Enter');
    const privatePopover = await newPage(app, isCards, before);
    const privateBox = privatePopover.getByRole('alertdialog', { name: `Sign in to ${router.origin}` });
    await expect(privateBox).toBeVisible();
    await expect(privateBox.getByLabel('Username')).toHaveValue(USER);
    await expect(privateBox.getByRole('checkbox', { name: 'Remember' })).toHaveCount(0);
    await privateBox.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => router.tried.at(-1)).toBe(`${USER}:${PASSWORD}`);
    await expect(privateBox).toBeHidden();
    // Another area, typed: signed in, and nothing saved.
    await privateShell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(privateOverlay.getByRole('combobox')).toBeFocused();
    await privateOverlay.getByRole('combobox').fill(`${router.origin}/staff`);
    await privateOverlay.keyboard.press('Enter');
    const staff = privatePopover.getByRole('alertdialog', { name: `Sign in to ${router.origin}` });
    await expect(staff.locator('q')).toHaveText('Staff');
    await expect(staff.getByRole('checkbox', { name: 'Remember' })).toHaveCount(0);
    await staff.getByLabel('Username').fill(OTHER_USER);
    await staff.getByLabel('Password').fill(OTHER_PASSWORD);
    await staff.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => router.tried.at(-1)).toBe(`${OTHER_USER}:${OTHER_PASSWORD}`);
    await expect(staff).toBeHidden();
    await expect(privatePopover.getByRole('dialog')).toHaveCount(0);
    expect(await savedRows(app, shell)).toHaveLength(1);
  } finally {
    await app.close();
  }
  expectClean(findings);
});

test('a proxy’s sign-in box has no Remember, and isn’t filled', async () => {
  test.setTimeout(120_000);
  // A forward proxy that always asks for a password.
  const proxy = createServer((_req, res) => {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="Corp proxy"', 'content-type': 'text/html' });
    res.end('<title>Proxy sign-in needed</title>');
  });
  const proxyPort = await new Promise<number>((done) => proxy.listen(0, '127.0.0.1', () => done((proxy.address() as AddressInfo).port)));
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-http-proxy-'));
  const app = await launch({ CHORD_HOME_URL: 'about:blank', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile, args: [MAP] });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const popover = await pageWhere(app, isCards);
    // Settings → Privacy → Proxy: this one for every chord.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await settings.getByRole('radiogroup', { name: 'Proxy for every chord' }).getByRole('radio', { name: /^A proxy server/ }).click();
    await settings.getByLabel('Proxy for every chord: address', { exact: true }).fill('127.0.0.1');
    await settings.getByLabel('Proxy for every chord: port', { exact: true }).fill(String(proxyPort));
    await settings.getByRole('button', { name: 'Use this proxy' }).click();
    await closeSettings(app);

    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('http://site.test/');
    await overlay.keyboard.press('Enter');
    const box = popover.getByRole('alertdialog', { name: `The proxy 127.0.0.1:${proxyPort} needs you to sign in` });
    await expect(box).toBeVisible();
    await expect(box.locator('q')).toHaveText('Corp proxy');
    await expect(box.getByRole('checkbox', { name: 'Remember' })).toHaveCount(0);
    await expect(box.getByRole('button', { name: 'Unlock passwords' })).toHaveCount(0);
    await expect(box.getByRole('listbox', { name: 'Saved sign-ins' })).toHaveCount(0);
    await expect(box.getByLabel('Username')).toHaveValue('');
    await box.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(box).toBeHidden();
  } finally {
    await app.close();
    proxy.close();
  }
});
