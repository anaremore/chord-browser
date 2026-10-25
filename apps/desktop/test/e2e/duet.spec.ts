/**
 * Duet, end to end, with a fake Claude Code (fake-claude.mjs) speaking the
 * real stream-json protocol: no network, no real CLI, no sign-in. The fake
 * keeps its "session files" in a temp CLAUDE_CONFIG_DIR, so resume, fallback
 * and deletion of the provider's copy can be checked on disk.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { DUET_WORLD, EXTRACT_SCRIPT } from '../../src/main/duet/extract';
import { buildPdf, SAMPLE_PDF_PAGES } from '../fixtures/pdf';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

/** Requests for the test PDF, and whether each carried the sign-in cookie. */
const pdfRequests: { signedIn: boolean }[] = [];

const appDir = resolve(import.meta.dirname, '../..');
const fake = resolve(import.meta.dirname, 'fake-claude.mjs');
const capturesDir = resolve(appDir, 'test-results', 'captures');

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/article': '<title>Article</title><h1>Chords</h1><p>Chords are three notes played together, and they sound full.</p>',
    '/second': '<title>Second page</title><p>Another page.</p>',
    // Form values must never leave the page, whatever the field.
    '/form':
      '<title>Form</title><h1>Account settings</h1><p>Visible words here.</p>' +
      '<input value="hunter2-secret"><input type="password" value="pw-very-secret"><textarea>my-draft-note</textarea>' +
      '<select><option>card-4242-selected</option></select><input autocomplete="one-time-code" value="otp-123456">',
    // Layouts that hid real text from Duet: a page wrapped in display: contents (Substack's), a section
    // that skips rendering off screen, and a long page's top once you've scrolled down. Then what stays hidden.
    '/layouts':
      '<title>Layouts</title><p>Top of a long page.</p>' +
      '<div style="display: contents"><article><h1>Wrapped</h1><p>Inside a display-contents wrapper.</p></article></div>' +
      '<div style="height: 9000px"></div>' +
      '<section style="content-visibility: auto; contain-intrinsic-size: auto 400px"><p>A section that renders only on screen.</p></section>' +
      '<div style="height: 9000px"></div><p>Bottom of the page.</p>' +
      '<p hidden>hidden-attribute</p><p style="display: none">display-none</p><p style="visibility: hidden">visibility-hidden</p>' +
      '<p style="opacity: 0">opacity-zero</p><div style="position: absolute; left: -9999px">moved-off-screen</div>' +
      '<div style="display: contents" hidden><p>hidden-contents-wrapper</p></div>',
  };
  const server = createServer((req, res) => {
    // A PDF behind a sign-in: /login sets the cookie and goes on to it; without the cookie it's 403.
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'chord_pdf=yes; Path=/; HttpOnly' });
      res.end('<title>Signing in</title><meta http-equiv="refresh" content="0;url=/guide.pdf">');
      return;
    }
    if (req.url?.startsWith('/guide.pdf')) {
      const signedIn = /(^|;\s*)chord_pdf=yes/.test(req.headers.cookie ?? '');
      pdfRequests.push({ signedIn });
      // no-store: Duet's own copy has to come through the network, with the tab's cookies.
      res.writeHead(signedIn ? 200 : 403, { 'content-type': signedIn ? 'application/pdf' : 'text/plain', 'cache-control': 'no-store' });
      res.end(signedIn ? Buffer.from(buildPdf(SAMPLE_PDF_PAGES, { title: 'Field guide' })) : 'sign in first');
      return;
    }
    const body = pages[req.url ?? '/'];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

interface Setup {
  profile: string;
  config: string;
}
const fresh = (): Setup => ({ profile: mkdtempSync(join(tmpdir(), 'chord-e2e-')), config: mkdtempSync(join(tmpdir(), 'chord-claude-')) });

async function launch(setup: Setup, home: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: setup.profile,
    CHORD_HOME_URL: `${site.origin}${home}`,
    CHORD_DUET_CLAUDE: fake,
    // No Codex in these tests (a path that doesn't exist).
    CHORD_DUET_CODEX: join(setup.config, 'no-codex'),
    CLAUDE_CONFIG_DIR: setup.config,
    ...env,
  };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

async function shellOf(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => p.url().startsWith('chord://shell') || p.url().includes('/shell/index.html')), { timeout: 20_000 }).toBe(true);
  return app.windows().find((p) => p.url().startsWith('chord://shell') || p.url().includes('/shell/index.html'))!;
}

const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run(a), action);

async function openDuet(shell: Page): Promise<Locator> {
  await runAction(shell, 'duet.toggle');
  const panel = shell.getByRole('complementary', { name: 'Duet' });
  await expect(panel).toBeVisible();
  return panel;
}

async function setUp(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Use this' }).first().click();
  await panel.getByRole('button', { name: 'Got it' }).click();
}

async function send(panel: Locator, text: string): Promise<void> {
  const input = panel.getByRole('textbox', { name: 'Message Duet' });
  await input.fill(text);
  await input.press('Enter');
}

const fakeLog = (setup: Setup) =>
  readFileSync(join(setup.config, 'fake-log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { resume: string | null; session: string; summary: boolean; restricted: boolean; tools: string });

const sessionFiles = (setup: Setup) => {
  const projects = join(setup.config, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((dir) => readdirSync(join(projects, dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(projects, dir, f)));
};

test('Duet: set up, ask about the page with a citation, gate reads, stop, and resume after a relaunch', async () => {
  const setup = fresh();
  let app = await launch(setup, '/article');
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await expect(panel.getByText('Meet Duet.')).toBeVisible();
    await setUp(panel);

    // The current tab is attached; reading it needs no card; the reply cites it.
    await expect(panel.getByText(/This tab · 127\.0\.0\.1/)).toBeVisible();
    await send(panel, 'Summarize this page');
    await expect(panel.getByText('Here is the gist.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Source 1: “/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Read “Article”/ })).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Duet read this tab' })).toBeVisible();
    // Browse mode: no built-in tools, the user's settings ignored.
    expect(fakeLog(setup)[0]).toMatchObject({ restricted: true, tools: '', resume: null });

    // Ask first: listing tabs asks; "Allow for this chat" stops it asking again.
    await send(panel, 'list my tabs');
    await panel.getByRole('group', { name: 'Duet is asking' }).getByRole('button', { name: 'Allow for this chat' }).click();
    await expect(panel.getByText(/I can see \d+ tabs\./)).toBeVisible();
    await send(panel, 'list them again');
    await expect(panel.getByText(/I can see \d+ tabs\./)).toHaveCount(2);
    await expect(panel.getByText('See the list of your tabs')).toHaveCount(1);

    // Stop ends a long reply where it is.
    await send(panel, 'write something long');
    await expect(panel.getByText(/word5 /)).toBeVisible();
    await panel.getByRole('button', { name: 'Stop' }).click();
    await expect(panel.getByText('Interrupted.')).toBeVisible();
  } finally {
    await app.close();
  }

  const first = fakeLog(setup)[0]!.session;
  app = await launch(setup, '/article');
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    // The chat was used just now, so it's still there.
    await expect(panel.getByText('Here is the gist.')).toBeVisible();
    await send(panel, 'hello again');
    await expect(panel.getByText('Hello from the fake.')).toBeVisible();
    expect(fakeLog(setup).at(-1)).toMatchObject({ resume: first });

    // @duet finds the chat by its words.
    const overlay = app.windows().find((p) => p.url().startsWith('chord://overlay') || p.url().includes('/overlay/index.html'))!;
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    // The space sets the filter itself; Enter on a half-typed one raced the results on a slow machine.
    await overlay.keyboard.type('@duet ');
    await expect(overlay.getByTestId('scope-chip')).toHaveText('Duet chats');
    await overlay.keyboard.type('gist');
    await expect(overlay.getByRole('option').first()).toContainText('Summarize this page');
  } finally {
    await app.close();
  }
});

test('Duet: a lost session continues from a summary; after the idle window a fresh chat offers Continue; delete removes the provider copy too', async () => {
  const setup = fresh();
  let app = await launch(setup, '/article');
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await setUp(panel);
    await send(panel, 'Summarize this page');
    await expect(panel.getByText('Here is the gist.')).toBeVisible();
  } finally {
    await app.close();
  }

  // The provider's copy goes away (an upgrade, a cleanup): Duet starts again from a summary.
  for (const file of sessionFiles(setup)) rmSync(file);
  app = await launch(setup, '/article');
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await send(panel, 'hello');
    await expect(panel.getByText('Continued with a summary')).toBeVisible();
    await expect(panel.getByText('Hello from the fake.')).toBeVisible();
    expect(fakeLog(setup).at(-1)).toMatchObject({ resume: null, summary: true });
  } finally {
    await app.close();
  }

  // Past the idle window, the panel starts fresh and offers to continue.
  app = await launch(setup, '/article', { CHORD_DUET_IDLE_MS: '1' });
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await expect(panel.getByText('Ask about this page, your tabs, or anything you’re working on.')).toBeVisible();
    await panel.getByRole('button', { name: 'Continue “Summarize this page”' }).click();
    await expect(panel.getByText('Here is the gist.')).toBeVisible();

    // Deleting the chat deletes the provider's copy too.
    expect(sessionFiles(setup).length).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Chats' }).click();
    await panel.getByRole('menuitem', { name: 'Delete this chat' }).click();
    await expect(panel.getByText('Here is the gist.')).toHaveCount(0);
    await expect.poll(() => sessionFiles(setup).length).toBe(0);
  } finally {
    await app.close();
  }
});

test('Duet reads text in display: contents wrappers, off-screen sections and a scrolled page’s top, and still not hidden text', async () => {
  const app = await launch(fresh(), '/layouts');
  try {
    await shellOf(app);
    const url = `${site.origin}/layouts`;
    await expect.poll(() => app.windows().some((p) => p.url() === url), { timeout: 20_000 }).toBe(true);
    const page = app.windows().find((p) => p.url() === url)!;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(15_000);
    const read = (await app.evaluate(
      ({ webContents }, { url, world, code }) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.executeJavaScriptInIsolatedWorld(world, [{ code }]),
      { url, world: DUET_WORLD, code: EXTRACT_SCRIPT },
    )) as { text: string };
    for (const shown of ['Top of a long page.', '# Wrapped', 'Inside a display-contents wrapper.', 'A section that renders only on screen.', 'Bottom of the page.']) expect(read.text).toContain(shown);
    for (const hidden of ['hidden-attribute', 'display-none', 'visibility-hidden', 'opacity-zero', 'moved-off-screen', 'hidden-contents-wrapper']) expect(read.text).not.toContain(hidden);
  } finally {
    await app.close();
  }
});

test('Duet: form values never leave the page, and a Never site is refused even under All my tabs', async () => {
  const setup = fresh();
  const app = await launch(setup, '/form');
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await setUp(panel);
    await send(panel, 'what does the secret page say');
    const reply = panel.getByText(/The page says:/);
    await expect(reply).toContainText('Account settings');
    for (const secret of ['hunter2-secret', 'pw-very-secret', 'my-draft-note', 'card-4242-selected', 'otp-123456']) await expect(reply).not.toContainText(secret);

    // Mark the site "Never", then let Duet read all tabs: it still can't have it.
    await runAction(shell, 'app.settings');
    await expect.poll(() => app.windows().some((p) => p.url().includes('settings'))).toBe(true);
    const settings = app.windows().find((p) => p.url().includes('settings'))!;
    await settings.getByRole('button', { name: 'Duet' }).click();
    const add = settings.getByRole('textbox', { name: 'Add a site Duet never reads' });
    await add.fill('127.0.0.1');
    await add.press('Enter');
    await panel.getByRole('radiogroup', { name: 'What Duet can read' }).getByRole('radio', { name: 'All tabs' }).click();
    await expect(panel.getByText(/This tab · 127\.0\.0\.1/)).toHaveCount(0);
    await send(panel, 'list my tabs');
    await expect(panel.getByText('I can see 0 tabs.')).toBeVisible();

    // Off in this chord: no composer until it's turned back on, from the panel itself.
    await panel.getByRole('button', { name: 'Chats' }).click();
    await panel.getByRole('menuitem', { name: 'Turn off in this chord' }).click();
    await expect(panel.getByText(/Duet is off in this chord/)).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Message Duet' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Turn on in this chord' }).click();
    await expect(panel.getByRole('textbox', { name: 'Message Duet' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Duet: a Claude Code too old for browse mode isn’t asked whether it’s signed in, and Setup says to update it', async () => {
  const setup = fresh();
  const app = await launch(setup, '/article', { FAKE_CLAUDE_VERSION: '1.0.34' });
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await expect(panel.getByText('Installed 1.0.34 · Needs an update')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'How to update' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    // `claude auth status` would be a prompt to 1.x: it was never run.
    expect(existsSync(join(setup.config, 'auth-asked'))).toBe(false);
  } finally {
    await app.close();
  }
});

/** Every page URL main has open (tabs, and the PDF viewer inside them). */
const openUrls = (app: ElectronApplication) => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));

test('Duet: reads a PDF through the tab’s own session, cites its page, and shows how full the context is', async () => {
  pdfRequests.length = 0;
  const setup = fresh();
  const app = await launch(setup, '/login');
  try {
    const shell = await shellOf(app);
    // The tab signs in, then shows the PDF in Chromium's viewer.
    await expect.poll(() => pdfRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await openUrls(app)).some((u) => u.endsWith('/guide.pdf'))).toBe(true);
    const panel = await openDuet(shell);
    await setUp(panel);
    // No meter before the CLI has reported anything.
    await expect(panel.getByRole('meter', { name: 'Context used' })).toHaveCount(0);
    await send(panel, 'What does this PDF say about triads?');
    await expect(panel.getByText(/The PDF has 3 pages\. Triads sound bright\./)).toBeVisible();
    // The page comes from the text Duet read, not from the model.
    const pill = panel.getByRole('button', { name: /^Source 1, page 2: “A major triad sounds bright”/ });
    await expect(pill).toHaveText('1 · p. 2');
    await expect(panel.getByRole('button', { name: /^Read “/ })).toBeVisible();
    // Duet's copy came over the network (no-store) with the tab's cookie: every request was signed in.
    expect(pdfRequests.length).toBeGreaterThanOrEqual(2);
    expect(pdfRequests.every((r) => r.signedIn)).toBe(true);

    // The CLI reported 124,000 of 200,000 tokens.
    const meter = panel.getByRole('meter', { name: 'Context used' });
    await expect(meter).toHaveAttribute('aria-valuenow', '62');
    await expect(meter).toHaveAttribute('aria-valuetext', /^62% of context used\. When it fills up, Claude Code compacts the conversation automatically/);

    // The citation finds the quote in the PDF viewer (which goes to its page and marks it).
    await app.evaluate(({ webContents }) => {
      const pdf = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/guide.pdf'))!;
      pdf.on('found-in-page', (_e, result) => ((globalThis as { found?: number }).found = result.matches));
    });
    await pill.click();
    await expect.poll(() => app.evaluate(() => (globalThis as { found?: number }).found ?? 0)).toBe(1);
  } finally {
    await app.close();
  }
});

/**
 * Claude Code installed only inside WSL, for real: the fake CLI runs inside the default distro
 * through wsl.exe. Opt-in (CHORD_E2E_WSL=1), as it needs Windows with WSL and node in the distro.
 * CLAUDE_CONFIG_DIR reaches the distro through WSLENV, the way a user's own setting would.
 */
test('Duet: Claude Code inside WSL is offered in Setup, answers through wsl.exe, and deleting the chat deletes its session there', async () => {
  test.skip(!(process.platform === 'win32' && process.env['CHORD_E2E_WSL'] === '1'), 'Needs WSL with node in the default distro: set CHORD_E2E_WSL=1');
  test.setTimeout(120_000);
  const wsl = (args: string[]) => new Promise<string>((done) => execFile('wsl.exe', args, { windowsHide: true }, (_e, out) => done(String(out))));
  const linuxFake = fake.replace(/^([A-Za-z]):/, (_m, drive: string) => `/mnt/${drive.toLowerCase()}`).replace(/\\/g, '/');
  const config = `/tmp/chord-e2e-wsl-${Date.now()}`;
  const sessions = () => wsl(['-e', 'sh', '-c', `ls ${config}/projects/*/*.jsonl 2>/dev/null`]).then((out) => out.trim().split('\n').filter(Boolean));
  const app = await launch(fresh(), '/article', {
    CHORD_DUET_CLAUDE: '',
    CHORD_DUET_CLAUDE_WSL: `node ${linuxFake}`,
    CLAUDE_CONFIG_DIR: config,
    WSLENV: [process.env['WSLENV'], 'CLAUDE_CONFIG_DIR/u'].filter(Boolean).join(':'),
  });
  try {
    const shell = await shellOf(app);
    const panel = await openDuet(shell);
    await expect(panel.getByText(/^Claude Code in WSL \(.+\)$/)).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText('Installed 2.1.309 · Signed in')).toBeVisible();
    await shell.screenshot({ path: resolve(capturesDir, `duet-${process.platform}-${process.arch}-wsl-setup.png`) });
    await setUp(panel);
    await send(panel, 'Summarize this page');
    await expect(panel.getByText('Here is the gist.')).toBeVisible({ timeout: 30_000 });
    expect(await sessions()).toHaveLength(1);
    await panel.getByRole('button', { name: 'Chats' }).click();
    await panel.getByRole('menuitem', { name: 'Delete this chat' }).click();
    await expect.poll(sessions, { timeout: 30_000 }).toHaveLength(0);
  } finally {
    await app.close();
    await wsl(['-e', 'rm', '-rf', '--', config]);
  }
});

/**
 * The window as the user sees it. The shell and each tab are separate views,
 * so the shell's own screenshot has a hole where the tab sits: the tab's own
 * screenshot is drawn there (clipped to the frame's corners), in the shell, by
 * a canvas. Only Chord's own pages are captured. `crop` (CSS pixels) cuts a
 * part out, drawn `zoom` times larger.
 */
async function windowPicture(app: ElectronApplication, shell: Page, tab: Page, options: { crop?: { x: number; y: number; width: number; height: number }; zoom?: number } = {}): Promise<Buffer> {
  const bounds = await app.evaluate(({ BaseWindow }, url) => {
    const find = (views: Electron.View[], x: number, y: number): Electron.Rectangle | null => {
      for (const view of views) {
        const b = view.getBounds();
        const contents = (view as Partial<Electron.WebContentsView>).webContents;
        if (contents && !contents.isDestroyed() && contents.getURL() === url) return { ...b, x: x + b.x, y: y + b.y };
        const inner = find(view.children, x + b.x, y + b.y);
        if (inner) return inner;
      }
      return null;
    };
    for (const win of BaseWindow.getAllWindows()) {
      const found = find(win.contentView.children, 0, 0);
      if (found) return found;
    }
    return null;
  }, tab.url());
  expect(bounds).not.toBeNull();
  await shell.evaluate(() => document.fonts.ready);
  const [base, page] = await Promise.all([shell.screenshot({ scale: 'css' }), tab.screenshot({ scale: 'css' })]);
  const png = await shell.evaluate(
    async ({ base, page, at, crop, zoom }) => {
      const bitmap = (b64: string) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const [shellImage, tabImage] = await Promise.all([bitmap(base), bitmap(page)]);
      const whole = new OffscreenCanvas(shellImage.width, shellImage.height);
      const ctx = whole.getContext('2d')!;
      ctx.drawImage(shellImage, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(at.x, at.y, at.width, at.height, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-frame')) || 0);
      ctx.clip();
      ctx.drawImage(tabImage, at.x, at.y, at.width, at.height);
      ctx.restore();
      const area = crop ?? { x: 0, y: 0, width: whole.width, height: whole.height };
      const out = new OffscreenCanvas(Math.round(area.width * zoom), Math.round(area.height * zoom));
      const octx = out.getContext('2d')!;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(whole, area.x, area.y, area.width, area.height, 0, 0, out.width, out.height);
      const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    },
    { base: base.toString('base64'), page: page.toString('base64'), at: bounds!, crop: options.crop ?? null, zoom: options.zoom ?? 1 },
  );
  return Buffer.from(png, 'base64');
}

for (const appearance of ['light', 'dark'] as const) {
  test(`Duet: captures a PDF citation and the context meter in ${appearance}`, async () => {
    const app = await launch(fresh(), '/login', { CHORD_APPEARANCE: appearance });
    try {
      const shell = await shellOf(app);
      await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe(appearance);
      await expect.poll(async () => (await openUrls(app)).some((u) => u.endsWith('/guide.pdf')), { timeout: 20_000 }).toBe(true);
      // As a user would: the PDF is open (Chromium's viewer done loading, its zoom set) before Duet opens beside it.
      await expect
        .poll(
          () =>
            app.evaluate(({ webContents }) => {
              const tab = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/guide.pdf'));
              return Boolean(tab && !tab.isLoading() && tab.mainFrame.framesInSubtree.some((f) => f.url.startsWith('chrome-extension://')));
            }),
          { timeout: 20_000 },
        )
        .toBe(true);
      await new Promise((r) => setTimeout(r, 1000));
      const panel = await openDuet(shell);
      await setUp(panel);
      await send(panel, 'What does this PDF say about triads?');
      const pill = panel.getByRole('button', { name: /^Source 1, page 2:/ });
      await expect(pill).toBeVisible();
      const meter = panel.getByRole('meter', { name: 'Context used' });
      await expect(meter).toHaveAttribute('aria-valuenow', '62');
      // Following the citation: the viewer finds the quote on page 2 and marks it.
      await app.evaluate(({ webContents }) => {
        const pdf = webContents.getAllWebContents().find((w) => w.getURL().endsWith('/guide.pdf'))!;
        pdf.on('found-in-page', (_e, result) => ((globalThis as { found?: number }).found = result.matches));
      });
      await pill.click();
      await expect.poll(() => app.evaluate(() => (globalThis as { found?: number }).found ?? 0)).toBe(1);
      // At rest: the pointer off the pill and the meter, the viewer done scrolling to the match.
      await shell.mouse.move(120, 400);
      await new Promise((r) => setTimeout(r, 600));
      const viewer = app.windows().find((p) => p.url().endsWith('/guide.pdf'))!;
      mkdirSync(capturesDir, { recursive: true });
      const name = (step: string) => resolve(capturesDir, `duet-${process.platform}-${process.arch}-${appearance}-${step}.png`);
      writeFileSync(name('4-pdf-citation-and-context'), await windowPicture(app, shell, viewer));
      // Close up: the header's meter and the reply's "1 · p. 2", twice as large.
      const box = (await panel.boundingBox())!;
      const reply = (await panel.getByText(/Triads sound bright\./).boundingBox())!;
      const crop = { x: box.x, y: box.y, width: box.width, height: reply.y + reply.height + 16 - box.y };
      writeFileSync(name('5-context-meter-and-citation-closeup'), await windowPicture(app, shell, viewer, { crop, zoom: 2 }));
    } finally {
      await app.close();
    }
  });
}

for (const appearance of ['light', 'dark'] as const) {
  test(`Duet: captures the panel in ${appearance} for design QA`, async () => {
    const app = await launch(fresh(), '/article', { CHORD_APPEARANCE: appearance });
    try {
      const shell = await shellOf(app);
      await expect.poll(() => shell.evaluate(() => document.documentElement.dataset['appearance'])).toBe(appearance);
      const panel = await openDuet(shell);
      const capture = async (step: string) => {
        await shell.evaluate(() => document.fonts.ready);
        // The panel slides in (DESIGN.md §6.5): captured once it has landed.
        let last = '';
        await expect.poll(async () => (last === (last = JSON.stringify(await panel.boundingBox())) ? 'still' : 'moving'), { intervals: [100] }).toBe('still');
        await shell.screenshot({ path: resolve(capturesDir, `duet-${process.platform}-${process.arch}-${appearance}-${step}.png`) });
      };
      await expect(panel.getByText('Meet Duet.')).toBeVisible();
      await capture('1-setup');
      await panel.getByRole('button', { name: 'Use this' }).first().click();
      await expect(panel.getByRole('button', { name: 'Got it' })).toBeVisible();
      await capture('2-first-use');
      await panel.getByRole('button', { name: 'Got it' }).click();
      await send(panel, 'Summarize this page');
      await expect(panel.getByText('Here is the gist.')).toBeVisible();
      await send(panel, 'list my tabs');
      await expect(panel.getByRole('group', { name: 'Duet is asking' })).toBeVisible();
      await capture('3-conversation');
    } finally {
      await app.close();
    }
  });
}
