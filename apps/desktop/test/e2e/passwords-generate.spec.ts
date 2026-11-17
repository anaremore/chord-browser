/**
 * Phase 2 of Chord's passwords (docs/decisions/S17-passwords.md §6, §9, §13 layer 3): the generator, sign-up and
 * change forms, as the owner designed them (2026-11-17, options 3A–6A). One journey against a small site that records
 * what each form posted, with a fresh profile and no keyring (so the vault starts with no passphrase):
 *
 * 1. **Sign up with Chord's password, no vault yet.** The new password's field opens the menu: *Use a strong
 *    password* first, the password in mono, the site's `passwordrules` in words. ↻ by Ctrl+Shift+K (⇧⌘K) makes
 *    another; Enter takes it. With no vault, the save card chooses the passphrase first; then the password is saved
 *    (*Not confirmed*) and filled into the new field and the confirmation's, meeting the site's rules, before any submit.
 * 2. **The submit works.** The site got that password, and the saved card says so: *Your new password … is saved.*
 * 3. **The sign-in form** lists the account, confirmed, and fills it.
 * 4. **A change form** with the current password: Chord's password for the new one; the account is matched by the
 *    current field, and the update card updates it. The next sign-in fills the new one.
 * 5. **A presave never submitted** is in Settings → Passwords as *Not confirmed*, in place of the date.
 *
 * axe checks the menu with the generator's row, the saved card and the update card; each is captured.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { audit, capturesDir, expectClean, isPopover, isSettings, isShell, launch, pageWhere, pressReal, runAction, type Finding } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@example.com';
const PASSPHRASE = 'correct horse battery staple';
/** The site's rules, on its new password's field (Apple's language): letters and digits, 12 to 16. */
const RULES = 'minlength: 12; maxlength: 16; required: lower; required: upper; required: digit; allowed: lower, upper, digit;';

const page = (title: string, body: string) => `<title>${title}</title><style>body { margin: 40px; } label, input { display: block; }</style>${body}`;
const SIGN_UP = page(
  'Create your account',
  '<h1>Create your account</h1><form id="f" action="/signup" method="post">' +
    '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">' +
    `<label for="n">Choose a password</label><input id="n" name="password" type="password" autocomplete="new-password" passwordrules="${RULES}">` +
    '<label for="c">Confirm password</label><input id="c" name="confirm" type="password" autocomplete="new-password">' +
    '<button id="go">Sign up</button></form>',
);
const SIGN_IN = page(
  'Sign in',
  '<h1>Sign in</h1><form id="f" action="/session" method="post">' +
    '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">' +
    '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">' +
    '<button id="go">Sign in</button></form>',
);
const CHANGE = page(
  'Change your password',
  '<h1>Change your password</h1><form id="f" action="/change" method="post">' +
    '<label for="o">Current password</label><input id="o" name="current" type="password" autocomplete="current-password">' +
    '<label for="n">New password</label><input id="n" name="password" type="password" autocomplete="new-password">' +
    '<label for="c">Confirm new password</label><input id="c" name="confirm" type="password" autocomplete="new-password">' +
    '<button id="go">Change password</button></form>',
);
const DONE = page('Done', '<p>Done.</p>');

const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Recorder {
  server: Server;
  origin: string;
  host: string;
  posts: { path: string; form: Record<string, string> }[];
}

function startRecorder(): Promise<Recorder> {
  const posts: Recorder['posts'] = [];
  const pages: Record<string, string> = { '/signup': SIGN_UP, '/login': SIGN_IN, '/change': CHANGE };
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        posts.push({ path: req.url ?? '', form: Object.fromEntries(new URLSearchParams(body)) });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DONE);
      });
      return;
    }
    const html = pages[req.url ?? ''];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'not found');
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ server, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, posts });
    }),
  );
}

let site: Recorder;
test.beforeAll(async () => {
  site = await startRecorder();
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

const hooks = (app: ElectronApplication) => ({
  events: () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: { passwordEvents(): Record<string, unknown>[] } }).chordTestHooks.passwordEvents()),
});

test('passwords: generate on a sign-up with no vault yet, confirm it, fill it, change it; a presave never submitted is Not confirmed', async () => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-generate-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/signup`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  const findings: Finding[] = [];
  const press = (path: string, key: string, modifiers: string[] = []) => pressReal(app, `${site.origin}${path}`, key, modifiers);
  const regenerate = process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'];
  try {
    const shell = await pageWhere(app, isShell);
    let tab = await pageWhere(app, (u) => u.startsWith(`${site.origin}/signup`));
    const popover = await pageWhere(app, isCards);
    const { events } = hooks(app);

    // 1. The new password's field: the generator's row first, the site's rules in words.
    await tab.fill('#u', USER);
    await tab.focus('#n');
    const menuPage = await pageWhere(app, isMenu);
    const menu = menuPage.getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    const row = menu.getByRole('option').first();
    await expect(row).toContainText('Use a strong password');
    await expect(row).toContainText('Letters and digits, 12–16, as this site asks');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(menu.getByRole('option').last()).toHaveAccessibleName('Other passwords…');
    const shown = async () => (await row.locator('[translate="no"]').textContent())!;
    const first = await shown();
    expect(first).toMatch(/^[A-Za-z0-9]{16}$/);
    findings.push(...(await audit(menuPage, 'the menu with the generator’s row', { appearance: 'light' })));
    await menuPage.locator('body').screenshot({ path: resolve(capturesDir, 'passwords-generate-menu-light.png') });
    // ↻ by its key: another password, and the page never sees the key.
    await expect(menuPage.getByRole('button', { name: /^Another password \((Ctrl\+Shift\+K|⇧⌘K)\)$/ })).toBeVisible();
    await tab.evaluate(() => {
      const w = window as unknown as { keys: string[] };
      w.keys = [];
      document.addEventListener('keydown', (e) => w.keys.push(e.key), true);
    });
    await press('/signup', 'K', regenerate);
    await expect.poll(shown).not.toBe(first);
    const generated = await shown();
    expect(await tab.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);

    // Enter: no vault yet, so the save card chooses the passphrase; nothing is filled until it's saved.
    await tab.waitForTimeout(600);
    await press('/signup', 'Enter');
    const setupCard = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(setupCard).toBeVisible({ timeout: 10_000 });
    await expect(tab.locator('#n')).toHaveValue('');
    await setupCard.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await setupCard.getByLabel('Again').fill(PASSPHRASE);
    await setupCard.getByRole('button', { name: 'Save' }).click();
    await expect(tab.locator('#n')).toHaveValue(generated, { timeout: 10_000 });
    await expect(tab.locator('#c')).toHaveValue(generated);
    await expect(tab.locator('#u')).toHaveValue(USER);
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible();
    // Nothing the detector reported holds it.
    expect(JSON.stringify(await events())).not.toContain(generated);

    // 2. The submit works: the site got it, and the saved card says so.
    await tab.click('#go');
    await tab.waitForURL(`${site.origin}/signup`);
    expect(site.posts.at(-1)).toEqual({ path: '/signup', form: { email: USER, password: generated, confirm: generated } });
    const saved = popover.getByRole('dialog', { name: `Your new password for ${site.host} is saved.` });
    await expect(saved).toBeVisible({ timeout: 15_000 });
    await expect(saved).toContainText(USER);
    await expect(saved).not.toContainText(generated);
    findings.push(...(await audit(popover, 'the saved card', { appearance: 'light' })));
    await saved.screenshot({ path: resolve(capturesDir, 'passwords-generate-saved-light.png') });
    await saved.getByRole('button', { name: 'Done' }).click();
    await expect(saved).toHaveCount(0);

    // 3. The sign-in form lists the account, confirmed, and fills it.
    tab = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await tab.goto(`${site.origin}/login`);
    await tab.focus('#u');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByRole('option', { name: USER })).toBeVisible();
    await expect(menu).not.toContainText('Not confirmed');
    await menu.getByRole('option', { name: USER }).click();
    await expect(tab.locator('#p')).toHaveValue(generated);

    // 4. A change form: the account found by its current password, the new one Chord's, Update.
    await tab.goto(`${site.origin}/change`);
    await tab.fill('#o', generated);
    await tab.focus('#n');
    await expect(menu.getByRole('option').first()).toContainText('Use a strong password', { timeout: 10_000 });
    // The accounts follow it.
    await expect(menu.getByRole('option', { name: USER })).toBeVisible();
    const next = await shown();
    // The generator's row takes no Enter in its first moments (durations.promptInputDelay).
    await tab.waitForTimeout(600);
    await press('/change', 'Enter');
    await expect(tab.locator('#n')).toHaveValue(next, { timeout: 10_000 });
    await expect(tab.locator('#c')).toHaveValue(next);
    await expect(tab.locator('#o')).toHaveValue(generated);
    await tab.click('#go');
    await tab.waitForURL(`${site.origin}/change`);
    expect(site.posts.at(-1)).toEqual({ path: '/change', form: { current: generated, password: next, confirm: next } });
    const update = popover.getByRole('dialog', { name: `Update the password for ${USER}?` });
    await expect(update).toBeVisible({ timeout: 15_000 });
    findings.push(...(await audit(popover, 'the update card after a change', { appearance: 'light' })));
    await update.screenshot({ path: resolve(capturesDir, 'passwords-generate-change-light.png') });
    await update.getByRole('button', { name: 'Update' }).click();
    await expect(update).toHaveCount(0);
    await tab.goto(`${site.origin}/login`);
    await tab.focus('#u');
    await expect(menu.getByRole('option', { name: USER })).toBeVisible({ timeout: 10_000 });
    // One account still: the change's presave went with the update.
    await expect(menu.getByRole('option')).toHaveCount(2);
    await menu.getByRole('option', { name: USER }).click();
    await expect(tab.locator('#p')).toHaveValue(next);

    // 5. A presave never submitted: in Settings, Not confirmed in place of the date.
    await tab.goto(`${site.origin}/signup`);
    await tab.focus('#n');
    await expect(menu.getByRole('option').first()).toContainText('Use a strong password', { timeout: 10_000 });
    await tab.waitForTimeout(600);
    await press('/signup', 'Enter');
    await expect(tab.locator('#n')).not.toHaveValue('', { timeout: 10_000 });
    await tab.goto(`${site.origin}/login`);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
    const list = settings.getByRole('main').getByRole('list', { name: 'Saved passwords' });
    await expect(list).toContainText('No username yet');
    await expect(list).toContainText('Not confirmed');
    await settings.getByRole('main').screenshot({ path: resolve(capturesDir, 'passwords-generate-not-confirmed-light.png') });
  } finally {
    await app.close();
  }
  expectClean(findings);
});
