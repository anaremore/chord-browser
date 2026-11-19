/**
 * Saving after a sign-in with no navigation (S17 §6, phase 3A-2; the owner's designs 1A and 2A), end to end with the
 * real agent and main, against test/fixtures/passwords/formless-optimistic.html: a formless sign-in whose fields go at
 * once and whose server answers later, 401 for a wrong password.
 *
 * 1. **It worked:** the card comes once the page is quiet; Save, pressed while the site could still say no, shows
 *    *Saving…* with the fields read-only, and the password is saved once the late window closes.
 * 2. **It didn't:** a wrong password's 401 comes after Save was pressed: the save is cancelled, the toast says
 *    *The site didn't accept that password, so Chord didn't save it.*, and the vault has nothing new.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { isPopover, isShell, launch, pageWhere } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@acme-e2e.dev';
const RIGHT = 'Zq9-late-Sekrit';
const WRONG = 'Zq9-wrong-Sekrit';
const PASSPHRASE = 'correct horse battery staple';
const FIXTURE = readFileSync(resolve(import.meta.dirname, '../fixtures/passwords/formless-optimistic.html'), 'utf8');
/** How long the server takes to answer: past the agent's quiet wait (1.5 s), so the card comes before the answer. */
const ANSWER_MS = 2500;

const isCards = (url: string) => isPopover(url) && !url.includes('#');

interface Site {
  server: Server;
  origin: string;
  host: string;
}

function startSite(): Promise<Site> {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const ok = new URLSearchParams(body).get('password') === RIGHT;
        setTimeout(() => {
          res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
          res.end(ok ? '{"ok":true}' : '{"error":"wrong password"}');
        }, ANSWER_MS);
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
      done({ server, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    }),
  );
}

let site: Site;
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test('passwords: a sign-in with no navigation is saved after the late window, and a late 401 cancels the save', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-passwords-late-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/login`, CHORD_E2E_HOOKS: '1', CHORD_APPEARANCE: 'light', CHORD_E2E_NO_KEYRING: '1' }, { profile });
  try {
    const shell = await pageWhere(app, isShell);
    const page = await pageWhere(app, (u) => u.startsWith(`${site.origin}/login`));
    const popover = await pageWhere(app, isCards);
    const signIn = async (password: string) => {
      await page.fill('#email', USER);
      await page.fill('#password', password);
      await page.click('#go');
    };

    // 2 first, while there's no vault: a wrong password, its 401 after Save. Nothing is saved, and the toast says so.
    await signIn(WRONG);
    const save = popover.getByRole('dialog', { name: `Save this password for ${site.host}?` });
    await expect(save).toBeVisible({ timeout: 15_000 });
    await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await save.getByLabel('Again').fill(PASSPHRASE);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await expect(save.getByText(`Waiting a moment for ${site.host} to confirm the sign-in.`)).toBeVisible();
    await expect(shell.getByText('The site didn’t accept that password, so Chord didn’t save it.')).toBeVisible({ timeout: 15_000 });
    await expect(save).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveText('Wrong password.');

    // 1. The right one: Save waits, then it's saved (the first one chooses the passphrase).
    await page.goto(`${site.origin}/login`);
    await signIn(RIGHT);
    await expect(save).toBeVisible({ timeout: 15_000 });
    await save.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await save.getByLabel('Again').fill(PASSPHRASE);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await expect(save.getByLabel('Username')).toHaveAttribute('readonly', '');
    await expect(shell.getByText('Saved. It’s in Settings → Passwords.')).toBeVisible({ timeout: 20_000 });
    await expect(save).toHaveCount(0);
  } finally {
    await app.close();
  }
});
