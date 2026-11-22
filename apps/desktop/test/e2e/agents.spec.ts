/**
 * Outside agents end to end (S18 M1b–d): a Chord serving its endpoint (Settings
 * → Agents, or CHORD_AGENTS=1 in development builds), and `chord mcp` (the same
 * executable, its relay) started as an agent starts it. The connect card in the
 * popover lets it in: Deny, Allow once, Always allow (no card next time, until
 * those sign-ins are gone). Then its Agent chord, its tools, the bar and Stop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';
import { audit, capturesDir, closeSettings, dispatch, expectClean, isOverlay, isPopover, isSettings, isShell, pageWhere, pressReal, runAction, settle, where } from './a11y-kit';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

failOnMainErrors();

const appDir = resolve(import.meta.dirname, '../..');

type Hooks = { chordTestHooks: { agents(): Promise<{ serving: string | null; connections: number; restricted: number | null }>; agentsStopAll(): void } };
/** The hooks are set once main has started its services: wait for them. */
const agents = async (app: ElectronApplication) => {
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as unknown as Partial<Hooks>).chordTestHooks))).toBe(true);
  return app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.agents());
};

async function launch(profile: string, env: Record<string, string>): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_E2E_HOOKS: '1', ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

/** `chord mcp` from the development build, as an agent starts it (the profile by CHORD_USER_DATA, as in development). */
function relay(profile: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile };
  delete env['ELECTRON_RUN_AS_NODE'];
  const child: ChildProcess = spawn(resolveElectron(), [appDir, ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (m: { result: Record<string, unknown> }) => void>();
  let buffer = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) {
        const m = JSON.parse(line) as { id: number; result: Record<string, unknown> };
        waiting.get(m.id)?.(m);
      }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<{ result: Record<string, unknown> }>((done) => {
      const n = ++id;
      waiting.set(n, done);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const content = r.result['content'] as { text: string }[];
    return { isError: r.result['isError'], text: content[0]!.text, held: content.slice(1).map((c) => c.text) };
  };
  return { child, request, call, exited: new Promise<number | null>((done) => child.once('exit', (code) => done(code))) };
}

function resolveElectron(): string {
  // The electron package's main export is the path of its binary.
  return (process.getBuiltinModule('module').createRequire(join(appDir, 'package.json'))('electron') as string);
}

const CODEX = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } };
const CLAUDE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328' } };
const DENIED = 'The user denied this connection in Chord. Stop using Chord’s tools and tell the user.';
const NO_AGENTS = 'No agents yet. Copy a line above into your terminal to connect one.';

/** The connect card in the window's popover, for that agent. */
const cardOf = (popover: Page, name: string) => popover.getByRole('alertdialog', { name: `${name} wants to use Chord` });

/** Answer the card as you would: once it's shown (its buttons wait a moment before they take a click). */
async function answer(app: ElectronApplication, name: string, button: 'Deny' | 'Allow once' | 'Always allow' | 'Close'): Promise<void> {
  const popover = await pageWhere(app, isPopover);
  const card = cardOf(popover, name);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await popover.waitForTimeout(600);
  await card.getByRole('button', { name: button, exact: true }).click();
  await expect(card).toHaveCount(0);
}

/** Settings → Agents, opened from the window. */
async function agentsSettings(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Agents' }).click();
  await expect(settings.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Agents');
  return settings;
}

test('Settings → Agents turns it on; the card asks, Deny refuses, Allow once lets in this connection only, and Stop lists it in Settings', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // The old development hook does nothing now: only the card lets an agent in. A home of the test's own (Linux and
  // macOS read HOME), where Add to Antigravity writes.
  const home = mkdtempSync(join(tmpdir(), 'chord-e2e-home-'));
  const app = await launch(profile, { CHORD_AGENT_APPROVE: 'always', ...(process.platform === 'win32' ? {} : { HOME: home }) });
  try {
    const shell = await pageWhere(app, isShell);
    expect(await agents(app)).toMatchObject({ serving: null });
    let settings = await agentsSettings(app, shell);
    await expect(settings.getByText(NO_AGENTS)).toBeVisible();
    await expect(settings.getByText(/^claude mcp add chord -- .* mcp$/)).toBeVisible();
    await expect(settings.getByText(/^codex mcp add chord -- .* mcp$/)).toBeVisible();
    await settings.getByRole('switch', { name: 'Let agents connect' }).click();
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(true);

    // Antigravity: Chord adds itself to its MCP config (the same command as the lines above), with Undo.
    if (process.platform !== 'win32') {
      const config = join(home, '.gemini', 'config', 'mcp_config.json');
      mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
      writeFileSync(config, '');
      await settings.getByRole('button', { name: 'Add to Antigravity' }).click();
      const said = settings.getByRole('status').filter({ hasText: 'Added Chord to Antigravity. Refresh or restart its MCP servers to see it.' });
      await expect(said).toBeVisible();
      const entry = (JSON.parse(readFileSync(config, 'utf8')) as { mcpServers: { chord: { command: string; args: string[] } } }).mcpServers.chord;
      expect(entry.args.at(-1)).toBe('mcp');
      await settle(settings);
      mkdirSync(capturesDir, { recursive: true });
      await settings.screenshot({ path: join(capturesDir, 'agents-settings-antigravity.png') });
      await said.getByRole('button', { name: 'Undo' }).click();
      await expect(settings.getByRole('status').filter({ hasText: 'Antigravity’s MCP servers are as they were.' })).toBeVisible();
      // Only Chord's entry went: the rest of what Undo leaves is Antigravity's.
      expect((JSON.parse(readFileSync(config, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers).toEqual({});
    }
    await closeSettings(app);

    // Deny (× answers the same): told so, and nothing is kept.
    let mcp = relay(profile);
    const init = await mcp.request('initialize', CODEX);
    expect(init.result).toMatchObject({ serverInfo: { name: 'chord' }, capabilities: { tools: { listChanged: true } } });
    const denied = mcp.call('list_tabs');
    const popover = await pageWhere(app, isPopover);
    const card = cardOf(popover, 'Codex');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Who started it (once Chord has looked), where, what it may do; and it never takes the keyboard.
    await expect(card).toContainText(/Started (by .+ )?in /);
    // It never takes the keyboard, so it's announced, politely.
    await expect(popover.locator('[role="status"][aria-live="polite"]').filter({ hasText: 'Codex wants to use Chord' })).toHaveCount(1);
    for (const line of ['Open and read pages in its own Agent chord', 'Read a tab of yours only when you share it', 'Never see your passwords']) await expect(card).toContainText(line);
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '')).not.toContain('popover');
    mkdirSync(capturesDir, { recursive: true });
    await popover.waitForTimeout(600);
    await card.screenshot({ path: join(capturesDir, 'agents-connect-card.png') });
    expectClean(await audit(popover, 'connect card', { appearance: 'light' }));
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    expect(await denied).toMatchObject({ isError: true, text: DENIED });
    mcp.child.kill();

    // Allow once: this connection only. Then Stop: Settings lists it, and lets it continue.
    mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const listed = mcp.call('list_tabs');
    await answer(app, 'Codex', 'Allow once');
    expect((await listed).isError).toBe(false);
    expect(JSON.parse((await listed).text)).toEqual({ trust: 'untrusted', data: { tabs: [] } });
    expect(await agents(app)).toMatchObject({ connections: 1 });
    await app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.agentsStopAll());
    expect(await mcp.call('list_tabs')).toMatchObject({ isError: true, text: 'The user stopped you in Chord. Don’t call Chord’s tools again until the user asks you to.' });
    settings = await agentsSettings(app, shell);
    await expect(settings.getByRole('heading', { name: 'Stopped' })).toBeVisible();
    await expect(settings.getByText('Stopped · 0 tabs')).toBeVisible();
    // Allowed once isn't allowed for good.
    await expect(settings.getByText(NO_AGENTS)).toBeVisible();
    await settings.getByRole('button', { name: 'Let Codex continue' }).click();
    await expect(settings.getByRole('heading', { name: 'Stopped' })).toHaveCount(0);
    expect((await mcp.call('list_tabs')).isError).toBe(false);
    await closeSettings(app);
    mcp.child.kill();
    // A new connection asks again; its × is a no.
    mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const again = mcp.call('list_tabs');
    await answer(app, 'Codex', 'Close');
    expect((await again).text).toBe(DENIED);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
  }
  // Quitting takes the endpoint away.
  expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('Always allow: no card next time, with the sign-ins of the window that allowed it; once those are gone it asks again; Remove forgets it', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    // Personal gets sign-ins of its own, so they can go later.
    const own = '7d4c8a10-5b3e-4c2a-9f61-0a1b2c3d4e5f';
    const chordId = await shell.evaluate(async () => {
      type Snap = { state: { windows: Record<string, { activeChordId: string }> } };
      const snap = await (window as unknown as { chord: { state: { snapshot(): Promise<Snap> } } }).chord.state.snapshot();
      return Object.values(snap.state.windows)[0]!.activeChordId;
    });
    await dispatch(shell, { t: 'chord.profile', chordId, profileId: own });

    let mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    const first = mcp.call('list_tabs');
    await answer(app, 'Claude Code', 'Always allow');
    expect((await first).isError).toBe(false);
    const settings = await agentsSettings(app, shell);
    await expect(settings.getByText('Always allowed · Personal’s sign-ins · connected now · 0 tabs', { exact: true })).toBeVisible();
    await expect(settings.getByText('Chord goes by the name the agent gives. Remove any you don’t recognize.')).toBeVisible();
    mkdirSync(capturesDir, { recursive: true });
    await settle(settings);
    await settings.screenshot({ path: join(capturesDir, 'agents-settings.png') });
    expectClean(await audit(settings, 'Settings → Agents', { appearance: 'light' }));
    mcp.child.stdin!.end();
    await mcp.exited;
    await expect(settings.getByText('Always allowed · Personal’s sign-ins · last used today', { exact: true })).toBeVisible();

    // Reconnecting: let in without a card.
    mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    expect((await mcp.call('list_tabs')).isError).toBe(false);
    await expect(cardOf(await pageWhere(app, isPopover), 'Claude Code')).toHaveCount(0);
    mcp.child.stdin!.end();
    await mcp.exited;

    // Those sign-ins gone (Personal back on the default ones): the card asks again.
    await dispatch(shell, { t: 'chord.profile', chordId, profileId: 'default' });
    await expect(settings.getByText('Always allowed · last used today', { exact: true })).toBeVisible();
    mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    const asked = mcp.call('list_tabs');
    await answer(app, 'Claude Code', 'Allow once');
    expect((await asked).isError).toBe(false);
    mcp.child.stdin!.end();
    await mcp.exited;

    // Remove: forgotten.
    await settings.getByRole('button', { name: 'Remove Claude Code' }).click();
    await expect(settings.getByText(NO_AGENTS)).toBeVisible();
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Agents off (the default): no endpoint, and the relay finds no Chord', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, {});
  const mcp = relay(profile);
  try {
    expect(await agents(app)).toEqual({ serving: null, connections: 0, restricted: null });
    expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
    expect((await mcp.call('list_tabs')).text).toBe('Chord isn’t open. Ask the user to open Chord, then call this tool again.');
  } finally {
    mcp.child.kill();
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/* ---------- The Agent chord, its tools, the bar and Stop (S18 M1c) ---------- */

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/notes': '<title>Release notes</title><h1>Notes</h1><p>Electron 46 brings a faster start.</p>',
    // A page that shows a dialog as it loads: Chord holds it, and the read never waits on it.
    '/dialog': '<title>Greeter</title><p>Hello there.</p><script>setTimeout(() => alert("Hi from the page"), 50)</script>',
    // A page that downloads a file as it loads: refused in an agent's tab.
    '/download': '<title>Download</title><p>Fetching…</p><script>setTimeout(() => { location.href = "/file.zip" }, 50)</script>',
    // M2a: a button and a field at known places, and a log of what reached them, and whether the page took it as trusted.
    '/act':
      '<title>Act</title><style>body{margin:0}button,input{position:fixed;left:20px;width:200px;height:40px}button{top:20px}input{top:80px}#log{margin-top:140px}</style>' +
      '<button id=b>Go</button><input id=i><p id=log></p><script>const log = (t, e) => { document.getElementById("log").textContent += t + ":" + e.isTrusted + " "; };' +
      'b.addEventListener("click", (e) => log("click", e)); i.addEventListener("keydown", (e) => log("keydown-" + e.key, e)); i.addEventListener("beforeinput", (e) => log("beforeinput-" + e.inputType, e));</script>',
  };
  const server = createServer((req, res) => {
    if (req.url === '/file.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="file.zip"' });
      res.end('PK');
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

test('an agent opens and reads its own tabs, is stopped and let go on, is paused while you type, and its tabs are kept or closed when it’s done', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    let mcp = relay(profile);
    await mcp.request('initialize', CODEX);

    // open_tab: a tab in its own chord, shown below yours in the sidebar.
    const opening = mcp.call('open_tab', { url: `${site.origin}/notes` });
    await answer(app, 'Codex', 'Allow once');
    const opened = JSON.parse((await opening).text) as { data: { tab_id: string; title: string; page_id: string } };
    expect(opened.data).toMatchObject({ tab_id: 'a1', title: 'Release notes' });
    const section = shell.getByRole('region', { name: 'Codex’s tabs' });
    await expect(section.getByRole('button', { name: /Release notes/ })).toBeVisible();
    // Your own tabs are never its: it lists only its own.
    expect((JSON.parse((await mcp.call('list_tabs')).text) as { data: { tabs: { tab_id: string }[] } }).data.tabs.map((t) => t.tab_id)).toEqual(['a1']);

    // read_tab, with the page it read.
    const read = JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string; page_id: string; trust: string };
    expect(read).toMatchObject({ trust: 'untrusted', page_id: opened.data.page_id });
    expect(read.content).toContain('Electron 46 brings a faster start.');

    // A dialog in its tab is held, never a native window, and reported with its next result; a download is refused.
    await mcp.call('open_tab', { url: `${site.origin}/dialog` });
    await expect.poll(async () => (await mcp.call('read_tab', { tab_id: 'a2' })).held.join(' '), { timeout: 10_000 }).toContain('alert: Hi from the page');
    await mcp.call('open_tab', { url: `${site.origin}/download` });
    await expect.poll(async () => (await mcp.call('list_tabs')).held.join(' '), { timeout: 10_000 }).toContain('file.zip');

    // Shown over your chord: no bar while it's idle.
    await section.getByRole('button', { name: /Release notes/ }).click();
    await expect(shell.getByRole('status').filter({ hasText: /Codex|Paused/ })).toHaveCount(0);

    // Stop (Ctrl+. here): every later call is refused, and the bar says so, until you let it continue.
    // As the OS delivers it, so main's shortcuts see it (a key sent over DevTools' protocol skips them).
    await pressReal(app, shell.url(), '.', [process.platform === 'darwin' ? 'meta' : 'control']);
    const bar = shell.getByRole('status').filter({ hasText: 'Codex is stopped' });
    await expect(bar).toBeVisible();
    expect((await mcp.call('read_tab', { tab_id: 'a1' })).text).toBe('The user stopped you in Chord. Don’t call Chord’s tools again until the user asks you to.');
    await bar.getByRole('button', { name: 'Let Codex continue' }).click();
    await expect(bar).toHaveCount(0);
    expect((await mcp.call('read_tab', { tab_id: 'a1' })).isError).toBe(false);

    // You type in its tab: it's paused there until you let it go on.
    await pressReal(app, `${site.origin}/notes`, 'Down');
    const paused = shell.getByRole('status').filter({ hasText: 'Paused while you use this tab' });
    await expect(paused).toBeVisible();
    await paused.getByRole('button', { name: 'Let Codex continue' }).click();
    await expect(paused).toHaveCount(0);

    // It's done: Close all, with Undo.
    mcp.child.stdin!.end();
    await mcp.exited;
    const done = shell.getByText('Codex finished. Keep these tabs?');
    await expect(done).toBeVisible();
    await shell.getByRole('button', { name: 'Close all' }).click();
    await expect(section).toHaveCount(0);
    await shell.getByRole('button', { name: 'Undo' }).click();
    await expect(shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Release notes/ })).toBeVisible();
    // Back where it was: asked again.
    await expect(shell.getByRole('button', { name: 'Keep', description: 'Codex finished. Keep these tabs?' })).toBeVisible();

    // Another agent, done: Keep moves its tab into your chord.
    mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    const keeping = mcp.call('open_tab', { url: `${site.origin}/notes#kept` });
    await answer(app, 'Claude Code', 'Allow once');
    await keeping;
    mcp.child.stdin!.end();
    await mcp.exited;
    await expect(shell.getByText('Claude Code finished. Keep these tabs?')).toBeVisible();
    await shell.getByRole('button', { name: 'Keep', description: 'Claude Code finished. Keep these tabs?' }).click();
    await expect(shell.getByRole('region', { name: 'Claude Code’s tabs' })).toHaveCount(0);
    await expect(shell.getByRole('tree', { name: 'Unpinned tabs' })).toContainText('Release notes');
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/* ---------- Acting: the agent's input is the page's, never yours (S18 M2a) ---------- */

test('input Chord sends an agent’s tab is trusted by the page, reaches a parked tab, and is never taken for yours', async () => {
  test.setTimeout(90_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/act` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    // The tab isn't on screen: the hook sends inside one of the agent's calls, so it's parked and painting, as an action's will be.
    type Seen = { agent: number; yours: number; after: number; paused: boolean; shown: boolean } | null;
    const send = (events: unknown[], text?: string) =>
      app.evaluate((_electron, [url, events, text]) => (globalThis as unknown as { chordTestHooks: { agentInputSpike(u: string, e: unknown[], t?: string): Promise<Seen> } }).chordTestHooks.agentInputSpike(url, events, text), [
        `${site.origin}/act`,
        events,
        text,
      ] as const);
    const click = (x: number, y: number) => [
      { type: 'mouseMove', x, y },
      { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
    ];
    const clicked = await send(click(120, 40));
    expect(clicked).toMatchObject({ yours: 0, after: 0, paused: false, shown: false });
    expect(clicked!.agent).toBeGreaterThan(0);
    // Into the field: a key, Enter, and text inserted as one piece.
    const typed = await send([...click(120, 100), { type: 'keyDown', keyCode: 'A' }, { type: 'char', keyCode: 'a' }, { type: 'keyUp', keyCode: 'A' }, { type: 'keyDown', keyCode: 'Return' }, { type: 'keyUp', keyCode: 'Return' }], 'hé');
    expect(typed).toMatchObject({ yours: 0, after: 0, paused: false });
    const log = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    await expect.poll(log).toContain('click:true');
    const text = await log();
    expect(text).toContain('keydown-a:true');
    expect(text).toContain('keydown-Enter:true');
    expect(text).toContain('beforeinput-insertText:true');
    expect(text).not.toContain(':false');
    // Nothing of Chord's ran for it: no pause, and no bar but the working one, now gone.
    await expect(shell.getByRole('status').filter({ hasText: /Paused/ })).toHaveCount(0);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/* ---------- Sharing a tab (S18 M1e) ---------- */

test('you share a tab: the agent reads it and your selection, can’t close it, and once it leaves the site it’s refused', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, {});
  try {
    const shell = await pageWhere(app, isShell);
    const overlay = await pageWhere(app, isOverlay);
    // Agents on, as Settings → Agents turns it on.
    await runAction(shell, 'app.settings');
    const settings = await pageWhere(app, isSettings);
    await settings.evaluate(() => (window as unknown as { chord: { settings: { set(s: unknown): Promise<void> } } }).chord.settings.set({ agentsEnabled: true }));
    await closeSettings(app);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/notes` });
    const page = await pageWhere(app, (url) => url.startsWith(`${site.origin}/notes`));
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
    // The command bar's entries for sharing (there's no key): what it offers for "share", and choosing one.
    const sharing = /^(Share this tab with an agent|Stop sharing this tab with the agent)/;
    const offered = async (want: string[]): Promise<void> => {
      await runAction(shell, 'tab.new');
      await expect(overlay.getByRole('combobox')).toBeFocused();
      await overlay.keyboard.type('shar');
      // The web search row always shows: once it's there, the actions for the query are too.
      await expect(overlay.getByRole('option', { name: /Search/ }).first()).toBeVisible();
      await expect.poll(async () => (await overlay.getByRole('option').allTextContents()).filter((n) => sharing.test(n)).map((n) => n.match(sharing)![1])).toEqual(want);
    };
    const choose = async (name: string) => {
      await runAction(shell, 'tab.new');
      await expect(overlay.getByRole('combobox')).toBeFocused();
      await overlay.keyboard.type('shar');
      await overlay.getByRole('option', { name: new RegExp(`^${name}`) }).click();
    };

    // No agent let in yet: nothing offers sharing (no toast, no entry).
    await offered([]);
    await overlay.keyboard.press('Escape');

    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const first = mcp.call('list_tabs');
    await answer(app, 'Codex', 'Allow once');
    expect(JSON.parse((await first).text)).toEqual({ trust: 'untrusted', data: { tabs: [] } });

    // Now the command bar offers it, and shares the tab on screen with the agent that called last: its bar, and the
    // ✳ on its row.
    await offered(['Share this tab with an agent']);
    await overlay.keyboard.press('Escape');
    await choose('Share this tab with an agent');
    const bar = shell.getByRole('status').filter({ hasText: 'Shared with Codex: it can read this tab' });
    await expect(bar).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Shared with Codex' })).toBeVisible();
    mkdirSync(capturesDir, { recursive: true });
    await settle(shell);
    await shell.screenshot({ path: join(capturesDir, 'agents-shared-tab.png') });

    // Listed as s1; read, with what you selected; never closed by the agent.
    const listed = JSON.parse((await mcp.call('list_tabs')).text) as { data: { tabs: { tab_id: string; title: string; attached: boolean }[] } };
    expect(listed.data.tabs).toEqual([expect.objectContaining({ tab_id: 's1', title: 'Release notes', attached: true })]);
    expect(JSON.parse((await mcp.call('read_tab', { tab_id: 's1' })).text).content).toContain('Electron 46 brings a faster start.');
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('p')!);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    expect(JSON.parse((await mcp.call('read_selection', { tab_id: 's1' })).text).content).toContain('Electron 46 brings a faster start.');
    expect(await mcp.call('close_tab', { tab_id: 's1' })).toMatchObject({ isError: true, text: expect.stringContaining('isn’t yours') });
    await expect(bar).toBeVisible();

    // It leaves the site it was shared on: sharing ends, and the agent is told so.
    const elsewhere = site.origin.replace('127.0.0.1', 'localhost');
    await page.evaluate((url) => (location.href = url), `${elsewhere}/dialog`);
    await expect(bar).toHaveCount(0);
    await expect(shell.getByRole('img', { name: 'Shared with Codex' })).toHaveCount(0);
    expect(await mcp.call('read_tab', { tab_id: 's1' })).toMatchObject({ isError: true, text: 'The user isn’t sharing that tab with you any more. Use list_tabs for the tabs you can use.' });
    expect(JSON.parse((await mcp.call('list_tabs')).text).data.tabs).toEqual([]);

    // Shared again; the command bar's Stop sharing, then sharing once more and the bar's Stop sharing.
    await page.evaluate((url) => (location.href = url), `${site.origin}/notes`);
    await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await choose('Share this tab with an agent');
    await expect(bar).toBeVisible();
    await choose('Stop sharing this tab with the agent');
    await expect(bar).toHaveCount(0);
    await choose('Share this tab with an agent');
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(bar).toHaveCount(0);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
