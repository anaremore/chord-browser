/**
 * Duet, end to end, with a fake Claude Code (fake-claude.mjs) speaking the
 * real stream-json protocol: no network, no real CLI, no sign-in. The fake
 * keeps its "session files" in a temp CLAUDE_CONFIG_DIR, so resume, fallback
 * and deletion of the provider's copy can be checked on disk.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');
const fake = resolve(import.meta.dirname, 'fake-claude.mjs');

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
  return watchForMainErrors(await electron.launch({ args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
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
    await overlay.keyboard.type('@duet');
    await overlay.keyboard.press('Enter');
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
    await panel.getByRole('combobox', { name: 'What Duet can read' }).selectOption('all');
    await expect(panel.getByText(/This tab · 127\.0\.0\.1/)).toHaveCount(0);
    await send(panel, 'list my tabs');
    await expect(panel.getByText('I can see 0 tabs.')).toBeVisible();
  } finally {
    await app.close();
  }
});
