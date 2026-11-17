/**
 * Passwords on a two-step identifier-then-password sign-in (S17 §4, §6, §9), end to end with the
 * real agent and main, against test/fixtures/passwords/two-step-identifier.html: step 1 is an email
 * and Next (the next step's password field already in the form, hidden); Next swaps in step 2 in
 * place, the email carried as a hidden field, and signing in posts to /session.
 *
 * 1. **First sign-in:** type the email, Next, type the password, sign in. The save card offers
 *    that email and password; saving works, with the first passphrase.
 * 2. **Step 1 fill:** the menu under the email offers the account; picking it (Enter, as Electron's
 *    own input) fills the email only, and no password goes in.
 * 3. **Step 2 fill:** Next, then the password's menu offers the account; picking it fills the
 *    password, and the carried email gets no event at all.
 * 4. **Update:** a sign-in with a changed password gets the update card for the same account, and
 *    the next fill, step by step, is the new password.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { isPopover, isShell, launch, pageWhere, pressReal } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@acme-e2e.dev';
const FIRST = 'Zq9-first-Sekrit';
const SECOND = 'Zq9-second-Sekrit';
const PASSPHRASE = 'correct horse battery staple';
const FIXTURE = readFileSync(resolve(import.meta.dirname, '../fixtures/passwords/two-step-identifier.html'), 'utf8');
const SIGNED_IN = '<title>Signed in</title><p>Signed in.</p>';

const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Site {
  server: Server;
  origin: string;
  host: string;
  posts: Record<string, string>[];
}

/** GET /login is the fixture; POST /session records what was posted and answers with a signed-in page. */
function startSite(): Promise<Site> {
  const posts: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        posts.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(SIGNED_IN);
      });
      return;
    }
    const page = req.url === '/login' ? FIXTURE : null;
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? 'not found');
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ server, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, posts });
    }),
  );
}

let site: Site;
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

const press = (app: ElectronApplication, keyCode: string) => pressReal(app, `${site.origin}/login`, keyCode);

/** Both steps typed, as a person signs in: the email, Next, the password, Enter. */
async function signIn(page: Page, password: string): Promise<void> {
  await page.goto(`${site.origin}/login`);
  await page.fill('#identifier', USER);
  await page.click('#next');
  await page.waitForSelector('#password');
  await page.fill('#password', password);
  await page.press('#password', 'Enter');
  await page.waitForURL(`${site.origin}/session`);
}

test('passwords: a two-step identifier-then-password sign-in is saved, filled step by step, and updated', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-two-step-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    let page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    const popover = await pageWhere(app, isCards);

    // 1. The first sign-in, both steps typed: the card offers the email and the password, and chooses the passphrase.
    await signIn(page, FIRST);
    expect(site.posts.at(-1)).toEqual({ identifier: USER, password: FIRST });
    const save = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(save).toBeVisible({ timeout: 15_000 });
    await expect(save.getByLabel('Username')).toHaveValue(USER);
    // (The password it saves is checked by the fill in step 3: the vault gives back what was typed at step 2.)
    await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await save.getByLabel('Again').fill(PASSPHRASE);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save).toHaveCount(0);
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible();

    // 2. Signed out (the form again): on step 1, the menu under the email offers the account; Enter fills the email only.
    page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await page.goto(`${site.origin}/login`);
    await page.focus('#identifier');
    const menuPage = await pageWhere(app, isMenu);
    const menu = menuPage.getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    await press(app, 'Enter');
    await expect(page.locator('#identifier')).toHaveValue(USER);
    await expect(menu).toHaveCount(0);
    // No password went in: the next step's field, hidden in this one, is empty, and the page holds the password nowhere.
    await expect(page.locator('#later-password')).toHaveValue('');
    expect(await page.evaluate((p) => [...document.querySelectorAll('input')].some((i) => i.value === p), FIRST)).toBe(false);

    // 3. Next: on step 2, the password's menu offers the account; Enter fills the password, and the carried email stays.
    await page.click('#next');
    await page.waitForSelector('#password');
    // Every event the carried email gets from here: the fill must send it none.
    await page.evaluate(() => {
      const w = window as unknown as { carriedEvents: number };
      w.carriedEvents = 0;
      for (const type of ['input', 'change']) document.getElementById('carried')!.addEventListener(type, () => w.carriedEvents++);
    });
    await page.focus('#password');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    await press(app, 'Enter');
    await expect(page.locator('#password')).toHaveValue(FIRST);
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { carriedEvents: number }).carriedEvents)).toBe(0);
    await expect(page.locator('#carried')).toHaveValue(USER);
    // Submitting what was filled: the site gets it, and nothing is offered (it's what's saved).
    await page.press('#password', 'Enter');
    await page.waitForURL(`${site.origin}/session`);
    expect(site.posts.at(-1)).toEqual({ identifier: USER, password: FIRST });

    // 4. A changed password: the update card, for the same account.
    await signIn(page, SECOND);
    const update = popover.getByRole('dialog', { name: `Update the password for ${USER}?` });
    await expect(update).toBeVisible({ timeout: 15_000 });
    await update.getByRole('button', { name: 'Update' }).click();
    await expect(update).toHaveCount(0);
    // The next fill is the new password: step 1, Next, step 2.
    await page.goto(`${site.origin}/login`);
    await page.focus('#identifier');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await press(app, 'Enter');
    await expect(page.locator('#identifier')).toHaveValue(USER);
    await page.click('#next');
    await page.waitForSelector('#password');
    await page.focus('#password');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await press(app, 'Enter');
    await expect(page.locator('#password')).toHaveValue(SECOND);
  } finally {
    await app.close();
  }
});
