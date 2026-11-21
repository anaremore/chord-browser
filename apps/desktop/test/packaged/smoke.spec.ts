/**
 * Smoke test for a packaged build (`pnpm package:dir` first, or point
 * CHORD_APP at an executable). It proves what only packaging can break: the
 * fused binary starts, the asar'd shell loads over chord://, and chord-data's
 * utility process saves and restores a profile with node:sqlite.
 *
 * Playwright's _electron.launch can't drive a packaged Chord: it attaches to
 * the main process with --inspect, which the EnableNodeCliInspectArguments
 * fuse turns off (ARCHITECTURE.md §14.1). Chromium's remote debugging port
 * still works, so the app is started directly and driven over CDP; there is
 * no access to the main process.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS_RELEASED } from '@chord/core/agent-tools';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

/** electron-builder's unpacked output for this OS and arch. */
function packagedExecutable(): string {
  const fromEnv = process.env['CHORD_APP'];
  if (fromEnv) return resolve(fromEnv);
  const release = resolve(import.meta.dirname, '../../release');
  const arch = process.arch === 'x64' ? '' : `-${process.arch}`;
  if (process.platform === 'win32') return join(release, `win${arch}-unpacked`, 'Chord.exe');
  if (process.platform === 'darwin') return join(release, `mac${arch}`, 'Chord.app', 'Contents', 'MacOS', 'Chord');
  return join(release, `linux${arch}-unpacked`, 'chord');
}

type Running = { child: ChildProcess; browser: Browser; exited: Promise<number | null> };

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

/**
 * On macOS, cookie encryption keeps its key in the login keychain (Chord Safe
 * Storage), and only the build that saved it may read it without asking. An
 * ad-hoc signature changes with every build, so any other build waits on a
 * keychain prompt before loading a single page. A test can't answer one, and
 * shouldn't touch the tester's keychain anyway: Chromium's mock keychain
 * keeps the key in memory.
 */
const keychainArgs = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];

/** `args` go last: a link the OS hands over comes after --single-argument, which takes the rest of the line. */
async function start(executable: string, profile: string, args: string[] = []): Promise<Running> {
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', ...keychainArgs, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const endpoint = await new Promise<string>((done, fail) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error(`No DevTools endpoint after 30 s. Output:\n${output}`)), 30_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        done(match[1]!);
      }
    };
    child.stderr!.on('data', read);
    child.stdout!.on('data', read);
    void exited.then((code) => fail(new Error(`Chord exited (${code}) before it was ready. Output:\n${output}`)));
  });
  return { child, browser: await chromium.connectOverCDP(endpoint), exited };
}

const pages = (browser: Browser) => browser.contexts().flatMap((c) => c.pages());

async function pageWhere(browser: Browser, match: (url: string) => boolean): Promise<Page> {
  await expect.poll(() => pages(browser).some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return pages(browser).find((p) => match(p.url()))!;
}

/** Quits the way ⌘Q / Ctrl+Q does, so chord-data flushes before exit. */
async function quit(app: Running, shell: Page): Promise<void> {
  await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.quit')).catch(() => {});
  const code = await Promise.race([app.exited, new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 15_000))]);
  await app.browser.close().catch(() => {});
  if (code === 'timeout') {
    app.child.kill();
    throw new Error('Chord did not quit within 15 s');
  }
  expect(code).toBe(0);
}

const isShell = (url: string) => url === 'chord://shell/';
const isOverlay = (url: string) => url.startsWith('chord://overlay/');
const isSettings = (url: string) => url.startsWith('chord://settings/');
const isMini = (url: string) => url.startsWith('chord://mini/');

let site: { server: Server; origin: string };
test.beforeAll(async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>Smoke page</title><p>Served from the test.</p>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

test('the packaged app browses, opens Settings, and restores tabs after a relaunch', async () => {
  const executable = packagedExecutable();
  expect(existsSync(executable), `${executable} exists (run pnpm package:dir first)`).toBe(true);
  const profile = mkdtempSync(join(tmpdir(), 'chord-packaged-'));
  const page = `${site.origin}/smoke`;

  let app = await start(executable, profile);
  try {
    const shell = await pageWhere(app.browser, isShell);
    const overlay = await pageWhere(app.browser, isOverlay);
    const today = shell.getByRole('tree', { name: 'Unpinned tabs' });
    // The bundled typeface loads from inside the asar.
    await expect(shell.getByText('Personal')).toBeVisible();
    const onestLoaded = () => shell.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Onest' && f.status === 'loaded'));
    await expect.poll(onestLoaded).toBe(true);

    // A tab loads a local page.
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    // Fill rather than type: keys sent before the field has focus would be lost.
    const address = overlay.getByRole('combobox');
    await address.fill(page);
    await expect(overlay.getByRole('option').first()).toContainText(page);
    await address.press('Enter');
    // A cold packaged app's first page load can take a while on a shared CI machine.
    await expect(today).toContainText('Smoke page', { timeout: 15_000 });
    const tab = await pageWhere(app.browser, (url) => url === page);
    expect(await tab.title()).toBe('Smoke page');

    // Settings opens in its own window; a change there should survive the relaunch.
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app.browser, isSettings);
    await settings.getByRole('radio', { name: /Kagi/ }).click();
    await expect(settings.getByRole('radio', { name: /Kagi/ })).toHaveAttribute('aria-checked', 'true');

    await quit(app, shell);
  } catch (error) {
    app.child.kill();
    throw error;
  }

  // Same profile: chord-data (a utility process inside the asar, on node:sqlite) restores it.
  app = await start(executable, profile);
  try {
    const shell = await pageWhere(app.browser, isShell);
    const today = shell.getByRole('tree', { name: 'Unpinned tabs' });
    await expect(today).toContainText('Smoke page', { timeout: 15_000 });
    await expect(today.getByRole('treeitem', { name: 'Smoke page', exact: true })).toHaveAttribute('aria-selected', 'true');
    await pageWhere(app.browser, (url) => url === page);
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app.browser, isSettings);
    await expect(settings.getByRole('radio', { name: /Kagi/ })).toHaveAttribute('aria-checked', 'true');
    await quit(app, shell);
  } catch (error) {
    app.child.kill();
    throw error;
  }
});

test('links handed over by the OS open in mini windows, at launch and in a running Chord', async () => {
  const executable = packagedExecutable();
  const profile = mkdtempSync(join(tmpdir(), 'chord-packaged-'));
  // The way the Windows registration launches Chord (build/installer.nsh).
  const app = await start(executable, profile, ['--single-argument', `${site.origin}/from-launch`]);
  try {
    // Launched for a link: its mini window, and nothing else (DESIGN.md §7.9).
    await pageWhere(app.browser, isMini);
    await pageWhere(app.browser, (url) => url === `${site.origin}/from-launch`);
    expect(pages(app.browser).some((p) => isShell(p.url()))).toBe(false);

    // A second launch with the same profile hands its link to the running Chord and exits: another mini window.
    const second = spawn(executable, [`--user-data-dir=${profile}`, ...keychainArgs, '--single-argument', `${site.origin}/from-second`], { env: childEnv(), stdio: 'ignore' });
    const code = await new Promise<number | null>((done) => second.once('exit', (c) => done(c)));
    expect(code).toBe(0);
    await pageWhere(app.browser, (url) => url === `${site.origin}/from-second`);
    await expect.poll(() => pages(app.browser).filter((p) => isMini(p.url())).length).toBe(2);

    // "Open in" moves a mini window's page into a chord: Chord's window comes back with it as a tab.
    const bars = pages(app.browser).filter((p) => isMini(p.url()));
    const urlOf = (bar: Page) => bar.evaluate(() => (window as unknown as { chord: { mini: { state(): Promise<{ url: string }> } } }).chord.mini.state().then((s) => s.url));
    const bar = (await urlOf(bars[0]!)) === `${site.origin}/from-second` ? bars[0]! : bars[1]!;
    await bar.getByRole('button', { name: /^Open in/ }).click();
    const shell = await pageWhere(app.browser, isShell);
    await expect(shell.getByRole('tree', { name: 'Unpinned tabs' }).getByRole('treeitem').first()).toContainText('Smoke page');
    await expect.poll(() => pages(app.browser).filter((p) => isMini(p.url())).length).toBe(1);

    // A packaged build can be the default browser, so Settings offers it (not clicked here: that asks the OS).
    await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
    const settings = await pageWhere(app.browser, isSettings);
    await expect(settings.getByText(/^(Make Chord your default browser|Chord is your default browser)$/)).toBeVisible();
    await quit(app, shell);
  } catch (error) {
    app.child.kill();
    throw error;
  }
});

test('macOS: a build the keychain has never seen loads pages without asking', async () => {
  test.skip(process.platform !== 'darwin', 'the keychain prompt is macOS-only');
  const executable = packagedExecutable();
  // The next build, as the keychain sees it: the same app with a new ad-hoc signature.
  const copy = join(mkdtempSync(join(tmpdir(), 'chord-resigned-')), 'Chord.app');
  execFileSync('cp', ['-Rc', resolve(executable, '../../..'), copy]);
  execFileSync('plutil', ['-insert', 'ChordTestBuild', '-string', randomUUID(), join(copy, 'Contents', 'Info.plist')]);
  // Not the flags: on a Developer ID build they include the hardened runtime, whose library
  // validation would refuse an ad-hoc app loading frameworks signed by Chord's team.
  execFileSync('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', copy]);
  try {
    // One build after the other in the same account, as an update would run them.
    for (const build of [executable, join(copy, 'Contents', 'MacOS', 'Chord')]) {
      const app = await start(build, mkdtempSync(join(tmpdir(), 'chord-packaged-')), ['--single-argument', `${site.origin}/keychain`]);
      try {
        // Launched for a link, Chord opens it in a mini window (DESIGN.md §7.9), not its own window.
        const bar = await pageWhere(app.browser, isMini);
        const tab = await pageWhere(app.browser, (url) => url === `${site.origin}/keychain`);
        await expect.poll(() => tab.title()).toBe('Smoke page');
        // Quitting goes through Chord's window: "Open in" brings it back, with the page as a tab.
        await bar.getByRole('button', { name: /^Open in/ }).click();
        const shell = await pageWhere(app.browser, isShell);
        await quit(app, shell);
      } catch (error) {
        app.child.kill();
        throw error;
      }
    }
  } finally {
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

/* ---------- Outside agents (S18 M1b) ---------- */

/** `Chord mcp` as an agent starts it: its stdio, one JSON-RPC message a line (Electron may write a blank line first). */
function mcpClient(executable: string, profile: string, extra: string[] = []) {
  const args = [`--user-data-dir=${profile}`, ...(process.platform === 'linux' ? ['--ozone-platform=headless'] : []), ...extra, 'mcp'];
  const child = spawn(executable, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, (m: { result: Record<string, unknown> }) => void>();
  let buffer = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { id: number; result: Record<string, unknown> };
      waiting.get(m.id)?.(m);
    }
  });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<{ result: Record<string, unknown> }>((done) => {
      const n = ++id;
      waiting.set(n, done);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return { child, exited, request };
}

/** Where a packaged `Chord mcp` keeps its own files (main/agents/relay-folder.ts). */
function relayFolderFor(): string {
  const env = process.env;
  if (process.platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Chord MCP');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'Chord MCP');
  if (env['XDG_RUNTIME_DIR']) return join(env['XDG_RUNTIME_DIR'], 'chord-mcp');
  return join(env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'Chord MCP');
}

/**
 * A process's memory and its children. `mb`: Windows' working set, Linux's resident set, macOS's physical footprint
 * (what Activity Monitor shows: RSS there also counts the system frameworks every app maps, which aren't this
 * process's own). `rss`: its resident set everywhere. `children`: what each child is (its `--type`, else its name).
 */
function processInfo(pid: number): { mb: number; rss: number; children: string[] } {
  if (process.platform === 'win32') {
    const ps = `$p = Get-Process -Id ${pid}; $c = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.CommandLine }); "$($p.WorkingSet64)"; $c`;
    const [bytes, ...children] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim().split(/\r?\n/);
    const mb = Number(bytes) / 2 ** 20;
    return { mb, rss: mb, children: children.filter(Boolean).map(kindOf) };
  }
  if (process.platform === 'linux') {
    const kb = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
    // From /proc, since the Fedora .rpm container has no ps. The parent pid is the 2nd field after the command name,
    // which sits in parentheses (and may hold spaces).
    const children = readdirSync('/proc')
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
          return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid;
        } catch {
          return false;
        }
      })
      .map((d) => {
        try {
          return kindOf(readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' '));
        } catch {
          return '?';
        }
      });
    return { mb: kb / 1024, rss: kb / 1024, children };
  }
  const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
  const children = execFileSync('ps', ['-A', '-o', 'ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[1]) === pid)
    .map((m) => kindOf(m[2]!));
  // vmmap's summary: "Physical footprint:   45.2M".
  const summary = execFileSync('vmmap', ['-summary', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const footprint = /Physical footprint:\s+([\d.]+)([KMG])/.exec(summary);
  const mb = footprint ? Number(footprint[1]) * { K: 1 / 1024, M: 1, G: 1024 }[footprint[2] as 'K' | 'M' | 'G'] : rss;
  return { mb, rss, children };
}

/** A child process as Chromium names it (`--type=zygote`), else its program. */
const kindOf = (command: string): string => /--type=(\S+)/.exec(command)?.[1] ?? command.trim().split(/\s+/)[0] ?? '?';

test('Chord mcp: the relay alone answers fast, in one process, with no window and nothing written to the profile', async () => {
  const executable = packagedExecutable();
  const profile = mkdtempSync(join(tmpdir(), 'chord-packaged-'));
  const hello = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328' } };
  // Start to the initialize answer, as M0 measured it: one start to warm up (a new build's first is the OS scanning it), then the median of five.
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const run = mcpClient(executable, profile);
    await run.request('initialize', hello);
    if (i > 0) times.push(performance.now() - t0);
    run.child.stdin!.end();
    await run.exited;
  }
  const initializeMs = times.sort((a, b) => a - b)[2]!;
  const mcp = mcpClient(executable, profile);
  try {
    const init = await mcp.request('initialize', hello);
    expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'chord' }, capabilities: { tools: { listChanged: true } } });
    expect(((await mcp.request('tools/list', {})).result['tools'] as unknown[]).length).toBe(8);
    // Settled: one process (GPU and network service in-process), within its memory budget.
    await new Promise((done) => setTimeout(done, 1000));
    const { mb, rss, children } = processInfo(mcp.child.pid!);
    console.log(`Chord mcp: initialize ${Math.round(initializeMs)} ms (median of ${times.map(Math.round).join(', ')}), ${Math.round(mb)} MB (resident ${Math.round(rss)} MB), child processes: ${children.length ? children.join(', ') : 'none'}`);
    // #90's measurement: on Linux, without Chromium's zygotes (which need the sandbox off), for comparison.
    if (process.platform === 'linux') {
      const bare = mcpClient(executable, profile, ['--no-zygote', '--no-sandbox']);
      await bare.request('initialize', hello);
      await new Promise((done) => setTimeout(done, 1000));
      const without = processInfo(bare.child.pid!);
      console.log(`Chord mcp with --no-zygote --no-sandbox: ${Math.round(without.mb)} MB, child processes: ${without.children.length ? without.children.join(', ') : 'none'}`);
      bare.child.stdin!.end();
      await bare.exited;
    }
    // Held on Windows, where M0 measured them. Measuring the others now (#90).
    if (process.platform === 'win32') {
      expect(children).toEqual([]);
      expect(mb).toBeLessThanOrEqual(90);
    }
    // The budget is CI Windows' (S18 M1 plan): elsewhere it's reported.
    if (process.env['CI'] && process.platform === 'win32') expect(initializeMs).toBeLessThanOrEqual(250);
    const call = await mcp.request('tools/call', { name: 'list_tabs', arguments: {} });
    expect(call.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Chord isn’t open. Ask the user to open Chord, then call this tool again.' }] });
    // Nothing written to the profile it reads: its own files go in a folder of the user's own, never a shared one in /tmp.
    expect(readdirSync(profile)).toEqual([]);
    const own = relayFolderFor();
    expect(existsSync(own), own).toBe(true);
    if (process.platform !== 'win32') expect(statSync(own).mode & 0o777).toBe(0o700);
    mcp.child.stdin!.end();
    expect(await mcp.exited).toBe(0);
  } finally {
    mcp.child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Chord mcp holds no lock; a packaged Chord serves agents only with Settings → Agents on (and only once AGENTS_RELEASED), and no hook lets one in', async () => {
  const executable = packagedExecutable();
  const profile = mkdtempSync(join(tmpdir(), 'chord-packaged-'));
  const first = await start(executable, profile);
  try {
    await quit(first, await pageWhere(first.browser, isShell));
  } catch (error) {
    first.child.kill();
    throw error;
  }
  const agentsSetting = (value?: string) => {
    const db = new DatabaseSync(join(profile, 'chord.db'));
    try {
      if (value) db.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('agentsEnabled', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
      return (db.prepare("SELECT value FROM setting WHERE key = 'agentsEnabled'").get() as { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  };
  /** Chord on that profile with the old development switches set: neither does anything in a packaged build. */
  const startAsked = () => {
    process.env['CHORD_AGENTS'] = '1';
    process.env['CHORD_AGENT_APPROVE'] = 'always';
    return start(executable, profile).finally(() => {
      delete process.env['CHORD_AGENTS'];
      delete process.env['CHORD_AGENT_APPROVE'];
    });
  };
  const notOpen = { isError: true, content: [{ type: 'text', text: 'Chord isn’t open. Ask the user to open Chord, then call this tool again.' }] };
  const mcp = mcpClient(executable, profile);
  try {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } });
    // Off (the default): no lock, so a Chord starts on that profile as if the relay weren't there, and serves nothing.
    expect(['false', undefined]).toContain(agentsSetting());
    let app = await startAsked();
    try {
      const shell = await pageWhere(app.browser, isShell);
      await expect(shell.getByText('Personal')).toBeVisible();
      expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
      expect((await mcp.request('tools/call', { name: 'list_tabs', arguments: {} })).result).toMatchObject(notOpen);
      await quit(app, shell);
    } catch (error) {
      app.child.kill();
      throw error;
    }
    // On, as Settings → Agents saves it: one endpoint, and the agent's first call shows the card (no hook answers it).
    expect(agentsSetting('true')).toBe('true');
    app = await startAsked();
    try {
      const shell = await pageWhere(app.browser, isShell);
      await expect(shell.getByText('Personal')).toBeVisible();
      if (!AGENTS_RELEASED) {
        // Before 0.14.0 a packaged Chord has no Agents: the saved setting serves nothing, and Settings has no Agents section.
        expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
        expect((await mcp.request('tools/call', { name: 'list_tabs', arguments: {} })).result).toMatchObject(notOpen);
        await shell.evaluate(() => (window as unknown as { chord: { action: { run(a: string): Promise<void> } } }).chord.action.run('app.settings'));
        const settings = await pageWhere(app.browser, isSettings);
        const nav = settings.getByRole('navigation', { name: 'Settings sections' });
        await expect(nav.getByRole('button', { name: 'About', exact: true })).toBeVisible();
        await expect(nav.getByRole('button', { name: 'Agents', exact: true })).toHaveCount(0);
        expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
        await quit(app, shell);
        return;
      }
      await expect.poll(() => existsSync(join(profile, 'agent-endpoint.json'))).toBe(true);
      const call = mcp.request('tools/call', { name: 'list_tabs', arguments: {} });
      const popover = await pageWhere(app.browser, (url) => url === 'chord://popover/');
      await expect(popover.getByRole('alertdialog', { name: 'Codex wants to use Chord' })).toBeVisible({ timeout: 15_000 });
      await quit(app, shell);
      // Quitting takes the card down unanswered: the agent was never let in.
      expect((await call).result).toMatchObject({ isError: true });
    } catch (error) {
      app.child.kill();
      throw error;
    }
    expect(existsSync(join(profile, 'agent-endpoint.json'))).toBe(false);
  } finally {
    mcp.child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});
