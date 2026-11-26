/**
 * Ad and tracker blocking end to end (ARCHITECTURE.md §9, decision D5), with
 * no network: every host the pages use is this machine (--host-resolver-rules),
 * and a request the test server sees is one that wasn't blocked. The lists are
 * the real EasyList and EasyPrivacy bundled with the build, so the ad host here
 * is a real one they list.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const FIXTURE_EXTENSION = resolve(appDir, 'test/fixtures/extension');
const LISTS = resolve(appDir, 'build/ad-blocking');
/** A version newer than any bundled list, for the refreshed copies the test server hands out. */
const NEW_VERSION = '209912312359';

/** Every host the pages use, here. The port stays the server's. */
const HOSTS = ['news.test', 'other.test', 'brand-new-tracker.test', 'securepubads.g.doubleclick.net'];

interface Site {
  server: Server;
  port: number;
  /** Requests that reached the server, as host + path. */
  hits: string[];
  /** Requests for the lists, with their conditional headers. */
  listRequests: string[];
}

let site: Site;

/**
 * The news page asks for an ad script (a host EasyList blocks), one of its own
 * scripts, and the brand-new tracker only refreshed lists know; it has an ad
 * slot EasyList's generic element hiding covers.
 */
const PAGE = (port: number) => `<!doctype html><meta charset="utf-8"><title>News</title>
<div class="div-gpt-ad-top" id="slot">Advertisement</div>
<p id="story">A chord is three notes played together.</p>
<script>
  window.probe = (url) => fetch(url + (url.includes('?') ? '&' : '?') + 'n=' + Math.random(), { mode: 'no-cors', cache: 'no-store' }).then(() => 'loaded', () => 'blocked');
  window.results = Promise.all([
    probe('http://securepubads.g.doubleclick.net:${port}/tag/js/gpt.js'),
    probe('/own.js'),
  ]).then(([ad, own]) => ({ ad, own }));
</script>`;

test.beforeAll(async () => {
  const hits: string[] = [];
  const listRequests: string[] = [];
  const refreshed = (id: string) => {
    const text = readFileSync(join(LISTS, `${id}.txt`), 'utf8').replace(/^! Version: \d+/m, `! Version: ${NEW_VERSION}`);
    return id === 'easyprivacy' ? `${text}\n||brand-new-tracker.test^\n` : text;
  };
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(`${host}${path}`);
    const list = /^\/lists\/(easylist|easyprivacy)\.txt$/.exec(path);
    if (list) {
      listRequests.push(`${list[1]} ${req.headers['if-none-match'] ?? ''}`);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag: `"${list[1]}-${NEW_VERSION}"` });
      return res.end(refreshed(list[1]!));
    }
    if (path === '/' || path === '/news.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE((server.address() as AddressInfo).port));
    }
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end('/* ok */');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, port: (server.address() as AddressInfo).port, hits, listRequests };
});
test.afterAll(() => site.server.close());

const newsUrl = () => `http://news.test:${site.port}/news.html`;
const adHits = () => site.hits.filter((h) => h === 'securepubads.g.doubleclick.net/tag/js/gpt.js').length;

async function launch(env: Record<string, string> = {}, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_HOME_URL: newsUrl(), CHORD_E2E_HOOKS: '1', ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  const rules = HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, `--host-resolver-rules=${rules}`], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}
const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
type Chord = { chord: { action: { run(a: string): Promise<void> } } };

type Inspect = { status: { lists: { version: string | null }[] }; profiles: Record<string, { extension: boolean; applied: boolean; dispatcher: boolean }>; worker: boolean };
type Hooks = { chordTestHooks: { adBlocking(): Inspect; contextMenu(id: number): string[] | null; chooseContextMenuItem(id: number, label: string): void } };
const inspect = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.adBlocking());

/** The default profile's extension has the rules on. */
async function rulesReady(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => (await inspect(app)).profiles['default']?.applied, { timeout: 30_000 }).toBe(true);
}

/** Load the page again and wait for its probes: what got through, from the page and from the server's side. */
async function reload(tab: Page): Promise<{ ad: string; own: string; adHits: number }> {
  const before = adHits();
  await tab.reload();
  const results = await tab.evaluate(() => (window as unknown as { results: Promise<{ ad: string; own: string }> }).results);
  return { ...results, adHits: adHits() - before };
}

const slotHidden = (tab: Page) => tab.evaluate(() => getComputedStyle(document.getElementById('slot')!).display === 'none');

const contentsId = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)?.id ?? null, url);

/** Right-click the page's text, and choose an item of its menu. */
async function chooseFromPageMenu(app: ElectronApplication, tab: Page, label: string): Promise<void> {
  const id = (await contentsId(app, tab.url()))!;
  await tab.locator('#story').click({ button: 'right' });
  await expect.poll(() => app.evaluate((_electron, i) => (globalThis as unknown as Hooks).chordTestHooks.contextMenu(i), id)).toContain(label);
  await app.evaluate((_electron, [i, l]) => (globalThis as unknown as Hooks).chordTestHooks.chooseContextMenuItem(i as number, l as string), [id, label] as const);
}

test('a chord’s pages: ads and trackers blocked, ad slots hidden, and a site turned off from its page’s menu, with Undo', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    await rulesReady(app);
    // Chromium matches the rules itself: the ad never reaches the server, the page's own script does.
    expect(await reload(tab)).toEqual({ ad: 'blocked', own: 'loaded', adHits: 0 });
    await expect.poll(() => slotHidden(tab)).toBe(true);
    // Chord's extension isn't anyone's to see: not in the sidebar's shelf.
    await expect(shell.locator('[data-placement="sidebar"]')).toHaveCount(0);

    // Off for this site from its page's menu: the page reloads with its ads, and Undo puts blocking back.
    const loaded = adHits();
    await chooseFromPageMenu(app, tab, 'Block ads on this site');
    await expect.poll(adHits, { timeout: 15_000 }).toBeGreaterThan(loaded);
    await expect.poll(() => slotHidden(tab).catch(() => true)).toBe(false);
    await tab.waitForLoadState('load');
    const toast = shell.getByRole('group', { name: 'Not blocking ads on news.test' });
    await expect(toast).toBeVisible();
    // Undo reloads the page too, once blocking is back: its ad slot is hidden again.
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => slotHidden(tab).catch(() => false), { timeout: 15_000 }).toBe(true);
    await tab.waitForLoadState('load');
    await rulesReady(app);
    expect(await reload(tab)).toEqual({ ad: 'blocked', own: 'loaded', adHits: 0 });
  } finally {
    await app.close();
  }
});

test('Chromium slow to add the extension (#189): a fresh profile’s first page waits past launch’s 3 s cap for its rules, and its first request is blocked', async () => {
  const before = adHits();
  // Development builds only: the extension's load held 4.5 s, as a slow Windows disk did on CI.
  const app = await launch({ CHORD_E2E_AD_BLOCKING_DELAY_MS: '4500' });
  try {
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    // Its first load, not a reload: the page loaded only once the rules were on.
    const results = await tab.evaluate(() => (window as unknown as { results: Promise<{ ad: string; own: string }> }).results);
    expect(results).toEqual({ ad: 'blocked', own: 'loaded' });
    expect(adHits() - before).toBe(0);
  } finally {
    await app.close();
  }
});

test('Settings → Privacy: the switch turns blocking off and on, and lists the sites it’s off for', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    await rulesReady(app);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    const toggle = settings.getByRole('switch', { name: 'Block ads and trackers' });
    await expect(toggle).toBeChecked();
    // What the lists' host sees is beside the switch, and the lists say where they're from.
    await expect(settings.getByText(/easylist\.to, which sees your IP address/)).toBeVisible();
    await expect(settings.getByText(/EasyList from .+ and EasyPrivacy from/)).toBeVisible();

    await toggle.click();
    await expect.poll(async () => (await inspect(app)).profiles['default']?.extension).toBe(false);
    expect(await reload(tab)).toEqual({ ad: 'loaded', own: 'loaded', adHits: 1 });
    expect(await slotHidden(tab)).toBe(false);
    await toggle.click();
    await rulesReady(app);
    expect(await reload(tab)).toEqual({ ad: 'blocked', own: 'loaded', adHits: 0 });

    // A site added here is one blocking is off for; taking it off the list blocks there again.
    const input = settings.getByRole('textbox', { name: 'Add a site where ads aren’t blocked' });
    await input.fill('https://www.news.test/some/page');
    await input.press('Enter');
    await expect(settings.getByRole('button', { name: 'Block ads on news.test again' })).toBeVisible();
    await rulesReady(app);
    expect(await reload(tab)).toMatchObject({ ad: 'loaded', adHits: 1 });
    await settings.getByRole('button', { name: 'Block ads on news.test again' }).click();
    await rulesReady(app);
    expect(await reload(tab)).toMatchObject({ ad: 'blocked', adHits: 0 });
  } finally {
    await app.close();
  }
});

test('a chord whose blocking didn’t come on (#284): its row in Settings → Privacy, Try again, Trying…, then the row goes', async () => {
  // Development builds only: the extension's first load fails, each load held 1.5 s (so Trying… shows).
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'once', CHORD_E2E_AD_BLOCKING_DELAY_MS: '1500' });
  try {
    const shell = await pageWhere(app, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    const row = settings.getByText(/^Not blocking in [^.]+$/);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(settings.getByText('Ad blocking couldn’t start for this chord, so its pages load without it.')).toBeVisible();
    // For the owner's preview: light, then dark.
    await settings.screenshot({ path: test.info().outputPath('ad-blocking-failed-light.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'dark'));
    await settings.waitForTimeout(400);
    await settings.screenshot({ path: test.info().outputPath('ad-blocking-failed-dark.png') });
    await app.evaluate(({ nativeTheme }) => void (nativeTheme.themeSource = 'system'));
    await settings.getByRole('button', { name: 'Try again' }).click();
    const trying = settings.getByRole('button', { name: 'Trying…' });
    await expect(trying).toBeVisible();
    await expect(trying).toBeDisabled();
    await settings.screenshot({ path: test.info().outputPath('ad-blocking-trying.png') });
    // It comes on: the row goes, and the rules are on.
    await expect(row).toBeHidden({ timeout: 20_000 });
    await rulesReady(app);
  } finally {
    await app.close();
  }
});

test('a chord whose blocking still won’t come on (#284): Try again, Trying…, and the row comes back as it was', async () => {
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'always', CHORD_E2E_AD_BLOCKING_DELAY_MS: '1500' });
  try {
    const shell = await pageWhere(app, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeVisible({ timeout: 20_000 });
    await settings.getByRole('button', { name: 'Try again' }).click();
    await expect(settings.getByRole('button', { name: 'Trying…' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 20_000 });
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeVisible();
    // Blocking off: no row (nothing to block).
    await settings.getByRole('switch', { name: 'Block ads and trackers' }).click();
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Try again from the keyboard (#284, Carbon’s B1, B2): focus stays on it while it tries; a screen reader hears which chord, and each change', async () => {
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'always', CHORD_E2E_AD_BLOCKING_DELAY_MS: '1500' });
  try {
    const shell = await pageWhere(app, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeVisible({ timeout: 20_000 });
    const status = settings.getByRole('status').filter({ hasText: /blocking/i });
    await expect(status).toHaveText(/^Not blocking in \S/);
    const button = settings.getByRole('button', { name: 'Try again' });
    // Its description names the chord, then why.
    await expect(button).toHaveAccessibleDescription(/^Not blocking in .+ Ad blocking couldn’t start/);
    await button.focus();
    await settings.keyboard.press('Enter');
    await expect(settings.getByRole('button', { name: 'Trying…' })).toBeVisible();
    // Never the native disabled, which would drop the focus to the page.
    expect(await settings.evaluate(() => document.activeElement?.textContent)).toBe('Trying…');
    await expect(settings.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 20_000 });
    expect(await settings.evaluate(() => document.activeElement?.textContent)).toBe('Try again');
    await expect(status).toHaveText(/^Still not blocking in \S/);
  } finally {
    await app.close();
  }
});

test('Try again from the keyboard, and it works (#284, Carbon’s B1): the row goes, focus goes to the switch, and it’s said', async () => {
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'once', CHORD_E2E_AD_BLOCKING_DELAY_MS: '1500' });
  try {
    const shell = await pageWhere(app, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeVisible({ timeout: 20_000 });
    await settings.getByRole('button', { name: 'Try again' }).focus();
    await settings.keyboard.press('Enter');
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeHidden({ timeout: 20_000 });
    expect(await settings.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)).toBe('Block ads and trackers');
    await expect(settings.getByRole('status').filter({ hasText: /blocking/i })).toHaveText(/^Blocking ads in \S.* again\.$/);
  } finally {
    await app.close();
  }
});

test('a chord named with 64 characters and no space (#284, Carbon’s SF2): its name wraps, never under Try again', async () => {
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'always' });
  try {
    const shell = await pageWhere(app, isShell);
    const chordId = await shell.evaluate(async () => {
      const { state } = await (window as unknown as { chord: { state: { snapshot(): Promise<{ state: { chords: Record<string, { id: string }> } }> } } }).chord.state.snapshot();
      return Object.keys(state.chords)[0]!;
    });
    await shell.evaluate(
      ({ chordId, name }) => (window as unknown as { chord: { state: { dispatch(c: unknown): Promise<void> } } }).chord.state.dispatch({ t: 'chord.update', chordId, name }),
      { chordId, name: 'W'.repeat(64) },
    );
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    const label = settings.getByText(/^Not blocking in W+$/);
    await expect(label).toBeVisible({ timeout: 20_000 });
    const button = settings.getByRole('button', { name: 'Try again' });
    const [text, pill] = [(await label.boundingBox())!, (await button.boundingBox())!];
    await settings.screenshot({ path: test.info().outputPath('ad-blocking-long-name.png') });
    // The label ends before the button starts, and its text stays inside it: it wraps rather than paint across it.
    expect(text.x + text.width).toBeLessThanOrEqual(pill.x);
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await app.close();
  }
});

test('Trying… under Chord’s own reduced motion, and the row in forced colors (#284, Carbon’s SF3, SF4)', async () => {
  const app = await launch({ CHORD_E2E_AD_BLOCKING_FAIL: 'always', CHORD_E2E_AD_BLOCKING_DELAY_MS: '3000' });
  try {
    const shell = await pageWhere(app, isShell);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Privacy' }).click();
    await expect(settings.getByText(/^Not blocking in [^.]+$/)).toBeVisible({ timeout: 20_000 });
    // Settings → Motion's reduced motion, as shared/motion.ts sets it: the ring holds still.
    await settings.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', ''));
    await settings.getByRole('button', { name: 'Try again' }).click();
    const trying = settings.getByRole('button', { name: 'Trying…' });
    await expect(trying).toBeVisible();
    expect(await trying.evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
    // Forced colors: the dot in a system color, and the pill an edge.
    await settings.emulateMedia({ forcedColors: 'active' });
    const label = settings.getByText(/^Not blocking in [^.]+$/);
    expect(await label.evaluate((el) => getComputedStyle(el, '::before').forcedColorAdjust)).toBe('none');
    expect(await trying.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe('0px');
  } finally {
    await app.close();
  }
});

test('a private window is covered: its requests are checked in Chord, its ad slots hidden, and its own exceptions go with it', async () => {
  const app = await launch();
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    await rulesReady(app);
    // The window's own command bar, found first: since it loads after the shell paints, a private window's can come before it.
    const mainOverlay = await pageWhere(app, isOverlay);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('window.newPrivate'));
    await expect.poll(() => app.windows().filter((p) => isOverlay(p.url())).length).toBe(2);
    const privateOverlay = app.windows().find((p) => isOverlay(p.url()) && p !== mainOverlay)!;
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    const before = adHits();
    await privateOverlay.getByRole('combobox').fill(`http://news.test:${site.port}/`);
    await privateOverlay.keyboard.press('Enter');
    const privateTab = await pageWhere(app, (url) => url === `http://news.test:${site.port}/`);
    // No extension can load in an in-memory session: the request dispatcher asks the engine.
    const state = await inspect(app);
    const privateProfile = Object.keys(state.profiles).find((p) => p.startsWith('private-'))!;
    expect(state.profiles[privateProfile]).toMatchObject({ extension: false, dispatcher: true });
    expect(await privateTab.evaluate(() => (window as unknown as { results: Promise<unknown> }).results)).toEqual({ ad: 'blocked', own: 'loaded' });
    expect(adHits()).toBe(before);
    await expect.poll(() => slotHidden(privateTab)).toBe(true);

    // Off for the site in the private window only: the chord's page still blocks it.
    await chooseFromPageMenu(app, privateTab, 'Block ads on this site');
    await expect.poll(adHits, { timeout: 15_000 }).toBeGreaterThan(before);
    expect(await reload(tab)).toMatchObject({ ad: 'blocked', adHits: 0 });
  } finally {
    await app.close();
  }
});

test('an extension’s own declarativeNetRequest rules still apply beside Chord’s (as uBO Lite’s do)', async () => {
  const app = await launch({ CHORD_LOAD_EXTENSION: FIXTURE_EXTENSION });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    await rulesReady(app);
    // The test extension's rule blocks /blocked-by-extension on every page (its install step turns it on).
    await expect.poll(() => tab.evaluate(() => (window as unknown as { probe(u: string): Promise<string> }).probe('/blocked-by-extension')), { timeout: 20_000 }).toBe('blocked');
    expect(await reload(tab)).toEqual({ ad: 'blocked', own: 'loaded', adHits: 0 });
    // Only the extension you added is listed; Chord's own isn't.
    await expect(shell.locator('[data-placement="sidebar"]').getByRole('button', { name: /^Chord Test/ })).toBeVisible({ timeout: 20_000 });
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('app.settings'));
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'Extensions', exact: true }).click();
    const installed = settings.getByRole('list', { name: 'Installed extensions' }).getByRole('listitem');
    await expect(installed).toHaveCount(1);
    await expect(installed.first()).toHaveAccessibleName('Chord Test Extension');
  } finally {
    await app.close();
  }
});

test('the lists refresh from their own host, and the new rules apply in chords and private windows', async () => {
  const app = await launch({ CHORD_AD_BLOCKING_URL: `http://127.0.0.1:${site.port}/lists` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(newsUrl()));
    // A development build checks half a second after launch; both lists come back newer.
    await expect.poll(async () => (await inspect(app)).status.lists.map((l) => l.version), { timeout: 30_000 }).toEqual([NEW_VERSION, NEW_VERSION]);
    await rulesReady(app);
    const probe = (page: Page) => page.evaluate((port) => (window as unknown as { probe(u: string): Promise<string> }).probe(`http://brand-new-tracker.test:${port}/t.js`), site.port);
    await tab.reload();
    expect(await probe(tab)).toBe('blocked');
    expect(site.hits).not.toContain('brand-new-tracker.test/t.js');
    // A private window's engine has them too.
    // The window's own command bar, found first: since it loads after the shell paints, a private window's can come before it.
    const mainOverlay = await pageWhere(app, isOverlay);
    await shell.evaluate(() => (window as unknown as Chord).chord.action.run('window.newPrivate'));
    await expect.poll(() => app.windows().filter((p) => isOverlay(p.url())).length).toBe(2);
    const privateOverlay = app.windows().find((p) => isOverlay(p.url()) && p !== mainOverlay)!;
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('combobox').fill(`http://other.test:${site.port}/`);
    await privateOverlay.keyboard.press('Enter');
    const privateTab = await pageWhere(app, (url) => url === `http://other.test:${site.port}/`);
    expect(await probe(privateTab)).toBe('blocked');
    expect(site.hits).not.toContain('brand-new-tracker.test/t.js');
    // Asked for without conditions the first time: Chord had no copy of its own yet.
    expect([...site.listRequests].sort()).toEqual(['easylist ', 'easyprivacy ']);
  } finally {
    await app.close();
  }
});
