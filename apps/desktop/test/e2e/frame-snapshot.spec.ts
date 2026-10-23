/**
 * The frame's snapshot (ARCHITECTURE.md §5; DESIGN.md §6.1 rule 4, §6.5):
 * docking and collapsing the sidebar, and opening and closing Duet's panel,
 * change the content frame's size by picturing the pages and gliding the
 * pictures in the shell. Each page moves twice at most, never every frame;
 * with motion off nothing is pictured at all.
 *
 * Only Chord's own views are pictured (the shell's page, by Playwright).
 * Mid-transition frames go to test-results/frame-snapshot/.
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { paneRects } from '@chord/core';
import { springCurve, springs } from '@chord/tokens';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const framesDir = resolve(appDir, 'test-results', 'frame-snapshot');
/** The page's color, to find in its picture: rgb(200, 40, 120). */
const COLOR = [200, 40, 120] as const;
/** Duet's panel and the gap before it (DESIGN.md §7.8). */
const DUET_SPACE = 380 + 8;

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/': `<title>Colored page</title><style>html{background:rgb(${COLOR.join(',')})}</style><input id="field" aria-label="Field">`,
    '/second': '<title>Second page</title><p>Another page.</p>',
    '/fullscreen':
      '<title>Fullscreen</title><div id="stage">A video, say</div><button id="go">Go fullscreen</button>' +
      `<script>document.getElementById('go').onclick = () => document.getElementById('stage').requestFullscreen();</script>`,
  };
  const server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  mkdirSync(framesDir, { recursive: true });
});
test.afterAll(() => site.server.close());

async function launch(home = '/', profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'))): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: profile,
    CHORD_HOME_URL: `${site.origin}${home}`,
    // Duet's panel opens without looking for a real Claude Code or Codex (paths that don't exist).
    CHORD_DUET_CLAUDE: join(profile, 'no-claude'),
    CHORD_DUET_CODEX: join(profile, 'no-codex'),
  };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function pageWhere(app: ElectronApplication, match: (url: string) => boolean, not: Page[] = []): Promise<Page> {
  const find = () => app.windows().find((p) => match(p.url()) && !not.includes(p));
  await expect.poll(() => Boolean(find()), { timeout: 20_000 }).toBe(true);
  return find()!;
}

const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');

const runAction = (shell: Page, action: string) =>
  shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

/**
 * Motion on or off whatever the OS says (this PC asks for reduced motion):
 * main's reading is replaced and announced, as perf.spec.ts does, and the
 * shell's own media query follows.
 */
async function setMotion(app: ElectronApplication, shell: Page, on: boolean): Promise<void> {
  await app.evaluate(({ nativeTheme, systemPreferences }, reduced) => {
    systemPreferences.getAnimationSettings = () => ({ shouldRenderRichAnimation: !reduced, scrollAnimationsEnabledBySystem: !reduced, prefersReducedMotion: reduced });
    nativeTheme.emit('updated');
  }, !on);
  await shell.emulateMedia({ reducedMotion: on ? 'no-preference' : 'reduce' });
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(!on);
}

/** Which window: the first one, or the private one. */
type Which = 'first' | 'private';

/**
 * From now on, notes in main each move of each page in the window's frame
 * (`setBounds`: where to, when, and whether the page had the keyboard), and counts
 * its pictures (`capturePage`). Optionally makes its pictures fail or never come.
 */
async function watch(app: ElectronApplication, which: Which = 'first', capture: 'real' | 'fail' | 'hang' = 'real'): Promise<void> {
  await app.evaluate(
    ({ BaseWindow }, { origin, which, capture }) => {
      interface Watched {
        setBounds(b: { x: number; y: number; width: number; height: number }): void;
        webContents: { getURL(): string; capturePage(): Promise<unknown>; isFocused(): boolean };
      }
      interface Snap {
        moves: Record<string, number>;
        rects: Record<string, { x: number; y: number; width: number; height: number; focused: boolean; at: number }[]>;
        captures: number;
      }
      const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === (which === 'private' ? 'Chord (private window)' : 'Chord'))!;
      const g = globalThis as unknown as { snap: Snap };
      g.snap = { moves: {}, rects: {}, captures: 0 };
      for (const v of w.contentView.children as unknown as Watched[]) {
        if (!('webContents' in v) || !v.webContents.getURL().startsWith(origin)) continue;
        const url = v.webContents.getURL();
        const own = v as unknown as Record<string, unknown>;
        const setBounds = (own['chordSetBounds'] as Watched['setBounds'] | undefined) ?? v.setBounds.bind(v);
        own['chordSetBounds'] = setBounds;
        v.setBounds = (b) => {
          g.snap.moves[url] = (g.snap.moves[url] ?? 0) + 1;
          (g.snap.rects[url] ??= []).push({ ...b, focused: v.webContents.isFocused(), at: Date.now() });
          setBounds(b);
        };
        const contents = v.webContents as unknown as Record<string, unknown>;
        const capturePage = (contents['chordCapturePage'] as Watched['webContents']['capturePage'] | undefined) ?? v.webContents.capturePage.bind(v.webContents);
        contents['chordCapturePage'] = capturePage;
        v.webContents.capturePage = () => {
          g.snap.captures++;
          if (capture === 'fail') return Promise.reject(new Error('No picture today'));
          if (capture === 'hang') return new Promise(() => {});
          return capturePage();
        };
      }
    },
    { origin: site.origin, which, capture },
  );
}

interface Watched {
  moves: Record<string, number>;
  rects: Record<string, { x: number; y: number; width: number; height: number; focused: boolean; at: number }[]>;
  captures: number;
}
const watched = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { snap: Watched }).snap);

/**
 * The snapshot's two moves of a page: first out of sight, all but its top-left
 * pixel past the window's bottom-right corner, already at its final size; then
 * into place. Never more, never per frame.
 */
function expectGlide(moves: Watched['rects'][string] | undefined, to: { x: number; y: number; width: number; height: number }, window: { width: number; height: number }) {
  expect(moves?.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([{ x: window.width - 1, y: window.height - 1, width: to.width, height: to.height }, to]);
}

/** The pages in a window's frame, left to right, with their bounds; and the window's content width. */
const pages = (app: ElectronApplication, which: Which = 'first') =>
  app.evaluate(
    ({ BaseWindow }, { origin, which }) => {
      const w = BaseWindow.getAllWindows().find((x) => x.getTitle() === (which === 'private' ? 'Chord (private window)' : 'Chord'))!;
      const views = w.contentView.children
        .filter((v) => 'webContents' in v && (v as { webContents: { getURL(): string } }).webContents.getURL().startsWith(origin))
        .map((v) => ({ ...v.getBounds(), focused: (v as unknown as { webContents: { isFocused(): boolean } }).webContents.isFocused() }))
        .sort((a, b) => a.x - b.x);
      return { views, width: w.getContentBounds().width, height: w.getContentBounds().height };
    },
    { origin: site.origin, which },
  );

/**
 * Notes, in the shell, whether a frame snapshot ever showed (a picture was
 * added), and the first picture's center color and position.
 */
const recordPictures = (shell: Page) =>
  shell.evaluate(() => {
    const seen = { count: 0, color: [] as number[], rects: [] as { x: number; y: number; width: number; height: number }[], unseen: false, focusable: true };
    (window as unknown as { snapSeen: typeof seen }).snapSeen = seen;
    new MutationObserver(() => {
      const canvases = [...document.querySelectorAll('canvas')];
      if (canvases.length === 0 || seen.count > 0) return;
      seen.count = canvases.length;
      seen.rects = canvases.map((c) => ({ x: parseFloat(c.style.left), y: parseFloat(c.style.top), width: parseFloat(c.style.width), height: parseFloat(c.style.height) }));
      const c = canvases[0]!;
      // Out of screen readers' way, and never focusable.
      seen.unseen = c.closest('[aria-hidden="true"]') !== null;
      seen.focusable = c.tabIndex >= 0;
      seen.color = [...c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data];
    }).observe(document.body, { childList: true, subtree: true });
  });
const picturesSeen = (shell: Page) =>
  shell.evaluate(() => (window as unknown as { snapSeen: { count: number; color: number[]; rects: { x: number; y: number; width: number; height: number }[]; unseen: boolean; focusable: boolean } }).snapSeen);
const picturesNow = (shell: Page) => shell.evaluate(() => document.querySelectorAll('canvas').length);

/** Saves the shell as it is now (Chord's own view only) to test-results/frame-snapshot/. */
const saveFrame = (shell: Page, name: string) => shell.screenshot({ path: join(framesDir, `${name}.png`) }).catch(() => undefined);

/**
 * Runs `act` and, once the pictures start gliding, saves a few frames of the
 * shell mid-glide (Chord's own view only): `<name>-1.png` and on.
 */
async function glide(shell: Page, name: string, act: () => Promise<unknown>): Promise<void> {
  const gliding = shell.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.style.transform !== ''), undefined, { polling: 'raf', timeout: 5000 });
  await act();
  await gliding;
  for (let i = 1; i <= 3 && (await picturesNow(shell)) > 0; i++) await saveFrame(shell, `${name}-${i}`);
}

async function ready(app: ElectronApplication, home = 'Colored page'): Promise<{ shell: Page; overlay: Page }> {
  const shell = await pageWhere(app, isShell);
  const overlay = await pageWhere(app, isOverlay);
  await expect(shell.getByRole('tree', { name: 'Today' })).toContainText(home);
  await expect.poll(async () => (await pages(app)).views.length).toBe(1);
  // Just after launch, a slow machine (CI's macOS ones) takes longer than a snapshot may (PREPARE_TIMEOUT_MS)
  // over its first picture and the shell's first frames, and the frame just changes at once instead. Once a
  // page has been pictured and the shell is idle, it glides, as it does in a Chord that has been running.
  await app.evaluate(async ({ webContents }, origin) => {
    await Promise.all(webContents.getAllWebContents().filter((c) => c.getURL().startsWith(origin)).map((c) => c.capturePage()));
  }, site.origin);
  await shell.evaluate(() => new Promise<void>((done) => requestIdleCallback(() => done(), { timeout: 2000 })));
  return { shell, overlay };
}

test('docking and collapsing glide the page by its snapshot: two moves, its picture in the shell, focus kept', async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    await setMotion(app, shell, true);
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(248);
    const before = (await pages(app)).views[0]!;
    // The page has the keyboard (as after clicking into it).
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!.focus(), site.origin);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/`);
    // The page stays shown throughout (out of sight, not hidden): it never hears it went away.
    await tab.evaluate(() => {
      const w = window as unknown as { hidden: number };
      w.hidden = 0;
      document.addEventListener('visibilitychange', () => (w.hidden += document.visibilityState === 'hidden' ? 1 : 0));
    });

    for (const [name, x] of [['collapse', 4], ['dock', 248]] as const) {
      await watch(app);
      await recordPictures(shell);
      // Mid-glide, the page waits out of sight and its picture glides in the shell.
      await glide(shell, name, () => runAction(shell, 'view.toggleSidebar'));
      await expect.poll(() => picturesNow(shell)).toBe(0);
      const { views, width, height } = await pages(app);
      expect(views[0]!.x).toBe(x);
      expect(await tab.evaluate(() => (window as unknown as { hidden: number }).hidden)).toBe(0);

      const seen = await picturesSeen(shell);
      expect(seen.count).toBe(1);
      expect(seen).toMatchObject({ unseen: true, focusable: false });
      // The picture is the page: its color, where the page was, at its size.
      for (const [i, c] of COLOR.entries()) expect(Math.abs(seen.color[i]! - c)).toBeLessThanOrEqual(2);
      expect(seen.rects[0]!.x).toBe(name === 'collapse' ? 248 : 4);
      const counts = await watched(app);
      expect(counts.captures).toBe(1);
      // Out of sight at its final size, then into place: never per frame. It kept the keyboard throughout.
      const { focused: _, ...page } = views[0]!;
      expectGlide(counts.rects[`${site.origin}/`], page, { width, height });
      expect(counts.rects[`${site.origin}/`]!.every((m) => m.focused)).toBe(true);
      expect(views[0]!.focused).toBe(true);
      expect(page.width).toBe(before.width + (name === 'collapse' ? 244 : 0));
    }
  } finally {
    await app.close();
  }
});

test("Duet's panel slides in while the page's frame narrows by its snapshot, and out while it widens", async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    await setMotion(app, shell, true);
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(248);
    const full = (await pages(app)).views[0]!.width;
    const panel = shell.getByRole('complementary', { name: 'Duet' });

    for (const [name, width] of [['duet-open', full - DUET_SPACE], ['duet-close', full]] as const) {
      await watch(app);
      await recordPictures(shell);
      await glide(shell, name, () => runAction(shell, 'duet.toggle'));
      await expect.poll(async () => (await pages(app)).views[0]!.width).toBe(width);
      await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(248);
      if (name === 'duet-open') await expect(panel).toBeVisible();
      else await expect(panel).toBeHidden();
      await expect.poll(() => picturesNow(shell)).toBe(0);
      expect((await picturesSeen(shell)).count).toBe(1);
      const { views, width: w, height } = await pages(app);
      const { focused: _, ...page } = views[0]!;
      expectGlide((await watched(app)).rects[`${site.origin}/`], page, { width: w, height });
    }
  } finally {
    await app.close();
  }
});

test('split view: every pane is pictured and laid out with the same pane rects', async () => {
  const app = await launch();
  try {
    const { shell, overlay } = await ready(app);
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    await overlay.keyboard.type(`${site.origin}/second`);
    await overlay.keyboard.press('Enter');
    await expect(shell.getByRole('tree', { name: 'Today' }).getByRole('treeitem').first()).toContainText('Second page');
    // Second page beside the first.
    await shell.evaluate(async () => {
      const chord = (window as unknown as { chord: { state: { snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string> }>; nodes: Record<string, { id: string; kind: string; title?: string }> } }>; dispatch(c: unknown): Promise<void> } } }).chord;
      const { windowId, state } = await chord.state.snapshot();
      const win = state.windows[windowId]!;
      const first = Object.values(state.nodes).find((n) => n.kind === 'tab' && n.title === 'Colored page')!;
      await chord.state.dispatch({ t: 'split.add', windowId, withId: win.activeTab[win.activeChordId], nodeId: first.id, direction: 'row' });
    });
    await expect.poll(async () => (await pages(app)).views.length).toBe(2);
    await setMotion(app, shell, true);

    const before = (await pages(app)).views;
    await watch(app);
    await recordPictures(shell);
    await glide(shell, 'split-collapse', () => runAction(shell, 'view.toggleSidebar'));
    await expect.poll(() => picturesNow(shell)).toBe(0);

    // Each pane was pictured where it was…
    const seen = await picturesSeen(shell);
    expect(seen.count).toBe(2);
    expect(seen.rects.map((r) => r.x).sort((a, b) => a - b)).toEqual(before.map((v) => v.x));
    const counts = await watched(app);
    expect(counts.captures).toBe(2);
    // …and went where the shared pane math puts it in the wider frame.
    const { views, width, height } = await pages(app);
    const frame = { x: 4, y: 40, width: width - 4 - 4, height: height - 40 - 4 };
    const total = before[0]!.width + before[1]!.width;
    const expected = paneRects(frame, 'row', [before[0]!.width / total, before[1]!.width / total]);
    expect(views.map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }))).toEqual(expected);
    // Each pane moved twice: out of sight at its new size, then into place.
    const order = [`${site.origin}/`, `${site.origin}/second`].sort((a, b) => counts.rects[a]!.at(-1)!.x - counts.rects[b]!.at(-1)!.x);
    order.forEach((u, i) => expectGlide(counts.rects[u], expected[i]!, { width, height }));
  } finally {
    await app.close();
  }
});

test('a key typed into the page brings it back at once', async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    await setMotion(app, shell, true);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/`);
    await tab.locator('#field').focus();
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!.focus(), site.origin);

    await watch(app);
    // The pictures glide slowly here, so the key surely comes while they do.
    await shell.evaluate(() => document.documentElement.style.setProperty('--spring-smooth-duration', '3000ms'));
    await runAction(shell, 'view.toggleSidebar');
    // A key the way a real one arrives (through main's input handling): the page is back in place
    // as main hands it the key, not when the glide would have ended.
    const placed = await app.evaluate(({ webContents, BaseWindow }, origin) => {
      const page = webContents.getAllWebContents().find((c) => c.getURL().startsWith(origin))!;
      const view = BaseWindow.getAllWindows()[0]!.contentView.children.find((v) => 'webContents' in v && v.webContents === page)!;
      const before = view.getBounds().x;
      page.sendInputEvent({ type: 'keyDown', keyCode: 'k' });
      page.sendInputEvent({ type: 'char', keyCode: 'k' });
      page.sendInputEvent({ type: 'keyUp', keyCode: 'k' });
      return { before, after: view.getBounds().x, width: BaseWindow.getAllWindows()[0]!.getContentBounds().width };
    }, site.origin);
    expect(placed).toEqual({ before: placed.width - 1, after: 4, width: placed.width });
    await expect(tab.locator('#field')).toHaveValue('k');
    expect(Object.values((await watched(app)).moves)).toEqual([2]);
  } finally {
    await app.close();
  }
});

test('peeking the sidebar while the page glides brings the page back at once, under the sidebar', async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    await setMotion(app, shell, true);
    const sidebar = shell.getByRole('navigation', { name: 'Sidebar' });
    // The picture glides slowly here, so the peek surely comes while it does.
    await shell.evaluate(() => document.documentElement.style.setProperty('--spring-smooth-duration', '3000ms'));
    await watch(app);
    await shell.mouse.move(300, 300);
    const gliding = shell.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.style.transform !== ''), undefined, { polling: 'raf' });
    await runAction(shell, 'view.toggleSidebar');
    await gliding;

    // The pointer reaches the window's left edge: the sidebar slides in over the page, which is back in place.
    await shell.mouse.move(1, 300, { steps: 6 });
    // Timed from when the pointer is there: moving it takes the test a while on a slow machine.
    const edgeAt = Date.now();
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(4);
    const [away, back] = (await watched(app)).rects[`${site.origin}/`]!;
    expect(back).toMatchObject({ x: 4 });
    // Back with the peek, not when main would have brought it back anyway (the shell never said the picture arrived).
    const fallbackAt = away!.at + springCurve(springs.smooth).durationMs + 300;
    expect(fallbackAt - edgeAt).toBeGreaterThan(250);
    expect(back!.at - edgeAt).toBeLessThan(250);
    await expect.poll(() => picturesNow(shell)).toBe(0);
  } finally {
    await app.close();
  }
});

test('with reduced motion, or "Animate the sidebar" off, nothing is pictured and the frame changes at once', async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    // Reduced motion (this PC's own setting, made sure of).
    await setMotion(app, shell, false);
    await watch(app);
    await recordPictures(shell);
    await runAction(shell, 'view.toggleSidebar');
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(4);
    // Straight to its new place: one move, no picture.
    expect(await watched(app)).toMatchObject({ moves: { [`${site.origin}/`]: 1 }, captures: 0 });
    expect((await picturesSeen(shell)).count).toBe(0);
    await runAction(shell, 'view.toggleSidebar');
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(248);

    // Motion on, but Settings → Motion → "Animate the sidebar" off.
    await setMotion(app, shell, true);
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, (url) => url.startsWith('chord://settings') || url.includes('/settings/index.html'));
    await settings.getByRole('button', { name: 'Motion' }).click();
    const sidebarSwitch = settings.getByRole('switch', { name: 'Animate the sidebar' });
    await sidebarSwitch.click();
    await expect(sidebarSwitch).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['motionOff'])).toContain('sidebar');
    await watch(app);
    await recordPictures(shell);
    await runAction(shell, 'view.toggleSidebar');
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(4);
    expect((await watched(app)).captures).toBe(0);
    expect((await picturesSeen(shell)).count).toBe(0);
    await runAction(shell, 'duet.toggle');
    await expect(shell.getByRole('complementary', { name: 'Duet' })).toBeVisible();
    await expect.poll(async () => (await pages(app)).views[0]!.width).toBe((await pages(app)).width - 4 - 4 - DUET_SPACE);
    expect((await watched(app)).captures).toBe(0);
    expect((await picturesSeen(shell)).count).toBe(0);
  } finally {
    await app.close();
  }
});

test('a picture that fails, or takes too long, and the frame just changes at once', async () => {
  const app = await launch();
  try {
    const { shell } = await ready(app);
    await setMotion(app, shell, true);
    for (const [capture, x] of [['fail', 4], ['hang', 248]] as const) {
      await watch(app, 'first', capture);
      await recordPictures(shell);
      const start = Date.now();
      await runAction(shell, 'view.toggleSidebar');
      await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(x);
      // A hung picture is given up on quickly (PREPARE_TIMEOUT_MS), not waited for.
      expect(Date.now() - start).toBeLessThan(1500);
      const counts = await watched(app);
      expect(counts.captures).toBe(1);
      expect(Object.values(counts.moves)).toEqual([1]);
      expect((await picturesSeen(shell)).count).toBe(0);
    }
  } finally {
    await app.close();
  }
});

test('a page in fullscreen is never pictured; it comes back to the frame as it is now', async () => {
  const app = await launch('/fullscreen', undefined);
  try {
    const { shell } = await ready(app, 'Fullscreen');
    await setMotion(app, shell, true);
    const tab = await pageWhere(app, (url) => url === `${site.origin}/fullscreen`);
    await tab.locator('#go').click();
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(0);
    await watch(app);
    await runAction(shell, 'view.toggleSidebar');
    await expect(shell.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    expect((await watched(app)).captures).toBe(0);
    await expect.poll(() => tab.evaluate(() => (document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : true))).toBe(true);
    // Back in the frame, which is collapsed now.
    await expect.poll(async () => (await pages(app)).views[0]!.x).toBe(4);
  } finally {
    await app.close();
  }
});

test("a private window's pictures stay in memory: nothing new reaches the disk", async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch('/', profile);
  try {
    const { shell, overlay } = await ready(app);
    await runAction(shell, 'window.newPrivate');
    const privateShell = await pageWhere(app, isShell, [shell]);
    const privateOverlay = await pageWhere(app, isOverlay, [overlay]);
    await expect(privateShell.getByText('This window is private.')).toBeVisible();
    await privateShell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.keyboard.type(`${site.origin}/second`);
    await privateOverlay.keyboard.press('Enter');
    await expect.poll(async () => (await pages(app, 'private')).views.length).toBe(1);
    await setMotion(app, privateShell, true);

    const images = () =>
      walk(profile)
        .filter((f) => /\.(png|jpe?g|bmp|webp|raw)$/i.test(f.path) || /Captures/i.test(f.path))
        .map((f) => `${f.path} ${f.size}`)
        .sort();
    const before = images();
    await watch(app, 'private');
    await recordPictures(privateShell);
    await runAction(privateShell, 'view.toggleSidebar');
    await expect.poll(async () => (await pages(app, 'private')).views[0]!.x).toBe(4);
    await expect.poll(() => picturesNow(privateShell)).toBe(0);
    // It was pictured, and glided…
    expect((await picturesSeen(privateShell)).count).toBe(1);
    expect((await watched(app)).captures).toBe(1);
    // …with nothing written anywhere in the profile for it.
    expect(images()).toEqual(before);
  } finally {
    await app.close();
  }
});

/** Every file under `dir`, with its size. */
function walk(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) out.push(...walk(path));
      else out.push({ path, size: stat.size });
    } catch {
      // A file that went away while listing (a journal, say).
    }
  }
  return out;
}
