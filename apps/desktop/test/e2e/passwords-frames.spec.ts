/**
 * Passwords in a same-origin frame (S17 phase 3C), end to end with the real sentinel, agent and main: the tab's page
 * holds only a frame of its own origin, and test/fixtures/passwords/frame-sign-in.html, in that frame, is the sign-in.
 *
 * 1. **The sentinel wakes on the frame's password field** (the preload runs in the top frame only, and looks into the
 *    frames it may use at load). The first sign-in, typed in the frame, posted by the frame's script, which sends the
 *    tab on, is saved from the card, which offers the email.
 * 2. **The menu under the frame's field** offers the account; Enter fills both fields in the frame, the frame's own
 *    script reads them, and the server gets them.
 * 3. **The sentinel's frame cap counts usable frames only** (review round 2 of #67): 25 other sites' frames ahead of the
 *    login frame, and it still wakes on the login frame's field.
 * 4. **A frame loaded sandboxed, its attribute removed at its load** (P3a, the real sentinel's record): the agent is
 *    awake on the page's own field, and the frame's sign-in gets no menu and sends nothing.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { isPopover, isShell, launch, pageWhere, pressReal } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@acme-e2e.dev';
const PASSWORD = 'Zq9-frame-Sekrit';
const PASSPHRASE = 'correct horse battery staple';
const FRAME = readFileSync(resolve(import.meta.dirname, '../fixtures/passwords/frame-sign-in.html'), 'utf8');
const LOGIN = '<!doctype html><title>Sign in</title><h1>Sign in</h1><iframe id="fr" src="/frame" style="width:420px;height:260px;border:0"></iframe>';
const HOME = '<title>Home</title><p>Signed in.</p>';

const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
/** Runs `code` in the page's world 4440 (the agent's), from main. */
const inAgentWorld = (app: ElectronApplication, url: string, code: string) =>
  app.evaluate(({ webContents }, [u, c]) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(u))!.executeJavaScriptInIsolatedWorld(4440, [{ code: c }]), [url, code] as const);
interface Hooks {
  passwordEvents(): Record<string, unknown>[];
  clearPasswordEvents(): void;
}
const types = async (app: ElectronApplication) => (await app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.passwordEvents())).map((e) => e['type']);
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Site {
  server: Server;
  origin: string;
  host: string;
  posts: Record<string, string>[];
}

/** GET /login holds the frame, GET /frame is the fixture, POST /session records what was posted, GET /home is after. */
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
    const page = req.url === '/login' ? LOGIN : req.url === '/frame' ? FRAME : req.url === '/home' ? HOME : req.url === '/ads-login' ? ADS_LOGIN() : req.url === '/sandboxed-login' ? SANDBOXED_LOGIN : null;
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
/** Another site (another port, so another origin): its ad frames. */
let ads: Server;
let adsOrigin = '';
test.beforeAll(async () => {
  site = await startSite();
  ads = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><p>Ad</p>');
  });
  await new Promise<void>((done) => ads.listen(0, '127.0.0.1', () => done()));
  adsOrigin = `http://127.0.0.1:${(ads.address() as AddressInfo).port}`;
});
test.afterAll(() => {
  site.server.close();
  ads.close();
});
/** 25 other sites' frames, then the login frame. */
const ADS_LOGIN = () =>
  `<!doctype html><title>Sign in</title><h1>Sign in</h1>${`<iframe src="${adsOrigin}/ad" style="width:60px;height:30px"></iframe>`.repeat(25)}<iframe id="fr" src="/frame" style="width:420px;height:260px;border:0"></iframe>`;
/** The page's own sign-in, and a frame loaded sandboxed whose attribute goes at its load. */
const SANDBOXED_LOGIN =
  '<!doctype html><title>Sign in</title><form><input id="own" type="password" aria-label="Password"></form><iframe id="fr" src="/frame" sandbox="allow-same-origin allow-scripts allow-forms" onload="this.removeAttribute(\'sandbox\')" style="width:420px;height:260px;border:0"></iframe>';

test('passwords: a sign-in form in a same-origin frame is saved and filled', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-frames-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    let page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    const popover = await pageWhere(app, isCards);
    const frame = page.frameLocator('#fr');

    // 1. Typed in the frame: the page's own tree has no field at all; the sentinel found the frame's at load.
    expect(await page.evaluate(() => document.querySelector('input'))).toBeNull();
    await frame.locator('#email').click();
    await page.waitForTimeout(300);
    await frame.locator('#email').fill(USER);
    await frame.locator('#password').fill(PASSWORD);
    await frame.locator('#go').click();
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

    // 2. Back on the form: the menu under the frame's email offers the account; Enter fills both, in the frame.
    page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await page.goto(`${site.origin}/login`);
    await page.frameLocator('#fr').locator('#email').click();
    const menu = (await pageWhere(app, isMenu)).getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    await pressReal(app, `${site.origin}/login`, 'Enter');
    await expect(page.frameLocator('#fr').locator('#email')).toHaveValue(USER);
    await expect(page.frameLocator('#fr').locator('#password')).toHaveValue(PASSWORD);
    await expect(menu).toHaveCount(0);
    // The frame's own script reads them and posts them.
    await page.frameLocator('#fr').locator('#go').click();
    await page.waitForURL(`${site.origin}/home`);
    expect(site.posts.at(-1)).toEqual({ email: USER, password: PASSWORD });
  } finally {
    await app.close();
  }
});

test('passwords: 25 other sites’ frames ahead of a same-origin login frame, and one loaded sandboxed: the sentinel’s frame look', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-frames-look-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/ads-login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    // 3. The page's own tree has no field; the login frame comes after 25 others: the sentinel still wakes the agent.
    await pageWhere(app, (u) => u.startsWith(`${site.origin}/ads-login`));
    await expect.poll(() => inAgentWorld(app, `${site.origin}/ads-login`, 'typeof chordPasswords'), { timeout: 10_000 }).toBe('object');

    // 4. A frame loaded sandboxed, its attribute removed at its load: still sandboxed, and never used.
    const page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await page.goto(`${site.origin}/sandboxed-login`);
    await expect.poll(() => inAgentWorld(app, `${site.origin}/sandboxed-login`, 'typeof chordPasswords'), { timeout: 10_000 }).toBe('object');
    expect(await page.evaluate(() => document.getElementById('fr')!.hasAttribute('sandbox'))).toBe(false);
    const frame = page.frameLocator('#fr');
    await frame.locator('#email').click();
    await frame.locator('#email').fill(USER);
    await frame.locator('#password').fill(PASSWORD);
    await frame.locator('#password').press('Enter');
    await page.waitForTimeout(2000);
    expect(await types(app)).not.toContain('submitted');
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().endsWith('#menu') && w.isFocused()))).toBe(false);
  } finally {
    await app.close();
  }
});
