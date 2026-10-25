/**
 * Counts on tabs (DESIGN.md §7.2, ARCHITECTURE.md §9): the number a page
 * gives itself with the Badging API (`navigator.setAppBadge`), as Telegram
 * does for unread messages, shows on its tab and adds up on Chord's icon.
 * A frame inside a page has none; a new page clears it; a tab showing one
 * doesn't sleep; a site's can be hidden and shown again; closed folders and
 * other chords show theirs; the switch in Settings turns them all off.
 */
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { dispatch, isSettings, isShell, launch, pageWhere, runAction, tabIdByTitle, where } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const capturesDir = resolve(import.meta.dirname, '../../test-results/captures');

let server: Server;
let port = 0;
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/chat': '<title>Chat</title><script>navigator.setAppBadge(3)</script>',
    '/mail': '<title>Mail</title><script>navigator.setAppBadge(250)</script>',
    // A frame inside a page can't give its page a count (an ad, a widget).
    '/framed': '<title>Framed</title><iframe src="/inner"></iframe>',
    '/inner': '<script>navigator.setAppBadge(9)</script>',
    '/plain': '<title>Plain</title>',
    // A site with a service worker, which sets the count it's sent (a push, in real life).
    '/app': '<title>App</title><script>navigator.serviceWorker.register("/sw.js")</script>',
    '/app/other': '<title>Other</title>',
  };
  const worker =
    'self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));' +
    'self.addEventListener("message", (event) => event.waitUntil(event.data === "clear" ? self.navigator.clearAppBadge() : self.navigator.setAppBadge(event.data)));';
  server = createServer((req, res) => {
    if (req.url === '/sw.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(worker);
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? 'not found');
  });
  // Every address, so 127.0.0.1 and localhost are two sites.
  await new Promise<void>((done) => server.listen(0, done));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

const appBadge = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { chordTestHooks: { appBadge(): number | 'dot' | null } }).chordTestHooks.appBadge());

async function setSettings(app: ElectronApplication, shell: Page, settings: Record<string, unknown>) {
  await runAction(shell, 'app.settings');
  const page = await pageWhere(app, isSettings);
  await page.evaluate((s) => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set(s), settings);
  await shell.bringToFront();
  return page;
}

test('a page’s count shows on its tab and adds up on Chord’s icon; frames don’t count, a new page clears it, it keeps the tab awake, and it can be hidden', async () => {
  const chatUrl = `http://127.0.0.1:${port}/chat`;
  const mailUrl = `http://localhost:${port}/mail`;
  const app = await launch({ CHORD_HOME_URL: chatUrl, CHORD_E2E_HOOKS: '1', CHORD_SLEEP_AFTER_MS: '700', CHORD_IDLE_CHECK_MS: '200' });
  try {
    const shell = await pageWhere(app, isShell);
    const today = shell.getByRole('tree', { name: 'Today' });
    const chat = await pageWhere(app, (url) => url === chatUrl);

    // The count on its row (its description for screen readers), and on Chord's icon.
    const row = (name: string) => today.getByRole('treeitem', { name, exact: true });
    const chatRow = row('Chat');
    await expect(chatRow.locator('[data-count]')).toHaveText('3');
    await expect(chatRow).toHaveAccessibleDescription('3 unread');
    await expect.poll(() => appBadge(app)).toBe(3);
    // The Badging API as pages know it: still built in, and refusing what it would.
    expect(await chat.evaluate(() => String(navigator.setAppBadge))).toContain('[native code]');
    expect(await chat.evaluate(() => navigator.setAppBadge(-1).then(() => 'set', (e: Error) => e.name))).toBe('TypeError');

    // A page whose frame sets a count has none; another site's adds up, past 99 as "99+".
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `http://127.0.0.1:${port}/framed`, background: false });
    await expect(row('Framed')).toBeVisible();
    await dispatch(shell, { t: 'tab.open', windowId, url: mailUrl, background: false });
    const mailRow = row('Mail');
    await expect(mailRow.locator('[data-count]')).toHaveText('99+');
    await expect(mailRow).toHaveAccessibleDescription('more than 99 unread');
    await expect(row('Framed').locator('[data-count]')).toHaveCount(0);
    mkdirSync(capturesDir, { recursive: true });
    await shell.screenshot({ path: resolve(capturesDir, `tab-counts-${process.platform}-${process.arch}-rows.png`) });
    await expect.poll(() => appBadge(app)).toBe(253);

    // Out of sight, the page with no count goes to sleep; the one with a count stays awake.
    await expect(row('Framed')).toHaveAttribute('data-asleep', 'true', { timeout: 10_000 });
    await expect(chatRow).not.toHaveAttribute('data-asleep');

    // No number is a dot; clearing it, or a new page, takes it away. (On screen: with no count, out of sight it would sleep.)
    await chatRow.click();
    await chat.evaluate(() => navigator.setAppBadge());
    await expect(chatRow).toHaveAccessibleDescription('unread');
    await expect(chatRow.locator('[data-count]')).toHaveText('');
    await chat.evaluate(() => navigator.clearAppBadge());
    await expect(chatRow.locator('[data-count]')).toHaveCount(0);
    await expect.poll(() => appBadge(app)).toBe(250);
    await chat.evaluate(() => navigator.setAppBadge(5));
    await expect(chatRow).toHaveAccessibleDescription('5 unread');
    await chat.evaluate((url) => (location.href = url), `http://127.0.0.1:${port}/plain`);
    await expect(row('Plain')).toBeVisible();
    await expect(row('Plain').locator('[data-count]')).toHaveCount(0);
    await expect.poll(() => appBadge(app)).toBe(250);

    // Hidden for its site (the tab's menu): gone from the tab and the icon; listed in Settings, to show again.
    // On screen meanwhile: with its count hidden, a tab out of sight sleeps like any other.
    await mailRow.click();
    await dispatch(shell, { t: 'tabCounts.site', site: mailUrl, off: true });
    await expect(mailRow.locator('[data-count]')).toHaveCount(0);
    await expect.poll(() => appBadge(app)).toBe(null);
    const settings = await setSettings(app, shell, {});
    await settings.getByRole('button', { name: 'Show the count from localhost again' }).click();
    await shell.bringToFront();
    await expect(mailRow.locator('[data-count]')).toHaveText('99+');

    // A closed folder adds up what's inside it (Mail, the tab on screen, goes into a new one).
    await runAction(shell, 'folder.new');
    const name = shell.getByRole('textbox', { name: 'Folder name' });
    await name.fill('Messages');
    await name.press('Enter');
    const folder = shell.getByRole('tree', { name: 'Pinned' }).getByRole('treeitem', { name: 'Messages', exact: true });
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(folder.locator('[data-count]')).toHaveCount(0);
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(folder.locator('[data-count]')).toHaveText('99+');
    await expect(folder).toHaveAccessibleDescription('more than 99 unread');

    // A favorite's tile shows its tab's count on its corner.
    await dispatch(shell, { t: 'favorite.add', favoriteId: '0199a000-0000-7000-8000-000000000001', nodeId: await tabIdByTitle(shell, 'Mail') });
    const tile = shell.getByRole('button', { name: 'Mail, more than 99 unread' });
    await expect(tile.locator('[data-count]')).toHaveText('99+');
    await shell.screenshot({ path: resolve(capturesDir, `tab-counts-${process.platform}-${process.arch}-folder-tile.png`) });

    // Another chord: the dot on the chord with the count.
    await shell.getByRole('button', { name: 'New chord' }).click();
    const field = shell.getByRole('textbox', { name: 'Chord name' });
    await field.fill('Work');
    await field.press('Enter');
    const chords = shell.getByRole('tablist', { name: 'Chords' });
    await expect(chords.getByRole('tab', { name: 'Personal, unread' })).toBeVisible();
    await expect(chords.getByRole('tab', { name: 'Work', exact: true })).toHaveAttribute('aria-selected', 'true');

    // Off in Settings: no counts anywhere, Chord's icon included.
    await setSettings(app, shell, { tabCounts: { enabled: false } });
    await expect(chords.getByRole('tab', { name: 'Personal', exact: true })).toBeVisible();
    await expect.poll(() => appBadge(app)).toBe(null);
  } finally {
    await app.close();
  }
});

test('a site’s service worker gives its count to the site’s tabs; the page’s own comes first, and Chord’s icon counts the site once', async () => {
  const url = `http://127.0.0.1:${port}/app`;
  const app = await launch({ CHORD_HOME_URL: url, CHORD_E2E_HOOKS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    const today = shell.getByRole('tree', { name: 'Today' });
    const page = await pageWhere(app, (u) => u === url);
    const toWorker = (value: number | 'clear') =>
      page.evaluate(async (v) => {
        const registration = await navigator.serviceWorker.ready;
        registration.active!.postMessage(v);
      }, value);
    const row = today.getByRole('treeitem', { name: 'App', exact: true });

    await toWorker(7);
    await expect(row.locator('[data-count]')).toHaveText('7');
    await expect.poll(() => appBadge(app)).toBe(7);
    // The page's own count comes first; cleared, the worker's shows again.
    await page.evaluate(() => navigator.setAppBadge(2));
    await expect(row.locator('[data-count]')).toHaveText('2');
    await page.evaluate(() => navigator.clearAppBadge());
    await expect(row.locator('[data-count]')).toHaveText('7');

    // Another of the site's tabs shows it too; Chord's icon counts the site once.
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `http://127.0.0.1:${port}/app/other`, background: false });
    await expect(today.getByRole('treeitem', { name: 'Other', exact: true }).locator('[data-count]')).toHaveText('7');
    await expect.poll(() => appBadge(app)).toBe(7);

    // The worker clears it: gone from both, and from the icon.
    await toWorker('clear');
    await expect(today.locator('[data-count]')).toHaveCount(0);
    await expect.poll(() => appBadge(app)).toBe(null);
  } finally {
    await app.close();
  }
});
