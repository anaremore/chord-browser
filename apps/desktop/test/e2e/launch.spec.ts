import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '../..');
const capturesDir = resolve(appDir, 'test-results', 'captures');

/** What the command bar asked the stub suggestion endpoint, in order. */
const suggestionsAsked: string[] = [];

/** A few tiny pages so navigation works without the network. */
function startSite(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': '<title>First page</title><a id="next" href="/second">Next</a>',
    '/second': '<title>Second page</title><p>Second</p>',
    '/third': '<title>Third page</title><p>Third</p>',
    '/words': '<title>Words</title><p>A chord is three notes. Play the chord, then the next chord.</p>',
    '/files': '<title>Files</title><a id="get" href="/report.bin">Get the report</a>',
    // "No icon", the way example.com says it; and an icon that claims to be a PNG but isn't.
    '/no-icon': '<title>No icon</title><link rel="icon" href="data:,">',
    '/bad-icon': '<title>Bad icon</title><link rel="icon" href="/bad.png">',
    // A "Sign in with…" flow: a sized popup reports back through window.opener, then closes.
    '/signin':
      `<title>Signed out</title><button id="signin" onclick="window.open('/signin-popup', 'auth', 'width=420,height=560')">Sign in</button>` +
      `<script>addEventListener('message', (e) => { if (e.data === 'signed-in') document.title = 'Signed in'; });</script>`,
    '/signin-popup': `<title>Sign in</title><button id="done" onclick="window.opener.postMessage('signed-in', '*'); window.close()">Continue</button>`,
  };
  const server = createServer((req, res) => {
    // Search suggestions (CHORD_SUGGEST_URL) in the OpenSearch shape the engines use; every question is logged.
    if (req.url?.startsWith('/suggest?q=')) {
      const q = decodeURIComponent(req.url.slice('/suggest?q='.length));
      suggestionsAsked.push(q);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([q, [`${q} progressions`, `${q} finder`]]));
      return;
    }
    // GitHub Releases (CHORD_UPDATE_FEED): one release newer than a development build's 0.0.0.
    if (req.url === '/releases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { tag_name: 'v0.2.0', name: 'Chord 0.2.0', html_url: 'https://github.com/anaremore/chord-browser/releases/tag/v0.2.0', draft: false, prerelease: false },
          { tag_name: 'v9.0.0', name: 'Draft', html_url: 'https://github.com/anaremore/chord-browser/releases/tag/v9.0.0', draft: true, prerelease: false },
        ]),
      );
      return;
    }
    if (req.url === '/bad.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('this is not a png');
      return;
    }
    if (req.url === '/report.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.bin"' });
      res.end(Buffer.alloc(300_000, 7));
      return;
    }
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

async function launch(env: Record<string, string>, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  // A fresh profile per launch unless a test reuses one: tests never touch a developer's real data.
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
const isPopover = (url: string) => url.startsWith('chord://popover') || url.includes('/popover/index.html');

/** Run an action from the shortcut registry the way the shell's own buttons do. */
const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/** Whether the active tab's view is showing (it hides while the frame explains an error). */
const tabVisible = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.contentView.children[1]!.getVisible());

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

/** Bounds of the window's views, bottom to top: shell, active tab, overlay. */
const viewBounds = (app: ElectronApplication) =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));

test('the sidebar collapses to a minimal bar and docks again', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    const docked = (await viewBounds(app))[1]!;

    await shell.getByRole('button', { name: 'Hide sidebar' }).click();
    // The minimal bar takes over: its own toggle, and the page's domain / title.
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await expect(shell.getByRole('navigation', { name: 'Sidebar' })).toBeHidden();
    await expect.poll(async () => (await viewBounds(app))[1]!.x).toBe(4); // the bezel (size.frameInset)
    const collapsed = (await viewBounds(app))[1]!;
    expect(collapsed.width).toBeGreaterThan(docked.width);

    await shell.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(shell.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
    await expect.poll(async () => (await viewBounds(app))[1]).toEqual(docked);
  } finally {
    await app.close();
  }
});

test('zoom and copy actions act on the active tab', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    const run = (action: string) =>
      shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);
    const zoom = () =>
      app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!.getZoomFactor(), site.origin);

    await run('view.zoomIn');
    await expect.poll(zoom).toBeCloseTo(1.1);
    await run('view.zoomOut');
    await run('view.zoomOut');
    await expect.poll(zoom).toBeCloseTo(0.9);
    await run('view.zoomReset');
    await expect.poll(zoom).toBeCloseTo(1);

    await run('address.copyMarkdown');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`[First page](${site.origin}/)`);
  } finally {
    await app.close();
  }
});

// Spike S8. Input is injected at the page with sendInputEvent, which takes the
// same route as real keys on Windows and Linux. macOS menus need a real
// NSEvent, which injected keys don't carry, so there it's checked by hand.
test('page-first keys reach Chord only when the page passes; reserved keys fire once', async () => {
  test.skip(process.platform === 'darwin', 'injected keys carry no NSEvent for the macOS menu');
  // Headless Weston never activates the window, and menu accelerators only fire for an active one.
  // Unverified as the cause; Wayland is checked by hand (docs/decisions/S8-keyboard-routing.md).
  test.skip(process.env['XDG_SESSION_TYPE'] === 'wayland', 'menu accelerators need an active window; headless Weston has none');
  const page = encodeURIComponent(
    '<title>Keys</title><input autofocus><script>let take=false;' +
      'document.addEventListener("keydown",e=>{if(take&&e.key.toLowerCase()==="s"&&e.ctrlKey){e.preventDefault();document.title="page kept it"}});' +
      'window.takeKeys=()=>{take=true}</script>',
  );
  const app = await launch({ CHORD_HOME_URL: `data:text/html,${page}` });
  try {
    const shell = await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith('data:'));
    // Focus moves asynchronously (slowly on Linux CI), so wait until the page has it before typing.
    const press = async (key: string) => {
      await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => x.getURL().startsWith('data:'))!.focus());
      await expect.poll(() => tab.evaluate(() => document.hasFocus())).toBe(true);
      await app.evaluate(({ webContents }, k) => {
        const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith('data:'))!;
        c.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] });
        c.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] });
      }, key);
    };
    const sidebar = shell.getByRole('navigation', { name: 'Sidebar' });

    // The page ignores Ctrl+S, so it falls through to Chord: the sidebar collapses.
    await press('S');
    await expect(sidebar).toBeHidden();
    await press('S');
    await expect(sidebar).toBeVisible();

    // Once the page handles Ctrl+S itself, the page wins.
    await tab.evaluate(() => (window as unknown as { takeKeys(): void }).takeKeys());
    await press('S');
    await expect.poll(() => tab.title()).toBe('page kept it');
    await expect(sidebar).toBeVisible();

    // Ctrl+T is reserved: Chord gets it before the page, exactly once.
    await press('T');
    await expect((await pageWhere(app, isOverlay)).getByRole('dialog')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Settings opens from the shell and its changes apply live', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app, (url) => url.startsWith('chord://settings') || url.includes('/settings/index.html'));

    // Search engine: the command bar offers the new engine at once.
    await settings.getByRole('radio', { name: /DuckDuckGo/ }).click();
    await expect(settings.getByRole('radio', { name: /DuckDuckGo/ })).toHaveAttribute('aria-checked', 'true');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('chord browser');
    await expect(overlay.getByRole('option').first()).toContainText('Search DuckDuckGo');
    await overlay.keyboard.press('Escape');

    // Motion: a switch flips, and the shell learns which animations are off.
    await settings.getByRole('button', { name: 'Motion' }).click();
    const sidebarSwitch = settings.getByRole('switch', { name: 'Animate the sidebar' });
    await sidebarSwitch.click();
    await expect(sidebarSwitch).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['motionOff'])).toContain('sidebar');

    // Appearance: picking a theme re-themes the browser window behind.
    const shellVar = (name: string) => shell.evaluate((n) => getComputedStyle(document.querySelector('[data-sidebar]')!).getPropertyValue(n), name);
    const tint = () => shellVar('--color-tint');
    const before = await tint();
    await settings.getByRole('button', { name: 'Appearance' }).click();
    const seaGlass = settings.getByRole('button', { name: 'Sea Glass', exact: true });
    await seaGlass.click();
    await expect(seaGlass).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(tint).not.toBe(before);

    // Color scheme: Dark turns the whole browser dark.
    const schemes = settings.getByRole('radiogroup', { name: 'Color scheme' });
    await schemes.getByRole('radio', { name: 'Dark' }).click();
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe('dark');
    await schemes.getByRole('radio', { name: 'Light' }).click();
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe('light');

    // A theme of your own: made here, it goes straight onto the chord.
    await settings.getByRole('button', { name: 'Create theme' }).click();
    await settings.getByRole('textbox', { name: 'Theme name' }).fill('Late Night');
    await settings.getByRole('radio', { name: 'Orchid' }).click();
    await settings.getByRole('region', { name: 'New theme' }).getByRole('button', { name: 'Create theme' }).click();
    const lateNight = settings.getByRole('button', { name: 'Late Night', exact: true });
    await expect(lateNight).toHaveAttribute('aria-pressed', 'true');
    await expect(seaGlass).toHaveAttribute('aria-pressed', 'false');

    // Importing a theme code adds it to the library and applies it.
    await settings.getByRole('button', { name: 'Import' }).click();
    const code = settings.getByRole('textbox', { name: 'Theme code' });
    await code.fill('not a theme');
    await expect(settings.getByText('That isn’t a theme code.')).toBeVisible();
    await code.fill(JSON.stringify({ chordTheme: 1, name: 'Pasted', stops: [{ l: 0.72, c: 0.12, h: 150 }, { l: 0.72, c: 0.12, h: 220 }], grain: 0.3 }));
    await settings.getByRole('button', { name: 'Add theme' }).click();
    await expect(settings.getByRole('button', { name: 'Pasted', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // Deleting asks twice, in place; the chord keeps its colors.
    const tintBeforeDelete = await tint();
    await settings.getByRole('button', { name: 'Edit Pasted' }).click();
    await settings.getByRole('button', { name: 'Delete', exact: true }).click();
    await settings.getByRole('button', { name: 'Delete for good?' }).click();
    await expect(settings.getByRole('button', { name: 'Pasted', exact: true })).toHaveCount(0);
    expect(await tint()).toBe(tintBeforeDelete);

    // Interface → Contrast: dividers in the window behind get stronger.
    const divider = await shellVar('--color-divider');
    await settings.getByRole('slider', { name: 'Contrast' }).fill('100');
    await expect.poll(() => shellVar('--color-divider')).not.toBe(divider);
  } finally {
    await app.close();
  }
});

test('a page without a usable icon shows its monogram, never a broken image', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/no-icon` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('No icon');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/bad-icon`);
    await overlay.keyboard.press('Enter');
    await expect(today).toContainText('Bad icon');
    // The bad PNG is fetched, offered, fails to decode, and gives way to the monogram.
    await shell.waitForTimeout(1000);
    await expect(today.locator('img')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('a sign-in popup keeps its opener, opens at the size it asked for, and reports back', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/signin` });
  try {
    await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/signin`);
    await tab.locator('#signin').click();
    const popup = await pageWhere(app, (url) => url === `${site.origin}/signin-popup`);
    const size = await app.evaluate(
      ({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((b) => b.webContents.getURL() === url)!.getContentSize(),
      `${site.origin}/signin-popup`,
    );
    expect(size).toEqual([420, 560]);
    await popup.locator('#done').click();
    await expect.poll(() => tab.title()).toBe('Signed in');
    await expect.poll(() => app.windows().some((p) => p.url() === `${site.origin}/signin-popup`)).toBe(false);
  } finally {
    await app.close();
  }
});

test('a relaunch restores tabs, the sidebar and settings', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  let app = await launch({ CHORD_HOME_URL: `${site.origin}/` }, profile);
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('First page');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/third`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('listitem').first()).toContainText('Third page');
    await shell.getByRole('button', { name: 'Hide sidebar' }).click();
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app, (url) => url.startsWith('chord://settings') || url.includes('/settings/index.html'));
    await settings.getByRole('radio', { name: /Kagi/ }).click();
    await expect(settings.getByRole('radio', { name: /Kagi/ })).toHaveAttribute('aria-checked', 'true');
    // A theme of your own, on this chord, and a dark color scheme.
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await settings.getByRole('button', { name: 'Import' }).click();
    await settings.getByRole('textbox', { name: 'Theme code' }).fill(JSON.stringify({ chordTheme: 1, name: 'Kept', stops: [{ l: 0.72, c: 0.12, h: 40 }], grain: 0.1 }));
    await settings.getByRole('button', { name: 'Add theme' }).click();
    await expect(settings.getByRole('button', { name: 'Kept', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await settings.getByRole('radiogroup', { name: 'Color scheme' }).getByRole('radio', { name: 'Dark' }).click();
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe('dark');
  } finally {
    await app.close();
  }

  app = await launch({}, profile);
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    // Same tabs, same order, same active tab; the sidebar is still collapsed.
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await shell.getByRole('button', { name: 'Show sidebar' }).click();
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today.getByRole('listitem')).toHaveCount(2);
    await expect(today.getByRole('listitem').first()).toContainText('Third page');
    await expect(today.getByRole('button', { name: 'Third page', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => app.windows().some((p) => p.url() === `${site.origin}/third`)).toBe(true);
    // Settings came back too.
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('chord browser');
    await expect(overlay.getByRole('option').first()).toContainText('Search Kagi');
    await overlay.keyboard.press('Escape');
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe('dark');
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, (url) => url.startsWith('chord://settings') || url.includes('/settings/index.html'));
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await expect(settings.getByRole('button', { name: 'Kept', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await app.close();
  }
});

test('chords: create, name, switch, and each keeps its own tabs', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const run = (action: string) =>
      shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);
    const chords = shell.getByRole('tablist', { name: 'Chords' });
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');

    // A new chord starts empty, with its name ready to type over.
    await shell.getByRole('button', { name: 'New chord' }).click();
    const name = shell.getByRole('textbox', { name: 'Chord name' });
    await expect(name).toBeFocused();
    await name.fill('Work');
    await name.press('Enter');
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByText('Fresh chord, fresh start.')).toBeVisible();

    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/third`);
    await overlay.keyboard.press('Enter');
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('Third page');

    // Back to Personal from the switcher: its tab is still there, and Work's isn't.
    await chords.getByRole('tab', { name: 'Personal' }).click();
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('First page');
    await expect(today).not.toContainText('Third page');

    // ⌘2 / Ctrl+2, and the command bar, both reach Work.
    await run('chord.goto2');
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await run('chord.goto1');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('work');
    await expect(overlay.getByRole('option').filter({ hasText: /Work\s*Chord/ })).toHaveCount(1);
    await overlay.keyboard.press('Escape');

    // Deleting is immediate, with Undo in a toast (never a system dialog).
    await run('chord.goto2');
    await run('chord.delete');
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveCount(0);
    const toast = shell.getByRole('status').filter({ hasText: 'Deleted “Work”' });
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(chords.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('Third page');
  } finally {
    await app.close();
  }
});

test('many chords: the switcher scrolls sideways with the wheel and keeps the current one in view', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const strip = shell.getByRole('tablist', { name: 'Chords' });
    await expect(strip.getByRole('tab')).toHaveCount(1);
    const theme = { stops: [{ l: 0.72, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' as const };
    for (let i = 2; i <= 12; i++) {
      await shell.evaluate(
        (args) => (window as unknown as { chord: { state: { dispatch(c: unknown): Promise<void> } } }).chord.state.dispatch(args),
        { t: 'chord.create', windowId: 'w', name: `Chord ${i}`, icon: String.fromCodePoint(0x24b6 + i), theme },
      );
    }
    await expect(strip.getByRole('tab')).toHaveCount(12);
    const metrics = () => strip.evaluate((el) => ({ scroll: el.scrollLeft, overflow: el.scrollWidth - el.clientWidth, fade: el.dataset['fade'] }));
    // The newest chord is current and scrolled into view, at the end.
    await expect.poll(async () => (await metrics()).overflow).toBeGreaterThan(0);
    await expect(strip.getByRole('tab', { name: 'Chord 12' })).toBeInViewport();
    await expect.poll(async () => (await metrics()).fade).not.toBe('none');

    // A plain mouse wheel moves it back toward the start.
    const box = (await strip.boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = (await metrics()).scroll;
    await shell.mouse.wheel(0, -200);
    await expect.poll(async () => (await metrics()).scroll).toBeLessThan(before);
  } finally {
    await app.close();
  }
});

test('a chord takes a custom icon: picked from the grid, or typed', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const personal = shell.getByRole('tablist', { name: 'Chords' }).getByRole('tab', { name: 'Personal' });
    await expect(personal).toContainText('✦');

    await shell.getByRole('button', { name: 'Change icon' }).click();
    const picker = shell.getByRole('dialog', { name: 'Chord icon' });
    await picker.getByRole('button', { name: '🚀' }).click();
    await expect(picker).toBeHidden();
    await expect(personal).toContainText('🚀');

    // Typing (or the OS emoji panel) sets whatever comes first; letters are capitalized.
    await shell.getByRole('button', { name: 'Change icon' }).click();
    await picker.getByRole('textbox').fill('p');
    await expect(personal).toContainText('P');
  } finally {
    await app.close();
  }
});

test('pinned tabs: pin with a key, close keeps them, and dragging reorders and pins', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    const pinned = shell.getByRole('list', { name: 'Pinned' });
    await expect(today).toContainText('First page');
    for (const path of ['second', 'third']) {
      await openCommandBar(shell, overlay, 'new');
      await overlay.keyboard.type(`${site.origin}/${path}`);
      await overlay.keyboard.press('Enter');
      await expect(today.getByRole('listitem').first()).toContainText(path === 'second' ? 'Second page' : 'Third page');
    }

    // ⌘D / Ctrl+D pins the active tab.
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('tab.pin'));
    await expect(pinned.getByRole('listitem')).toHaveCount(1);
    await expect(pinned).toContainText('Third page');
    await expect(today.getByRole('listitem')).toHaveCount(2);

    // Closing a pinned tab unloads it; it stays pinned.
    await pinned.getByRole('listitem').first().hover();
    await pinned.getByRole('button', { name: /^Close/ }).click();
    await expect(pinned.getByRole('listitem')).toHaveCount(1);
    await expect(pinned.getByRole('button', { name: 'Third page', exact: true })).not.toHaveAttribute('aria-current', 'page');
    // It reads as unloaded, and stays that way once the page has gone.
    await shell.waitForTimeout(800);
    await expect(pinned.getByRole('button', { name: 'Third page', exact: true })).toHaveAttribute('data-unloaded', 'true');

    // Drag First page (bottom of Today) above Second page.
    const drag = async (from: Locator, to: Locator, offsetY: number) => {
      const a = (await from.boundingBox())!;
      const b = (await to.boundingBox())!;
      await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await shell.mouse.down();
      await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 6, { steps: 4 });
      await shell.mouse.move(b.x + b.width / 2, b.y + offsetY, { steps: 12 });
      // Let the sortable settle over the target before letting go, as a hand would.
      await shell.waitForTimeout(200);
      await shell.mouse.move(b.x + b.width / 2 + 1, b.y + offsetY, { steps: 2 });
      await shell.mouse.up();
    };
    await drag(today.getByRole('listitem').nth(1), today.getByRole('listitem').first(), 4);
    await expect(today.getByRole('listitem').first()).toContainText('First page');
    // A new drag can't start while the last one's drop animation is still settling.
    await shell.waitForTimeout(600);

    // Drag Second page up into Pinned, below Third page.
    await drag(today.getByRole('listitem').nth(1), pinned.getByRole('listitem').first(), 28);
    await expect(pinned.getByRole('listitem')).toHaveCount(2);
    await expect(pinned.getByRole('listitem').nth(1)).toContainText('Second page');
    await expect(today.getByRole('listitem')).toHaveCount(1);

    // And back down: dropping a pinned tab on a Today row unpins it there.
    await shell.waitForTimeout(600);
    await drag(pinned.getByRole('listitem').first(), today.getByRole('listitem').first(), 4);
    await expect(pinned.getByRole('listitem')).toHaveCount(1);
    await expect(today.getByRole('listitem')).toHaveCount(2);
    await expect(today.getByRole('listitem').first()).toContainText('Third page');
  } finally {
    await app.close();
  }
});

test('find in page: counts matches, steps through them, and closes', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/words` });
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('Words');

    await runAction(shell, 'view.find');
    const field = popover.getByRole('textbox', { name: 'Find in page' });
    await expect(field).toBeFocused();
    await field.fill('chord');
    const bar = popover.getByRole('search', { name: 'Find in page' });
    await expect(bar).toContainText('1 of 3');
    await field.press('Enter');
    await expect(bar).toContainText('2 of 3');
    await field.press('Shift+Enter');
    await expect(bar).toContainText('1 of 3');
    await field.fill('harmonica');
    await expect(bar).toContainText('No matches');

    await field.press('Escape');
    await expect(bar).toBeHidden();
  } finally {
    await app.close();
  }
});

test('a permission prompt asks once, and the answer is remembered for the site', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    await pageWhere(app, isShell);
    const tab = await pageWhere(app, (url) => url.startsWith(site.origin));
    const popover = await pageWhere(app, isPopover);
    const ask = () => tab.evaluate(() => Notification.requestPermission());

    const first = ask();
    const prompt = popover.getByRole('alertdialog');
    await expect(prompt).toContainText('127.0.0.1');
    await expect(prompt).toContainText('Show notifications');
    await prompt.getByRole('button', { name: 'Allow' }).click();
    expect(await first).toBe('granted');
    await expect(prompt).toBeHidden();

    // Remembered: no second prompt, and the page can see it's allowed.
    expect(await ask()).toBe('granted');
    expect(await tab.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state)).toBe('granted');
  } finally {
    await app.close();
  }
});

test('a page that fails to load explains why, and recovers', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    // A port that was just closed: connection refused.
    const closed = await new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => done(port));
      });
    });
    const navigate = (url: string) =>
      app.evaluate(({ BaseWindow, WebContentsView }, u) => {
        const tab = BaseWindow.getAllWindows()[0]!.contentView.children[1];
        if (tab instanceof WebContentsView) void tab.webContents.loadURL(u).catch(() => {});
      }, url);

    await navigate(`http://127.0.0.1:${closed}/`);
    const alert = shell.getByRole('alert');
    await expect(alert).toContainText('can’t be reached');
    await expect(alert).toContainText('ERR_CONNECTION_REFUSED');
    await expect.poll(() => tabVisible(app)).toBe(false);

    await navigate(`${site.origin}/second`);
    await expect(alert).toBeHidden();
    await expect.poll(() => tabVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});

test('a page that keeps crashing stops after two reloads, and Reload brings it back', async () => {
  // ⚠ Times out on every Linux runner (X11 and Wayland, x64 and arm64) and hangs app.close();
  // the cause isn't known yet. Crash handling itself is covered on Windows and macOS.
  test.skip(process.platform === 'linux', 'forced renderer crashes hang on Linux CI; under investigation');
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    const crash = () =>
      app.evaluate(({ webContents }, origin) => {
        const page = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin) && !c.isCrashed());
        page?.forcefullyCrashRenderer();
        return Boolean(page);
      }, site.origin);
    const loaded = () =>
      app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some((c) => c.getURL().startsWith(origin) && !c.isCrashed() && !c.isLoading()), site.origin);
    // Count crashes as main sees them, so each one registers before the next.
    await app.evaluate(({ webContents }, origin) => {
      const counter = globalThis as { crashes?: number };
      counter.crashes = 0;
      for (const c of webContents.getAllWebContents()) if (c.getURL().startsWith(origin)) c.on('render-process-gone', () => void counter.crashes!++);
    }, site.origin);
    const crashes = () => app.evaluate(() => (globalThis as { crashes?: number }).crashes ?? 0);

    // Chord reloads a crashed page itself, twice (Crest's rule)…
    for (let i = 1; i <= 2; i++) {
      expect(await crash()).toBe(true);
      await expect.poll(crashes).toBe(i);
      await expect.poll(loaded, { timeout: 10_000 }).toBe(true);
    }
    // …and the third time it explains instead.
    await crash();
    await expect.poll(crashes).toBe(3);
    const alert = shell.getByRole('alert');
    await expect(alert).toContainText('This page stopped working.');
    await alert.getByRole('button', { name: 'Reload' }).click();
    await expect(alert).toBeHidden();
    await expect.poll(loaded, { timeout: 10_000 }).toBe(true);
  } finally {
    await app.close();
  }
});

test('downloads save to the Downloads folder without asking, never overwrite, and show in the panel', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'chord-dl-'));
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/files`, CHORD_DOWNLOADS_DIR: folder });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const tab = await pageWhere(app, (url) => url.startsWith(`${site.origin}/files`));

    await tab.click('#get');
    await expect(shell.getByRole('button', { name: 'Downloads, new' })).toBeVisible();
    await tab.click('#get');
    await expect.poll(() => readdirSync(folder).sort()).toEqual(['report (1).bin', 'report.bin']);
    expect(statSync(join(folder, 'report.bin')).size).toBe(300_000);
    // Both finished (the file appears just before the download reports done).
    await expect(shell.getByRole('button', { name: 'Downloads, new', exact: true })).toBeVisible();

    await shell.getByRole('button', { name: /^Downloads/ }).click();
    const panel = overlay.getByRole('dialog', { name: 'Downloads' });
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    await expect(panel).toContainText('report (1).bin');
    await expect(panel).toContainText('Done · 300 KB');
    // Opening the panel marks them seen.
    await overlay.keyboard.press('Escape');
    await expect(shell.getByRole('button', { name: 'Downloads', exact: true })).toBeVisible();

    // Downloaded files carry the mark of the web on Windows, so SmartScreen and Office's
    // Protected View still apply to them.
    if (process.platform === 'win32') {
      expect(readFileSync(join(folder, 'report.bin:Zone.Identifier'), 'utf8')).toMatch(/ZoneId=3/);
    }
  } finally {
    await app.close();
  }
});

test('history: a page you visited and closed is found again from the command bar', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/words` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('Words');

    // Open another page so Words can be closed, then close Words.
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/third`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('listitem').first()).toContainText('Third page');
    await today.getByRole('listitem').filter({ hasText: 'Words' }).hover();
    await today.getByRole('button', { name: /^Close Words/ }).click();
    await expect(today.getByRole('listitem')).toHaveCount(1);

    // Visits reach chord-data within a quarter second; then history finds it by title.
    await expect
      .poll(async () => {
        await openCommandBar(shell, overlay, 'new');
        await overlay.getByRole('textbox').fill('word');
        await overlay.waitForTimeout(150);
        const found = await overlay.getByRole('option').filter({ hasText: 'Words' }).count();
        await overlay.keyboard.press('Escape');
        return found;
      })
      .toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
const selection = (field: Locator) => field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]);

test('the command bar completes an address inline; Backspace never brings it back, Tab accepts it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('First page');
    // A recent tab on a host nothing else starts with.
    const port = new URL(site.origin).port;
    const full = `localhost:${port}/second`;
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`http://${full}`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('listitem').first()).toContainText('Second page');

    await openCommandBar(shell, overlay, 'new');
    const field = overlay.getByRole('textbox');
    await overlay.keyboard.type('loc');
    await expect(field).toHaveValue(full);
    expect(await selection(field)).toEqual([3, full.length]);
    // Backspace takes the completion away, and it doesn't come straight back.
    await overlay.keyboard.press('Backspace');
    await expect(field).toHaveValue('loc');
    await overlay.waitForTimeout(250);
    await expect(field).toHaveValue('loc');
    // Typing on completes again; Tab accepts it, caret at the end, and Return goes there.
    await overlay.keyboard.type('a');
    await expect(field).toHaveValue(full);
    await overlay.keyboard.press('Tab');
    await expect(field).toHaveValue(full);
    expect(await selection(field)).toEqual([full.length, full.length]);
    await expect(overlay.getByRole('option').first()).toContainText('Second page');
  } finally {
    await app.close();
  }
});

test('site keywords and @filters narrow the command bar to a chip', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('First page');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type(`${site.origin}/third`);
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('listitem').first()).toContainText('Third page');

    await openCommandBar(shell, overlay, 'new');
    const field = overlay.getByRole('textbox');
    const chip = overlay.getByTestId('scope-chip');
    // yt, then Tab: the bar searches YouTube.
    await overlay.keyboard.type('yt');
    await expect(overlay.getByRole('option').filter({ hasText: 'Search YouTube' })).toBeVisible();
    await overlay.keyboard.press('Tab');
    await expect(chip).toHaveText('YouTube');
    await expect(field).toHaveValue('');
    await expect(field).toHaveAttribute('placeholder', 'Search YouTube');
    await overlay.keyboard.type('lofi');
    await expect(overlay.getByRole('option').first()).toContainText('lofi');
    await expect(overlay.getByRole('option').first()).toContainText('Search YouTube');
    // Backspace through the text, then once more in the empty field: the chip goes.
    for (let i = 0; i < 4; i++) await overlay.keyboard.press('Backspace');
    await expect(chip).toBeVisible();
    await overlay.keyboard.press('Backspace');
    await expect(chip).toHaveCount(0);
    // Short keywords switch on Space too.
    await overlay.keyboard.type('gh ');
    await expect(chip).toHaveText('GitHub');
    await overlay.keyboard.press('Backspace');
    await expect(chip).toHaveCount(0);

    // @tabs, then Space: open tabs only, and nothing else.
    await overlay.keyboard.type('@tabs ');
    await expect(chip).toHaveText('Tabs');
    await expect(overlay.getByRole('option')).toHaveCount(1);
    await expect(overlay.getByRole('option').first()).toContainText('First page');
    await overlay.keyboard.press('Enter');
    await expect(today.getByRole('button', { name: 'First page', exact: true })).toHaveAttribute('aria-current', 'page');

    // `@` lists the filters; Return on one narrows to it.
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('@h');
    await expect(overlay.getByRole('option').first()).toContainText('Search history');
    await overlay.keyboard.press('Enter');
    await expect(chip).toHaveText('History');
  } finally {
    await app.close();
  }
});

test('search suggestions come in under local results; addresses are never sent, and the switch stops them', async () => {
  suggestionsAsked.length = 0;
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_SUGGEST_URL: `${site.origin}/suggest?q=` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('First page');
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('chord');
    const options = overlay.getByRole('option');
    await expect(options.filter({ hasText: 'chord progressions' })).toBeVisible();
    // The search for what was typed stays first; suggestions come last.
    await expect(options.first()).toContainText('Search Google');
    const texts = await options.allTextContents();
    expect(texts.at(-2)).toContain('chord progressions');
    expect(texts.at(-1)).toContain('chord finder');
    // Typing quickly asks after the pause, not for every key.
    expect(suggestionsAsked).toContain('chord');
    expect(suggestionsAsked.length).toBeLessThan(3);

    // Neither does a filter being typed, or an address.
    await overlay.getByRole('textbox').fill('@hist');
    await overlay.waitForTimeout(400);
    expect(suggestionsAsked.some((q) => q.startsWith('@'))).toBe(false);
    await overlay.getByRole('textbox').fill('example.com/private/path');
    await overlay.waitForTimeout(400);
    expect(suggestionsAsked.some((q) => q.includes('example.com'))).toBe(false);
    await overlay.keyboard.press('Escape');

    // Off in Settings → General: no more questions, no more rows.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    const toggle = settings.getByRole('switch', { name: 'Search suggestions' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const asked = suggestionsAsked.length;
    await openCommandBar(shell, overlay, 'new');
    await overlay.keyboard.type('chord');
    await overlay.waitForTimeout(400);
    await expect(overlay.getByRole('option').filter({ hasText: 'chord progressions' })).toHaveCount(0);
    expect(suggestionsAsked.length).toBe(asked);
  } finally {
    await app.close();
  }
});

test('a newer release is announced once, in a toast, and in Settings → About', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/`, CHORD_UPDATE_FEED: `${site.origin}/releases` });
  try {
    const shell = await pageWhere(app, isShell);
    // The draft (9.0.0) never counts; 0.2.0 is newer than a development build's 0.0.0.
    await expect(shell.getByRole('status').filter({ hasText: 'Chord 0.2.0 is out' })).toBeVisible({ timeout: 10_000 });
    await expect(shell.getByRole('button', { name: 'What’s new' })).toBeVisible();
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('button', { name: 'About' }).click();
    await expect(settings.getByText('Chord 0.2.0 is out')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'See what’s new' })).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Check for updates automatically' })).toHaveAttribute('aria-checked', 'true');
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
