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
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** `args` go last: a link the OS hands over comes after --single-argument, which takes the rest of the line. */
async function start(executable: string, profile: string, args: string[] = []): Promise<Running> {
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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
    const today = shell.getByRole('list', { name: 'Today' });
    // The bundled typeface loads from inside the asar.
    await expect(shell.getByText('Personal')).toBeVisible();
    const onestLoaded = () => shell.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Onest' && f.status === 'loaded'));
    await expect.poll(onestLoaded).toBe(true);

    // A tab loads a local page.
    await shell.evaluate(() => (window as unknown as { chord: { overlay: { open(m: string): Promise<void> } } }).chord.overlay.open('new'));
    await expect(overlay.getByRole('dialog')).toBeVisible();
    // Fill rather than type: keys sent before the field has focus would be lost.
    const address = overlay.getByRole('textbox');
    await address.fill(page);
    await expect(overlay.getByRole('option').first()).toContainText(page);
    await address.press('Enter');
    await expect(today).toContainText('Smoke page');
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
    const today = shell.getByRole('list', { name: 'Today' });
    await expect(today).toContainText('Smoke page');
    await expect(today.getByRole('button', { name: 'Smoke page', exact: true })).toHaveAttribute('aria-current', 'page');
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
    const second = spawn(executable, [`--user-data-dir=${profile}`, '--single-argument', `${site.origin}/from-second`], { env: childEnv(), stdio: 'ignore' });
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
    await expect(shell.getByRole('list', { name: 'Today' }).getByRole('listitem').first()).toContainText('Smoke page');
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
