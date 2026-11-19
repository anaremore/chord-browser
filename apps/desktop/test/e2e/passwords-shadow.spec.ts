/**
 * Passwords on a sign-in form of web components (S17 phase 3B), end to end with the real sentinel,
 * agent and main, against test/fixtures/passwords/shadow-components.html: each field's input is in
 * an open shadow root of its <x-text-field>, the <form> and its button in the page's own tree.
 *
 * 1. **The sentinel wakes on focus inside a root** (the event's composed path: its target is only the
 *    host), and the first sign-in, typed, is saved from the card, which offers the email.
 * 2. **The menu under a field in a root** offers the account; Enter fills both inputs, through their
 *    roots, and the page's own script posts them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { isPopover, isShell, launch, pageWhere, pressReal } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@acme-e2e.dev';
const PASSWORD = 'Zq9-shadow-Sekrit';
const PASSPHRASE = 'correct horse battery staple';
const FIXTURE = readFileSync(resolve(import.meta.dirname, '../fixtures/passwords/shadow-components.html'), 'utf8');
const HOME = '<title>Home</title><p>Signed in.</p>';

const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Site {
  server: Server;
  origin: string;
  host: string;
  posts: Record<string, string>[];
}

/** GET /login is the fixture, POST /session records what was posted, GET /home is where it goes after. */
function startSite(): Promise<Site> {
  const posts: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        posts.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    const page = req.url === '/login' ? FIXTURE : req.url === '/home' ? HOME : null;
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

/** Playwright's CSS steps into open shadow roots: the input inside a host. */
const field = (host: string) => `#${host} input`;

test('passwords: a sign-in form of web components (fields in open shadow roots) is saved and filled', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-shadow-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    let page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    const popover = await pageWhere(app, isCards);

    // 1. Typed, in the components' roots: the page has no password field in its own tree, so focus wakes the agent.
    expect(await page.evaluate(() => document.querySelector('input'))).toBeNull();
    await page.click(field('email'));
    await page.waitForTimeout(300);
    await page.fill(field('email'), USER);
    await page.fill(field('password'), PASSWORD);
    await page.click('#go');
    await page.waitForURL(`${site.origin}/home`);
    expect(site.posts.at(-1)).toEqual({ email: USER, password: PASSWORD });
    const save = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(save).toBeVisible({ timeout: 15_000 });
    await expect(save.getByLabel('Username')).toHaveValue(USER);
    await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await save.getByLabel('Again').fill(PASSPHRASE);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save).toHaveCount(0);
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible();

    // 2. Back on the form: the menu under the email in its root offers the account; Enter fills both, through the roots.
    page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await page.goto(`${site.origin}/login`);
    await page.click(field('email'));
    const menu = (await pageWhere(app, isMenu)).getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    await pressReal(app, `${site.origin}/login`, 'Enter');
    await expect(page.locator(field('email'))).toHaveValue(USER);
    await expect(page.locator(field('password'))).toHaveValue(PASSWORD);
    await expect(menu).toHaveCount(0);
    // The page's own script reads them from its components and posts them.
    await page.click('#go');
    await page.waitForURL(`${site.origin}/home`);
    expect(site.posts.at(-1)).toEqual({ email: USER, password: PASSWORD });
  } finally {
    await app.close();
  }
});
