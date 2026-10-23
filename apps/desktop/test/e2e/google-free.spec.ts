/**
 * Google-free mode keeps its promise (docs/decisions/S10-google-free.md):
 * once it's on, a whole session that only visits a local page contacts no
 * Google host, read from Chromium's own net log. The session searches in
 * the command bar (suggestions) and checks spelling in a language whose
 * dictionary isn't downloaded, the two things that went to Google before.
 *
 * Needs no network: a request that can't connect still shows in the log.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';
import { contactedHosts, GOOGLE_HOST } from './netlog';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
/** A language Windows doesn't check itself on a stock English install, so Chromium wants its dictionary. */
const SPELLING = 'nl';

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Local page</title><textarea spellcheck="true" aria-label="Notes">Dit zin heeft fouten erin</textarea>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

async function launch(profile: string, args: string[] = []): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_HOME_URL: `${site.origin}/` };
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run', ...args], env, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
type Chord = { chord: { action: { run(a: string): Promise<void> }; overlay: { open(m: string): Promise<void> } } };

test('a Google-free session contacts no Google host on its own', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));

  // First run: switch it on in Settings → Privacy, where the search engine choice appears.
  const first = await launch(profile);
  try {
    const shell = await pageWhere(first, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(first, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await settings.getByRole('switch', { name: 'Google-free mode' }).click();
    const engines = settings.getByRole('radiogroup', { name: 'Search with' });
    await expect(engines.getByRole('radio', { name: /DuckDuckGo/ })).toHaveAttribute('aria-checked', 'true');
    await expect(engines.getByRole('radio', { name: /Google/ })).toHaveCount(0);
    // General offers Google, but not while the mode is on.
    await settings.getByRole('button', { name: 'General' }).click();
    await expect(settings.getByRole('radio', { name: /^Google/ })).toBeDisabled();
    // A spelling language whose dictionary isn't downloaded.
    await settings.evaluate((language) => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ spellcheck: { language } }), SPELLING);
  } finally {
    await first.close();
  }

  // Second run, logged from the start: the mode was on before anything loaded.
  const log = join(profile, 'netlog.json');
  const second = await launch(profile, [`--log-net-log=${log}`]);
  try {
    const shell = await pageWhere(second, isShell);
    const overlay = await pageWhere(second, isOverlay);
    const tab = await pageWhere(second, (url) => url.startsWith(site.origin));
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('Local page');
    // Spelling runs on the text field.
    await tab.getByRole('textbox', { name: 'Notes' }).click();
    await tab.keyboard.type(' en meer fouten');
    // A search in the command bar: suggestions are asked for as you type.
    await shell.evaluate(() => (window as unknown as Chord).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await overlay.keyboard.type('weather tomorrow');
    await expect(overlay.getByRole('option').first()).toContainText('Search DuckDuckGo');
    await overlay.waitForTimeout(1500);
    await overlay.keyboard.press('Escape');
    await tab.waitForTimeout(1500);
  } finally {
    await second.close();
  }

  const hosts = contactedHosts(log);
  const google = [...hosts].filter(([host]) => GOOGLE_HOST.test(host)).map(([host, how]) => `${host}: ${[...how].join(', ')}`);
  expect(google, 'Google hosts contacted in Google-free mode').toEqual([]);
  // The suggestions went to the engine chosen instead, so the search really happened.
  expect([...hosts.keys()]).toContain('duckduckgo.com');
});
