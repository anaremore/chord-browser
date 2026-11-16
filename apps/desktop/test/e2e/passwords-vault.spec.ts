/**
 * Chord's own passwords, the vault (docs/decisions/S17-passwords.md §7, §9,
 * §13 layer 3), end to end, in light and dark:
 *
 * 1. Settings → Passwords with nothing saved: *Add a password…* asks for the
 *    passphrase too, since the first password sets it. The row opens to Show
 *    and Copy (no passphrase again: it was typed a moment ago); Copy puts it on
 *    the clipboard and never in the page; Delete has Undo. chord.db and its
 *    write-ahead log, searched as bytes, hold neither the password nor the
 *    username nor the site. Lock now locks.
 * 2. Relaunched, the vault is locked. The unlock card shows at the top of
 *    the tab (as the menu under a field will ask for it); a wrong passphrase
 *    says so and keeps the card, the right one opens the vault and the card goes.
 *
 * axe checks Settings → Passwords and the card, and each is captured.
 * The menu under the field, filling and the save cards come with the
 * detector (phase 1's other half), so this spec stops at the vault.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { audit, capturesDir, closeSettings, expectClean, isPopover, isSettings, isShell, launch, pageWhere, runAction, startSite, type Finding, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const PASSPHRASE = 'correct horse battery staple';
const PASSWORD = 'Zq9-hunter2-Sekrit';
const USERNAME = 'ada@acme-e2e.dev';
const SITE = 'https://vault-e2e.example';

let site: Site;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>Home page</title><p>Home</p>' });
  mkdirSync(capturesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

async function chord(profile: string, mode: 'light' | 'dark'): Promise<{ app: ElectronApplication; shell: Page }> {
  // No keyring on any system (a development build's switch), as on Linux without one: nothing keeps the key, so a
  // relaunch is locked, and the card doesn't offer to keep it unlocked.
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: mode, CHORD_E2E_NO_KEYRING: '1' }, { profile });
  return { app, shell: await pageWhere(app, isShell) };
}

async function openPasswords(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
  await expect(settings.getByRole('heading', { name: 'Passwords', level: 1 })).toBeVisible();
  return settings;
}

const readClipboard = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());

for (const mode of ['light', 'dark'] as const) {
  test(`passwords: the first one sets the passphrase; Show, Copy, Delete and Undo; never in chord.db's bytes; a relaunch is locked and the card unlocks it (${mode})`, async () => {
    test.setTimeout(150_000);
    const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-'));
    const findings: Finding[] = [];
    let { app, shell } = await chord(profile, mode);
    try {
      let settings = await openPasswords(app, shell);
      const main = settings.getByRole('main');
      await expect(main.getByText('No passwords yet. Sign in somewhere and Chord offers to keep it.')).toBeVisible();
      findings.push(...(await audit(settings, `Settings → Passwords, empty (${mode})`, { appearance: mode })));

      // The first password: its card asks for the passphrase as well.
      await main.getByRole('button', { name: 'Add a password…' }).click();
      const add = main.getByRole('form', { name: 'Add a password' });
      await add.getByLabel('Address').fill(SITE);
      await add.getByLabel('Username').fill(USERNAME);
      await add.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await expect(add.getByText('Choose a passphrase to lock your passwords. Chord can’t get it back for you.')).toBeVisible();
      await add.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
      await add.getByLabel('Again').fill('not the same');
      await add.getByLabel('Again').blur();
      await expect(add.getByText('The two don’t match.')).toBeVisible();
      findings.push(...(await audit(settings, `Settings → Passwords, adding the first (${mode})`, { appearance: mode })));
      await add.getByLabel('Again').fill(PASSPHRASE);
      await add.getByRole('button', { name: 'Save' }).click();

      const list = main.getByRole('list', { name: 'Saved passwords' });
      const row = list.getByRole('button', { name: /vault-e2e\.example/ });
      await expect(row).toContainText(USERNAME);
      await expect(row).toContainText('Today');
      await row.click();
      const detail = main.getByRole('group', { name: `vault-e2e.example, ${USERNAME}` });
      await expect(detail.getByRole('img', { name: 'Password hidden' })).toBeVisible();
      // Settings has no password until Show: none in the page now.
      expect(await settings.content()).not.toContain(PASSWORD);
      findings.push(...(await audit(settings, `Settings → Passwords, a row open (${mode})`, { appearance: mode })));

      // Show: typed a moment ago, so it doesn't ask again.
      await detail.getByRole('button', { name: 'Show password' }).click();
      await expect(detail.getByRole('textbox', { name: 'Password' })).toHaveValue(PASSWORD);
      await detail.getByRole('button', { name: 'Hide password' }).click();
      // Copy: on the clipboard, never in the page.
      await detail.getByRole('button', { name: 'Copy password' }).click();
      await expect(detail.getByText('It leaves the clipboard in a minute.')).toBeVisible();
      expect(await readClipboard(app)).toBe(PASSWORD);
      expect(await settings.content()).not.toContain(PASSWORD);
      await app.evaluate(({ clipboard }) => clipboard.writeText(''));

      // Delete, with Undo for the session.
      await detail.getByRole('button', { name: 'Delete' }).click();
      await expect(row).toHaveCount(0);
      const deleted = main.getByRole('status').filter({ hasText: 'Deleted vault-e2e.example' });
      await expect(deleted).toContainText(USERNAME);
      await deleted.getByRole('button', { name: 'Undo' }).click();
      await expect(row).toBeVisible();

      // chord.db and its log, as bytes: none of it in the clear.
      for (const file of ['chord.db', 'chord.db-wal']) {
        const path = join(profile, file);
        if (!existsSync(path)) continue;
        const bytes = readFileSync(path);
        for (const secret of [PASSWORD, USERNAME, 'vault-e2e', PASSPHRASE]) {
          expect(bytes.includes(Buffer.from(secret, 'utf8')), `${secret} in ${file}`).toBe(false);
          expect(bytes.includes(Buffer.from(secret, 'utf16le')), `${secret} (UTF-16) in ${file}`).toBe(false);
        }
      }

      // Lock now: the list goes, and the passphrase opens it again.
      await main.getByRole('button', { name: 'Lock now' }).click();
      await expect(main.getByText('Your passwords are locked.')).toBeVisible();
      await expect(list).toHaveCount(0);
      findings.push(...(await audit(settings, `Settings → Passwords, locked (${mode})`, { appearance: mode })));
      await closeSettings(app);
      await app.close();

      // Relaunched: locked, and the card at the top of the tab asks.
      ({ app, shell } = await chord(profile, mode));
      const popover = await pageWhere(app, isPopover);
      const asked = app.evaluate(() => (globalThis as unknown as { chordTestHooks: { passwordsAskUnlock(): Promise<boolean> } }).chordTestHooks.passwordsAskUnlock());
      const card = popover.getByRole('alertdialog', { name: 'Unlock passwords' });
      await expect(card).toBeVisible();
      // No keyring here: it doesn't offer to keep them unlocked.
      await expect(card.getByRole('switch')).toHaveCount(0);
      await expect(card.getByLabel('Passphrase')).toBeFocused();
      findings.push(...(await audit(popover, `the unlock card (${mode})`, { appearance: mode })));
      await card.getByLabel('Passphrase').fill('not the passphrase');
      await card.getByRole('button', { name: 'Unlock' }).click();
      await expect(card.getByRole('alert')).toHaveText('That isn’t the passphrase. Try again.');
      // Emptied and focused again: typing goes straight in, and a second wrong try does the same.
      await expect(card.getByLabel('Passphrase')).toBeFocused();
      await expect(card.getByLabel('Passphrase')).toHaveValue('');
      await card.getByLabel('Passphrase').pressSequentially('still not it');
      await card.getByLabel('Passphrase').press('Enter');
      await expect(card.getByLabel('Passphrase')).toBeFocused();
      await expect(card.getByLabel('Passphrase')).toHaveValue('');
      findings.push(...(await audit(popover, `the unlock card, a wrong passphrase (${mode})`, { appearance: mode })));
      await card.getByLabel('Passphrase').fill(PASSPHRASE);
      await card.getByRole('button', { name: 'Unlock' }).click();
      expect(await asked).toBe(true);
      await expect(card).toHaveCount(0);

      // Open now: Settings lists it again.
      settings = await openPasswords(app, shell);
      await expect(settings.getByRole('main').getByRole('list', { name: 'Saved passwords' })).toContainText(USERNAME);
    } finally {
      await app.close();
    }
    expectClean(findings);
  });
}

/** A sign-in's last change, set as if it were made then (Settings shows *Today*, *Yesterday*, *Nov 2*). */
function dated(profile: string, dates: number[]): void {
  const db = new DatabaseSync(join(profile, 'chord.db'));
  try {
    const ids = (db.prepare('SELECT id FROM login ORDER BY rowid').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(dates.length);
    ids.forEach((id, i) => db.prepare('UPDATE login SET updated_at = ? WHERE id = ?').run(dates[i]!, id));
    expect((db.prepare('SELECT updated_at AS at FROM login ORDER BY rowid').all() as { at: number }[]).map((r) => r.at)).toEqual(dates);
  } finally {
    db.close();
  }
}

for (const mode of ['light', 'dark'] as const) {
  test(`passwords, the captures: Settings with sign-ins, Keep unlocked, locked; the unlock card with its switch and a wrong passphrase (${mode})`, async () => {
    test.setTimeout(120_000);
    const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-'));
    // A keyring that's there (a stand-in, in memory), so Keep unlocked is offered, as on most computers.
    const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: mode, CHORD_E2E_TEST_KEYRING: '1' }, { profile });
    const findings: Finding[] = [];
    try {
      const shell = await pageWhere(app, isShell);
      const settings = await openPasswords(app, shell);
      // Tall enough for the whole section, as the mock draws it.
      await app.evaluate(({ BaseWindow }) => {
        const w = BaseWindow.getAllWindows().find((b) => b.getTitle() === 'Chord Settings')!;
        w.setSize(w.getSize()[0]!, 1040);
      });
      await settings.evaluate(async (passphrase) => {
        const chord = (window as unknown as { chord: { passwords: { setup(p: string): Promise<unknown>; add(l: unknown): Promise<unknown> } } }).chord;
        await chord.passwords.setup(passphrase);
        await chord.passwords.add({ origin: 'https://github.com', username: 'ada@acme.dev', password: 'gh-Zq9-hunter2', note: '' });
        await chord.passwords.add({ origin: 'https://linear.app', username: 'ada@acme.dev', password: 'ln-Zq9-hunter2', note: '' });
        await chord.passwords.add({ origin: 'https://news.ycombinator.com', username: 'adal', password: 'hn-Zq9-hunter2', note: '' });
      }, PASSPHRASE);
      const now = Date.now();
      dated(profile, [now, now - 86_400_000, new Date(new Date(now).getFullYear(), 10, 2, 12).getTime()]);
      // Settings asks for its view again when its window comes to the front.
      await settings.evaluate(() => window.dispatchEvent(new Event('focus')));
      const main = settings.getByRole('main');
      const list = main.getByRole('list', { name: 'Saved passwords' });
      await expect(list.getByRole('button')).toHaveCount(3);
      await expect(list.getByRole('button', { name: /linear\.app/ })).toContainText('Yesterday');
      await expect(list.getByRole('button', { name: /news\.ycombinator\.com/ })).toContainText('Nov 2');
      await list.getByRole('button', { name: /github\.com/ }).click();
      // Keep unlocked is offered, off, with what it gives up.
      await expect(main.getByRole('switch', { name: 'Keep unlocked on this computer' })).toHaveAttribute('aria-checked', 'false');
      await expect(main.getByText('Then other programs you run could read your passwords, on Windows and Linux.')).toBeVisible();
      await settings.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
      findings.push(...(await audit(settings, `Settings → Passwords with sign-ins and a keyring (${mode})`, { appearance: mode })));
      await settings.screenshot({ path: resolve(capturesDir, `settings-passwords-${mode}.png`) });

      // Locked: the field, Unlock and Forgot it? in the Passphrase row.
      await main.getByRole('button', { name: 'Lock now' }).click();
      await expect(main.getByText('Your passwords are locked.')).toBeVisible();
      await expect(main.getByLabel('Passphrase')).toHaveCount(1);
      findings.push(...(await audit(settings, `Settings → Passwords, locked, with a keyring (${mode})`, { appearance: mode })));
      await settings.screenshot({ path: resolve(capturesDir, `settings-passwords-locked-${mode}.png`) });
      await closeSettings(app);

      // The card, with Keep unlocked offered and off.
      const popover = await pageWhere(app, isPopover);
      const asked = app.evaluate(() => (globalThis as unknown as { chordTestHooks: { passwordsAskUnlock(): Promise<boolean> } }).chordTestHooks.passwordsAskUnlock());
      const card = popover.getByRole('alertdialog', { name: 'Unlock passwords' });
      await expect(card.getByRole('switch', { name: 'Keep unlocked on this computer' })).toHaveAttribute('aria-checked', 'false');
      await expect(card.getByText('Then other programs you run could read your passwords, on Windows and Linux.')).toBeVisible();
      findings.push(...(await audit(popover, `the unlock card with a keyring (${mode})`, { appearance: mode })));
      await card.screenshot({ path: resolve(capturesDir, `passwords-unlock-${mode}.png`) });
      await card.getByLabel('Passphrase').fill('not the passphrase');
      await card.getByRole('button', { name: 'Unlock' }).click();
      await expect(card.getByRole('alert')).toBeVisible();
      await expect(card.getByLabel('Passphrase')).toBeFocused();
      await card.screenshot({ path: resolve(capturesDir, `passwords-unlock-wrong-${mode}.png`) });
      await card.getByLabel('Passphrase').fill(PASSPHRASE);
      await card.getByRole('button', { name: 'Unlock' }).click();
      expect(await asked).toBe(true);
    } finally {
      await app.close();
    }
    expectClean(findings);
  });
}
