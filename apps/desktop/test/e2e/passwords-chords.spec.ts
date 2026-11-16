/**
 * Settings → Passwords, each chord's own switch (docs/decisions/S17-passwords.md §11;
 * DESIGN.md §8.9): under *Offer to save and fill passwords*, one row per chord. A chord with a
 * known password manager installed shows its switch off and says which; turning it on there
 * takes effect at once, with no restart: the next sign-in gets the save card.
 *
 * Bitwarden stands in by its store id, recorded as installed with no files (a test hook): its
 * real package can't be signed here, and only the id counts.
 *
 * axe checks the rows, the reason line included, and they're captured.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { audit, capturesDir, expectClean, isPopover, isSettings, isShell, launch, pageWhere, runAction, type Finding } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const BITWARDEN = 'nngceckbapebfimnlniiiahkandclblb';
const USER = 'ada@acme-e2e.dev';
const PASSWORD = 'Zq9-chords-Sekrit';
/** Longer than main waits after a page stops loading to decide a sign-in (saving.ts, SETTLE_MS), and the card's ask after it. */
const SETTLE_WAIT_MS = 3000;

const SIGN_IN =
  '<title>Sign in</title><h1>Sign in to Acme</h1>' +
  '<form action="/session" method="post">' +
  '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">' +
  '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">' +
  '<button>Sign in</button></form>';

let server: Server;
let origin = '';
test.beforeAll(async () => {
  mkdirSync(capturesDir, { recursive: true });
  server = createServer((req, res) => {
    const page = req.method === 'POST' && req.url === '/session' ? '<title>Welcome</title><p>Signed in.</p>' : req.url === '/login' ? SIGN_IN : null;
    if (req.method === 'POST') req.resume();
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.fill('#u', USER);
  await page.fill('#p', PASSWORD);
  await page.press('#p', 'Enter');
  await page.waitForURL(`${origin}/session`);
}

test('passwords: a chord with a password manager shows its switch off and says why; turned on, the next sign-in is offered a save', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-chords-'));
  const app = await launch({ CHORD_HOME_URL: `${origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  const findings: Finding[] = [];
  try {
    const shell = await pageWhere(app, isShell);
    const page = await pageWhere(app, (u) => u.startsWith(`${origin}/login`));
    const popover = await pageWhere(app, (u) => isPopover(u) && !u.includes('#'));
    const chordName = await app.evaluate(
      (_electron, [id, name]) => (globalThis as unknown as { chordTestHooks: { recordExtensionForTests(id: string, name: string): string } }).chordTestHooks.recordExtensionForTests(id, name),
      [BITWARDEN, 'Bitwarden'] as const,
    );

    // Settings → Passwords: the main switch on, and under it the chord's own, off, saying why.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
    const main = settings.getByRole('main');
    const all = main.getByRole('switch', { name: 'Offer to save and fill passwords' });
    await expect(all).toHaveAttribute('aria-checked', 'true');
    await expect(all).toHaveAccessibleDescription('In each chord below.');
    const chords = main.getByRole('group', { name: 'Offer to save and fill passwords' });
    const own = chords.getByRole('switch', { name: chordName, exact: true });
    await expect(own).toHaveAttribute('aria-checked', 'false');
    await expect(own).toHaveAccessibleDescription('Off: Bitwarden is installed here.');
    // The old one-line notice and its link are gone.
    await expect(main.getByRole('button', { name: 'Turn on there too' })).toHaveCount(0);
    findings.push(...(await audit(settings, 'Settings → Passwords, a chord off for Bitwarden', { appearance: 'light' })));
    await main.getByRole('group', { name: 'Offer to save and fill passwords' }).screenshot({ path: resolve(capturesDir, 'passwords-chords-light.png') });

    // Off there: a sign-in is offered nothing.
    await signIn(page);
    await page.waitForTimeout(SETTLE_WAIT_MS);
    await expect(popover.getByRole('dialog')).toHaveCount(0);

    // With the main switch off, the chord's switch can't be used; on again, it's as it was.
    await all.click();
    await expect(own).toBeDisabled();
    await all.click();
    await expect(own).toBeEnabled();

    // Turned on there: the reason goes, and the next sign-in (no restart) gets the save card.
    await own.click();
    await expect(own).toHaveAttribute('aria-checked', 'true');
    await expect(main.getByText('Off: Bitwarden is installed here.')).toHaveCount(0);
    await signIn(page);
    await expect(popover.getByRole('dialog', { name: `Save this password for ${new URL(origin).host}?` })).toBeVisible({ timeout: 15_000 });

    expectClean(findings);
  } finally {
    await app.close();
  }
});
