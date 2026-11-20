/**
 * A sign-in code typed after the password (S17 §6, phase 3D; the owner's design 1A), end to end with the real agent,
 * main and chord-data, on a site of Apple's `websites-that-append-2fa-to-password.json`. The site is this machine
 * (--host-resolver-rules, a throwaway self-signed certificate and --ignore-certificate-errors, as shots.spec.ts does:
 * the site's own https address, which its HSTS needs); nothing leaves it.
 *
 * 1. **Saved without the code:** the first save on the site, typed with a 6-digit code after the password: the card says
 *    Chord left off the last 6 digits, and the fill afterwards is the password alone.
 * 2. **The same password with another code:** no card (the code is no new password).
 * 3. **Keep them:** another account, its password really ending in 6 digits. The eye shows the password without them;
 *    *Keep them* says it will be saved as typed, the eye shows it whole, and the fill afterwards is what was typed.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { isPopover, isShell, launch, pageWhere } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

/** One of Apple's listed sites, served here. */
const HOST = 'usaa.com';
const PASSPHRASE = 'correct horse battery staple';
const ADA = 'ada@acme-e2e.dev';
const ADA_PASSWORD = 'Zq9-code-Sekrit';
const GRACE = 'grace@acme-e2e.dev';
/** Grace's own password ends in 6 digits: no code in it. */
const GRACE_PASSWORD = 'Zq9-mine-Sekrit123456';

const SIGN_IN =
  '<!doctype html><title>Sign in</title><h1>Sign in</h1><form action="/session" method="post"><input id="u" name="username" aria-label="Username" autocomplete="username"><input id="p" name="password" type="password" aria-label="Password" autocomplete="current-password"><button id="go">Sign in</button></form>';
const WELCOME = '<!doctype html><title>Welcome</title><p>Signed in.</p>';

const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Site {
  server: Server;
  port: number;
}
function startSite(): Promise<Site> {
  const dir = mkdtempSync(join(tmpdir(), 'chord-e2e-code-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  rmSync(dir, { recursive: true, force: true });
  const server = createServer(tls, (req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(WELCOME);
      });
      return;
    }
    const page = req.url === '/login' ? SIGN_IN : null;
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? 'not found');
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as AddressInfo).port })));
}

let site: Site;
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test('passwords: a code after the password on a listed site is left off, unless you keep it', async () => {
  test.setTimeout(180_000);
  const host = HOST;
  const origin = `https://${host}`;
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-code-'));
  const app = await launch(
    { CHORD_HOME_URL: `${origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' },
    { profile, args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${site.port}`, '--ignore-certificate-errors'] },
  );
  try {
    await pageWhere(app, isShell);
    const page = await pageWhere(app, (u) => u.startsWith(`${origin}/login`));
    const popover = await pageWhere(app, isCards);
    const save = popover.getByRole('dialog', { name: `Save this password for ${host}?` });
    const signIn = async (p: Page, username: string, password: string) => {
      await p.goto(`${origin}/login`);
      await p.fill('#u', username);
      await p.fill('#p', password);
      await p.click('#go');
      await p.waitForURL(`${origin}/session`);
    };
    /** What the menu fills for an account: what was saved for it. */
    const filled = async (username: string) => {
      await page.goto(`${origin}/login`);
      await page.focus('#u');
      const menu = (await pageWhere(app, isMenu)).getByRole('listbox', { name: `Passwords for ${host}` });
      await expect(menu).toBeVisible({ timeout: 10_000 });
      await menu.getByRole('option', { name: username }).click();
      await expect(page.locator('#u')).toHaveValue(username);
      return page.locator('#p').inputValue();
    };
    const vault = () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: { passwordsCount(): Promise<{ state: string; count: number }> } }).chordTestHooks.passwordsCount());

    // 1. The first save on the site (it chooses the passphrase too): typed with a code, saved without it.
    await signIn(page, ADA, `${ADA_PASSWORD}482913`);
    await expect(save).toBeVisible({ timeout: 15_000 });
    await expect(save.getByText('This site takes a sign-in code after the password, so Chord left off the last 6 digits.')).toBeVisible();
    await expect(save.getByRole('button', { name: 'Keep them' })).toBeVisible();
    await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await save.getByLabel('Again').fill(PASSPHRASE);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save).toHaveCount(0, { timeout: 15_000 });
    expect(await vault()).toEqual({ state: 'open', count: 1 });
    expect(await filled(ADA)).toBe(ADA_PASSWORD);

    // 2. The same password with the next code: nothing to save or update.
    await signIn(page, ADA, `${ADA_PASSWORD}607114`);
    await page.waitForTimeout(3000);
    await expect(popover.getByRole('dialog')).toHaveCount(0);

    // 3. Grace's password really ends in 6 digits: the eye shows what Save would save, then Keep them, then Save.
    await signIn(page, GRACE, GRACE_PASSWORD);
    await expect(save).toBeVisible({ timeout: 15_000 });
    await save.getByRole('button', { name: 'Show password' }).click();
    await expect(save.getByText('Zq9-mine-Sekrit', { exact: true })).toBeVisible();
    await save.getByRole('button', { name: 'Keep them' }).click();
    await expect(save.getByText('Chord will save the password as you typed it.')).toBeVisible();
    await expect(save.getByRole('button', { name: 'Leave off the code' })).toBeVisible();
    await expect(save.getByText(GRACE_PASSWORD, { exact: true })).toBeVisible();
    // Nothing is saved until Save.
    expect(await vault()).toEqual({ state: 'open', count: 1 });
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save).toHaveCount(0, { timeout: 15_000 });
    expect(await vault()).toEqual({ state: 'open', count: 2 });
    expect(await filled(GRACE)).toBe(GRACE_PASSWORD);
    expect(await filled(ADA)).toBe(ADA_PASSWORD);
  } finally {
    await app.close();
  }
});
