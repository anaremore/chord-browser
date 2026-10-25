/**
 * Developer tools in the window (DESIGN.md §7.15; ARCHITECTURE.md §9), as
 * one journey: F12 docks a tab's DevTools beside its page, on the right to
 * start with; dragging the edge resizes them; the header puts them at the
 * bottom and pops them out into a window of their own, whose bar docks them
 * back; each tab keeps its own (switching tabs shows that tab's, or none);
 * they glide with the page when the frame changes size; the header's ✕ closes
 * them and Inspect opens them again; closing the tab closes them; and the
 * side and size come back after a relaunch.
 *
 * Keys can't be pressed into a page from Playwright (they never reach
 * before-input-event), so F12 runs through the action registry, as its
 * shortcut does. The layout is checked against core's own math.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devtoolsLayout, type DevtoolsSide, type PaneRect } from '@chord/core';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/': '<title>First page</title><p id="text">First</p>',
    '/second': '<title>Second page</title><p id="text">Second</p>',
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

async function launch(profile: string): Promise<ElectronApplication> {
  // A fresh profile, never a developer's real data.
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_E2E_HOOKS: '1', CHORD_HOME_URL: `${site.origin}/` };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => match(p.url()))!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
const isBar = (url: string) => url.startsWith('chord://devtools') || url.includes('/devtools/index.html');

interface Chord {
  chord: {
    action: { run(a: string): Promise<void> };
    overlay: { open(m: string): Promise<void> };
    state: {
      snapshot(): Promise<{
        windowId: string;
        state: {
          settings: { devtools: { side: DevtoolsSide; width: number; height: number; window: boolean } };
          live: Record<string, { devtools: 'docked' | 'window' | null } | undefined>;
          nodes: Record<string, { id: string; kind: string; title?: string }>;
        };
      }>;
      dispatch(c: unknown): Promise<void>;
    };
  };
}
type Hooks = { chordTestHooks: { snapshotFallbacks(): (string | null)[]; contextMenu(id: number): string[] | null; chooseContextMenuItem(id: number, label: string): void } };

const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as Chord).chord.action.run(a), action);

/** The setting, and each tab's DevTools, by title. */
const devtoolsState = (shell: Page) =>
  shell.evaluate(async () => {
    const { windowId, state } = await (window as unknown as Chord).chord.state.snapshot();
    const tabs = Object.values(state.nodes).filter((n) => n.kind === 'tab');
    return {
      windowId,
      settings: state.settings.devtools,
      ids: Object.fromEntries(tabs.map((t) => [t.title ?? '', t.id])),
      open: Object.fromEntries(tabs.map((t) => [t.title ?? '', state.live[t.id]?.devtools ?? null])),
    };
  });

/** The content frame, where the shell draws it (window pixels: the interface is at 100%). */
const frameRect = (shell: Page): Promise<PaneRect> =>
  shell.evaluate(() => {
    const r = document.querySelector('[data-region="page"]')!.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });

interface ViewInfo extends PaneRect {
  url: string;
  id: number;
}

/** The views of a window (`Chord`, or a DevTools window), with their bounds and what they show. */
const viewsOf = (app: ElectronApplication, title: RegExp) =>
  app.evaluate(({ BaseWindow }, source) => {
    const w = BaseWindow.getAllWindows().find((x) => !x.isDestroyed() && new RegExp(source).test(x.getTitle()));
    if (!w) return null;
    return w.contentView.children.map((v) => {
      const contents = 'webContents' in v ? (v as unknown as { webContents: { getURL(): string; id: number } }).webContents : null;
      return { ...v.getBounds(), url: contents?.getURL() ?? '', id: contents?.id ?? 0 };
    });
  }, title.source) as Promise<ViewInfo[] | null>;

const MAIN = /^Chord$/;
const DEVTOOLS_WINDOW = /^Developer tools/;
const isDevtools = (v: ViewInfo) => v.url.startsWith('devtools://');

/** Every DevTools page alive. */
const devtoolsPages = (app: ElectronApplication) =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.getURL().startsWith('devtools://'))
      .map((c) => ({ id: c.id })),
  );

/** What the page at `url` has as its DevTools, once they've loaded (Electron's `devToolsWebContents`): their address. */
const inspectedBy = (app: ElectronApplication, url: string) =>
  app.evaluate(({ webContents }, u) => {
    const tools = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL() === u)?.devToolsWebContents;
    return tools && !tools.isDestroyed() ? tools.getURL() : '';
  }, url);

/** Where the page and its docked DevTools are, against where core's math puts them in the frame the shell draws. */
async function docked(app: ElectronApplication, shell: Page, url: string, side: DevtoolsSide, size: number) {
  const frame = await frameRect(shell);
  const views = (await viewsOf(app, MAIN)) ?? [];
  const expected = devtoolsLayout(frame, side, size);
  const page = views.find((v) => v.url === url);
  const tools = views.find(isDevtools);
  const box = (r: PaneRect | undefined) => (r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
  return { page: box(page), tools: box(tools), fits: JSON.stringify([box(page), box(tools)]) === JSON.stringify([expected.page, expected.view]) };
}

/** Shell, command bar, and a page opened through it (the newest is active, at the top of Today). */
async function setUp(app: ElectronApplication, path: string) {
  const shell = await pageWhere(app, isShell);
  const overlay = await pageWhere(app, isOverlay);
  const today = shell.getByRole('tree', { name: 'Today' });
  await expect(today).toContainText('First page');
  await shell.evaluate(() => (window as unknown as Chord).chord.overlay.open('new'));
  await expect(overlay.getByRole('dialog')).toBeVisible();
  await overlay.keyboard.type(`${site.origin}${path}`);
  await overlay.keyboard.press('Enter');
  await expect(today.getByRole('treeitem').first()).toContainText(/second/i);
  return shell;
}

/**
 * Motion on whatever the OS says, as frame-snapshot.spec.ts does: main's
 * reading is replaced and announced, and the shell's media query follows.
 */
async function motionOn(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(({ nativeTheme, systemPreferences }) => {
    systemPreferences.getAnimationSettings = () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false });
    nativeTheme.emit('updated');
  });
  await shell.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(false);
}

test('DevTools dock beside the page, resize, move, pop out and back, stay with their tab, and keep their side and size', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const second = `${site.origin}/second`;
  let app = await launch(profile);
  try {
    const shell = await setUp(app, '/second');

    // F12: docked on the right (the default), 440 px, beside the page in the frame, under Chord's header.
    await runAction(shell, 'app.devtools');
    await expect.poll(async () => (await devtoolsState(shell)).open['Second page']).toBe('docked');
    expect((await devtoolsState(shell)).settings).toEqual({ side: 'right', width: 440, height: 320, window: false });
    await expect.poll(async () => (await docked(app, shell, second, 'right', 440)).fits).toBe(true);
    await expect(shell.getByRole('region', { name: 'Developer tools' })).toBeVisible();
    // DevTools loaded in that view, and the page counts them as its own (Electron says so once they've loaded).
    await expect.poll(() => inspectedBy(app, second), { timeout: 20_000 }).toMatch(/^devtools:\/\/devtools\//);
    const devtoolsId = (await devtoolsPages(app))[0]!.id;

    // Dragging the edge 120 px toward the page: 560 px, live, saved once let go.
    const edge = shell.getByRole('separator', { name: 'Resize developer tools' });
    // The pointer rests on it first (Playwright checks nothing else would take it there), as a hand does.
    await edge.hover();
    const box = (await edge.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // What the shell hears of the drag, to say so if it doesn't take.
    await shell.evaluate(() => {
      const w = window as unknown as { edgeEvents: string[] };
      w.edgeEvents = [];
      for (const type of ['pointerdown', 'gotpointercapture', 'pointermove', 'pointerup', 'lostpointercapture']) {
        document.addEventListener(type, (e) => w.edgeEvents.push(`${type} on ${(e.target as Element).getAttribute('aria-label') ?? (e.target as Element).tagName}`), true);
      }
      window.addEventListener('error', (e) => w.edgeEvents.push(`error: ${e.message}`));
    });
    await shell.mouse.move(cx, cy);
    await shell.mouse.down();
    await shell.mouse.move(cx - 60, cy, { steps: 5 });
    await shell.mouse.move(cx - 120, cy, { steps: 5 });
    await shell.mouse.up();
    await expect
      .poll(async () => (await devtoolsState(shell)).settings.width)
      .toBe(560)
      .catch(async (error: Error) => {
        const heard = await shell.evaluate(() => [...new Set((window as unknown as { edgeEvents: string[] }).edgeEvents)].join('; '));
        throw new Error(`${error.message}\nThe shell heard: ${heard || 'nothing'}`);
      });
    await expect.poll(async () => (await docked(app, shell, second, 'right', 560)).fits).toBe(true);

    // The other side: at the bottom, 320 px tall; the width waits for the right side.
    await shell.getByRole('button', { name: 'Dock to the bottom' }).click();
    await expect.poll(async () => (await devtoolsState(shell)).settings).toEqual({ side: 'bottom', width: 560, height: 320, window: false });
    await expect.poll(async () => (await docked(app, shell, second, 'bottom', 320)).fits).toBe(true);

    // Pop out: into a window of their own, under its bar; the page has the frame again.
    await shell.getByRole('button', { name: 'Pop out into a window' }).click();
    await expect.poll(async () => (await devtoolsState(shell)).open['Second page']).toBe('window');
    await expect.poll(async () => ((await viewsOf(app, DEVTOOLS_WINDOW)) ?? []).some(isDevtools)).toBe(true);
    const frame = await frameRect(shell);
    await expect.poll(async () => ((await viewsOf(app, MAIN)) ?? []).some(isDevtools)).toBe(false);
    await expect.poll(async () => ((await viewsOf(app, MAIN)) ?? []).find((v) => v.url === second)).toMatchObject({ ...frame });
    const bar = await pageWhere(app, isBar);
    await expect(bar.getByTestId('devtools-host')).toHaveText('127.0.0.1');
    const own = (await viewsOf(app, DEVTOOLS_WINDOW))!;
    expect(own.find(isDevtools)!.y).toBe(own.find((v) => isBar(v.url))!.height);
    expect((await devtoolsState(shell)).settings.window).toBe(true);

    // Back in, from the window's bar: at the bottom again; the window goes. Nothing reloaded.
    await bar.getByRole('button', { name: 'Dock in the window' }).click();
    await expect.poll(async () => (await devtoolsState(shell)).open['Second page']).toBe('docked');
    await expect.poll(() => viewsOf(app, DEVTOOLS_WINDOW)).toBeNull();
    await expect.poll(async () => (await docked(app, shell, second, 'bottom', 320)).fits).toBe(true);
    expect((await devtoolsState(shell)).settings.window).toBe(false);
    expect((await devtoolsPages(app)).map((p) => p.id)).toEqual([devtoolsId]);

    // Each tab keeps its own: First page has none; back on Second page, its DevTools are there, as they were.
    const { windowId, ids } = await devtoolsState(shell);
    await shell.evaluate((c) => (window as unknown as Chord).chord.state.dispatch(c), { t: 'tab.activate', windowId, nodeId: ids['First page'] });
    await expect.poll(async () => ((await viewsOf(app, MAIN)) ?? []).some(isDevtools)).toBe(false);
    await expect(shell.getByRole('region', { name: 'Developer tools' })).toHaveCount(0);
    expect((await devtoolsState(shell)).open).toMatchObject({ 'First page': null, 'Second page': 'docked' });
    await shell.evaluate((c) => (window as unknown as Chord).chord.state.dispatch(c), { t: 'tab.activate', windowId, nodeId: ids['Second page'] });
    await expect.poll(async () => (await docked(app, shell, second, 'bottom', 320)).fits).toBe(true);
    expect((await devtoolsPages(app)).map((p) => p.id)).toEqual([devtoolsId]);

    // Collapsing the sidebar changes the frame's size: DevTools are pictured and glide with the page, then land beside it.
    await motionOn(app, shell);
    // Pictured once already (a slow machine's first picture takes longest), then counted.
    await app.evaluate(async ({ webContents }) => {
      const tools = webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith('devtools://'))!;
      await tools.capturePage();
      const g = globalThis as unknown as { devtoolsCaptures: number };
      g.devtoolsCaptures = 0;
      const capture = tools.capturePage.bind(tools);
      tools.capturePage = ((...args: Parameters<typeof capture>) => {
        g.devtoolsCaptures++;
        return capture(...args);
      }) as typeof tools.capturePage;
    });
    // The shell's picture of them carries a copy of their header.
    await shell.evaluate(() => {
      const w = window as unknown as { devtoolsPicture: boolean };
      w.devtoolsPicture = false;
      new MutationObserver((records) => {
        for (const added of records.flatMap((r) => [...r.addedNodes])) {
          if (added instanceof HTMLElement && added.querySelector('canvas') && added.querySelector('[inert]')?.textContent?.includes('Developer tools')) w.devtoolsPicture = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await runAction(shell, 'view.toggleSidebar');
    await expect.poll(async () => (await frameRect(shell)).x).toBeLessThan(frame.x);
    await expect.poll(async () => (await docked(app, shell, second, 'bottom', 320)).fits).toBe(true);
    const fallback = await app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.snapshotFallbacks()[0]);
    if (fallback === null) {
      expect(await app.evaluate(() => (globalThis as unknown as { devtoolsCaptures: number }).devtoolsCaptures)).toBe(1);
      expect(await shell.evaluate(() => (window as unknown as { devtoolsPicture: boolean }).devtoolsPicture)).toBe(true);
    } else {
      // A machine too slow to picture the frame in time (CI's slower Macs, now and then) changes it at once, as designed.
      expect(['capture', 'shown']).toContain(fallback);
    }
    await runAction(shell, 'view.toggleSidebar');
    await expect.poll(async () => (await frameRect(shell)).x).toBe(frame.x);

    // The header's ✕ closes them; Inspect, from the page's menu, opens them again where they were (docked, at the bottom).
    await shell.getByRole('button', { name: 'Close developer tools' }).click();
    await expect.poll(() => devtoolsPages(app)).toEqual([]);
    await expect.poll(async () => ((await viewsOf(app, MAIN)) ?? []).some(isDevtools)).toBe(false);
    expect((await devtoolsState(shell)).open['Second page']).toBeNull();
    const page = await pageWhere(app, (url) => url === second);
    const pageId = (await viewsOf(app, MAIN))!.find((v) => v.url === second)!.id;
    await page.locator('#text').click({ button: 'right' });
    await expect.poll(() => app.evaluate((_electron, id) => (globalThis as unknown as Hooks).chordTestHooks.contextMenu(id), pageId)).toContain('Inspect');
    await app.evaluate((_electron, id) => (globalThis as unknown as Hooks).chordTestHooks.chooseContextMenuItem(id, 'Inspect'), pageId);
    await expect.poll(async () => (await devtoolsState(shell)).open['Second page']).toBe('docked');
    await expect.poll(async () => (await docked(app, shell, second, 'bottom', 320)).fits).toBe(true);

    // Closing the tab closes its DevTools.
    await runAction(shell, 'tab.close');
    await expect.poll(() => devtoolsPages(app)).toEqual([]);
    await expect.poll(async () => ((await viewsOf(app, MAIN)) ?? []).some(isDevtools)).toBe(false);
  } finally {
    await app.close();
  }

  // After a relaunch: still at the bottom, 320 tall, and 560 wide on the right.
  app = await launch(profile);
  try {
    const shell = await pageWhere(app, isShell);
    await expect(shell.getByRole('tree', { name: 'Today' })).toContainText('First page');
    expect((await devtoolsState(shell)).settings).toEqual({ side: 'bottom', width: 560, height: 320, window: false });
    await runAction(shell, 'app.devtools');
    await expect.poll(async () => (await docked(app, shell, `${site.origin}/`, 'bottom', 320)).fits).toBe(true);
    await shell.getByRole('button', { name: 'Dock to the right' }).click();
    await expect.poll(async () => (await docked(app, shell, `${site.origin}/`, 'right', 560)).fits).toBe(true);
    // F12 again closes them.
    await runAction(shell, 'app.devtools');
    await expect.poll(() => devtoolsPages(app)).toEqual([]);
  } finally {
    await app.close();
  }
});
