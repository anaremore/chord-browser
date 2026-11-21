/**
 * Outside agents' transport, end to end (S18 M1b, development builds only): a
 * Chord serving its endpoint (CHORD_AGENTS=1), and `chord mcp` (the same
 * executable, its relay) started as an agent starts it. The connection card is
 * the development hook's (CHORD_AGENT_APPROVE) until Settings → Agents (M1d);
 * the tools run against the stub scope until the Agent chord (M1c).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { failOnMainErrors, watchForMainErrors } from './main-errors';
import { isShell, pageWhere, pressReal } from './a11y-kit';
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

test('an agent connects through chord mcp, is let in by the development hook, and Stop refuses it', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_AGENT_APPROVE: 'once' });
  const mcp = relay(profile);
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(true);
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } });
    expect(init.result).toMatchObject({ serverInfo: { name: 'chord' }, capabilities: { tools: { listChanged: true } } });
    const listed = await mcp.call('list_tabs');
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.text)).toEqual({ trust: 'untrusted', data: { tabs: [] } });
    expect(await agents(app)).toMatchObject({ connections: 1 });
    await app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.agentsStopAll());
    expect(await mcp.call('list_tabs')).toMatchObject({ isError: true, text: 'The user stopped you in Chord. Don’t call Chord’s tools again until the user asks you to.' });
  } finally {
    await app.close();
  }
  // Quitting takes the endpoint away: the relay's next call says Chord isn't open, and the file is gone.
  expect(await mcp.call('list_tabs')).toMatchObject({ isError: true, text: 'Chord isn’t open. Ask the user to open Chord, then call this tool again.' });
  expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
  mcp.child.stdin!.end();
  expect(await mcp.exited).toBe(0);
  rmSync(profile, { recursive: true, force: true });
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
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_AGENT_APPROVE: 'once' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    let mcp = relay(profile);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } });

    // open_tab: a tab in its own chord, shown below yours in the sidebar.
    const opened = JSON.parse((await mcp.call('open_tab', { url: `${site.origin}/notes` })).text) as { data: { tab_id: string; title: string; page_id: string } };
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
    await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328' } });
    await mcp.call('open_tab', { url: `${site.origin}/notes#kept` });
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
