import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '../..');
const capturesDir = resolve(appDir, 'test-results', 'captures');

/** Two tiny pages so navigation works without the network. */
function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title><a id="next" href="/second">Next</a>',
    '/second': '<title>Second page</title><p>Second</p>',
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
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return electron.launch({ args: [appDir], env: childEnv, cwd: appDir });
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');

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

    // The shell reflects the tab.
    await expect(shell.getByText('Personal')).toBeVisible();
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');

    // Navigate inside the page, then go back from Chord's own Back button.
    await tab.click('#next');
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('Second page');
    const back = shell.getByRole('button', { name: 'Back' });
    await expect(back).toBeEnabled();
    await back.click();
    await expect.poll(() => tab.url()).toBe(`${site.origin}/`);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
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
    expect(await shell.evaluate(() => typeof window.chord.nav.command)).toBe('function');
    expect(await tab.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
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
