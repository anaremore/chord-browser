/**
 * Chord's passwords where you use them (docs/decisions/S17-passwords.md §6, §9, §13 layer 3):
 * the menu under the field, filling, and the save cards, end to end against a small site that
 * records what each sign-in posted. One journey, in order, with a fresh profile and no keyring
 * (so the vault starts with no passphrase):
 *
 * 1. **Save, with the first passphrase.** A sign-in that worked gets the card, which chooses
 *    the passphrase too; Save, and the toast says where it went. The server got what was typed.
 * 2. **Offer and fill, by keys.** Focusing the username field opens the menu under it, with the
 *    account. ↓ ↑ Enter (pressed as Electron's own input, which reaches main's
 *    `before-input-event`, M0 §3) fill it: the page saw typing, and **none of the four keys**.
 *    Submitting what was filled offers nothing (it's what's saved).
 * 3. **Update.** The same username with a new password: *Update the password for…?*; its eye
 *    shows the new one. Update, and the next fill (a click on the row this time) fills that.
 * 4. **The menu and a card at once, ×, the key, and Never.** Another username: the save card,
 *    its username typed over; a link back to the form and a menu there leave the card as it was
 *    (the menu has a view of its own). × hides it, the key beside the address brings it back,
 *    *Never for this site* ends it, and the next sign-in there is offered nothing.
 * 5. **A private window** fills from the vault, and is never offered a save.
 *
 * And apart: the unlock card stays up, with what's typed in it, while the menu offers
 * *Unlock passwords*.
 *
 * axe checks the menu, the first-save card and the update card, and each is captured.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { audit, capturesDir, closeSettings, expectClean, isOverlay, isPopover, isSettings, isShell, launch, newPage, pageWhere, pressReal, runAction, type Finding } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@acme-e2e.dev';
const FIRST = 'Zq9-first-Sekrit';
const SECOND = 'Zq9-second-Sekrit';
const OTHER_USER = 'grace@acme-e2e.dev';
const PASSPHRASE = 'correct horse battery staple';
/** Longer than main waits after a page stops loading to decide a sign-in (saving.ts, SETTLE_MS), and the card's ask after it. */
const SETTLE_WAIT_MS = 3000;

/** The sign-in page: it records the keys and the typing its own script sees. */
const SIGN_IN =
  '<title>Sign in</title><style>body { margin: 40px; }</style><h1>Sign in to Acme</h1>' +
  '<form id="f" action="/session" method="post">' +
  '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">' +
  '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">' +
  '<button id="go">Sign in</button></form>' +
  '<script>window.seen = { keys: [], ups: [], presses: [], inputs: [] };' +
  "document.addEventListener('keydown', (e) => seen.keys.push(e.key), true);" +
  "document.addEventListener('keyup', (e) => seen.ups.push(e.key), true);" +
  "document.addEventListener('keypress', (e) => seen.presses.push(e.key), true);" +
  "document.addEventListener('input', (e) => seen.inputs.push(e.target.id), true);</script>";
// A link back to the form: the page's own navigation, which a save card stays through (yours, from the address bar, ends it).
const WELCOME = '<title>Welcome</title><p>Signed in.</p><a id="again" href="/login">Sign in again</a>';

/** The menu under a field has a view of its own, on the popover's page (`#menu`); the popover's cards are the other one. */
const isMenu = (url: string) => isPopover(url) && url.endsWith('#menu');
const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Recorder {
  server: Server;
  origin: string;
  host: string;
  posts: Record<string, string>[];
}

/** The site: GET /login is the form; POST /session records what was posted and shows a page without it. */
function startRecorder(): Promise<Recorder> {
  const posts: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        posts.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(WELCOME);
      });
      return;
    }
    const page = req.url === '/login' ? SIGN_IN : req.url === '/' ? '<title>Home</title><p>Home</p>' : null;
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

let site: Recorder;
test.beforeAll(async () => {
  site = await startRecorder();
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

interface Hooks {
  passwordEvents(): Record<string, unknown>[];
  clearPasswordEvents(): void;
}
const hooks = (app: ElectronApplication) => ({
  events: () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.passwordEvents()),
  clear: () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.clearPasswordEvents()),
});

/** Keys as Electron's own input to the page (`sendInputEvent`): they reach before-input-event, as a person's do. */
const press = (app: ElectronApplication, keyCode: string) => pressReal(app, `${site.origin}/login`, keyCode);

interface Seen {
  keys: string[];
  ups: string[];
  presses: string[];
  inputs: string[];
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: Seen }).seen);

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto(`${site.origin}/login`);
  await page.fill('#u', username);
  await page.fill('#p', password);
  await page.press('#p', 'Enter');
  await page.waitForURL(`${site.origin}/session`);
}

test('passwords: save with the first passphrase, fill by keys and by click, update, never; a private window fills and never saves', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-fill-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  const findings: Finding[] = [];
  try {
    const shell = await pageWhere(app, isShell);
    let page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    const popover = await pageWhere(app, isCards);
    const { events, clear } = hooks(app);

    // 1. A sign-in that worked, with no vault yet: the card offers to save it and chooses the passphrase.
    await signIn(page, USER, FIRST);
    expect(site.posts.at(-1)).toEqual({ email: USER, password: FIRST });
    const firstSave = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(firstSave).toBeVisible({ timeout: 15_000 });
    await expect(firstSave.getByLabel('Username')).toHaveValue(USER);
    await expect(firstSave.getByText('Choose a passphrase to lock your passwords. Chord can’t get it back for you.')).toBeVisible();
    // The card never takes focus, nor the menu under the field (its own view, `#menu`): the page keeps it (#200). The
    // window has the focus and the page has it within it, not merely nothing else (which a window behind would pass).
    // (Asked of main: Playwright emulates focus in each page it drives, so `document.hasFocus()` there says nothing.)
    // Polled: focus the OS gave one of them on its own goes back on main's next turn, which a check can run ahead of;
    // then again a second later, past anything the OS does after. Their focus log, if the page hasn't it.
    // Under headless Weston (CI's Wayland) no window ever reports focus, even after focus() (#340): there, the page
    // having it within the window is what can be checked.
    const pageHasKeys = () =>
      app.evaluate(
        ({ app: a, BaseWindow, webContents }, origin) =>
          (a.commandLine.getSwitchValue('ozone-platform') === 'wayland' || BaseWindow.getFocusedWindow() !== null) &&
          (webContents.getFocusedWebContents()?.getURL().startsWith(origin) ?? false),
        site.origin,
      );
    const keysOnPage = (when: string) =>
      expect
        .poll(pageHasKeys, { timeout: 3_000, message: `the page has the keyboard ${when}` })
        .toBe(true)
        .catch(async (error: unknown) => {
          const log = await app.evaluate(({ BaseWindow, webContents }) => ({
            events: (globalThis as unknown as { chordTestHooks: { cardFocus(): unknown } }).chordTestHooks.cardFocus(),
            windowFocused: BaseWindow.getFocusedWindow() !== null,
            focused: webContents.getFocusedWebContents()?.getURL().replace(/^[a-z-]+:\/\/[^/]*/, '') ?? null,
          }));
          throw new Error(`${String(error)}\nthe floating views' focus: ${JSON.stringify(log)}`, { cause: error });
        });
    await keysOnPage('as the save card shows');
    await page.waitForTimeout(1_000);
    await keysOnPage('a second later');
    findings.push(...(await audit(popover, 'the first save card', { appearance: 'light' })));
    await firstSave.screenshot({ path: resolve(capturesDir, 'passwords-save-first-light.png') });
    await firstSave.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await firstSave.getByLabel('Again').fill(PASSPHRASE);
    await firstSave.getByRole('button', { name: 'Save' }).click();
    await expect(firstSave).toHaveCount(0);
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible();
    // Nothing the detector reported to the test hook holds what was typed.
    expect(JSON.stringify(await events())).not.toContain(FIRST);

    // 2. Back on the form: focus opens the menu under the field, with the account and nothing else of it.
    page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/`));
    await page.goto(`${site.origin}/login`);
    await page.focus('#u');
    // Its own small view, made the first time a sign-in field takes focus in the window.
    const menuPage = await pageWhere(app, isMenu);
    const menu = menuPage.getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu).toBeVisible({ timeout: 10_000 });
    // By accessible name: the tinted initial beside each username is hidden from assistive tech.
    await expect(menu.getByRole('option')).toHaveCount(2);
    await expect(menu.getByRole('option').nth(0)).toHaveAccessibleName(USER);
    await expect(menu.getByRole('option').nth(1)).toHaveAccessibleName('Other passwords…');
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    // Plain HTTP on this computer (127.0.0.1) isn't called insecure (core's insecureOrigin); other http pages are, in the unit table.
    await expect(menuPage.getByText('This page isn’t secure')).toHaveCount(0);
    // Under the field: the card's top-left (inside the view's 12 px padding) is 4 px under the field's bottom-left.
    const placed = await app.evaluate(({ BaseWindow }, origin) => {
      for (const w of BaseWindow.getAllWindows()) {
        const views = w.contentView.children as Electron.WebContentsView[];
        const pop = views.find((v) => v.webContents?.getURL().endsWith('#menu'));
        const tab = views.find((v) => v.webContents?.getURL().startsWith(`${origin}/login`));
        if (pop && tab) return { pop: pop.getBounds(), tab: tab.getBounds(), zoom: tab.webContents.getZoomFactor() };
      }
      return null;
    }, site.origin);
    const field = await page.evaluate(() => {
      const r = document.getElementById('u')!.getBoundingClientRect();
      return { left: r.left, bottom: r.bottom };
    });
    expect(placed).not.toBeNull();
    expect(Math.abs(placed!.pop.x + 12 - (placed!.tab.x + field.left * placed!.zoom))).toBeLessThanOrEqual(1);
    expect(Math.abs(placed!.pop.y + 12 - (placed!.tab.y + field.bottom * placed!.zoom + 4))).toBeLessThanOrEqual(1);
    findings.push(...(await audit(menuPage, 'the menu under the field', { appearance: 'light' })));
    await menuPage.locator('body').screenshot({ path: resolve(capturesDir, 'passwords-menu-light.png') });
    // ↓ ↑ Enter: main's. The page sees none of them, and its field keeps the keyboard.
    await page.evaluate(() => ((window as unknown as { seen: Seen }).seen = { keys: [], ups: [], presses: [], inputs: [] }));
    await press(app, 'Down');
    await expect(menu.getByRole('option', { name: 'Other passwords…' })).toHaveAttribute('aria-selected', 'true');
    await press(app, 'Up');
    await expect(menu.getByRole('option', { name: USER })).toHaveAttribute('aria-selected', 'true');
    await press(app, 'Enter');
    await expect(page.locator('#p')).toHaveValue(FIRST);
    await expect(page.locator('#u')).toHaveValue(USER);
    await expect(menu).toHaveCount(0);
    const afterFill = await seen(page);
    // Not even half a key: no keyup (a site's own suggestion list, a form that submits on Enter's keyup), no keypress.
    expect(afterFill.keys).toEqual([]);
    expect(afterFill.ups).toEqual([]);
    expect(afterFill.presses).toEqual([]);
    expect(afterFill.inputs).toEqual(['u', 'p']);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('u');
    // Submitting what was filled: it's what's saved, so nothing is offered, and the site got it.
    await clear();
    await page.click('#go');
    await page.waitForURL(`${site.origin}/session`);
    expect(site.posts.at(-1)).toEqual({ email: USER, password: FIRST });
    await expect.poll(async () => (await events()).map((e) => e['type']), { timeout: 15_000 }).toContain('signedIn');
    await page.waitForTimeout(SETTLE_WAIT_MS);
    await expect(popover.getByRole('dialog')).toHaveCount(0);

    // 3. The same username with a new password: the update card, and its eye shows the new one.
    await signIn(page, USER, SECOND);
    const update = popover.getByRole('dialog', { name: `Update the password for ${USER}?` });
    await expect(update).toBeVisible({ timeout: 15_000 });
    await update.getByRole('button', { name: 'Show password' }).click();
    await expect(update.getByText(SECOND)).toBeVisible();
    findings.push(...(await audit(popover, 'the update card, password shown', { appearance: 'light' })));
    await update.screenshot({ path: resolve(capturesDir, 'passwords-update-light.png') });
    await update.getByRole('button', { name: 'Hide password' }).click();
    await expect(update.getByText(SECOND)).toHaveCount(0);
    await update.getByRole('button', { name: 'Update' }).click();
    await expect(update).toHaveCount(0);
    // The next fill is the new password, by a click on the row this time.
    await page.goto(`${site.origin}/login`);
    await page.focus('#u');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await menu.getByRole('option', { name: USER }).click();
    await expect(page.locator('#p')).toHaveValue(SECOND);

    // 4. Another account on the same site: the save card, its username typed over.
    await signIn(page, OTHER_USER, 'Zq9-grace-Sekrit');
    const save = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(save).toBeVisible({ timeout: 15_000 });
    findings.push(...(await audit(popover, 'the save card', { appearance: 'light' })));
    await save.screenshot({ path: resolve(capturesDir, 'passwords-save-light.png') });
    await save.getByLabel('Username').fill('grace.edited');
    // Back to the form by the page's own link (the card stays through it), and a menu there: the card is as it was.
    await page.click('#again');
    await page.waitForURL(`${site.origin}/login`);
    await page.focus('#u');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(save).toBeVisible();
    await expect(save.getByLabel('Username')).toHaveValue('grace.edited');
    await press(app, 'Escape');
    await expect(menu).toHaveCount(0);
    await expect(save.getByLabel('Username')).toHaveValue('grace.edited');
    // ×: the card hides, and the key beside the address brings it back.
    await save.getByRole('button', { name: 'Close' }).click();
    await expect(save).toHaveCount(0);
    const key = shell.getByRole('button', { name: 'Save password' }).filter({ visible: true });
    await expect(key).toBeVisible();
    await key.click();
    await expect(save).toBeVisible();
    await expect(key).toHaveCount(0);
    // Never for this site: the card, and the key, go for good; the next sign-in there is offered nothing.
    await save.getByRole('button', { name: 'Never for this site' }).click();
    await expect(save).toHaveCount(0);
    await clear();
    await signIn(page, OTHER_USER, 'Zq9-grace-again');
    await expect.poll(async () => (await events()).map((e) => e['type']), { timeout: 15_000 }).toContain('signedIn');
    await page.waitForTimeout(SETTLE_WAIT_MS);
    await expect(popover.getByRole('dialog')).toHaveCount(0);

    // 5. A private window: the menu fills from the vault, and a sign-in there is never offered a save.
    const overlay = await pageWhere(app, isOverlay);
    await runAction(shell, 'window.newPrivate');
    await newPage(app, isShell, [shell]);
    const privateOverlay = await newPage(app, isOverlay, [overlay]);
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('combobox').fill(`${site.origin}/login`);
    await privateOverlay.keyboard.press('Enter');
    const privatePopover = await newPage(app, isCards, [popover]);
    const privatePage = await newPage(app, (u) => u.startsWith(`${site.origin}/login`), [page]);
    await privatePage.waitForLoadState('domcontentloaded');
    await privatePage.focus('#u');
    const privateMenuPage = await newPage(app, isMenu, [menuPage]);
    const privateMenu = privateMenuPage.getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(privateMenu).toBeVisible({ timeout: 10_000 });
    await privateMenu.getByRole('option', { name: USER }).click();
    await expect(privatePage.locator('#p')).toHaveValue(SECOND);
    await clear();
    await privatePage.fill('#u', 'someone@private.example');
    await privatePage.fill('#p', 'Zq9-private-Sekrit');
    const pressedAt = await app.evaluate(() => Date.now());
    await privatePage.press('#p', 'Enter');
    await privatePage.waitForURL(`${site.origin}/session`);
    // Failure-only (#253, seen once on macOS arm64): what the detector reported, when (ms after Enter), and from which
    // contents, against the private page's own; and the page the submit left.
    await expect
      .poll(async () => (await events()).map((e) => e['type']), { timeout: 10_000 })
      .toContain('submitted')
      .catch(async (error: unknown) => {
        const seen = (await events()).map((e) => ({ ...e, at: typeof e['at'] === 'number' ? e['at'] - pressedAt : null }));
        const privateId = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().filter((c) => c.getURL().startsWith(origin)).map((c) => ({ id: c.id, url: c.getURL().slice(origin.length) })), site.origin);
        throw new Error(`${String(error)}
the detector's events since Enter: ${JSON.stringify(seen)}
the site's pages: ${JSON.stringify(privateId)}`, { cause: error });
      });
    await privatePage.waitForTimeout(SETTLE_WAIT_MS);
    expect((await events()).map((e) => e['type'])).not.toContain('signedIn');
    await expect(privatePopover.getByRole('dialog')).toHaveCount(0);
  } finally {
    await app.close();
  }
  expectClean(findings);
});

test('passwords: the unlock card stays up, with what’s typed in it, while the menu under the field offers Unlock passwords', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-unlock-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    // A vault with this site's account, locked.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.evaluate(
      async ({ passphrase, origin, username, password }) => {
        const chord = (window as unknown as { chord: { passwords: { setup(p: string): Promise<unknown>; add(l: unknown): Promise<unknown>; lock(): Promise<unknown> } } }).chord;
        await chord.passwords.setup(passphrase);
        await chord.passwords.add({ origin, username, password, note: '' });
        await chord.passwords.lock();
      },
      { passphrase: PASSPHRASE, origin: site.origin, username: USER, password: FIRST },
    );
    await closeSettings(app);

    // The unlock card at the top of the tab, half typed.
    const popover = await pageWhere(app, isCards);
    const asked = app.evaluate(() => (globalThis as unknown as { chordTestHooks: { passwordsAskUnlock(): Promise<boolean> } }).chordTestHooks.passwordsAskUnlock());
    const card = popover.getByRole('alertdialog', { name: 'Unlock passwords' });
    await expect(card).toBeVisible();
    await card.getByLabel('Passphrase').fill('half typed');

    // The field takes focus: the menu, in its own view, offers Unlock passwords; the card stays, with what's in it.
    const page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    await page.focus('#u');
    const menuPage = await pageWhere(app, isMenu);
    const menu = menuPage.getByRole('listbox', { name: `Passwords for ${site.host}` });
    await expect(menu.getByRole('option', { name: 'Unlock passwords' })).toBeVisible({ timeout: 10_000 });
    await expect(card).toBeVisible();
    await expect(card.getByLabel('Passphrase')).toHaveValue('half typed');
    // The menu closes; the card is still as it was.
    await press(app, 'Escape');
    await expect(menu).toHaveCount(0);
    await expect(card.getByLabel('Passphrase')).toHaveValue('half typed');
    await card.getByLabel('Passphrase').fill(PASSPHRASE);
    await card.getByRole('button', { name: 'Unlock' }).click();
    expect(await asked).toBe(true);
    await expect(card).toHaveCount(0);
  } finally {
    await app.close();
  }
});
