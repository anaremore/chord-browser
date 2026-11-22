/**
 * The README's and the website's screenshots: not a test, though Playwright runs it
 * (playwright.shots.config.ts, so the E2E suite never does). Made in the Linux E2E container by
 * scripts/dev/shots.mjs, on Xvfb, so no window opens on your desktop.
 *
 * Each launch has a throwaway profile (in the run's temp folder, removed when it ends) and real
 * public pages (the passwords picture's sign-in page is a stand-in, served from this machine). Chord runs at 2× (--force-device-scale-factor), its window 1440 × 900 CSS pixels
 * at the screen's top left, so a picture is 2880 × 1800. A picture is the whole window as the
 * screen shows it: the shell, the pages over it and the caption buttons, from desktopCapturer's
 * copy of the screen cropped to the window, taken once two copies in a row agree (loads, fonts
 * and animations done). The assistant's answer comes from demo-claude.mjs.
 *
 * Writes test-results/shots/<name>.png. The screen must hold the window at 2×: shots.mjs sets
 * CHORD_E2E_SCREEN for that.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appDir, dispatch, isOverlay, isPopover, isSettings, isShell, launch, pageWhere, runAction, type ChordGlobal } from '../e2e/a11y-kit';
import { failOnMainErrors } from '../e2e/main-errors';

failOnMainErrors();

const outDir = resolve(appDir, 'test-results', 'shots');
const demoClaude = resolve(import.meta.dirname, 'demo-claude.mjs');
/** The window, in CSS pixels. */
const SIZE = { width: 1440, height: 900 };
const SCALE = 2;

const swatch = { lilac: { l: 0.72, c: 0.12, h: 300 }, periwinkle: { l: 0.72, c: 0.12, h: 270 }, orchid: { l: 0.72, c: 0.13, h: 330 }, mint: { l: 0.72, c: 0.1, h: 165 }, sky: { l: 0.72, c: 0.11, h: 235 }, honey: { l: 0.72, c: 0.13, h: 85 }, tangerine: { l: 0.72, c: 0.15, h: 55 } };
const PAGES = {
  github: 'https://github.com/anaremore/chord-browser',
  mdn: 'https://developer.mozilla.org/en-US/',
  hn: 'https://news.ycombinator.com/',
  fifths: 'https://en.wikipedia.org/wiki/Circle_of_fifths',
  arpeggio: 'https://en.wikipedia.org/wiki/Arpeggio',
  electron: 'https://www.electronjs.org/docs/latest',
  webdev: 'https://web.dev/',
  chord: 'https://en.wikipedia.org/wiki/Chord_(music)',
  html: 'https://developer.mozilla.org/en-US/docs/Web/HTML',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeAll(() => {
  // Xvfb's screen, copied by desktopCapturer, and xdotool for the pointer: this needs X11.
  if (process.platform !== 'linux' || !process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']) {
    throw new Error('The screenshots are made in the Linux container, on X11: node scripts/dev/shots.mjs');
  }
  mkdirSync(outDir, { recursive: true });
});

/** Every page finished loading, or 30 s gone by: a page that never stops still draws. */
async function pagesLoaded(app: ElectronApplication): Promise<void> {
  for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
    if (!(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((c) => !c.isDestroyed() && c.isLoading())))) return;
  }
}

/** Every tab's site icon in, or 20 s gone by: a tab without one shows its monogram. */
async function iconsLoaded(shell: Page): Promise<void> {
  const missing = () =>
    shell.evaluate(async () => {
      const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
      return Object.values(state.nodes).flatMap((b) => Object.values(b))
        .filter((n) => n.kind === 'tab' && !n.favicon)
        .map((n) => n.url);
    });
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(250)) if (!(await missing()).length) return;
  console.log(`[shots] No site icon for ${(await missing()).join(', ')}`);
}

/**
 * The window titled `title` as the screen shows it, in device pixels, once two copies of the
 * screen 300 ms apart agree (at most 8 s: a caret blinks), to test-results/shots/<name>.png.
 */
async function capture(app: ElectronApplication, title: string, name: string): Promise<void> {
  const png = await app.evaluate(
    async ({ BaseWindow, desktopCapturer, screen }, t) => {
      const win = BaseWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === t);
      if (!win) throw new Error(`No window titled ${t}`);
      const bounds = win.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      const scale = display.scaleFactor;
      const full = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
      const crop = { x: Math.round((bounds.x - display.bounds.x) * scale), y: Math.round((bounds.y - display.bounds.y) * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) };
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > full.width || crop.y + crop.height > full.height) {
        throw new Error(`${t} (${JSON.stringify(crop)}) isn't all on the screen (${full.width} × ${full.height})`);
      }
      const look = async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
        const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        if (!source) throw new Error('desktopCapturer found no screen');
        const size = source.thumbnail.getSize();
        // Full size, pixel for pixel: a smaller copy would be a scaled one.
        if (size.width !== full.width || size.height !== full.height) throw new Error(`The screen came back at ${size.width} × ${size.height}, not ${full.width} × ${full.height}`);
        return source.thumbnail.crop(crop);
      };
      let last = await look();
      for (const end = Date.now() + 8000; Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 300));
        const next = await look();
        const same = next.toBitmap().equals(last.toBitmap());
        last = next;
        if (same) break;
      }
      return last.toPNG().toString('base64');
    },
    title,
  );
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'));
}

/** A tab by its address. */
async function tabFor(shell: Page, url: string) {
  return shell.evaluate(async (u) => {
    const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    const tab = Object.values(state.nodes).flatMap((b) => Object.values(b)).find((n) => n.kind === 'tab' && n.url === u);
    if (!tab) throw new Error(`No tab at ${u}`);
    return tab;
  }, url);
}

/** Playwright's mouse, which the page it's given thinks is the pointer, rested where nothing hovers. */
const rest = (page: Page) => page.mouse.move(SIZE.width - 10, SIZE.height - 10);

async function session(appearance: 'light' | 'dark', env: Record<string, string> = {}, args: string[] = []) {
  // The assistant's stand-in keeps its session files here; no Codex (a path that doesn't exist).
  const config = mkdtempSync(join(tmpdir(), 'chord-shots-claude-'));
  const app = await launch(
    { CHORD_APPEARANCE: appearance, CHORD_HOME_URL: PAGES.chord, CHORD_ASSISTANT_CLAUDE: demoClaude, CHORD_ASSISTANT_CODEX: join(config, 'no-codex'), CLAUDE_CONFIG_DIR: config, ...env },
    { args: [`--force-device-scale-factor=${SCALE}`, ...args] },
  );
  const shell = await pageWhere(app, isShell);
  await shell.evaluate(() => document.fonts.ready);

  // The window at the screen's top left, which must hold it at 2×.
  const screenSize = await app.evaluate(({ BaseWindow, screen }, size) => {
    BaseWindow.getAllWindows()
      .find((w) => w.getTitle() === 'Chord')
      ?.setBounds({ x: 0, y: 0, ...size });
    const { size: s, scaleFactor } = screen.getPrimaryDisplay();
    return { width: Math.round(s.width * scaleFactor), height: Math.round(s.height * scaleFactor), scaleFactor };
  }, SIZE);
  if (screenSize.scaleFactor !== SCALE || screenSize.width < SIZE.width * SCALE || screenSize.height < SIZE.height * SCALE) {
    throw new Error(`The screen is ${screenSize.width} × ${screenSize.height} at ${screenSize.scaleFactor}×: it needs to hold ${SIZE.width} × ${SIZE.height} at ${SCALE}× (scripts/dev/shots.mjs sets CHORD_E2E_SCREEN)`);
  }
  // The system's pointer, off the window: Xvfb starts it in the middle of the screen, over the page.
  execFileSync('xdotool', ['mousemove', String(screenSize.width - 1), String(screenSize.height - 1)]);

  // Three chords, each with its own colors; back to the first to fill it.
  // Personal in Aurora, three colors; Work in Sea Glass; Music in Citrus.
  const { windowId, state } = await shell.evaluate(() => (window as unknown as ChordGlobal).chord.state.snapshot());
  const personal = state.windows[windowId]!.activeChordId;
  await dispatch(shell, { t: 'chord.theme', chordId: personal, theme: { stops: [swatch.mint, swatch.periwinkle, swatch.orchid] } });
  await dispatch(shell, { t: 'chord.create', windowId, name: 'Work', icon: '◆', theme: { stops: [swatch.mint, swatch.sky], grain: 0.2, appearance: 'auto' } });
  await dispatch(shell, { t: 'chord.create', windowId, name: 'Music', icon: '♪', theme: { stops: [swatch.honey, swatch.tangerine], grain: 0.2, appearance: 'auto' } });
  await dispatch(shell, { t: 'chord.activate', windowId, chordId: personal });

  // Pinned tabs, a folder of two, and Today tabs; the Chord article on screen.
  for (const url of [PAGES.github, PAGES.mdn, PAGES.hn]) await dispatch(shell, { t: 'tab.open', windowId, url, background: true, pinned: true });
  for (const url of [PAGES.fifths, PAGES.arpeggio, PAGES.electron, PAGES.webdev]) await dispatch(shell, { t: 'tab.open', windowId, url, background: true });
  await pagesLoaded(app);
  const fifths = await tabFor(shell, PAGES.fifths);
  await dispatch(shell, { t: 'tab.activate', windowId, nodeId: fifths.id });
  await runAction(shell, 'folder.new');
  await sleep(500);
  // A new folder opens with its name selected for typing, as it does for you.
  await shell.keyboard.press('Control+A');
  await shell.keyboard.type('Theory');
  await shell.keyboard.press('Enter');
  await sleep(300);
  const folder = await shell.evaluate(async () => {
    const { state: s } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    return Object.values(s.nodes).flatMap((b) => Object.values(b)).find((n) => n.kind === 'folder');
  });
  if (!folder) throw new Error('folder.new made no folder');
  const arpeggio = await tabFor(shell, PAGES.arpeggio);
  await dispatch(shell, { t: 'node.move', nodeId: arpeggio.id, section: 'pinned', index: 1, parentId: folder.id });
  const article = await tabFor(shell, PAGES.chord);
  await dispatch(shell, { t: 'tab.activate', windowId, nodeId: article.id });
  // The keyboard goes to the page, as after a click there: no focus ring left in the sidebar.
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.focus(), PAGES.chord);
  await rest(shell);
  await pagesLoaded(app);
  await quietBanners(app);
  await iconsLoaded(shell);
  return { app, shell, windowId, article };
}

/** Wikipedia's fundraising banners (CentralNotice) come and go by date and would cover the article: hidden for the pictures. */
async function quietBanners(app: ElectronApplication) {
  await app.evaluate(async ({ webContents }) => {
    for (const c of webContents.getAllWebContents()) {
      if (/^https:\/\/[a-z]+\.wikipedia\.org\//.test(c.getURL())) await c.insertCSS('#centralNotice, .frb, .cn-fundraising { display: none !important; }');
    }
  });
}

test('light: the window, the assistant beside the article, and split view', async () => {
  const { app, shell, windowId, article } = await session('light');
  try {
    await capture(app, 'Chord', 'chord-light');

    await runAction(shell, 'assistant.toggle');
    const panel = shell.getByRole('complementary', { name: 'Assistant' });
    await panel.getByRole('button', { name: 'Use this' }).first().click();
    await panel.getByRole('button', { name: 'Got it' }).click();
    const input = panel.getByRole('textbox', { name: 'Message' });
    await input.fill('What’s a chord, in one line?');
    await input.press('Enter');
    await panel.getByText('In the article').waitFor({ timeout: 20_000 });
    await rest(shell);
    await capture(app, 'Chord', 'assistant');
    await runAction(shell, 'assistant.toggle');
    await panel.waitFor({ state: 'hidden' });

    await dispatch(shell, { t: 'split.add', windowId, withId: article.id, url: PAGES.html });
    await rest(shell);
    await pagesLoaded(app);
    await iconsLoaded(shell);
    await capture(app, 'Chord', 'split-view');
  } finally {
    await app.close();
  }
});

test('dark: the window, the command bar, and Settings → Appearance', async () => {
  const { app, shell } = await session('dark');
  try {
    await capture(app, 'Chord', 'chord-dark');

    await runAction(shell, 'tab.new');
    const overlay = await pageWhere(app, isOverlay);
    await expect(overlay.getByRole('combobox')).toBeFocused();
    await overlay.keyboard.type('wiki', { delay: 60 });
    const results = overlay.getByRole('listbox', { name: 'Results' }).getByRole('option');
    // The search, Wikipedia's search, three open tabs, then the search engine's suggestions.
    await results.nth(5).waitFor({ timeout: 15_000 });
    await capture(app, 'Chord', 'command-bar');
    await overlay.keyboard.press('Escape');

    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
    await rest(settings);
    await capture(app, 'Chord Settings', 'themes');
  } finally {
    await app.close();
  }
});

/**
 * The passwords picture's sign-in page: no real site. A server on this machine answers for
 * https://accounts.example.com (--host-resolver-rules, a throwaway self-signed certificate and
 * --ignore-certificate-errors), so the address and the menu read as a site's would.
 */
const SIGN_IN_HOST = 'accounts.example.com';
const SIGN_IN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3d6be0"/><path d="M9 23 16 8l7 15" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SIGN_IN_STYLE =
  '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f9;font:16px/1.4 system-ui,sans-serif;color:#1d2433}' +
  'main{width:380px;background:#fff;border-radius:14px;padding:36px 32px;box-shadow:0 1px 2px #0000000f,0 8px 28px #00000014}' +
  '.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:18px;margin-bottom:22px}.brand img{width:28px;height:28px}' +
  'h1{font-size:24px;margin:0 0 6px}p{margin:0 0 22px;color:#5b6475}label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}' +
  'input{width:100%;padding:11px 12px;border:1px solid #c9cfda;border-radius:8px;font:inherit}input:focus{outline:2px solid #3d6be0;outline-offset:-1px;border-color:transparent}' +
  'button{margin-top:22px;width:100%;padding:12px;border:0;border-radius:8px;background:#3d6be0;color:#fff;font:inherit;font-weight:600}</style>';
const SIGN_IN_PAGE =
  '<!doctype html><title>Sign in · Acme</title><link rel="icon" href="/favicon.svg">' + SIGN_IN_STYLE +
  '<main><div class="brand"><img src="/favicon.svg" alt="">Acme</div><h1>Sign in</h1><p>Welcome back.</p>' +
  '<form action="/session" method="post"><label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">' +
  '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password"><button>Sign in</button></form></main>';
const SIGNED_IN_PAGE = '<!doctype html><title>Acme</title><link rel="icon" href="/favicon.svg">' + SIGN_IN_STYLE + '<main><h1>You’re signed in</h1><p>Welcome back.</p></main>';

test('light: passwords, the menu under a sign-in field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chord-shots-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${SIGN_IN_HOST}`, '-addext', `subjectAltName=DNS:${SIGN_IN_HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    const path = new URL(req.url ?? '/', `https://${SIGN_IN_HOST}`).pathname;
    if (path === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(SIGN_IN_ICON);
      return;
    }
    const body = req.method === 'POST' ? SIGNED_IN_PAGE : path === '/login' ? SIGN_IN_PAGE : null;
    req.resume();
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  // No keyring in the container: the vault starts with no passphrase, as on a computer without one.
  const { app, shell } = await session('light', { CHORD_E2E_NO_KEYRING: '1' }, [`--host-resolver-rules=MAP ${SIGN_IN_HOST} 127.0.0.1:${port}`, '--ignore-certificate-errors']);
  try {
    const login = `https://${SIGN_IN_HOST}/login`;
    // In the article's tab: Playwright drives the pages Chord opened at launch, not a tab opened since.
    const page = await pageWhere(app, (u) => u === PAGES.chord);
    await page.goto(login);
    const popover = await pageWhere(app, (u) => isPopover(u) && !u.includes('#'));

    // A sign-in, and the card that keeps it, choosing the passphrase.
    await page.fill('#u', 'ada@example.com');
    await page.fill('#p', 'Zq9-shots-Sekrit');
    await page.press('#p', 'Enter');
    await page.waitForURL(`https://${SIGN_IN_HOST}/session`);
    const save = popover.getByRole('dialog', { name: `Save this password for ${SIGN_IN_HOST}?` });
    await save.waitFor({ timeout: 15_000 });
    await save.getByLabel('Passphrase', { exact: true }).fill('correct horse battery staple');
    await save.getByLabel('Again').fill('correct horse battery staple');
    await save.getByRole('button', { name: 'Save' }).click();
    await save.waitFor({ state: 'detached' });
    await shell.getByText('Saved. It’s in Settings → Passwords.').waitFor({ state: 'hidden', timeout: 15_000 });

    // Back at the form: the email field's focus opens the menu under it.
    await page.goto(login);
    await page.focus('#u');
    const menu = (await pageWhere(app, (u) => isPopover(u) && u.endsWith('#menu'))).getByRole('listbox', { name: `Passwords for ${SIGN_IN_HOST}` });
    await menu.waitFor({ timeout: 10_000 });
    await rest(shell);
    await iconsLoaded(shell);
    await capture(app, 'Chord', 'passwords');
  } finally {
    await app.close();
    server.close();
  }
});

/**
 * The agents picture's page that's being worked on: example.com as a stand-in, served from this machine as the
 * passwords picture's sign-in page is. Its text draws at once and an image on it never finishes, so the agent's
 * open_tab is still at work, and its bar up, when the picture is taken.
 */
const AGENT_HOST = 'example.com';
const AGENT_PAGE =
  '<!doctype html><title>Example Domain</title><link rel="icon" href="data:,">' +
  '<style>body{margin:0;background:#f0f0f2;font:16px/1.5 -apple-system,system-ui,sans-serif}div{width:600px;margin:5em auto;padding:2em;background:#fdfdff;border-radius:.5em;box-shadow:2px 3px 7px 2px #00000005}h1{margin-top:0}a{color:#38488f}</style>' +
  '<div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href="https://www.iana.org/domains/example">More information...</a></p><img src="/slow.png" alt="" width="1" height="1"></div>';

/** `chord mcp` from this build, as an agent starts it: Claude Code, here, talking to the Chord on `profile`. */
function agentRelay(profile: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile };
  delete env['ELECTRON_RUN_AS_NODE'];
  const electron = process.getBuiltinModule('module').createRequire(join(appDir, 'package.json'))('electron') as string;
  const child = spawn(electron, [appDir, '--ozone-platform=headless', 'mcp'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map<number, (m: unknown) => void>();
  let buffer = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        const m = JSON.parse(line) as { id?: number };
        if (typeof m.id === 'number') waiting.get(m.id)?.(m);
      }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((done) => {
      const n = ++id;
      waiting.set(n, done);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return { child, request, call: (name: string, args: Record<string, unknown>) => request('tools/call', { name, arguments: args }) };
}

test('light: agents, Claude Code at work in its own chord', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chord-shots-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${AGENT_HOST}`, '-addext', `subjectAltName=DNS:${AGENT_HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const held: ServerResponse[] = [];
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    // The image never comes: the page never stops loading.
    if (req.url === '/slow.png') return void held.push(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(AGENT_PAGE);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  // Agents on, as Settings → Agents turns it on (CHORD_AGENTS, development builds).
  const { app, shell, windowId } = await session('light', { CHORD_AGENTS: '1' }, [`--host-resolver-rules=MAP ${AGENT_HOST} 127.0.0.1:${port}`, '--ignore-certificate-errors']);
  const profile = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const agent = agentRelay(profile);
  try {
    await agent.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328' } });
    // Its first call asks: Allow once, on the card.
    const first = agent.call('open_tab', { url: 'https://en.wikipedia.org/wiki/Web_browser' });
    const popover = await pageWhere(app, (u) => isPopover(u) && !u.includes('#'));
    const card = popover.getByRole('alertdialog', { name: 'Claude Code wants to use Chord' });
    await card.waitFor({ timeout: 20_000 });
    await sleep(700);
    await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    await first;
    await agent.call('open_tab', { url: PAGES.html });
    // The tab it's working on: open_tab still waiting on the page, the agent's bar over it, with Stop.
    void agent.call('open_tab', { url: `https://${AGENT_HOST}/` });
    let working: { id: string } | undefined;
    for (const end = Date.now() + 20_000; !working && Date.now() < end; await sleep(200)) {
      working = await shell.evaluate(async (host) => {
        const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
        return Object.values(state.nodes)
          .flatMap((b) => Object.values(b))
          .find((n) => n.kind === 'tab' && (n.url ?? '').includes(host));
      }, AGENT_HOST);
    }
    if (!working) throw new Error('open_tab made no tab');
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: working.id });
    await shell.getByRole('status').filter({ hasText: 'Claude Code is reading this tab' }).waitFor({ timeout: 10_000 });
    await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await rest(shell);
    await quietBanners(app);
    await iconsLoaded(shell);
    await capture(app, 'Chord', 'agents');
  } finally {
    agent.child.kill();
    for (const res of held) res.destroy();
    await app.close();
    server.close();
  }
});
