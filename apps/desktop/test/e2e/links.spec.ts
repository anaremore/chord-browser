/**
 * Links from everywhere (DESIGN.md §7.9, §8.5): links other apps hand Chord
 * open in a mini window, a pinned tab's links to other sites open in Peek, and
 * link routes send a site's links to its chord.
 *
 * Two hosts on one server stand for two sites: 127.0.0.1 and localhost.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { State } from '@chord/core';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

interface Site {
  server: Server;
  /** http://127.0.0.1:port */
  origin: string;
  /** The same server as another site: http://localhost:port */
  other: string;
}

function startSite(): Promise<Site> {
  let port = 0;
  const pages: Record<string, () => string> = {
    '/home': () => '<title>Home</title>',
    '/a': () => '<title>A</title><a id="next" href="/b">Next</a>',
    '/b': () => '<title>B</title><p>B</p>',
    '/c': () => '<title>C</title>',
    '/d': () => '<title>D</title>',
    '/pinned': () => `<title>Pinned</title><p><a id="out" href="http://localhost:${port}/other">Elsewhere</a></p><p><a id="same" href="/b">Same site</a></p>`,
    '/private': () => `<title>Private</title><p><a id="out" href="http://localhost:${port}/secret">Secret</a></p>`,
    '/other': () => '<title>Other</title><a id="next" href="/other2">More</a>',
    '/other2': () => '<title>Other 2</title>',
    '/secret': () => '<title>Secret</title>',
  };
  const server = createServer((req, res) => {
    const page = pages[(req.url ?? '/').split('?')[0]!];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ? page() : 'not found');
  });
  // Every address, so both 127.0.0.1 and localhost (which may be ::1) reach it.
  return new Promise((done) =>
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      done({ server, origin: `http://127.0.0.1:${port}`, other: `http://localhost:${port}` });
    }),
  );
}

let site: Site;
test.beforeAll(async () => {
  site = await startSite();
});
test.afterAll(() => site.server.close());

async function launch(env: Record<string, string>, args: string[] = []): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: mkdtempSync(join(tmpdir(), 'chord-e2e-')), ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  // A link from another app comes last, after --single-argument, as the OS hands it over.
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run', ...args], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean, timeout = 20_000): Promise<Page> {
  const open = () => app.windows().filter((p) => !p.isClosed());
  await expect.poll(() => open().some((p) => match(p.url())), { timeout }).toBe(true);
  return open().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
const isMini = (url: string) => url.startsWith('chord://mini') || url.includes('/mini/index.html');

type ChordWindow = { chord: { action: { run(a: string): Promise<void> }; state: { snapshot(): Promise<{ windowId: string; state: State }>; dispatch(c: unknown): Promise<void> } } };

const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as ChordWindow).chord.action.run(a), action);
const snapshot = (shell: Page) => shell.evaluate(() => (window as unknown as ChordWindow).chord.state.snapshot());
const dispatch = (shell: Page, command: unknown) => shell.evaluate((c) => (window as unknown as ChordWindow).chord.state.dispatch(c), command);

/** Open an address from the command bar, the way a person does. */
async function visit(shell: Page, overlay: Page, url: string) {
  await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await overlay.getByRole('textbox').fill(url);
  await overlay.keyboard.press('Enter');
}

/** A page's WebContents in main, by its address. */
const contentsId = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)?.id ?? null, url);
const canGoBack = (app: ElectronApplication, id: number) =>
  app.evaluate(({ webContents }, i) => {
    const c = webContents.fromId(i);
    return c && !c.isDestroyed() ? c.navigationHistory.canGoBack() : null;
  }, id);

/** Another app hands Chord a link while it runs (the OS starts Chord again, which passes it on). */
const handOver = (app: ElectronApplication, url: string) =>
  app.evaluate(({ app: electronApp }, u) => {
    electronApp.emit('second-instance', { preventDefault() {} }, ['chord', '--single-argument', u], process.cwd(), {});
  }, url);

/**
 * Click a link in a page with the mouse, as a person does, from main. Peek
 * cancels the page's own navigation, which Playwright would otherwise keep
 * waiting for on that page.
 */
async function clickLink(app: ElectronApplication, url: string, selector: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, [u, sel]) => {
      const c = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)!;
      const at = (await c.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      )) as { x: number; y: number };
      c.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      c.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    },
    [url, selector] as const,
  );
}

const tabWith = (state: State, url: string) => Object.values(state.nodes).find((n) => n.kind === 'tab' && n.url === url);

test('a link from another app opens in a mini window, and Open in moves it into a chord with its history', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/home` }, ['--single-argument', `${site.origin}/a`]);
  try {
    const bar = await pageWhere(app, isMini);
    const page = await pageWhere(app, (url) => url === `${site.origin}/a`);
    // Launched just to open a link: only its mini window, not every window Chord had.
    expect(app.windows().some((p) => isShell(p.url()))).toBe(false);
    await expect(bar.getByTestId('mini-host')).toHaveText('127.0.0.1');
    const promote = bar.getByRole('button', { name: /^Open in/ });
    await expect(promote).toContainText('Personal');

    // Follow a link inside it: that's history the tab should keep.
    await page.locator('#next').click();
    await expect.poll(() => page.url()).toBe(`${site.origin}/b`);
    const id = (await contentsId(app, `${site.origin}/b`))!;

    await promote.click();
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('list', { name: 'Today' }).getByRole('listitem').first()).toContainText('B');
    // The same page moved into the window, so Back still goes to A.
    expect(await contentsId(app, `${site.origin}/b`)).toBe(id);
    await expect.poll(() => canGoBack(app, id)).toBe(true);
    await expect.poll(() => app.windows().some((p) => isMini(p.url()))).toBe(false);
    const { windowId, state } = await snapshot(shell);
    const tab = tabWith(state, `${site.origin}/b`);
    expect(tab).toMatchObject({ section: 'today', chordId: state.windows[windowId]!.activeChordId });
    expect(state.windows[windowId]!.activeTab[state.windows[windowId]!.activeChordId]).toBe(tab!.id);

    // Another link while Chord runs: a mini window of its own. Closing it closes its page.
    await handOver(app, `${site.origin}/c`);
    await pageWhere(app, isMini);
    await pageWhere(app, (url) => url === `${site.origin}/c`);
    await expect
      .poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().some((w) => w.getTitle() === 'C')))
      .toBe(true);
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.getTitle() === 'C')?.close());
    await expect.poll(() => contentsId(app, `${site.origin}/c`)).toBeNull();
    expect(tabWith((await snapshot(shell)).state, `${site.origin}/c`)).toBeUndefined();

    // Settings → General: links from other apps can open as tabs instead.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('radiogroup', { name: 'Links from other apps open in' }).getByRole('radio', { name: 'New tab' }).click();
    await expect.poll(async () => (await snapshot(shell)).state.settings.externalLinks).toBe('tab');
    await handOver(app, `${site.origin}/d`);
    await expect(shell.getByRole('list', { name: 'Today' }).getByRole('listitem').first()).toContainText('D');
    expect(app.windows().some((p) => isMini(p.url()))).toBe(false);
  } finally {
    await app.close();
  }
});

test('a pinned tab’s link to another site opens in Peek: Esc or a click outside closes it, Open in Today keeps it', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/pinned`, CHORD_E2E_HOOKS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/pinned`);
    await runAction(shell, 'tab.pin');
    await expect(shell.getByRole('list', { name: 'Pinned' })).toContainText('Pinned');
    const peek = overlay.getByRole('dialog', { name: /^Peek/ });

    // A link to the same site goes on in place, as always.
    await tab.locator('#same').click();
    await expect.poll(() => tab.url()).toBe(`${site.origin}/b`);
    await expect(peek).toBeHidden();
    await tab.goBack();
    await expect.poll(() => tab.url()).toBe(`${site.origin}/pinned`);

    // Another site: Peek, over the pinned page, which stays where it was.
    await clickLink(app, `${site.origin}/pinned`, '#out');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('localhost');
    const peekPage = await pageWhere(app, (url) => url === `${site.other}/other`);
    expect(tab.url()).toBe(`${site.origin}/pinned`);

    // Esc, in Peek's page, closes it; its page goes, and nothing was added to the sidebar.
    await expect.poll(() => peekPage.evaluate(() => document.hasFocus())).toBe(true);
    await app.evaluate(({ webContents }, u) => {
      const c = webContents.getAllWebContents().find((w) => w.getURL() === u)!;
      c.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      c.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, `${site.other}/other`);
    await expect(peek).toBeHidden();
    await expect.poll(() => contentsId(app, `${site.other}/other`)).toBeNull();
    expect(tabWith((await snapshot(shell)).state, `${site.other}/other`)).toBeUndefined();

    // A click outside the card closes it too.
    await clickLink(app, `${site.origin}/pinned`, '#out');
    await expect(peek).toBeVisible();
    await overlay.getByTestId('peek-scrim').click({ position: { x: 4, y: 4 } });
    await expect(peek).toBeHidden();

    // Open in Today: the page, with its own back stack, becomes the top Today tab.
    await clickLink(app, `${site.origin}/pinned`, '#out');
    await expect(peek).toBeVisible();
    const again = await pageWhere(app, (url) => url === `${site.other}/other`);
    await again.locator('#next').click();
    await expect(peek).toContainText('Other 2');
    const id = (await contentsId(app, `${site.other}/other2`))!;
    await peek.getByRole('button', { name: /Open in Today/ }).click();
    await expect(peek).toBeHidden();
    await expect(shell.getByRole('list', { name: 'Today' }).getByRole('listitem').first()).toContainText('Other 2');
    expect(await contentsId(app, `${site.other}/other2`)).toBe(id);
    await expect.poll(() => canGoBack(app, id)).toBe(true);
    const { windowId, state } = await snapshot(shell);
    expect(state.windows[windowId]!.activeTab[state.windows[windowId]!.activeChordId]).toBe(tabWith(state, `${site.other}/other2`)!.id);
    expect(tabWith(state, `${site.origin}/pinned`)).toMatchObject({ section: 'pinned' });

    // In a split, Peek floats over the pinned tab's pane, not the whole frame.
    const pinnedId = tabWith(state, `${site.origin}/pinned`)!.id;
    await dispatch(shell, { t: 'split.add', windowId, withId: pinnedId, url: `${site.origin}/b` });
    await pageWhere(app, (url) => url === `${site.origin}/b`);
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: pinnedId });
    await expect.poll(async () => (await snapshot(shell)).state.windows[windowId]!.activeTab[state.windows[windowId]!.activeChordId]).toBe(pinnedId);
    await clickLink(app, `${site.origin}/pinned`, '#out');
    await expect(peek).toBeVisible();
    const paneOf = (url: string) =>
      app.evaluate(({ BaseWindow }, u) => {
        for (const w of BaseWindow.getAllWindows()) {
          const view = w.contentView.children.find((v) => 'webContents' in v && (v as Electron.WebContentsView).webContents.getURL() === u);
          if (view) return view.getBounds();
        }
        return null;
      }, url);
    const pane = (await paneOf(`${site.origin}/pinned`))!;
    // Two panes side by side: Peek sized to the whole frame wouldn't fit in one.
    expect(await paneOf(`${site.origin}/b`)).not.toEqual(pane);
    const card = (await peek.boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(pane.x);
    expect(card.x + card.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
    await overlay.getByTestId('peek-scrim').click({ position: { x: 4, y: 4 } });
    await expect(peek).toBeHidden();

    // A private window has no pinned tabs, but any link can open in Peek from its menu; nothing of it is kept.
    await runAction(shell, 'window.newPrivate');
    await expect.poll(() => app.windows().filter((p) => isOverlay(p.url())).length).toBe(2);
    const privateOverlay = app.windows().filter((p) => isOverlay(p.url()))[1]!;
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('textbox').fill(`${site.origin}/private`);
    await privateOverlay.keyboard.press('Enter');
    const privateTab = await pageWhere(app, (url) => url === `${site.origin}/private`);
    const privateId = (await contentsId(app, `${site.origin}/private`))!;
    await privateTab.locator('#out').click({ button: 'right' });
    type Hooks = { chordTestHooks: { contextMenu(id: number): string[] | null; chooseContextMenuItem(id: number, label: string): void } };
    await expect
      .poll(() => app.evaluate((_electron, i) => (globalThis as unknown as Hooks).chordTestHooks.contextMenu(i), privateId))
      .toContain('Open link in Peek');
    await app.evaluate((_electron, i) => (globalThis as unknown as Hooks).chordTestHooks.chooseContextMenuItem(i, 'Open link in Peek'), privateId);
    const privatePeek = privateOverlay.getByRole('dialog', { name: /^Peek/ });
    await expect(privatePeek).toBeVisible();
    await pageWhere(app, (url) => url === `${site.other}/secret`);
    await expect(privatePeek).toContainText('Secret');
    // A normal window's Peek is history like any page; a private window's never is.
    const history = async (q: string) =>
      (
        await overlay.evaluate(
          (text) => (window as unknown as { chord: { history: { search(q: string): Promise<{ history: { url: string }[] }> } } }).chord.history.search(text),
          q,
        )
      ).history.map((h) => h.url);
    await expect.poll(() => history('localhost')).toContain(`${site.other}/other`);
    expect(await history('secret')).not.toContain(`${site.other}/secret`);
  } finally {
    await app.close();
  }
});

test('a link route sends a site’s links to its chord, from other apps and the command bar, and Chord offers one', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/a` });
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    await expect(shell.getByRole('list', { name: 'Today' })).toContainText('A');
    const theme = { stops: [{ l: 0.72, c: 0.1, h: 200 }], grain: 0.2, appearance: 'auto' as const };
    await dispatch(shell, { t: 'chord.create', windowId: 'w', name: 'Work', icon: 'W', theme });
    const chordNamed = (state: State, name: string) => Object.values(state.chords).find((c) => c.name === name)!.id;
    const first = await snapshot(shell);
    const work = chordNamed(first.state, 'Work');
    const personal = chordNamed(first.state, 'Personal');
    await dispatch(shell, { t: 'chord.activate', windowId: 'w', chordId: personal });

    // Moving a site's pages to the same chord twice: Chord asks, once, and only then makes a route.
    for (const path of ['/other', '/other2']) {
      await visit(shell, overlay, `${site.other}${path}`);
      await expect(shell.getByRole('list', { name: 'Today' }).getByRole('listitem').first()).toContainText(path === '/other' ? 'Other' : 'Other 2');
      const { state } = await snapshot(shell);
      await shell.evaluate(
        ([nodeId, chordId]) => (window as unknown as { chord: { sidebar: { moveToChord(n: string, c: string): Promise<void> } } }).chord.sidebar.moveToChord(nodeId!, chordId!),
        [tabWith(state, `${site.other}${path}`)!.id, work],
      );
    }
    expect((await snapshot(shell)).state.linkRoutes).toEqual({});
    // On the move's own toast: a second line, under "Moved to Work" and its Undo.
    const moved = shell.getByRole('status').filter({ hasText: 'Always open localhost here?' });
    await expect(moved).toContainText('Moved to Work');
    await moved.getByRole('button', { name: 'Always' }).click();
    await expect.poll(async () => (await snapshot(shell)).state.linkRoutes['localhost']?.chordId).toBe(work);
    // Answered, the question goes; the move's Undo stays.
    await expect(shell.getByText('Always open localhost here?')).toBeHidden();
    await expect(shell.getByRole('status').filter({ hasText: 'Moved to Work' }).first().getByRole('button', { name: 'Undo' })).toBeVisible();

    // From another app: straight to Work, as a tab (a route skips the mini window).
    await handOver(app, `${site.other}/c`);
    await expect.poll(async () => tabWith((await snapshot(shell)).state, `${site.other}/c`)?.chordId).toBe(work);
    expect(app.windows().some((p) => isMini(p.url()))).toBe(false);
    const windowId = (await snapshot(shell)).windowId;
    await expect.poll(async () => (await snapshot(shell)).state.windows[windowId]!.activeChordId).toBe(work);

    // From the command bar, typed in Personal: it opens in Work, and the window goes there.
    await dispatch(shell, { t: 'chord.activate', windowId, chordId: personal });
    await visit(shell, overlay, `${site.other}/d`);
    await expect.poll(async () => tabWith((await snapshot(shell)).state, `${site.other}/d`)?.chordId).toBe(work);
    await expect.poll(async () => (await snapshot(shell)).state.windows[windowId]!.activeChordId).toBe(work);

    // Settings → General → Link routes lists them, adds one, and removes one.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await expect(settings.getByRole('combobox', { name: 'Chord for localhost' })).toHaveValue(work);
    await settings.getByRole('textbox', { name: 'Site for a new route' }).fill('https://www.example.org/path');
    await settings.getByRole('combobox', { name: 'Chord for the new route' }).selectOption(personal);
    await settings.getByRole('button', { name: 'Add route' }).click();
    await expect(settings.getByRole('combobox', { name: 'Chord for example.org' })).toHaveValue(personal);
    await settings.getByRole('button', { name: 'Remove the route for localhost' }).click();
    await expect.poll(async () => Object.keys((await snapshot(shell)).state.linkRoutes)).toEqual(['example.org']);
  } finally {
    await app.close();
  }
});
