/**
 * The assistant clicks and types in the tab on screen (S18 M2e-2a), end to end, with the fake Claude Code
 * (fake-claude.mjs's `Act:` turns): the site card and the *Send data* card inline in the chat, *Allow for this chat*
 * lasting for the chat, a risky step asking every time, and your own key in the tab stopping it. On fixtures: a card
 * table (one use among many), and a checkout on another site.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { dispatch, pressReal, where } from './a11y-kit';
import { watchForMainErrors } from './main-errors';

const appDir = resolve(import.meta.dirname, '../..');
const fake = resolve(import.meta.dirname, 'fake-claude.mjs');

/** What reached the fixture site: each POST, by its path. */
const reached: string[] = [];
let site: { server: Server; origin: string; other: string };

test.beforeAll(async () => {
  const pages: Record<string, string> = {
    // A card table: each move is a POST to the site, as a game's would be.
    '/table':
      '<title>Table 7</title><h1>Hand 12</h1><p id=log></p>' +
      ['Fold', 'Call', 'Raise'].map((m) => `<button onclick="fetch('/move?${m}', { method: 'POST', body: '${m}' }).then(() => (log.textContent += '${m} '))">${m}</button>`).join(' '),
    // A sign-up form: filled from its card, then reset by the assistant (the owner's preview, 2026-11-24).
    '/form': '<title>Sign up</title><form><label>Full name <input name=name></label> <label>Email <input name=email></label> <button type=button onclick="this.form.reset()">Reset</button></form>',
    // M2e-2b: what a click can set off. Each button's outcome goes in the page's log (and the passkey's time, for the
    // pending-request check: one asked with a 20 s timeout while Chord holds WebAuthn).
    '/tricks':
      '<title>Tricks</title><p id=log></p><p id=copyme>page-clipboard-text</p><a id=file href="/file.zip" download hidden>f</a><input type=file id=up hidden>' +
      '<button onclick="log.textContent += (window.open(\'/table\', \'p\', \'width=300,height=200\') ? \'opened \' : \'blocked \')">Open window</button>' +
      '<button onclick="up.click()">Upload</button>' +
      '<button onclick="getSelection().selectAllChildren(copyme); document.execCommand(\'copy\'); log.textContent += \'copied \'">Copy</button>' +
      '<button onclick="const t = Date.now(); navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 20000, userVerification: \'discouraged\', allowCredentials: [] } }).then(() => (log.textContent += \'passkey-ok \'), (e) => (log.textContent += \'passkey-\' + e.name + \'-\' + Math.round((Date.now() - t) / 1000) + \'s \'))">Passkey</button>' +
      '<button onclick="file.click()">Download</button>' +
      // Neon's B1 on #150: a link that opens a file in a new tab.
      '<a href="/file.zip" target=_blank>Get file</a>' +
      // The PaymentRequest row: Electron has no payment service (the M2e-2 spike); a later one that adds it fails here.
      '<button onclick="try { new PaymentRequest([{ supportedMethods: \'https://pay.example/\' }], { total: { label: \'x\', amount: { currency: \'USD\', value: \'1\' } } }).show().then(() => (log.textContent += \'pay-ok \'), (e) => (log.textContent += \'pay-\' + e.name + \' \')) } catch (e) { log.textContent += \'pay-\' + e.name + \' \' }">Open sheet</button>' +
      // FedCM: an identity provider on this origin (the spike's). Electron has no FedCM UI: the request fails by itself.
      '<button onclick="navigator.credentials.get({ identity: { providers: [{ configURL: location.origin + \'/fedcm.json\', clientId: \'x\' }] } }).then(() => (log.textContent += \'signin-ok \'), (e) => (log.textContent += \'signin-\' + e.name + \' \'))">Identity</button>',
    // M2e-2b, C3: a page whose service worker sends its POSTs itself (the worker's own fetch, which no page hold sees).
    '/sw':
      '<title>Worker</title><p id=log></p><script>navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => (log.textContent += navigator.serviceWorker.controller ? "controlled " : "ready "))</script>' +
      `<button onclick="fetch('/swmove', { method: 'POST', body: 'x' }).then(() => (log.textContent += 'moved '))">Move</button>`,
    // A checkout: paying asks every time.
    '/checkout': '<title>Checkout</title><form method=post action=/order><label>Shipping <select name=ship><option>Standard</option><option>Express</option></select></label> <button>Place order</button></form>',
  };
  const server = createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      // What the worker sends itself is marked (?sw), so a test can tell it from the page's own (Neon's N2 on #150).
      res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', (e) => { if (e.request.method === 'POST') e.respondWith(e.request.text().then((body) => fetch(e.request.url + '?sw', { method: 'POST', body }))); });");
      return;
    }
    const idp: Record<string, unknown> = {
      '/.well-known/web-identity': { provider_urls: [`${site.other}/fedcm.json`] },
      '/fedcm.json': { accounts_endpoint: '/accounts', client_metadata_endpoint: '/client', id_assertion_endpoint: '/assert', login_url: '/login' },
      '/accounts': { accounts: [{ id: '1', name: 'Ada', email: 'ada@example.com', given_name: 'Ada' }] },
      '/client': {},
      '/assert': { token: 't' },
    };
    const idpPath = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && idpPath in idp) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-login': 'logged-in' });
      res.end(JSON.stringify(idp[idpPath]));
      return;
    }
    if (req.url === '/file.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="file.zip"' });
      res.end('PK');
      return;
    }
    if (req.method === 'POST') {
      reached.push(`POST ${req.url}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Done</title><p>done</p>');
      return;
    }
    const body = pages[(req.url ?? '/').split('?')[0]!];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  // Another site, the same server: localhost isn't 127.0.0.1's site.
  site = { server, origin: `http://127.0.0.1:${port}`, other: `http://localhost:${port}` };
});
test.afterAll(() => site.server.close());

async function launch(profile: string, config: string): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CHORD_USER_DATA: profile,
    CHORD_HOME_URL: `${site.origin}/table`,
    CHORD_ASSISTANT_CLAUDE: fake,
    CHORD_ASSISTANT_CODEX: join(config, 'no-codex'),
    CLAUDE_CONFIG_DIR: config,
    CHORD_DOWNLOADS_DIR: join(profile, 'downloads'),
  };
  mkdirSync(join(profile, 'downloads'), { recursive: true });
  delete env['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env, cwd: appDir }));
}

async function shellOf(app: ElectronApplication): Promise<Page> {
  const isShell = (p: Page) => p.url().startsWith('chord://shell') || p.url().includes('/shell/index.html');
  await expect.poll(() => app.windows().some(isShell), { timeout: 20_000 }).toBe(true);
  return app.windows().find(isShell)!;
}

async function openAssistant(shell: Page): Promise<Locator> {
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('assistant.toggle'));
  const panel = shell.getByRole('complementary', { name: 'Assistant' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Use this' }).first().click();
  await panel.getByRole('button', { name: 'Got it' }).click();
  return panel;
}

async function send(panel: Locator, text: string): Promise<void> {
  const input = panel.getByRole('textbox', { name: 'Message' });
  await input.fill(text);
  await input.press('Enter');
}

/** The fake's last `Act:` turn: each step's tool and what Chord answered. */
const lastActing = (config: string): { tool: string; result: string }[] => {
  const lines = readFileSync(join(config, 'acting.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1)!) as { tool: string; result: string }[];
};
const actingTurns = (config: string): number => {
  try {
    return readFileSync(join(config, 'acting.jsonl'), 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
};
const act = (steps: object[]) => `Act: ${JSON.stringify(steps)}`;

test('the assistant acts in your tab: the site card and Send data card in the chat, Allow for this chat, a risky step every time, and your key stops it (M2e-2a)', async () => {
  test.setTimeout(150_000);
  reached.length = 0;
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const app = await launch(profile, config);
  try {
    const shell = await shellOf(app);
    const panel = await openAssistant(shell);
    const card = (title: RegExp) => panel.getByRole('group', { name: title });

    // Raise: the first action on the site asks, in the chat; then what the click sends asks.
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Raise' }]));
    const siteCard = card(/^Let the assistant click and type on /);
    await expect(siteCard).toBeVisible({ timeout: 20_000 });
    await expect(siteCard).toContainText('It wants to click “Raise”.');
    // Its first moment takes no click (F6): one right away does nothing.
    await siteCard.getByRole('button', { name: 'Allow for this chat' }).click();
    await expect(siteCard.getByRole('button', { name: 'Allow for this chat' })).toBeVisible();
    await shell.waitForTimeout(700);
    await siteCard.getByRole('button', { name: 'Allow for this chat' }).click();
    const sendCard = card(/^Send data to /);
    await expect(sendCard).toBeVisible({ timeout: 15_000 });
    await expect(sendCard).toContainText('The assistant clicked “Raise”, and the page is sending something to its site.');
    // Mid-action, the bar over the tab says what it's doing, with Stop (round 2 of #147: the bar and its Stop).
    const bar = shell.getByRole('status').filter({ hasText: 'The assistant is clicking “Raise”' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(reached).toEqual([]);
    await shell.waitForTimeout(700);
    await sendCard.getByRole('button', { name: 'Allow for this chat' }).click();
    await expect.poll(() => reached).toEqual(['POST /move?Raise']);
    await expect.poll(() => actingTurns(config), { timeout: 15_000 }).toBe(1);
    expect(lastActing(config).find((s) => s.tool === 'click')?.result).toContain('Clicked “Raise”');
    // Its own click (input Chord sends, isAgentInput) is never you taking the tab (invariant 1; browser.ts' userInput).
    await expect(panel.getByText('Stopped: you used the tab')).toHaveCount(0);

    // Call, in the next message, after Raise's lease is over (past TAIL_MS): no card (the site, and what it sends
    // there, allowed for this chat: the chat keeps it, not the lease).
    await shell.waitForTimeout(2_500);
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Call' }]));
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => reached).toEqual(['POST /move?Raise', 'POST /move?Call']);
    expect(lastActing(config).find((s) => s.tool === 'click')?.result).toContain('Clicked “Call”');
    await expect(panel.getByRole('group', { name: /^(Let the assistant|Send data)/ })).toHaveCount(0);

    // Another site, on screen: its first action asks; your key in the page stops it there (F1).
    const windowId = (await where(shell)).windowId;
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.other}/checkout` });
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(`${site.other}/checkout`))).toBe(true);
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Place order' }]));
    const otherCard = card(/^Let the assistant click and type on localhost:\d+\?$/);
    await expect(otherCard).toBeVisible({ timeout: 20_000 });
    await pressReal(app, `${site.other}/checkout`, 'Down');
    await expect(otherCard.getByRole('button', { name: 'Allow for this chat' })).toHaveCount(0);
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(3);
    expect(lastActing(config).find((s) => s.tool === 'click')?.result).toContain('The user took that tab over');
    await expect(panel.getByText('Stopped: you used the tab')).toBeVisible();

    // Again: allowed for the chat, then paying asks every time; Don't, and nothing reaches the site.
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Place order' }]));
    await expect(otherCard.last()).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await card(/^Let the assistant click and type on localhost:\d+\?$/).last().getByRole('button', { name: 'Allow for this chat' }).click();
    const pay = card(/^Place the order on localhost:\d+\?$/);
    await expect(pay).toBeVisible({ timeout: 15_000 });
    await expect(pay).toContainText('The assistant is about to click “Place order”.');
    await shell.waitForTimeout(700);
    await pay.getByRole('button', { name: 'Don’t' }).click();
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(4);
    expect(lastActing(config).find((s) => s.tool === 'click')?.result).toContain('The user said no to this step');
    expect(reached.filter((r) => r.startsWith('POST /order'))).toEqual([]);

    // Once more, and Stop (the bar's, as Ctrl+.: every agent and reply) ends it: the card comes down, nothing is sent.
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Place order' }]));
    await expect(pay.last()).toBeVisible({ timeout: 20_000 });
    await dispatch(shell, { t: 'agents.stopAll' });
    await expect(panel.getByRole('group', { name: /^Place the order/ })).toHaveCount(0);
    expect(reached.filter((r) => r.startsWith('POST /order'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

test('after a turn that only filled a form (its card answered), the next message acts in the same tab: the site card, never “switched away” (the owner’s preview)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const app = await launch(profile, config);
  try {
    const shell = await shellOf(app);
    const windowId = (await where(shell)).windowId;
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/form` });
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(`${site.origin}/form`))).toBe(true);
    const page = app.windows().find((p) => p.url().startsWith(`${site.origin}/form`))!;
    const panel = await openAssistant(shell);
    // A read-only turn: the fill card, answered.
    await send(panel, 'fill this form for me');
    const fill = panel.getByRole('button', { name: /^Fill \d+ fields?$/ });
    await expect(fill).toBeVisible({ timeout: 20_000 });
    await fill.click();
    await expect.poll(() => page.evaluate(() => (document.querySelector('input[name=name]') as HTMLInputElement).value)).toBe('Ada Lovelace');
    // You switch to another tab and back, between turns; the form is on screen as you send: the new message acts there
    // (the owner's preview, 2026-11-24): the site card, never a refusal carried from between turns.
    const formTab = (await where(shell)).tabId!;
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/table` });
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: formTab });
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Reset' }]));
    const siteCard = panel.getByRole('group', { name: /^Let the assistant click and type on / });
    await expect(siteCard).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await siteCard.getByRole('button', { name: 'Allow for this chat' }).click();
    await expect.poll(() => page.evaluate(() => (document.querySelector('input[name=name]') as HTMLInputElement).value), { timeout: 20_000 }).toBe('');
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(1);
    expect(lastActing(config).find((x) => x.tool === 'click')?.result).toContain('Clicked “Reset”');

    // A switch during a turn still ends that turn's acting, and says what was seen.
    await send(panel, act([{ sleep: 2500 }, { tool: 'snapshot' }, { tool: 'click', name: 'Reset' }]));
    await shell.waitForTimeout(500);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/table` });
    expect((await where(shell)).tabId).not.toBe(formTab);
    await dispatch(shell, { t: 'tab.activate', windowId, nodeId: formTab });
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(2);
    expect(lastActing(config).find((x) => x.tool === 'click')?.result).toContain('That tab left the screen while you were working on this message (another tab is on screen in its window)');
  } finally {
    const acted = (() => {
      try {
        return readFileSync(join(config, 'acting.jsonl'), 'utf8');
      } catch {
        return '';
      }
    })();
    if (acted) console.log(`acting: ${acted}`);
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

test('what the assistant’s click sets off in your tab is caught: a window, a file picker, the clipboard, a passkey, a download (M2e-2b)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const app = await launch(profile, config);
  try {
    const shell = await shellOf(app);
    const panel = await openAssistant(shell);
    await dispatch(shell, { t: 'tab.open', windowId: (await where(shell)).windowId, url: `${site.other}/tricks` });
    // On localhost: WebAuthn takes no IP address as a site (127.0.0.1 is a SecurityError before anything else).
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(`${site.other}/tricks`))).toBe(true);
    const page = app.windows().find((p) => p.url().startsWith(`${site.other}/tricks`))!;
    await app.evaluate(({ clipboard }) => clipboard.writeText('yours'));
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Open window' }, { tool: 'click', name: 'Upload' }, { tool: 'click', name: 'Copy' }, { tool: 'click', name: 'Passkey' }]));
    const siteCard = panel.getByRole('group', { name: /^Let the assistant click and type on / });
    await expect(siteCard).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await siteCard.getByRole('button', { name: 'Allow for this chat' }).click();
    await expect.poll(() => actingTurns(config), { timeout: 30_000 }).toBe(1);
    // A window of its own is never made; a file picker never shows; each is said in the chat.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);
    await expect(page.locator('#log')).toContainText('blocked');
    await expect(panel.getByText(/^The page tried to open .* in a new tab or window; it wasn’t opened/)).toBeVisible();
    await expect(panel.getByText('The page tried to open a file picker; it wasn’t shown')).toBeVisible();

    // The passkey: refused with no prompt; whether a request still pending when the domain turns off ends then is the
    // record's check (M2e-2 spike): its time is printed.
    await expect(page.locator('#log')).toContainText(/passkey-NotAllowedError-\d+s/, { timeout: 30_000 });
    console.log(`passkey: ${await page.locator('#log').textContent()}`);
    // The clipboard the page changed is put back once its click can set nothing off.
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 15_000 }).toBe('yours');
    // A link opening a file in a new tab, a payment, a sign-in with another site (Neon's B1 and B2 on #150).
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Get file' }, { tool: 'click', name: 'Open sheet' }, { tool: 'click', name: 'Identity' }]));
    await expect.poll(() => actingTurns(config), { timeout: 40_000 }).toBe(2);
    // No tab, no download, said.
    await expect(panel.getByText(/file\.zip in a new tab or window; it wasn’t opened/)).toBeVisible();
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => w.getURL().includes('file.zip')).length)).toBe(0);
    // Payments and FedCM: neither (Electron has no UI for them: each request fails by itself, with no window). A later
    // Electron that adds either fails here, and the lease has to hold it then (the M2e-2 spike; Neon's B2 on #150).
    await expect(page.locator('#log')).toContainText(/pay-\w+/);
    await expect(page.locator('#log')).not.toContainText('pay-ok');
    await expect(page.locator('#log')).toContainText('signin-NetworkError', { timeout: 15_000 });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);
    // A download its click starts asks first; Don't, and nothing is saved.
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Download' }]));
    const save = panel.getByRole('group', { name: /^Save file\.zip from / });
    await expect(save).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await save.getByRole('button', { name: 'Don’t' }).click();
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(3);
    // Don't: nothing in the folder, not even its pending name (Neon's S1 on #150).
    const folder = join(profile, 'downloads');
    expect(readdirSync(folder)).toEqual([]);
    // Allow: saved under its name.
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Download' }]));
    const again = panel.getByRole('group', { name: /^Save file\.zip from / }).last();
    await expect(again).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await again.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => existsSync(join(folder, 'file.zip')), { timeout: 20_000 }).toBe(true);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});

test('a page whose service worker sends its POSTs: while the assistant acts, its requests skip the worker and are held and asked about; after, the worker is back (M2e-2b, C3)', async () => {
  test.setTimeout(120_000);
  reached.length = 0;
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const app = await launch(profile, config);
  try {
    const shell = await shellOf(app);
    const panel = await openAssistant(shell);
    const windowId = (await where(shell)).windowId;
    // On localhost: a service worker needs a secure context.
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.other}/sw` });
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(`${site.other}/sw`))).toBe(true);
    const page = app.windows().find((p) => p.url().startsWith(`${site.other}/sw`))!;
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
    // Before: the worker's own (the page sends through it, as it always does).
    await page.evaluate(() => fetch('/swmove', { method: 'POST', body: 'yours' }));
    expect(reached).toEqual(['POST /swmove?sw']);
    reached.length = 0;
    await send(panel, act([{ tool: 'snapshot' }, { tool: 'click', name: 'Move' }]));
    const siteCard = panel.getByRole('group', { name: /^Let the assistant click and type on / });
    await expect(siteCard).toBeVisible({ timeout: 20_000 });
    await shell.waitForTimeout(700);
    await siteCard.getByRole('button', { name: 'Allow for this chat' }).click();
    // The click's POST skipped the worker: held, and asked about; nothing reached the site meanwhile.
    const sendCard = panel.getByRole('group', { name: /^Send data to / });
    await expect(sendCard).toBeVisible({ timeout: 15_000 });
    expect(reached).toEqual([]);
    await shell.waitForTimeout(700);
    await sendCard.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => reached).toEqual(['POST /swmove']);
    await expect.poll(() => actingTurns(config), { timeout: 20_000 }).toBe(1);
    // After the lease (6 s after its last action): the worker sends the page's POSTs again (Neon's N2 on #150).
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
    await shell.waitForTimeout(7_000);
    reached.length = 0;
    await page.evaluate(() => fetch('/swmove', { method: 'POST', body: 'yours' }));
    await expect.poll(() => reached).toEqual(['POST /swmove?sw']);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});
