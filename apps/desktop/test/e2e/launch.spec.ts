import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '../..');
const capturesDir = resolve(appDir, 'test-results', 'captures');

/** A few tiny pages so navigation works without the network. */
function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title><a id="next" href="/second">Next</a>',
    '/second': '<title>Second page</title><p>Second</p>',
    '/third': '<title>Third page</title><p>Third</p>',
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

async function launch(env: Record<string, string>): Promise<ElectronApplication> {
  // A fresh profile per launch: tests never touch a developer's real data.
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return electron.launch({ args: [appDir], env: childEnv, cwd: appDir });
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');

/** Opens the command bar the way the shell's own buttons do. (Synthetic keys can't reach Chord's shortcut router.) */
async function openCommandBar(shell: Page, overlay: Page, mode: 'new' | 'edit') {
  await shell.evaluate((m) => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open(m), mode);
  await expect(overlay.getByRole('dialog')).toBeVisible();
}

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

test('browses, and the shell drives navigation over IPC', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(site.origin));
    const today = shell.getByRole('list', { name: 'Today' });

    await expect(shell.getByText('Personal')).toBeVisible();
    await expect(today).toContainText('First page');

    await tab.click('#next');
    await expect(today).toContainText('Second page');
    const back = shell.getByRole('button', { name: 'Back' });
    await expect(back).toBeEnabled();
    await back.click();
    await expect.poll(() => tab.url()).toBe(`${site.origin}/`);
    await expect(today).toContainText('First page');
  } finally {
    await app.close();
  }
});

test('the command bar opens new tabs, edits the address in place, and tabs close', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('First page');

    // New tab: type an address, press Enter.
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/third`);
    await expect(overlay.getByRole('option').first()).toContainText(`${site.origin}/third`);
    await overlay.keyboard.press('Enter');
    await expect(overlay.getByRole('dialog')).toBeHidden();
    await expect(today.getByRole('listitem')).toHaveCount(2);
    await expect(today.getByRole('listitem').first()).toContainText('Third page'); // new tabs land on top

    // Edit in place: the current address is prefilled; navigate this tab.
    await openCommandBar(shell, overlay, 'edit');
    await expect(overlay.getByRole('textbox')).toHaveValue(`${site.origin}/third`);
    await overlay.getByRole('textbox').fill(`${site.origin}/second`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('listitem').first()).toContainText('Second page');
    await expect(today.getByRole('listitem')).toHaveCount(2);

    // Typing part of an open tab's title offers to switch to it, first.
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('first');
    await expect(overlay.getByRole('option').first()).toContainText('First page');
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByRole('dialog')).toBeHidden();

    // Close the top tab from its close button; the other remains and becomes active.
    await today.getByRole('listitem').first().hover();
    await today.getByRole('button', { name: /^Close/ }).first().click();
    await expect(today.getByRole('listitem')).toHaveCount(1);
    await expect(today.getByRole('button', { name: 'First page', exact: true })).toHaveAttribute('aria-current', 'page');
  } finally {
    await app.close();
  }
});

test('web content gets no Chord API; the shell does', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(site.origin));
    expect(await tab.evaluate(() => typeof (window as { chord?: unknown }).chord)).toBe('undefined');
    expect(await shell.evaluate(() => typeof (window as unknown as { chord: { state: { dispatch: unknown } } }).chord.state.dispatch)).toBe('function');
    expect(await tab.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
    // Decision S2: pages see a standard Chromium user agent.
    const userAgent = await tab.evaluate(() => navigator.userAgent);
    expect(userAgent).toMatch(/Chrome\/\d+\.0\.0\.0 /);
    expect(userAgent).not.toMatch(/Electron\/|Chord/);
  } finally {
    await app.close();
  }
});

for (const appearance of ['light', 'dark'] as const) {
  test(`captures the shell in ${appearance} for design QA`, async () => {
    const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_APPEARANCE: appearance });
    try {
      const shell = await pageWhere(app, isShell);
      await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
      await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe(appearance);
      await shell.evaluate(() => document.fonts.ready);
      await shell.screenshot({ path: resolve(capturesDir, `shell-${process.platform}-${process.arch}-${appearance}.png`) });
    } finally {
      await app.close();
    }
  });
}
