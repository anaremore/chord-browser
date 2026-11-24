/**
 * The assistant clicks and types in the tab on screen (S18 M2e-2a), end to end, with the fake Claude Code
 * (fake-claude.mjs's `Act:` turns): the site card and the *Send data* card inline in the chat, *Allow for this chat*
 * lasting for the chat, a risky step asking every time, and your own key in the tab stopping it. On fixtures: a card
 * table (one use among many), and a checkout on another site.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // A checkout: paying asks every time.
    '/checkout': '<title>Checkout</title><form method=post action=/order><label>Shipping <select name=ship><option>Standard</option><option>Express</option></select></label> <button>Place order</button></form>',
  };
  const server = createServer((req, res) => {
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
  };
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
    expect(reached).toEqual([]);
    await shell.waitForTimeout(700);
    await sendCard.getByRole('button', { name: 'Allow for this chat' }).click();
    await expect.poll(() => reached).toEqual(['POST /move?Raise']);
    await expect.poll(() => actingTurns(config), { timeout: 15_000 }).toBe(1);
    expect(lastActing(config).find((s) => s.tool === 'click')?.result).toContain('Clicked “Raise”');

    // Call, in the next message: no card (the site, and what it sends there, allowed for this chat).
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
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
});
