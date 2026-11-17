/**
 * Passwords in and out (docs/decisions/S17-passwords.md §10, phase 2), end
 * to end, as the owner's mock draws it (options 1C and 2A):
 *
 * 1. **A Chrome CSV into a vault with one sign-in:** the preview's *From*,
 *    *What comes in* and *Left out* (an app's row, a row with no address); the
 *    switch off, so yours is kept unless ticked; ticked, Import; the result
 *    line and the window's toast, each with Undo; Undo from the card puts the
 *    replaced one back. The same file again: nothing new.
 * 2. **Export:** a CSV in Chrome's shape (the passphrase was typed a moment
 *    ago, so no check), and Chord's encrypted file of passwords alone, with a
 *    passphrase of its own; neither file holds the vault's passphrase, and the
 *    encrypted one holds no password in the clear. That file comes back
 *    through Your data's import, its passwords row comparing them.
 * 3. **The large file:** a Bitwarden export of 6,240 rows (5,902 new, 210 the
 *    same, 118 different, 7 left out, 31 one-time codes, 3 repeated), *Review
 *    all* with its search, and the import's time from Import to its result.
 *
 * axe checks each state; the preview, the large one and the export card are captured.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { audit, capturesDir, expectClean, isSettings, isShell, launch, pageWhere, runAction, startSite, type Finding, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const PASSPHRASE = 'correct horse battery staple';

let site: Site;
let dir: string;
test.beforeAll(async () => {
  site = await startSite({ '/': '<title>Home page</title><p>Home</p>' });
  mkdirSync(capturesDir, { recursive: true });
  dir = mkdtempSync(join(tmpdir(), 'chord-e2e-password-files-'));
});
test.afterAll(() => site.server.close());

async function chord(mode: 'light' | 'dark'): Promise<{ app: ElectronApplication; shell: Page; settings: Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-transfer-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: mode, CHORD_E2E_NO_KEYRING: '1' }, { profile });
  const shell = await pageWhere(app, isShell);
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
  return { app, shell, settings };
}

/** The next open (or save) dialog answers with this path. */
const answerOpen = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
const answerSave = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);

/** The first password, by Add a password…, which chooses the passphrase too. */
async function firstPassword(settings: Page, origin: string, username: string, password: string): Promise<void> {
  const main = settings.getByRole('main');
  await main.getByRole('button', { name: 'Add a password…' }).click();
  const add = main.getByRole('form', { name: 'Add a password' });
  await add.getByLabel('Address').fill(origin);
  await add.getByLabel('Username').fill(username);
  await add.getByLabel('Password', { exact: true }).fill(password);
  await add.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await add.getByLabel('Again').fill(PASSPHRASE);
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(main.getByRole('list', { name: 'Saved passwords' })).toBeVisible();
}

const CHROME = [
  'name,url,username,password,note',
  'example.com,https://example.com/login,ada@example.com,Sekrit-new-1,',
  'shop.example.com,https://shop.example.com/,ada@example.com,Sekrit-file-2,from the file',
  'Home router,,admin,Sekrit-router,',
  'app,android://hash@com.example.app/,ada,Sekrit-app,',
  'example.com,https://example.com/login,ada@example.com,Sekrit-new-1,',
].join('\n');

for (const mode of ['light', 'dark'] as const) {
  test(`passwords: a CSV in with its preview, the file’s taken where ticked, Undo; exported as CSV and as Chord’s encrypted file, which comes back (${mode})`, async () => {
    test.setTimeout(180_000);
    const findings: Finding[] = [];
    const { app, shell, settings } = await chord(mode);
    try {
      const main = settings.getByRole('main');
      await firstPassword(settings, 'https://shop.example.com', 'ada@example.com', 'Sekrit-mine-2');

      // Import…: the dialog, then the preview.
      const file = join(dir, `Chrome Passwords ${mode}.csv`);
      writeFileSync(file, CHROME);
      await answerOpen(app, file);
      await main.getByRole('button', { name: 'Import…' }).click();
      const card = main.getByRole('group', { name: 'Import passwords' });
      await expect(card.getByText(`A Chrome, Edge or Brave export, 5 rows, from Chrome Passwords ${mode}.csv.`)).toBeVisible();
      await expect(card.getByText('New: 1 password. Different from yours: 1.')).toBeVisible();
      await expect(card.getByText('2 rows without a usable address:')).toBeVisible();
      await expect(card.getByText('Row 4: “Home router”, admin (no address)')).toBeVisible();
      await expect(card.getByText('Row 5: android://hash@com.example.app/, ada (an app, not a site)')).toBeVisible();
      await expect(card.getByText('1 row repeated a password already in the file; the later one counts.')).toBeVisible();
      // Keeping yours is the default; nothing of a password is on the page.
      const take = card.getByRole('switch', { name: 'Take the file’s where they differ' });
      await expect(take).toHaveAttribute('aria-checked', 'false');
      await expect(card.getByText('Off: yours stay as they are. Tick the ones to take.')).toBeVisible();
      expect(await settings.content()).not.toContain('Sekrit');
      findings.push(...(await audit(settings, `Passwords → Import, the preview (${mode})`, { appearance: mode })));
      await card.screenshot({ path: resolve(capturesDir, `passwords-import-preview-${mode}.png`) });

      // Ticked: the file's for that one.
      await card.getByRole('checkbox', { name: /shop\.example\.com · ada@example\.com/ }).check();
      await expect(take).toHaveAttribute('aria-checked', 'true');
      await card.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(card.getByText('Imported 1 password, and took the file’s for 1.')).toBeVisible({ timeout: 30_000 });
      await expect(shell.getByRole('group', { name: 'Imported 2 passwords' })).toBeVisible();
      await expect(main.getByRole('list', { name: 'Saved passwords' }).getByRole('button')).toHaveCount(2);
      findings.push(...(await audit(settings, `Passwords → Import, done (${mode})`, { appearance: mode })));

      // Undo, from the card: the replaced one comes back as it was.
      await card.getByRole('button', { name: 'Undo' }).click();
      await expect(card.getByText('Import undone. 1 replaced password came back as it was.')).toBeVisible();
      await expect(main.getByRole('list', { name: 'Saved passwords' }).getByRole('button')).toHaveCount(1);

      // The same file twice: in, then again: nothing new.
      await answerOpen(app, file);
      await card.getByRole('button', { name: 'Choose another file…' }).click();
      await card.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(card.getByText(/^Imported 1 password\.$/)).toBeVisible({ timeout: 30_000 });
      await answerOpen(app, file);
      await card.getByRole('button', { name: 'Choose another file…' }).click();
      await expect(card.getByText('New: 0 passwords. Same as yours: 1, left as they are. Different from yours: 1.')).toBeVisible();

      // Export… as a CSV: the passphrase was typed a moment ago, so it saves.
      await main.getByRole('button', { name: 'Import…' }).click();
      await main.getByRole('button', { name: 'Export…' }).click();
      const exporting = main.getByRole('group', { name: 'Export passwords' });
      await expect(exporting.getByRole('radio', { name: /Chord file, encrypted/ })).toHaveAttribute('aria-checked', 'true');
      await expect(exporting.getByText('Anyone with the file can read your passwords.')).toBeVisible();
      findings.push(...(await audit(settings, `Passwords → Export (${mode})`, { appearance: mode })));
      await exporting.screenshot({ path: resolve(capturesDir, `passwords-export-${mode}.png`) });
      await exporting.getByRole('radio', { name: /CSV/ }).click();
      const csvPath = join(dir, `Chord passwords ${mode}.csv`);
      await answerSave(app, csvPath);
      await exporting.getByRole('button', { name: 'Choose where to save…' }).click();
      await expect(main.getByText(`Saved Chord passwords ${mode}.csv, 2 passwords`)).toBeVisible();
      const exported = readFileSync(csvPath, 'utf8');
      expect(exported.split('\n')[0]).toBe('name,url,username,password,note');
      expect(exported).toContain('shop.example.com,https://shop.example.com/,ada@example.com,Sekrit-mine-2,');
      expect(exported).not.toContain(PASSPHRASE);

      // Export… as Chord's encrypted file: a passphrase of its own, suggested; no password in the clear.
      await main.getByRole('button', { name: 'Export…' }).click();
      await main.getByRole('button', { name: 'Export…' }).click();
      const again = main.getByRole('group', { name: 'Export passwords' });
      await again.getByRole('button', { name: 'Suggest one' }).click();
      const chordPath = join(dir, `Chord passwords ${mode}.chorddata`);
      await answerSave(app, chordPath);
      await again.getByRole('button', { name: 'Choose where to save…' }).click();
      await expect(main.getByText(`Saved Chord passwords ${mode}.chorddata, 2 passwords`)).toBeVisible({ timeout: 30_000 });
      const sealed = readFileSync(chordPath);
      expect(sealed.subarray(0, 17).toString()).toBe('chord-encrypted 1');
      for (const secret of ['Sekrit-mine-2', 'Sekrit-new-1', 'ada@example.com', PASSPHRASE]) expect(sealed.includes(Buffer.from(secret))).toBe(false);
      expect(sealed.toString('utf8', 0, 4096)).toContain('"includes":["passwords"]');
    } finally {
      await app.close();
    }
    expectClean(findings);
  });
}

test('passwords: an encrypted Chord file’s passwords come in through Your data, compared with the vault', async () => {
  test.setTimeout(150_000);
  const findings: Finding[] = [];
  // Made by the journey above's export, in its own profile: here, a new one.
  const first = await chord('light');
  const chordPath = join(dir, 'Chord passwords round trip.chorddata');
  let suggested = '';
  try {
    await firstPassword(first.settings, 'https://shop.example.com', 'ada@example.com', 'Sekrit-mine-2');
    const main = first.settings.getByRole('main');
    await main.getByRole('button', { name: 'Export…' }).click();
    const exporting = main.getByRole('group', { name: 'Export passwords' });
    await exporting.getByRole('button', { name: 'Suggest one' }).click();
    suggested = await exporting.getByLabel('Passphrase', { exact: true }).inputValue();
    await answerSave(first.app, chordPath);
    await exporting.getByRole('button', { name: 'Choose where to save…' }).click();
    await expect(main.getByText(/^Saved Chord passwords round trip\.chorddata, 1 password$/)).toBeVisible({ timeout: 30_000 });
  } finally {
    await first.app.close();
  }

  const { app, settings } = await chord('light');
  try {
    // No vault here yet: the file's passwords row chooses the passphrase, then compares.
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Your data' }).click();
    const main = settings.getByRole('main');
    await answerOpen(app, chordPath);
    await main.getByRole('button', { name: 'Choose a file…' }).click();
    const card = main.getByRole('group', { name: 'From a Chord file' });
    await card.getByLabel('Passphrase').fill(suggested);
    await card.getByRole('button', { name: 'Open' }).click();
    await expect(card.getByText('1 password. Choose a passphrase to lock them with here.')).toBeVisible();
    await card.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await card.getByLabel('Again').fill(PASSPHRASE);
    await card.getByRole('button', { name: 'Use it' }).click();
    await expect(card.getByText('New: 1 password.')).toBeVisible();
    await expect(card.getByRole('switch', { name: 'Import passwords' })).toHaveAttribute('aria-checked', 'true');
    findings.push(...(await audit(settings, 'Your data → a Chord file with passwords', { appearance: 'light' })));
    await card.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(card.getByText('Imported 1 password.')).toBeVisible({ timeout: 30_000 });
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passwords' }).click();
    await expect(main.getByRole('list', { name: 'Saved passwords' }).getByRole('button', { name: /shop\.example\.com/ })).toBeVisible();
  } finally {
    await app.close();
  }
  expectClean(findings);
});

/** S17 §10's large case: Bitwarden's header, 6,240 rows. */
function bitwarden(): { seed: string; big: string } {
  const header = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';
  const row = (host: string, password: string, totp = '') => `,,login,${host},,,0,https://${host}/,ada@example.com,${password},${totp}`;
  const seed = [header, ...Array.from({ length: 328 }, (_, i) => row(`s${i}.example.com`, `p${i}`))].join('\n');
  const rows: string[] = [];
  for (let i = 0; i < 210; i++) rows.push(row(`s${i}.example.com`, `p${i}`));
  for (let i = 210; i < 328; i++) rows.push(row(`s${i}.example.com`, `changed-${i}`));
  for (let i = 0; i < 5902; i++) rows.push(row(`n${i}.example.org`, `np${i}`, i < 31 ? 'JBSWY3DPEHPK3PXP' : ''));
  for (let i = 0; i < 3; i++) rows.push(row(`n${i}.example.org`, `np${i}`));
  for (let i = 0; i < 7; i++) rows.push(`,,login,App ${i},,,0,android://hash@com.example.app${i}/,ada,x,`);
  return { seed, big: [header, ...rows].join('\n') };
}

test('passwords: the large file, 6,240 rows: Review all with its search, and the import timed', async () => {
  test.setTimeout(240_000);
  const findings: Finding[] = [];
  const { app, settings } = await chord('light');
  try {
    const main = settings.getByRole('main');
    await firstPassword(settings, 'https://first.example.com', 'ada', 'Sekrit-first');
    const files = bitwarden();
    const seed = join(dir, 'seed.csv');
    const big = join(dir, 'bitwarden_export.csv');
    writeFileSync(seed, files.seed);
    writeFileSync(big, files.big);
    await answerOpen(app, seed);
    await main.getByRole('button', { name: 'Import…' }).click();
    const card = main.getByRole('group', { name: 'Import passwords' });
    await card.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(card.getByText('Imported 328 passwords.')).toBeVisible({ timeout: 60_000 });

    await answerOpen(app, big);
    await card.getByRole('button', { name: 'Choose another file…' }).click();
    await expect(card.getByText('A Bitwarden export, 6,240 rows, from bitwarden_export.csv.')).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText('New: 5,902 passwords. Same as yours: 210, left as they are. Different from yours: 118.')).toBeVisible();
    await expect(card.getByText('7 rows without a usable address: rows 6,235, 6,236, 6,237 and 4 more.')).toBeVisible();
    await expect(card.getByText('31 one-time-code secrets in the file were ignored. Chord doesn’t keep codes.')).toBeVisible();
    await card.getByRole('button', { name: 'Review all' }).click();
    const search = card.getByRole('searchbox', { name: 'Search the 118 that differ' });
    await expect(search).toBeFocused();
    // A virtual list: only the lines in view are drawn.
    expect(await card.getByRole('list', { name: 'Different from yours' }).getByRole('listitem').count()).toBeLessThan(20);
    findings.push(...(await audit(settings, 'Passwords → Import, 6,240 rows, Review all', { appearance: 'light' })));
    await card.screenshot({ path: resolve(capturesDir, 'passwords-import-large-light.png') });
    await search.fill('s21');
    await expect(card.getByText('10 match.')).toBeVisible();
    await card.getByRole('checkbox', { name: /s215\.example\.com/ }).check();
    await search.fill('');

    const started = Date.now();
    await card.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(card.getByText('Imported 5,902 passwords, and took the file’s for 1.')).toBeVisible({ timeout: 60_000 });
    const ms = Date.now() - started;
    console.log(`passwords-transfer: 6,240-row import, from Import to its result: ${ms} ms`);
    await expect(card.getByText('Yours stayed for 117. 7 rows without a usable address stayed out.')).toBeVisible();
  } finally {
    await app.close();
  }
  expectClean(findings);
});
