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

/** The shop's results (M2c): a button that says it worked, one under a banner, a list of choices. */
const shopResults = (q: string) =>
  `<title>Results</title><main><h1>Results for ${q}</h1>` +
  '<button onclick="document.getElementById(\'log\').textContent = \'return started\'">Start a return</button><p id=log></p>' +
  '<div style="position:relative;inline-size:200px"><button>Under the banner</button><div role=dialog aria-label="Cookie settings" style="position:absolute;inset:-4px;background:white">Cookies</div></div>' +
  '<label>Shipping <select onchange="document.getElementById(\'log\').textContent = \'shipping \' + this.value"><option>Standard</option><option>Express</option><option>Pickup</option><option>Pickup</option><optgroup label="Later" disabled><option>Overnight</option></optgroup></select></label>' +
  // Review 1 of #110: a field that sends the focus to a password field; one the page turns into a password field; a
  // clickable element under its own frame.
  '<input aria-label="Gift message" onfocus="document.getElementById(\'pw\').focus()"> <input type=password id=pw aria-label="Password">' +
  '<input aria-label="Nickname" id=nick> <button onclick="document.getElementById(\'nick\').type = \'password\'">Lock nickname</button>' +
  '<div role=button tabindex=0 style="position:relative;inline-size:160px;block-size:40px">Framed offer<iframe title="Ad" srcdoc="ad" style="position:absolute;inset:0;inline-size:100%;block-size:100%;border:0"></iframe></div>' +
  // Review 2 of #110: a button that, when the pointer comes over it, puts a frame over itself (the frame would get the
  // click: the last hit test must wait for the pointer's move to have reached the page).
  '<div role=button tabindex=0 style="inline-size:160px;block-size:40px" onclick="document.getElementById(\'log\').textContent = \'hover deal clicked\'" ' +
  'onmouseenter="const r = this.getBoundingClientRect(), f = document.createElement(\'iframe\'); f.title = \'Popup\'; f.srcdoc = \'x\'; ' +
  'f.style.cssText = \'position:absolute;border:0;left:\' + (r.left + scrollX) + \'px;top:\' + (r.top + scrollY) + \'px;width:\' + r.width + \'px;height:\' + r.height + \'px\'; document.body.append(f)">Hover deal</div>' +
  // Review 3 of #110: a button the page swallows pointer moves over (its own capture listener, put first): the move is
  // never seen, so the click fails closed.
  '<button id=sticky onclick="document.getElementById(\'log\').textContent = \'sticky deal clicked\'">Sticky deal</button>' +
  // Review 4: one button clicked twice at one point; one that, clicked, puts another in its place, over which the page
  // swallows moves too (so the move to it is never seen: only the last one, over the button gone, was).
  '<button style="inline-size:160px;block-size:40px" onclick="this.dataset.n = Number(this.dataset.n || 0) + 1; document.getElementById(\'log\').textContent = \'counted \' + this.dataset.n">Count</button>' +
  '<button style="inline-size:160px;block-size:40px" onclick="swapDeal(this)">Swap</button>' +
  '<script>addEventListener(\'mousemove\', (e) => { if (String(e.target.id).startsWith(\'sticky\')) e.stopImmediatePropagation(); }, true);' +
  'function swapDeal(old) { const b = document.createElement(\'button\'); b.id = \'sticky-b\'; b.textContent = \'Swapped deal\'; b.style.cssText = old.style.cssText; ' +
  'b.onclick = () => { document.getElementById(\'log\').textContent = \'swapped deal clicked\'; }; old.replaceWith(b); }</script></main>';

/** A ref from a snapshot's outline, by its line's start (`button "Start a return"`). */
const refOf = (outline: string, line: string) => {
  const found = outline.split('\n').find((l) => l.trim().startsWith(`- ${line} [ref=`));
  if (!found) throw new Error(`No "${line}" in\n${outline}`);
  return /\[ref=(e\d+)\]/.exec(found)![1]!;
};

/* ---------- Acting (S18 M2c) ---------- */

const siteCardOf = (popover: Page, name: string) => popover.getByRole('alertdialog', { name: new RegExp(`^Let ${name} click and type on `) });

test('acting: an agent types, clicks and chooses in its own tab; the first action on the site asks; refs go stale; a covered element is named (M2c)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/shop` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    // Its tab on screen, so its bar shows.
    await shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Shop/ }).click();
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const front = await snap();
    const search = refOf(front, 'searchbox "Search orders"');

    // The first action on the site asks: what it wants to do, in Chord's words; Codex was let in once, so no Always.
    const typing = mcp.call('type', { tab_id: 'a1', ref: search, text: 'wool', submit: true });
    const popover = await pageWhere(app, isPopover);
    const card = siteCardOf(popover, 'Codex');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`Let Codex click and type on 127.0.0.1:${new URL(site.origin).port}?`);
    await expect(card).toContainText('It wants to type in “Search orders”.');
    await expect(card.getByRole('button', { name: 'Always on this site' })).toHaveCount(0);
    await popover.waitForTimeout(600);
    await card.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const typed = JSON.parse((await typing).text) as { data: { done: string; navigated: boolean; url: string } };
    expect(typed.data).toMatchObject({ done: 'Typed in “Search orders”', navigated: true });
    expect(typed.data.url).toBe(`${site.origin}/shop/results?q=wool`);

    // The page changed: the front page's refs are stale.
    expect((await mcp.call('click', { tab_id: 'a1', ref: search })).text).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    const results = await snap();
    // On the same site, no card again; the bar says what it's doing.
    const clicked = await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Start a return"') });
    expect(JSON.parse(clicked.text)).toMatchObject({ data: { done: 'Clicked “Start a return”', navigated: false } });
    await expect(shell.getByRole('status').filter({ hasText: 'Codex is clicking “Start a return”' })).toBeVisible();
    await expect(siteCardOf(popover, 'Codex')).toHaveCount(0);
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content).toContain('return started');
    // Covered: nothing is sent, and the agent hears what covers it.
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Under the banner"') })).text).toBe('Something is covering that element: dialog “Cookie settings”. Deal with it first, or call snapshot again.');
    // Review 1 of #110. The focus sent to a password field: nothing typed. A field turned into a password field after
    // the snapshot: nothing typed. A click that would land on a frame: refused, by the frame's title. A choice the page
    // doesn't have: refused, never quoted back.
    expect((await mcp.call('type', { tab_id: 'a1', ref: refOf(results, 'textbox "Gift message"'), text: 'typed-into-the-wrong-field' })).text).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Lock nickname"') })).text)).toMatchObject({ data: { done: 'Clicked “Lock nickname”' } });
    expect((await mcp.call('type', { tab_id: 'a1', ref: refOf(results, 'textbox "Nickname"'), text: 'typed-into-a-password' })).text).toBe('That field is now a password, code or card field: the user fills it. Ask them to.');
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Framed offer"') })).text).toBe('Something is covering that element: frame “Ad”. Deal with it first, or call snapshot again.');
    expect((await mcp.call('select_option', { tab_id: 'a1', ref: refOf(results, 'combobox "Shipping"'), option: 'Free, trust me' })).text).toBe('That list has no such choice. Call snapshot for its choices.');
    // Review 2 of #110: a frame put over the button by its mouseenter handler, when the pointer came: refused, nothing
    // clicked. A choice in a disabled group isn't one; two choices by one name, neither.
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Hover deal"') })).text).toBe('Something is covering that element: frame “Popup”. Deal with it first, or call snapshot again.');
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content).not.toContain('hover deal clicked');
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Sticky deal"') })).text).toBe('The page didn’t see the pointer arrive, so nothing was clicked. Call snapshot again, then try once more.');
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content).not.toContain('sticky deal clicked');
    // Review 4: twice at one point, both clicks go in; a button that took another's place at the point, with the move
    // to it never seen, is refused (the last move seen there was over the one gone).
    const content = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Count"') })).text)).toMatchObject({ data: { done: 'Clicked “Count”' } });
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Count"') })).text)).toMatchObject({ data: { done: 'Clicked “Count”' } });
    expect(await content()).toContain('counted 2');
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(results, 'button "Swap"') })).text)).toMatchObject({ data: { done: 'Clicked “Swap”' } });
    const swapped = await snap();
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(swapped, 'button "Swapped deal"') })).text).toBe('The page didn’t see the pointer arrive, so nothing was clicked. Call snapshot again, then try once more.');
    expect(await content()).not.toContain('swapped deal clicked');
    expect((await mcp.call('select_option', { tab_id: 'a1', ref: refOf(swapped, 'combobox "Shipping"'), option: 'Overnight' })).text).toBe('That list has no such choice. Call snapshot for its choices.');
    expect((await mcp.call('select_option', { tab_id: 'a1', ref: refOf(swapped, 'combobox "Shipping"'), option: 'Pickup' })).text).toBe('That list has more than one choice by that name, so nothing was chosen. Ask the user to choose.');
    // A choice by its label.
    const chose = await mcp.call('select_option', { tab_id: 'a1', ref: refOf(swapped, 'combobox "Shipping"'), option: 'Express' });
    expect(JSON.parse(chose.text)).toMatchObject({ data: { done: 'Chose “Express” in “Shipping”' } });
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content).toContain('shipping Express');
    // Somewhere else, and back.
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/shop` })).text)).toMatchObject({ data: { done: `Went to 127.0.0.1:${new URL(site.origin).port}/shop`, navigated: true } });
    expect(JSON.parse((await mcp.call('back', { tab_id: 'a1' })).text)).toMatchObject({ data: { done: 'Went back', navigated: true, url: `${site.origin}/shop/results?q=wool` } });
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Always on this site: offered to an agent you always allow, kept, listed in Settings; Remove there makes it ask again (M2c)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    const opening = mcp.call('open_tab', { url: `${site.origin}/shop` });
    await answer(app, 'Claude Code', 'Always allow');
    await opening;
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const host = `127.0.0.1:${new URL(site.origin).port}`;
    const clicking = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'link "All orders"') });
    const popover = await pageWhere(app, isPopover);
    const card = siteCardOf(popover, 'Claude Code');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await card.getByRole('button', { name: 'Always on this site' }).click();
    expect(JSON.parse((await clicking).text)).toMatchObject({ data: { done: 'Clicked “All orders”', navigated: true } });
    // Settings → Agents lists it under the agent, with Remove.
    const settings = await agentsSettings(app, shell);
    const sites = settings.getByRole('group', { name: 'Sites Claude Code can click and type on' });
    await expect(sites).toContainText('Can click and type on');
    await expect(sites).toContainText(host);
    await sites.getByRole('button', { name: `Remove ${host} for Claude Code` }).click();
    await expect(sites).toContainText('Asks before acting on any site.');
    // It asks again there, mid-task too: a no this time, which lasts.
    const again = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Start a return"') });
    await expect(siteCardOf(popover, 'Claude Code')).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCardOf(popover, 'Claude Code').getByRole('button', { name: 'Deny', exact: true }).click();
    expect((await again).text).toBe(`The user didn’t let you act on ${host}. Don’t act there again unless the user asks you to.`);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A list of rows of links, buttons and text: `rows` of 5 elements each. */
const rowsPage = (rows: number) =>
  `<title>Rows</title><main><h1>Rows</h1><ul>${Array.from({ length: rows }, (_, i) => `<li><a href="/r${i}">Row ${i}</a> <span>Note ${i}</span> <button>Act ${i}</button></li>`).join('')}</ul></main>`;

test('acting: what a page hides from scripts, its own capture listeners, file inputs, and your click (Neon’s review of #110)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/neon` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const inPage = (code: string) =>
      app.evaluate(({ webContents }, [url, js]) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(url))!.executeJavaScript(js), [`${site.origin}/neon`, code] as const);
    // Your focus, before the agent acts (it must stay where it is: the agent's tab is parked, off screen).
    const focused = () => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null);
    // Yours: the window's own page has it (as when you're in the address bar).
    const yours = shell.url();
    await expect
      .poll(async () => {
        await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.focus(), yours);
        return focused();
      })
      .toBe(yours);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const outline = await snap();

    // File inputs, and a label that opens one, get no ref.
    expect.soft(outline).not.toMatch(/button "Upload" \[ref=/);
    expect.soft(outline).not.toMatch(/"Choose a photo" \[ref=/);

    // The first action asks the site card.
    const first = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Closed deal"') });
    const popover = await pageWhere(app, isPopover);
    const card = siteCardOf(popover, 'Codex');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await card.getByRole('button', { name: 'Allow for now', exact: true }).click();
    // A closed root's frame, under the point once the pointer moved there: refused, nothing clicked.
    expect.soft((await first).text).toBe('Something is covering that element: frame “Inner ad”. Deal with it first, or call snapshot again.');

    // A text box whose closed root sends the focus to a password field: nothing typed.
    const notes = await mcp.call('type', { tab_id: 'a1', ref: refOf(await snap(), 'textbox "Notes box"'), text: 'typed-into-a-closed-password' });
    expect.soft(notes.text).toBe('Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.');
    expect.soft(await inPage('window.__secret.value')).toBe('');

    // A key whose own capture listener (put first) sends it to a password field, unseen after: nothing goes in.
    const coupon = await mcp.call('press_key', { tab_id: 'a1', ref: refOf(await snap(), 'textbox "Coupon"'), key: 'Space' });
    expect.soft(coupon.text).toBe('The page moved the focus away from that field, so nothing was typed. Call snapshot again.');
    expect.soft(await inPage('document.getElementById("pw2").value')).toBe('');

    // A button that opens a file input, the input's click kept from Chord's own listener: the picker is held.
    const attach = await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Open attachments"') });
    // Held by the preload's listener, now the window's first (reported with a result, as a dialog is), or by the
    // debugger's interception (in the action's own result): either way no picker, and the agent hears of it.
    const heard = [attach.text, ...attach.held, ...(await mcp.call('list_tabs')).held].join(' ');
    expect.soft(heard).toMatch(/a file input|a file picker/);
    // Held, wherever the picker comes from, for the tab's whole life (agents/pickers.ts' interception, the preload's
    // holds in every frame): one in a closed root; one a page opens 1.5 s after the click (on the activation it gave);
    // a srcdoc frame's input and its File System Access picker. Each is heard by the agent.
    const heldSoFar: string[] = [];
    const heardOf = async (what: RegExp) => {
      await expect
        .poll(async () => {
          heldSoFar.push(...(await mcp.call('list_tabs')).held);
          return heldSoFar.join(' | ');
        }, { timeout: 10_000 })
        .toMatch(what);
      heldSoFar.length = 0;
    };
    // A click inside a closed root isn't made at all (#112: what it is can't be classified there).
    expect.soft((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Closed upload"') })).text).toBe('Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.');
    for (const button of ['Late upload', 'Late closed upload', 'Frame upload']) {
      const clicked = await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), `button "${button}"`) });
      expect.soft(clicked.isError, button).toBe(false);
      heldSoFar.push(...clicked.held);
      await heardOf(/a file (picker|input)/);
    }
    const framePicker = await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Frame picker"') });
    heldSoFar.push(...framePicker.held);
    await heardOf(/showOpenFilePicker/);

    // A button in a shadow root, clicked twice at one point: both clicks go in (the second's pointer moved off and back).
    for (let i = 0; i < 2; i++) expect.soft(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Step up"') })).text)).toMatchObject({ data: { done: 'Clicked “Step up”' } });
    expect.soft(await inPage('document.getElementById("log").textContent')).toContain('stepped 2');

    // A fresh frame with no address, its File System Access picker asked for right after it's put in: refused, never
    // shown (the promise settles; a picker on screen would leave it waiting).
    await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Fresh frame picker"') });
    await expect.soft.poll(() => inPage('document.getElementById("log").textContent'), { timeout: 10_000 }).toMatch(/refused \w+/);

    expect.soft(await focused(), 'after the pickers and the stepper').toBe(yours);
    // Keys whose keydown moves the focus (Tab) or goes somewhere (Enter on a link): done, as they are.
    await mcp.call('open_tab', { url: `${site.origin}/keys` });
    // The agent's new tab, parked behind your page, leaves your focus where it was, or gives it back within a moment
    // (window.ts' park: the OS can hand a view just shown the window's focus).
    await expect.soft.poll(focused, { message: 'after open_tab', timeout: 2000 }).toBe(yours);
    const keys = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a2' })).text) as { content: string }).content;
    const tabbed = await mcp.call('press_key', { tab_id: 'a2', ref: refOf(keys, 'textbox "First"'), key: 'Tab' });
    expect.soft(tabbed.isError, tabbed.text).toBe(false);
    expect.soft(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.activeElement.getAttribute("aria-label")'), `${site.origin}/keys`)).toBe('Second');
    expect.soft(await focused(), 'after Tab').toBe(yours);
    const entered = await mcp.call('press_key', { tab_id: 'a2', ref: refOf(keys, 'link "Onward"'), key: 'Enter' });
    expect.soft(entered.isError, entered.text).toBe(false);
    expect.soft(JSON.parse(entered.text)).toMatchObject({ data: { navigated: true, url: `${site.origin}/act` } });
    expect.soft(await focused(), 'after Enter on a link').toBe(yours);

    // Your focus never moved to the agent's tab.
    expect.soft(await focused()).toBe(yours);

    // Chord not in front while the agent acts: nothing is focused for you then (that would bring Chord forward), and
    // coming back to Chord, your page has the focus, never the agent's (window.ts' keepFocusOffParked).
    const inFront = (front: boolean) => app.evaluate(({ BaseWindow }, f) => { const w = BaseWindow.getAllWindows()[0]!; if (f) w.focus(); else w.blur(); }, front);
    await inFront(false);
    await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Step up"') });
    await inFront(true);
    await expect.soft.poll(focused, { message: 'coming back to Chord', timeout: 3000 }).toBe(yours);

    // Your click in its tab pauses it there, as a key does (shown over your chord, so its bar shows).
    await shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Neon/ }).click();
    await app.evaluate(({ webContents }, url) => {
      const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith(url))!;
      c.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
      c.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
    }, `${site.origin}/neon`);
    await expect.soft(shell.getByRole('status').filter({ hasText: 'Paused while you use this tab' })).toBeVisible();
    mcp.child.stdin!.end();
    await mcp.exited;
    // Kept: its page is made again as a tab of yours (core's keepAgentTab), with none of the agent's settings: no held
    // dialogs (alert shows Chord's own, not answered at once), the preload's agent guard gone, no debugger.
    await shell.getByRole('button', { name: 'Keep', exact: true }).click();
    const settingsOf = () =>
      app.evaluate(async ({ webContents }, url) => {
        const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith(url) && !x.isDestroyed());
        if (!c) return null;
        return { guard: await c.executeJavaScriptInIsolatedWorld(999, [{ code: 'typeof globalThis.__chordAgentGuard' }]), debugger: c.debugger.isAttached() };
      }, `${site.origin}/neon`);
    await expect.poll(settingsOf, { timeout: 15_000 }).toEqual({ guard: 'undefined', debugger: false });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

const stepCardOf = (popover: Page, title: RegExp) => popover.getByRole('alertdialog', { name: title });

test('risky steps: the step card every time, Show me, Don’t and Allow; the page’s tricks still ask; a search doesn’t (M2d)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/checkout` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const host = new URL(site.origin).host;
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const popover = await pageWhere(app, isPopover);
    /** Calls a tool, then answers the step card that shows (title), and returns the call's result. */
    const withStep = async (call: Promise<{ text: string; isError: unknown }>, title: RegExp, button: 'Allow' | 'Don’t') => {
      const card = stepCardOf(popover, title);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await popover.waitForTimeout(600);
      await card.getByRole('button', { name: button, exact: true }).click();
      return call;
    };
    const STEP_NO = 'The user said no to this step. Don’t try it another way; ask the user what to do.';
    const sendsTo = new RegExp(`^Send data to ${host.replace(/\./g, '\\.')}\\?$`);

    // The first action on the site: the site card (it still asks before risky steps, it says), then the step card.
    let outline = await snap();
    const placing = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Place order · $48.20"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await expect(siteCard).toContainText('It asks before anything it does sends data, and before it submits, pays, sends or deletes.');
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const order = stepCardOf(popover, new RegExp(`^Place the order on ${host.replace(/\./g, '\\.')}\\?$`));
    await expect(order).toBeVisible({ timeout: 15_000 });
    await expect(order).toContainText('Codex is about to click “Place order · $48.20”.');
    await expect(order).toContainText('Goes with it: Shipping, Gift note, Card number');
    // Show me: the agent's tab over your chord (its bar says it's waiting for you), the card still up.
    await popover.waitForTimeout(600);
    await order.getByRole('button', { name: 'Show me', exact: true }).click();
    await expect(shell.getByRole('status').filter({ hasText: 'Codex is waiting for you' })).toBeVisible();
    await expect(order).toBeVisible();
    // Don't: nothing sent.
    await order.getByRole('button', { name: 'Don’t', exact: true }).click();
    expect((await placing).text).toBe(STEP_NO);
    expect(reached).toEqual([]);
    // Again: the card again (never remembered); Allow: placed once.
    const placed = await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Place order · $48.20"') }), /^Place the order on /, 'Allow');
    expect(JSON.parse(placed.text)).toMatchObject({ data: { done: 'Clicked “Place order · $48.20”', navigated: true } });
    expect(reached).toEqual(['POST /order']);
    await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/checkout` });
    outline = await snap();

    // The page's tricks: each asks, or is stopped before it sends, and nothing reaches the site.
    // A misleading Continue (a form's submit, to /account/close): the card, by what it is.
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Continue"') }), /^Submit this form on /, 'Don’t')).text).toBe(STEP_NO);
    // A JS submit on click: what it sends is held, and the card asks where it goes (the owner's default).
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Next"') }), sendsTo, 'Don’t')).text).toBe(STEP_NO);
    // requestSubmit on a key (Space in a field): the same.
    outline = await snap();
    expect((await withStep(mcp.call('press_key', { tab_id: 'a1', ref: refOf(outline, 'textbox "Notes"'), key: 'Space' }), sendsTo, 'Don’t')).text).toBe(STEP_NO);
    // A link to a delete address, named innocently.
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'link "Item 7"') }), /^Delete this on /, 'Don’t')).text).toBe(STEP_NO);
    // Enter in a one-field form that POSTs, and type with submit there.
    outline = await snap();
    expect((await withStep(mcp.call('press_key', { tab_id: 'a1', ref: refOf(outline, 'textbox "Email"'), key: 'Enter' }), /^Submit this form on /, 'Don’t')).text).toBe(STEP_NO);
    expect((await withStep(mcp.call('type', { tab_id: 'a1', ref: refOf(await snap(), 'textbox "Email"'), text: 'me@example.com', submit: true }), /^Submit this form on /, 'Don’t')).text).toBe(STEP_NO);
    expect(reached).toEqual(['POST /order']);
    // #112 review 1: what the button really does, not what it looks like.
    outline = await snap();
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Look"') }), /^Delete this on /, 'Don’t')).text).toBe(STEP_NO);
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Save"') }), /^Submit this form on /, 'Don’t')).text).toBe(STEP_NO);
    const draft = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Save draft"') });
    await expect(stepCardOf(popover, /^Place the order on /)).toContainText('It reads “Pay $500”.', { timeout: 15_000 });
    expect((await withStep(draft, /^Place the order on /, 'Don’t')).text).toBe(STEP_NO);
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Jetzt kaufen"') }), /^Place the order on /, 'Don’t')).text).toBe(STEP_NO);
    expect(reached).toEqual(['POST /order']);

    // A search: reading, no card; it goes.
    const searched = await mcp.call('type', { tab_id: 'a1', ref: refOf(await snap(), 'searchbox "Search shop"'), text: 'wool', submit: true });
    expect(searched.text, 'the search’s result, not a refusal').toMatch(/^\{/);
    expect(JSON.parse(searched.text)).toMatchObject({ data: { navigated: true } });
    await expect(stepCardOf(popover, /on /)).toHaveCount(0);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a step answered late: waiting, then the Allow counts for that same step once (M2d)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // Cards answer within 8 s here, not 45, so a late answer is quick to show. The connect card waits that long too: at
  // 3 s, CI's macOS arm64 showed it and let its buttons take a click too late (#112), and open_tab came back waiting,
  // with no tab.
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_AGENT_WAIT_MS: '8000' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/checkout` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const item = refOf(outline, 'link "Item 7"');
    const WAITING = /waiting/i;
    // The site card, unanswered: waiting; answered late, the retry takes it.
    expect((await mcp.call('click', { tab_id: 'a1', ref: item })).text).toMatch(WAITING);
    const siteCard = siteCardOf(popover, 'Codex');
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    // The step card, unanswered: waiting; nothing reached the site.
    expect((await mcp.call('click', { tab_id: 'a1', ref: item })).text).toMatch(WAITING);
    expect(reached).toEqual([]);
    const step = stepCardOf(popover, /^Delete this on /);
    await step.getByRole('button', { name: 'Allow', exact: true }).click();
    // Allowed late: the same step, called again, goes without a card; once.
    const went = await mcp.call('click', { tab_id: 'a1', ref: item });
    expect(JSON.parse(went.text)).toMatchObject({ data: { done: 'Clicked “Item 7”', navigated: true } });
    expect(reached).toEqual(['GET /items/7/delete']);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('what an action sends asks first: held, one card, Allow sends and Don’t drops; reports never leave; another site’s frame too (M2d)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/noise` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const popover = await pageWhere(app, isPopover);
    const host = new URL(site.origin).host;
    const third = `localhost:${new URL(site.origin).port}`;
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const STEP_NO = 'The user said no to this step. Don’t try it another way; ask the user what to do.';
    const sendCard = (title: RegExp) => popover.getByRole('alertdialog', { name: title });
    const withCard = async (call: Promise<{ text: string }>, title: RegExp, button: 'Allow' | 'Don’t') => {
      const card = sendCard(title);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await popover.waitForTimeout(600);
      await card.getByRole('button', { name: button, exact: true }).click();
      return call;
    };
    // A frame of another site is named as one, its contents not readable (#112: never an empty node).
    const outline = await snap();
    expect(outline).toContain('- iframe "Sync" [contents not accessible: another site]');
    // The site card, once: a tab that sends nothing but the page's click beacon (dropped, no card).
    const first = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'tab "Details"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await expect(siteCard).toContainText('It asks before anything it does sends data, and before it submits, pays, sends or deletes.');
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await first).text)).toMatchObject({ data: { done: 'Clicked “Details”' } });
    // A toggle that saves (a same-site POST): held, one card; Allow sends it.
    const ownSite = new RegExp(`^Send data to ${host.replace(/\./g, '\\.')}\\?$`);
    const toggled = await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'checkbox "Dark mode"') }), ownSite, 'Allow');
    expect(JSON.parse(toggled.text)).toMatchObject({ data: { done: 'Clicked “Dark mode”' } });
    await expect.poll(() => reached.includes('POST /prefs')).toBe(true);
    // Like: Don't drops it.
    expect((await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Like"') }), ownSite, 'Don’t')).text).toBe(STEP_NO);
    // A frame of another site that sends on the page's word: held from its own process, and the card says where.
    const frameSends = await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Sync"') }), /^Send data to 2 sites\?$|^Send data to localhost/, 'Don’t');
    expect(frameSends.text).toBe(STEP_NO);
    await expect(sendCard(/^Send data to /)).toHaveCount(0);
    // Show more (a GET) and a link with ping: no card.
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Show more"') })).text)).toMatchObject({ data: { done: 'Clicked “Show more”' } });
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'link "Next page"') })).text)).toMatchObject({ data: { done: 'Clicked “Next page”' } });
    // Nothing but the toggle reached the site: no Like, no frame's save, and never a report (beacons, pings).
    await new Promise((r) => setTimeout(r, 500));
    expect(reached.filter((r) => r.startsWith('POST'))).toEqual(['POST /prefs']);
    void third;
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('typing into a field that takes a value: set in its format, never typed into the field before it; text that lands elsewhere is an error (#112, bug 1)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/booking` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const popover = await pageWhere(app, isPopover);
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const ref = (name: string) => refOf(outline, `textbox "${name}"`);
    /** The fields' values, as the page has them, its log, and what has the focus. */
    const values = () =>
      app.evaluate(({ webContents }, path) => {
        const tab = webContents.getAllWebContents().find((w) => w.getURL().endsWith(path));
        return tab!.executeJavaScript('Object.fromEntries([...document.querySelectorAll("input")].map((i) => [i.id, i.value]).concat([["log", log.textContent], ["focus", document.activeElement.id]]))') as Promise<Record<string, string>>;
      }, '/booking');
    // The owner's repro: text into the name (the site card first), then a time, with the name still focused.
    const naming = mcp.call('type', { tab_id: 'a1', ref: ref('Customer name'), text: 'Repro' });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await naming).text)).toMatchObject({ data: { done: 'Typed in “Customer name”' } });
    expect((await values()).focus).toBe('cn');
    expect(JSON.parse((await mcp.call('type', { tab_id: 'a1', ref: ref('Arrival'), text: '18:30' })).text)).toMatchObject({ data: { done: 'Typed in “Arrival”' } });
    let now = await values();
    expect(now).toMatchObject({ cn: 'Repro', t: '18:30' });
    // The page heard it as it hears a person's: input, then change.
    expect(now.log).toContain('input:t change:t');
    // Each other kind, with the name focused again first (a click into it), and the name never changed.
    const rows: [string, string, string][] = [
      ['Day', 'd', '2026-11-23'],
      ['When', 'dt', '2026-11-23T18:30'],
      ['Month', 'm', '2026-11'],
      ['Week', 'w', '2026-W48'],
    ];
    for (const [name, id, value] of rows) {
      expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: ref('Customer name') })).text)).toMatchObject({ data: { done: 'Clicked “Customer name”' } });
      expect((await values()).focus).toBe('cn');
      expect(JSON.parse((await mcp.call('type', { tab_id: 'a1', ref: ref(name), text: value })).text)).toMatchObject({ data: { done: `Typed in “${name}”` } });
      now = await values();
      expect(now[id]).toBe(value);
      expect(now.cn).toBe('Repro');
    }
    // A value not in the field's format: refused before anything, and nothing changed.
    expect((await mcp.call('type', { tab_id: 'a1', ref: ref('Arrival'), text: 'half past six' })).text).toBe('A time field takes a value like 18:30; nothing was put in it.');
    expect((await mcp.call('type', { tab_id: 'a1', ref: ref('Day'), text: 'tomorrow' })).text).toBe('A date field takes a value like 2026-11-23; nothing was put in it.');
    // In the format, but no such date: the field doesn't take it, and that's said.
    expect((await mcp.call('type', { tab_id: 'a1', ref: ref('Day'), text: '2026-02-31' })).text).toBe('A date field takes a value like 2026-11-23; nothing was put in it.');
    expect(await values()).toMatchObject({ cn: 'Repro', t: '18:30', d: '2026-11-23' });
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('dialogs while an agent acts: alert, confirm and prompt are held and reported, answered as Cancel, and the tab never freezes (#112)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/dialogs` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const popover = await pageWhere(app, isPopover);
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const held: string[] = [];
    const click = async (name: string) => {
      const r = await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, `button "${name}"`) });
      held.push(...r.held);
      return r;
    };
    const first = click('Show notice');
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const started = Date.now();
    expect(JSON.parse((await first).text)).toMatchObject({ data: { done: 'Clicked “Show notice”' } });
    expect(JSON.parse((await click('Ask yes or no')).text)).toMatchObject({ data: { done: 'Clicked “Ask yes or no”' } });
    expect(JSON.parse((await click('Ask a name')).text)).toMatchObject({ data: { done: 'Clicked “Ask a name”' } });
    // The page went on at once each time: alert returned, confirm said no, prompt gave nothing.
    const read = async () => {
      const r = await mcp.call('read_tab', { tab_id: 'a1' });
      held.push(...r.held);
      return (JSON.parse(r.text) as { content: string }).content;
    };
    expect(await read()).toContain('after-alert yes-no=false name=null');
    // Never frozen: three actions and a read well within a dialog's wait (a dialog left open would hang the read).
    expect(Date.now() - started).toBeLessThan(20_000);
    // Each held, and reported to the agent (with that action's result, or the next).
    await expect.poll(async () => (await read(), held.join(' | ')), { timeout: 10_000 }).toContain('prompt: Your name?');
    expect(held.join(' | ')).toContain('alert: Saved');
    expect(held.join(' | ')).toContain('confirm: Keep it?');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('workers, redirects and scripts: what a worker sends asks too; a 307 to another site asks again; a form to another site says where; a script going to a delete address asks (#112 review 2)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/workers` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const host = new URL(site.origin).host;
    const third = `localhost:${new URL(site.origin).port}`;
    const read = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    await expect.poll(read, { timeout: 15_000 }).toContain('controlled');
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const STEP_NO = 'The user said no to this step. Don’t try it another way; ask the user what to do.';
    const card = (title: RegExp) => popover.getByRole('alertdialog', { name: title });
    const withCard = async (call: Promise<{ text: string }>, title: RegExp, button: 'Allow' | 'Don’t') => {
      await expect(card(title)).toBeVisible({ timeout: 15_000 });
      await popover.waitForTimeout(600);
      await card(title).getByRole('button', { name: button, exact: true }).click();
      return call;
    };
    const ownSite = new RegExp(`^Send data to ${host.replace(/\./g, '\\.')}\\?$`);
    // The site card first, on a click that sends nothing.
    const first = mcp.call('snapshot', { tab_id: 'a1' });
    await first;
    // Each worker's send: held in its own target, one card, Don't drops it.
    for (const name of ['Worker', 'Shared worker', 'Through the service worker', 'Service worker']) {
      const clicking = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), `button "${name}"`) });
      if (name === 'Worker') {
        const siteCard = siteCardOf(popover, 'Codex');
        // The click's own answer, if it comes before the card (a refusal), says why.
        const early = await Promise.race([clicking.then((r) => r.text), siteCard.waitFor({ timeout: 15_000 }).then(() => null)]);
        expect(early, 'the site card, not an answer').toBeNull();
        await popover.waitForTimeout(600);
        await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
      }
      expect((await withCard(clicking, ownSite, 'Don’t')).text, name).toBe(STEP_NO);
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(reached.filter((r) => r.startsWith('POST'))).toEqual([]);
    // Through the service worker too: its own request, redirected by a 307 to another site, is held again.
    const otherSiteSw = new RegExp(`^Send data to ${third.replace(/\./g, '\\.')}\\?$`);
    const viaSw = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Redirected through the service worker"') });
    await withCard(Promise.resolve({ text: '' }), ownSite, 'Allow');
    await withCard(Promise.resolve({ text: '' }), otherSiteSw, 'Don’t');
    await viaSw;
    await new Promise((r) => setTimeout(r, 300));
    expect(reached.filter((r) => r.startsWith('POST'))).toEqual(['POST /redir307']);
    reached.length = 0;
    // An allowed POST that a 307 sends to another site: asked again, for that site; Don't keeps it from there.
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/redirects` })).text)).toMatchObject({ data: { navigated: true } });
    const redirected = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Redirected"') });
    await withCard(Promise.resolve({ text: '' }), ownSite, 'Allow');
    const otherSite = new RegExp(`^Send data to ${third.replace(/\./g, '\\.')}\\?$`);
    // The redirect's response can come after the action settled: then the tab's card asks, not the action's. Either
    // way it's held for its own site, and Don't keeps it from there.
    const after = (await withCard(redirected, otherSite, 'Don’t')).text;
    expect([STEP_NO, 'done']).toContain(after === STEP_NO ? STEP_NO : (JSON.parse(after) as { data: { done?: string } }).data.done ? 'done' : after);
    await new Promise((r) => setTimeout(r, 300));
    expect(reached.filter((r) => r.startsWith('POST'))).toEqual(['POST /redir307']);
    // A script sending the page to a delete address: asked as that step, and Don't keeps it where it was.
    const going = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Open settings"') });
    expect((await withCard(going, /^Delete this on /, 'Don’t')).text).toBe(STEP_NO);
    expect(reached.filter((r) => r.includes('/account/delete'))).toEqual([]);
    // A risky form to another site: its card says where it goes; Allow sends it there, and nothing else.
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/elsewhere` })).text)).toMatchObject({ data: { navigated: true } });
    const ordering = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Submit order"') });
    const order = card(/^Place the order on |^Submit this form on /);
    await expect(order).toBeVisible({ timeout: 15_000 });
    await expect(order).toContainText(`It goes to ${third}.`);
    await popover.waitForTimeout(600);
    await order.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(JSON.parse((await ordering).text)).toMatchObject({ data: { done: 'Clicked “Submit order”' } });
    await expect.poll(() => reached.includes('POST /collect')).toBe(true);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('between actions: what the tab sends asks (“Codex’s tab wants to send data”), Allow sends it, and your taking the tab fails it (the owner, 2026-11-23)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/later` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const host = new URL(site.origin).host;
    const ownSite = new RegExp(`^Send data to ${host.replace(/\./g, '\\.')}\\?$`);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const clicking = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Edit later"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    // The action's done before the page sends: no card then.
    expect(JSON.parse((await clicking).text)).toMatchObject({ data: { done: 'Clicked “Edit later”' } });
    // 2.5 s later the page sends: the tab's card, as drawn, with the subject the tab.
    const later = popover.getByRole('alertdialog', { name: ownSite });
    await expect(later).toBeVisible({ timeout: 15_000 });
    await expect(later).toContainText('Codex’s tab wants to send data to its site.');
    expect(reached).toEqual([]);
    await popover.waitForTimeout(600);
    await later.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => reached.includes('POST /autosave')).toBe(true);
    // Again, and this time you take the tab (a key in it): the card comes down, and what was held never goes.
    reached.length = 0;
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Edit later"') })).text)).toMatchObject({ data: { done: 'Clicked “Edit later”' } });
    await expect(popover.getByRole('alertdialog', { name: ownSite })).toBeVisible({ timeout: 15_000 });
    await shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Later/ }).click();
    await pressReal(app, `${site.origin}/later`, 'Down');
    await expect(popover.getByRole('alertdialog', { name: ownSite })).toHaveCount(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(reached).toEqual([]);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Allow until done: no more cards for that site from this tab; a new site still asks; your taking the tab ends it; a new agent session asks again (the owner, 2026-11-23)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/live` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const host = new URL(site.origin).host;
    const third = `localhost:${new URL(site.origin).port}`;
    const ownSite = popover.getByRole('alertdialog', { name: new RegExp(`^Send data to ${host.replace(/\./g, '\\.')}\\?$`) });
    const polls = () => reached.filter((r) => r === 'POST /poll').length;
    // The poll's card: Allow until done.
    await expect(ownSite).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await ownSite.getByRole('button', { name: 'Allow until done', exact: true }).click();
    await expect(ownSite).toHaveCount(0);
    // 3 s on: the polls go, and no card asks again.
    const sent = polls();
    await popover.waitForTimeout(3000);
    expect(polls()).toBeGreaterThanOrEqual(sent + 2);
    await expect(ownSite).toHaveCount(0);
    // A new site still asks (in an action: the action's card), and Don't keeps it from there.
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const telling = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Tell a partner"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const other = popover.getByRole('alertdialog', { name: new RegExp(`^Send data to ${third.replace(/\./g, '\\.')}\\?$`) });
    await expect(other).toBeVisible({ timeout: 15_000 });
    await expect(other.getByRole('button', { name: 'Allow until done', exact: true })).toBeVisible();
    await popover.waitForTimeout(600);
    await other.getByRole('button', { name: 'Don’t', exact: true }).click();
    await telling;
    expect(reached).not.toContain('POST /partner');
    // You take the tab (a key in it): Allow until done ends. Once you let the agent continue, the poll asks again.
    await shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Live/ }).click();
    await pressReal(app, `${site.origin}/live`, 'Down');
    await shell.getByRole('button', { name: 'Let Codex continue' }).click();
    await expect(ownSite).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await ownSite.getByRole('button', { name: 'Don’t', exact: true }).click();
    // A new agent session (the first one ends): its own tab's poll asks again.
    mcp.child.stdin!.end();
    await mcp.exited;
    const again = relay(profile);
    await again.request('initialize', CODEX);
    const reopening = again.call('open_tab', { url: `${site.origin}/live` });
    await answer(app, 'Codex', 'Allow once');
    expect((await reopening).text, 'open_tab opened its tab').toMatch(/^\{/);
    await expect(ownSite).toBeVisible({ timeout: 15_000 });
    again.child.stdin!.end();
    await again.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('between actions, the noise: a poll that posts, a feed that only reads, an autosave (a report for the owner, 2026-11-23, not a budget)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/live` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const cards = popover.getByRole('alertdialog', { name: /^Send data to / });
    // 10 s, no one answering: how many cards, and how many sends wait on them.
    const started = Date.now();
    await expect(cards).toHaveCount(1, { timeout: 15_000 });
    const firstCardMs = Date.now() - started;
    await popover.waitForTimeout(8000);
    const unanswered = await cards.count();
    const reachedUnanswered = reached.filter((r) => r.startsWith('POST')).length;
    // Then 10 s answering Allow each time a card shows: how many cards that takes.
    let allowed = 0;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if ((await cards.count()) > 0) {
        await popover.waitForTimeout(600);
        if ((await cards.count()) === 0) continue;
        await cards.first().getByRole('button', { name: 'Allow', exact: true }).click();
        allowed++;
      } else await popover.waitForTimeout(100);
    }
    const polls = reached.filter((r) => r === 'POST /poll').length;
    const reads = reached.filter((r) => r.startsWith('GET /updates')).length;
    console.log(`[sends noise] first card after ${firstCardMs} ms; unanswered 8 s: ${unanswered} card, ${reachedUnanswered} POSTs sent; answering 10 s: ${allowed} cards allowed, ${polls} polls sent, feed reads asked: ${reads === 0 ? 'none' : reads}`);
    expect(unanswered).toBe(1);
    expect(reachedUnanswered).toBe(0);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('snapshot: the outline of a tab an agent opened, its refs, and its budgets (M2b)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    expect(((await mcp.request('tools/list', {})).result['tools'] as { name: string }[]).map((t) => t.name)).toContain('snapshot');
    const opening = mcp.call('open_tab', { url: `${site.origin}/snap` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const result = await mcp.call('snapshot', { tab_id: 'a1' });
    expect(result.isError).toBe(false);
    const snap = JSON.parse(result.text) as { source: string; trust: string; refs: number; page_id: string; content: string };
    expect(snap).toMatchObject({ source: 'web_snapshot', trust: 'untrusted' });
    const lines = snap.content.split('\n').map((l) => l.trim());
    const has = (pattern: RegExp) => expect(lines.some((l) => pattern.test(l)), `${pattern} in\n${snap.content}`).toBe(true);
    has(/^- navigation "Site"$/);
    has(/^- link "Home" \[ref=e\d+\]$/);
    has(/^- heading "Your orders" \[ref=e\d+\]|^- heading "Your orders" \[level=1\]$/);
    has(/^- text: "Returns are free within 30 days\."$/);
    has(/^- searchbox "Search orders" \[ref=e\d+\] \[filled\]$/);
    has(/^- checkbox "Gift receipt" \[ref=e\d+\] \[checked\] \[required\]$/);
    has(/^- combobox "Shipping" \[ref=e\d+\] \[choice="Express"\]$/);
    has(/^- textbox "Note" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Password" \[password: the user signs in\]$/);
    has(/^- textbox "Code" \[one-time code: the user types it\]$/);
    has(/^- button "Start a return" \[ref=e\d+\]$/);
    has(/^- button "Cancel order" \[ref=e\d+\] \[disabled\]$/);
    has(/^- generic "Track package" \[ref=e\d+\]$/);
    has(/^- button "More" \[ref=e\d+\] \[collapsed\]$/);
    has(/^- button "In the shadow" \[ref=e\d+\]$/);
    has(/^- iframe "Chat"$/);
    has(/^- textbox "Message" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Card number" \[payment detail: the user fills it\]$/);
    has(/^- textbox \[ref=e\d+\] \[filled\]$/);
    has(/^- combobox "Expires" \[payment detail: the user fills it\]$/);
    has(/^- textbox "Cell" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Item" \[ref=e\d+\] \[filled\]$/);
    has(/^- textbox "Title" \[ref=e\d+\] \[filled\]$/);
    // A button labelled by an editor, a text area or a select isn't named by what's in it: by its own words instead.
    has(/^- button "Send" \[ref=e\d+\]$/);
    has(/^- button "Keep" \[ref=e\d+\]$/);
    has(/^- button "Pick" \[ref=e\d+\]$/);
    expect(lines.filter((l) => /^- textbox "Card number" \[payment detail: the user fills it\]$/.test(l))).toHaveLength(2);
    // What's hidden, what's in a frame, and what's in a field never show.
    for (const never of ['Invisible', 'Inside', 'wool scarf', 'secret-note-value', 'hunter2-secret', 'Hidden until opened', '123-45-6789', '4242', 'typed-into-a-role-textbox', 'Hidden from assistive tech', '07', '5555', 'typed-in-a-cell', 'typed-in-a-list-item', 'typed-in-a-heading', 'typed-label-source', 'Hidden, any case', 'initial-textarea-content', 'option-label-x']) expect(snap.content).not.toContain(never);

    // A page that's all editor: one typed field, never walked (review 3 of #104).
    for (const [i, path] of ['/edit-body', '/edit-html', '/design-mode'].entries()) {
      await mcp.call('open_tab', { url: `${site.origin}${path}` });
      const whole = JSON.parse((await mcp.call('snapshot', { tab_id: `a${i + 2}` })).text) as { content: string };
      expect(whole.content, path).toMatch(/^- textbox \[ref=e\d+\] \[filled\]$/);
      expect(whole.content, path).not.toContain('typed-');
    }
    expect(snap.refs).toBe((snap.content.match(/\[ref=e\d+\]/g) ?? []).length);
    // A second snapshot: new refs, counted on.
    const again = JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string };
    const firstMax = Math.max(...[...snap.content.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])));
    expect(Math.min(...[...again.content.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])))).toBe(firstMax + 1);

    // Budgets (docs/decisions/S18-agent-mcp.md, "M2: plan"): a typical page (about 1,500 elements) and a 20,000-element one.
    type Times = { times: number[]; nodes: number; keys: number; cut: Record<string, boolean> | null } | null;
    const timesOf = (url: string, runs: number) => app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentSnapshotTimes(u: string, r: number): Promise<Times> } }).chordTestHooks.agentSnapshotTimes(u, r), [url, runs] as const);
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    for (const [path, rows, runs] of [['/rows-300', 300, 20], ['/noisy', 300, 20], ['/rows-4000', 4000, 5], ['/texts', 0, 5]] as const) {
      await mcp.call('open_tab', { url: `${site.origin}${path}` });
      const measured = (await timesOf(`${site.origin}${path}`, runs))!;
      const ms = sorted(measured.times);
      const median = ms[Math.floor(ms.length / 2)]!;
      const worst = ms[ms.length - 1]!;
      const seen = `${path}: ${rows * 5} elements, ${measured.nodes} nodes, ${measured.keys} keys, cut ${JSON.stringify(measured.cut)}; median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms (${ms.map((t) => t.toFixed(0)).join(' ')})`;
      test.info().annotations.push({ type: 'snapshot timing', description: seen });
      console.log(`[snapshot timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${seen}`);
      if (rows === 300) {
        expect(measured.keys, seen).toBe(600);
        const typical = SNAPSHOT_TYPICAL_MS[`${process.platform}/${process.arch}`] ?? SNAPSHOT_TYPICAL_MS['default']!;
        expect(median, seen).toBeLessThan(typical.median);
        expect(worst, seen).toBeLessThan(typical.worst);
        // M2c: an action's own work before its input goes (the element checked, scrolled to, hit-tested), on this page.
        type ActTimes = { times: number[]; deep: number[]; failed?: string } | null;
        const act = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentActTimes(u: string, r: number): Promise<ActTimes> } }).chordTestHooks.agentActTimes(u, r), [`${site.origin}${path}`, 30] as const))!;
        expect(act.failed).toBeUndefined();
        const at = sorted(act.times);
        const actMedian = at[Math.floor(at.length / 2)]!;
        const actP95 = at[Math.floor(at.length * 0.95)]!;
        const actSeen = `${path}: an action's point step, median ${actMedian.toFixed(1)} ms, p95 ${actP95.toFixed(1)} ms (${at.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${actSeen}`);
        expect(actMedian, actSeen).toBeLessThan(ACT_POINT_MS.median);
        expect(actP95, actSeen).toBeLessThan(ACT_POINT_MS.p95);
        // Neon's review of #110: the debugger's session a press or typing opens, on this page. The document's first
        // finds Chord's world (Runtime enabled once: the page's stored console replayed, ~1,000 entries at most on
        // /noisy); the rest don't.
        const [first, ...later] = act.deep;
        const dt = sorted(later);
        const deepMedian = dt[Math.floor(dt.length / 2)]!;
        const deepP95 = dt[Math.floor(dt.length * 0.95)]!;
        const deepSeen = `${path}: the debugger's session, first ${first!.toFixed(1)} ms, then median ${deepMedian.toFixed(1)} ms, p95 ${deepP95.toFixed(1)} ms (${dt.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${deepSeen}`);
        expect(first!, deepSeen).toBeLessThan(ACT_DEEP_MS.first);
        expect(deepMedian, deepSeen).toBeLessThan(ACT_DEEP_MS.median);
        expect(deepP95, deepSeen).toBeLessThan(ACT_DEEP_MS.p95);
        if (path === '/rows-300') {
          // M2d: the send watch (sends.ts), every request of a 60-image page through it, against without it.
          await mcp.call('open_tab', { url: `${site.origin}/heavy` });
          type WatchTimes = { off: number[]; on: number[]; failed?: string } | null;
          const watched = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentWatchTimes(u: string, r: number): Promise<WatchTimes> } }).chordTestHooks.agentWatchTimes(u, r), [`${site.origin}/heavy`, 10] as const))!;
          expect(watched.failed).toBeUndefined();
          const mid = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)]!;
          const extra = mid(watched.on) - mid(watched.off);
          const watchSeen = `/heavy: the send watch, loaded with it median ${mid(watched.on).toFixed(1)} ms, without ${mid(watched.off).toFixed(1)} ms, extra ${extra.toFixed(1)} ms (on ${watched.on.map((t) => t.toFixed(0)).join(' ')}; off ${watched.off.map((t) => t.toFixed(0)).join(' ')})`;
          console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${watchSeen}`);
          expect(extra, watchSeen).toBeLessThan(SEND_WATCH_EXTRA_MS);
        }
      } else {
        // The median of five: one pause in five (a garbage collection on a page of 2,000,000 text nodes) took 777 ms once
        // on main itself, its other runs 35 to 43 ms. The worst is in the message.
        expect(median, seen).toBeLessThan(SNAPSHOT_HUGE_MS);
        // A page of 2,000,000 text nodes is cut at the scan's bound like any other (review 1 of #104).
        expect(measured.nodes, seen).toBeLessThanOrEqual(20_000);
      }
    }
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The snapshot's budgets, round trip from main (the renderer's work and the answer's way back), in the Linux container
 * and on CI's runners: a typical page (1,500 elements: 300 rows of a link, a note and a button) and a 20,000-element
 * one, which the script stops looking at after SNAPSHOT_SCAN_MS (150 ms). Measured (2026-11-22, the Linux container,
 * three runs each on X11 and Wayland): the typical page's median 12.8 to 15.9 ms, its worst 21 to 28 ms; the huge page
 * 127 to 166 ms median, 194 ms at worst; once text nodes counted toward the scan (review 1 of #104), 75 to 91 ms median
 * and 138 ms at worst, and a page of 2,000,000 text nodes 31 to 34 ms median, 49 ms at worst. The budgets are the plan's,
 * at least 1.5 times the worst seen.
 *
 * CI's runners (2026-11-22, #104), the typical page's median and worst: Windows x64 11.0 and 16.1 ms, Linux x64 X11 11.3
 * and 27.4, Wayland 15.1 and 36.2, macOS arm64 13.5 and 29.9, Windows arm64 19.1 and 23.2, Linux arm64 19.9 and 35.6;
 * the Intel Mac (macos-15-intel) 26.9 and 57.3, then 30.2 and 49.5 on its retry. That runner gets its own budget, about
 * 1.5 times the worst it showed; every other keeps the plan's. The 20,000-element and text-flood pages were 156 ms at
 * worst on any runner.
 *
 * macOS arm64 later (#112 at 7b66028, 2026-11-23): the typical page 24.2 and 60.2 ms, again 14.5 and 43.7, and /noisy
 * 25.9 and 35.8, against 13.5 and 29.9 on #104. That runner gets its own budget too, about 1.5 times the worst seen.
 */
const SNAPSHOT_TYPICAL_MS: Record<string, { median: number; worst: number }> = {
  default: { median: 25, worst: 60 },
  'darwin/x64': { median: 45, worst: 90 },
  'darwin/arm64': { median: 40, worst: 90 },
};
/** The huge pages' budget, on the median of five runs (a single pause can take one run far past it). */
const SNAPSHOT_HUGE_MS = 300;
/**
 * An action's own work in the page before its input goes (M2c: the element checked against its snapshot, scrolled to and
 * hit-tested), round trip from main, on the typical page: the plan's budget. Measured: the decision record's
 * "M2c: as built".
 */
const ACT_POINT_MS = { median: 15, p95: 40 };
/** The debugger's session for a press or typing (Neon's review of #110): a document's first, then the rest. */
const ACT_DEEP_MS = { first: 200, median: 25, p95: 60 };
/** The send watch's cost: a page of 60 requests loaded with it, against without it (median ms more). */
const SEND_WATCH_EXTRA_MS = 25;

test('Chord can’t tell which program started it: the card says so and offers no Always allow (M2a)', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_E2E_NO_PEER: '1' });
  try {
    await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CLAUDE);
    const calling = mcp.call('list_tabs');
    const popover = await pageWhere(app, isPopover);
    const card = cardOf(popover, 'Claude Code');
    await expect(card).toContainText('Chord can’t tell which program started it.');
    await expect(card.getByRole('button', { name: 'Always allow', exact: true })).toHaveCount(0);
    await answer(app, 'Claude Code', 'Allow once');
    expect((await calling).isError).toBe(false);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

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
/** What reached the test site that changes something (S18 M2d): each form posted, each delete address asked for. */
const reached: string[] = [];
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/notes': '<title>Release notes</title><h1>Notes</h1><p>Electron 46 brings a faster start.</p>',
    // A page that shows a dialog as it loads: Chord holds it, and the read never waits on it.
    '/dialog': '<title>Greeter</title><p>Hello there.</p><script>setTimeout(() => alert("Hi from the page"), 50)</script>',
    // A page that downloads a file as it loads: refused in an agent's tab.
    '/download': '<title>Download</title><p>Fetching…</p><script>setTimeout(() => { location.href = "/file.zip" }, 50)</script>',
    // M2a: a button and a field at known places, and a log of what reached them, and whether the page took it as trusted.
    // Review 3 of #104: pages that are all editor.
    '/edit-body': '<title>Notepad</title><body contenteditable>typed-in-the-body <b>and bold</b></body>',
    '/edit-html': '<html contenteditable><title>Notepad</title><body>typed-in-html</body></html>',
    '/design-mode': '<title>Notepad</title><body>typed-in-design-mode</body><script>document.designMode = "on";</script>',
    // M2c: a shop's front page, to act on.
    '/shop':
      '<title>Shop</title><main><h1>Orders</h1><form role="search" action="/shop/results"><label>Search orders <input name=q type=search></label> <button>Search</button></form>' +
      '<a href="/shop/results?q=all">All orders</a></main>',
    // M2b: a page for the snapshot, every kind of thing an outline says (and doesn't).
    '/snap':
      '<title>Orders</title><header><nav aria-label="Site"><a href="/">Home</a> <a href="/help">Help</a></nav></header>' +
      '<main><h1>Your orders</h1><p>Returns are free within 30 days.</p>' +
      '<label>Search orders <input type="search" value="wool scarf"></label>' +
      '<label><input type="checkbox" checked required> Gift receipt</label>' +
      '<label>Shipping <select><option>Standard</option><option selected>Express</option></select></label>' +
      '<label>Note <textarea>secret-note-value</textarea></label>' +
      '<label>Password <input type="password" value="hunter2-secret"></label>' +
      '<label>Code <input autocomplete="one-time-code"></label>' +
      '<button aria-label="Start a return">↩</button> <button disabled>Cancel order</button>' +
      '<div style="cursor:pointer" onclick="0">Track package</div>' +
      '<details><summary>More</summary><p>Hidden until opened.</p></details>' +
      '<div style="display:none"><button>Invisible</button></div>' +
      '<div id=host></div><iframe title="Chat" srcdoc="<button>Inside</button>"></iframe>' +
      // Review 1 of #104: rich-text fields are named by their labels only; a sensitive one has no ref; aria-hidden is left out.
      '<div contenteditable aria-label="Message">Hi Bob, my SSN is 123-45-6789</div>' +
      '<div contenteditable aria-label="Card number">4242 4242 4242 4242</div>' +
      '<div role=textbox>typed-into-a-role-textbox</div>' +
      '<div aria-hidden="true"><button>Hidden from assistive tech</button></div>' +
      '<label>Expires <select autocomplete="cc-exp-month"><option>01</option><option selected>07</option></select></label>' +
      // Review 2 of #104: editability first, whatever the tag or role.
      '<div contenteditable role="none" aria-label="Card number">5555 4444 3333 1111</div>' +
      '<table><tr><td contenteditable aria-label="Cell">typed-in-a-cell</td></tr></table>' +
      '<ul><li contenteditable aria-label="Item">typed-in-a-list-item</li></ul>' +
      '<h1 contenteditable aria-label="Title">typed-in-a-heading</h1>' +
      '<div contenteditable id=ed aria-label="Draft">typed-label-source</div><button aria-labelledby=ed>Send</button>' +
      '<div aria-hidden="TRUE"><button>Hidden, any case</button></div>' +
      // Review 3 of #104: a label taken from a text area or a select is never its value or its options.
      '<textarea id=ta aria-label="Draft text">initial-textarea-content</textarea><button aria-labelledby=ta>Keep</button>' +
      '<select id=sl aria-label="Size"><option selected>Small</option><option>option-label-x</option></select><button aria-labelledby=sl>Pick</button></main>' +
      '<script>host.attachShadow({ mode: "open" }).innerHTML = "<button>In the shadow</button>";</script>',
    // Neon's review of #110: closed shadow roots, a page's own capture listeners, file inputs.
    '/neon':
      '<title>Neon</title><style>body{margin:0;padding:20px}.row{display:block;margin:12px 0}</style><main>' +
      '<x-deal class=row role=button tabindex=0 aria-label="Closed deal" id=deal></x-deal>' +
      '<div class=row contenteditable aria-label="Notes box" id=notes style="width:200px;height:40px"></div>' +
      '<label class=row>Coupon <input id=coupon></label><input type=password id=pw2 aria-label="Account password">' +
      '<label class=row>Upload <input type=file id=up></label>' +
      '<label class=row for=up2 style="cursor:pointer">Choose a photo</label><input type=file id=up2 style="display:none">' +
      '<button class=row id=attach onclick="document.getElementById(\'up3\').click()">Open attachments</button><input type=file id=up3 style="display:none">' +
      '<x-up class=row role=button tabindex=0 aria-label="Closed upload" id=cup></x-up>' +
      // Round 5: pickers a page opens after the action, on the activation the click gave it; a frame's; a stepper in a
      // closed root, clicked twice.
      '<button class=row id=late onclick="setTimeout(() => { const i = document.createElement(\'input\'); i.type = \'file\'; i.click(); }, 1500)">Late upload</button>' +
      '<button class=row id=lateClosed onclick="setTimeout(() => cupRoot.querySelector(\'input\').click(), 1500)">Late closed upload</button>' +
      '<iframe id=fr title="Uploads" srcdoc="<input type=file id=fi>" style="width:200px;height:40px"></iframe>' +
      '<button class=row onclick="document.getElementById(\'fr\').contentDocument.getElementById(\'fi\').click()">Frame upload</button>' +
      '<button class=row onclick="document.getElementById(\'fr\').contentWindow.showOpenFilePicker().catch(() => {})">Frame picker</button>' +
      '<x-step class=row role=button tabindex=0 aria-label="Step up" id=step></x-step>' +
      '<button class=row onclick="const f = document.createElement(\'iframe\'); document.body.append(f); f.contentWindow.showOpenFilePicker().then(() => { log.textContent += \' picked\'; }, (e) => { log.textContent += \' refused \' + e.name; })">Fresh frame picker</button>' +
      '<p id=log></p></main><script>' +
      // A button whose closed root holds a frame, which takes the pointer once it moves over the button.
      'const dealRoot = deal.attachShadow({ mode: "closed" });' +
      'dealRoot.innerHTML = "<style>:host{display:inline-block;position:relative;width:160px;height:40px}</style><span>Closed deal</span><iframe title=\\"Inner ad\\" srcdoc=\\"ad\\" style=\\"position:absolute;left:0;top:0;width:100%;height:100%;border:0;pointer-events:none\\"></iframe>";' +
      'const innerFrame = dealRoot.querySelector("iframe");' +
      'deal.addEventListener("mousemove", () => { innerFrame.style.pointerEvents = "auto"; });' +
      'deal.addEventListener("click", () => { log.textContent += "deal clicked "; });' +
      // A text box whose closed root sends its focus to a password field.
      'const notesRoot = notes.attachShadow({ mode: "closed", delegatesFocus: true });' +
      'notesRoot.innerHTML = "<input type=password style=\\"width:180px\\">";' +
      'window.__secret = notesRoot.querySelector("input");' +
      // The page's own capture listeners, put first: a key in the coupon field goes to the password field, unseen.
      'for (const type of ["keydown", "keypress", "beforeinput", "input", "keyup"]) addEventListener(type, (e) => { if (e.target.id === "coupon") pw2.focus(); if (e.target.id === "coupon" || e.target.id === "pw2") e.stopImmediatePropagation(); }, true);' +
      // A button whose closed root holds the file input it clicks (the preload's listener sees only the button).
      'const cupRoot = cup.attachShadow({ mode: "closed" }); cupRoot.innerHTML = "<span>Closed upload</span><input type=file style=\\"display:none\\">";' +
      'cup.addEventListener("click", () => cupRoot.querySelector("input").click());' +
      'const stepRoot = step.attachShadow({ mode: "open" }); stepRoot.innerHTML = "<style>:host{display:inline-block;width:160px;height:40px}</style><span style=\\"display:block;width:100%;height:100%\\">+</span>";' +
      'step.addEventListener("click", () => { step.dataset.n = Number(step.dataset.n || 0) + 1; log.textContent = "stepped " + step.dataset.n; });' +
      // And the file input its button clicks, its click kept from anything after.
      'addEventListener("click", (e) => { if (e.target.id === "up3") e.stopImmediatePropagation(); }, true);' +
      '</script>',
    // Review 5 of #110: keys that move the focus or go somewhere on their keydown.
    '/keys': '<title>Keys</title><main><input aria-label="First"> <input aria-label="Second"> <a href="/act">Onward</a></main>',
    // M2d: a checkout, and the page tricks a risky step must still ask for.
    '/checkout':
      '<title>Checkout</title><main>' +
      '<form method=post action=/order><label>Shipping <select name=ship><option>Standard</option><option>Express</option></select></label> ' +
      '<label>Gift note <input name=note></label> <label>Card number <input name=card autocomplete=cc-number></label> <button>Place order · $48.20</button></form>' +
      // A misleading button: a form's submit called Continue (to a delete address, for good measure).
      '<form method=post action=/account/close><button>Continue</button></form>' +
      // A JS submit on click: no submit button, the page's own form.submit().
      '<form id=jsf method=post action=/subscribe-js></form><div role=button tabindex=0 onclick="document.getElementById(\'jsf\').submit()">Next</div>' +
      // requestSubmit on a key: Space in a field sends its form.
      '<form id=rsf method=post action=/notes><label>Notes <input onkeypress="if (event.key === \' \') document.getElementById(\'rsf\').requestSubmit()"></label></form>' +
      // A link to a delete address, named innocently.
      '<a href="/items/7/delete">Item 7</a>' +
      // A one-field form that POSTs (Enter in it submits), and a search (Enter in it is reading).
      '<form method=post action=/newsletter><label>Email <input name=email></label></form>' +
      '<form method=get action=/search role=search><label>Search shop <input type=search name=q></label></form>' +
      // #112 review 1: a search form's button that posts somewhere else (formaction, formmethod); a button of no known
      // type (a submit); an aria-label over other words; a label in German.
      '<form method=get action=/search role=search><label>Find <input type=search name=q2></label><button formaction=/account/delete formmethod=post>Look</button></form>' +
      '<form method=post action=/notes-bogus><label>Title <input name=t></label><button type=bogus>Save</button></form>' +
      '<button aria-label="Save draft" onclick="0">Pay $500</button>' +
      '<button onclick="0">Jetzt kaufen</button>' +
      '</main>',
    // The owner's hand test of #112 (bug 1): a text field, then fields that take a value in a format (a time typed in
    // after the text field had the focus went into the text field, and was reported done).
    '/booking':
      '<title>Booking</title><main><label>Customer name <input id=cn></label> <label>Arrival <input type=time id=t></label> ' +
      '<label>Day <input type=date id=d></label> <label>When <input type=datetime-local id=dt></label> ' +
      '<label>Month <input type=month id=m></label> <label>Week <input type=week id=w></label><p id=log></p>' +
      '<script>for (const el of document.querySelectorAll("input")) { el.addEventListener("input", () => { log.textContent += "input:" + el.id + " "; }); el.addEventListener("change", () => { log.textContent += "change:" + el.id + " "; }); }</script></main>',
    // #112 review 2: workers that send, a 307 to another site, a risky form to another site, a script going to a delete
    // address, and what a page sends between actions.
    '/workers':
      '<title>Workers</title><main>' +
      '<button onclick="w.postMessage(1)">Worker</button> <button onclick="sh.port.postMessage(1)">Shared worker</button> ' +
      '<button onclick="fetch(\'/sw-save\', { method: \'POST\', body: \'x\' }).catch(() => {})">Through the service worker</button> ' +
      '<button onclick="navigator.serviceWorker.controller.postMessage(1)">Service worker</button>' +
      '<button onclick="fetch(\'/redir307\', { method: \'POST\', body: \'x\' }).catch(() => {})">Redirected through the service worker</button>' +
      '<p id=log></p>' +
      '<script>const w = new Worker("/w.js"); const sh = new SharedWorker("/shared.js"); sh.port.start();' +
      'navigator.serviceWorker.register("/sw.js"); navigator.serviceWorker.addEventListener("controllerchange", () => { log.textContent = "controlled"; });' +
      'if (navigator.serviceWorker.controller) log.textContent = "controlled";</script></main>',
    // No worker here: a page's own redirects and navigations.
    '/redirects':
      '<title>Redirects</title><main><button onclick="fetch(\'/redir307\', { method: \'POST\', body: \'x\' }).catch(() => {})">Redirected</button>' +
      '<button onclick="location.href = \'/account/delete\'">Open settings</button></main>',
    '/later':
      '<title>Later</title><main><button onclick="setTimeout(() => fetch(\'/autosave\', { method: \'POST\', body: \'x\' }).catch(() => {}), 2500)">Edit later</button></main>',
    // The noise between actions: a poll that posts every second, a live feed that only reads, and an autosave as you type.
    '/live':
      '<title>Live</title><main><label>Draft <input id=d oninput="clearTimeout(window.t); window.t = setTimeout(() => fetch(\'/autosave\', { method: \'POST\', body: this.value }), 500)"></label>' +
      '<button onclick="fetch(location.origin.replace(\'127.0.0.1\', \'localhost\') + \'/partner\', { method: \'POST\', body: \'x\' }).catch(() => {})">Tell a partner</button>' +
      '<script>setInterval(() => fetch("/poll", { method: "POST", body: "x" }).catch(() => {}), 1000); setInterval(() => fetch("/updates").catch(() => {}), 1000);</script></main>',
    // Dialogs while an agent acts: held, answered as Cancel would be, the tab never frozen.
    '/dialogs':
      '<title>Dialogs</title><main>' +
      '<button onclick="alert(\'Saved\'); log.textContent += \'after-alert \'">Show notice</button>' +
      '<button onclick="log.textContent += \'yes-no=\' + confirm(\'Keep it?\') + \' \'">Ask yes or no</button>' +
      '<button onclick="log.textContent += \'name=\' + prompt(\'Your name?\', \'Sam\') + \' \'">Ask a name</button>' +
      '<p id=log></p></main>',
    '/act':
      '<title>Act</title><style>body{margin:0}button,input{position:fixed;left:20px;width:200px;height:40px}button{top:20px}input{top:80px}#log{margin-top:140px}</style>' +
      '<button id=b>Go</button><input id=i><p id=log></p><script>const log = (t, e) => { document.getElementById("log").textContent += t + ":" + e.isTrusted + " "; };' +
      'b.addEventListener("click", (e) => log("click", e)); i.addEventListener("keydown", (e) => log("keydown-" + e.key, e)); i.addEventListener("beforeinput", (e) => log("beforeinput-" + e.inputType, e));</script>',
  };
  const server = createServer((req, res) => {
    const thirdOrigin = `http://localhost:${(server.address() as AddressInfo).port}`;
    // #112 review 2: an allowed POST that a 307 sends on to another site, with its body.
    if (req.method === 'POST' && req.url === '/redir307') {
      reached.push('POST /redir307');
      req.resume();
      res.writeHead(307, { location: `${thirdOrigin}/landed` });
      res.end();
      return;
    }
    // Workers' scripts (#112 review 2): a dedicated, a shared and a service worker, each sending when told.
    const scripts: Record<string, string> = {
      '/w.js': 'onmessage = () => fetch("/worker-save", { method: "POST", body: "x" });',
      '/shared.js': 'onconnect = (e) => { const port = e.ports[0]; port.onmessage = () => fetch("/shared-save", { method: "POST", body: "x" }); };',
      '/sw.js':
        'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));' +
        'self.addEventListener("fetch", (e) => { if (e.request.method === "POST") e.respondWith(fetch(e.request)); });' +
        'self.addEventListener("message", () => fetch("/sw-own", { method: "POST", body: "x" }));',
    };
    if (req.url && scripts[req.url]) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(scripts[req.url]);
      return;
    }
    // M2d: a form posted, or a delete address asked for, is recorded: the step card's journeys check what reached it.
    if (req.method === 'POST' || /\/delete(\b|$)/.test(req.url ?? '')) {
      reached.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<title>Done</title><p>done ${req.method} ${req.url}</p>`);
      return;
    }
    if (req.url === '/file.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="file.zip"' });
      res.end('PK');
      return;
    }
    const rows = /^\/rows-(\d+)$/.exec(req.url ?? '');
    // A hostile page: 2,000,000 text nodes in one div (the parser would join them, so a script makes them).
    const texts = '<title>Texts</title><div id=d></div><script>const d = document.getElementById("d"); for (let i = 0; i < 2000000; i++) d.appendChild(document.createTextNode("x "));</script>';
    // Round 5 of #110: a typical page that logged 1,000 large objects (acting's debugger session must not replay them).
    const noisy = rowsPage(300) + '<script>for (let i = 0; i < 1000; i++) console.log({ i, big: "x".repeat(10000), list: Array.from({ length: 200 }, (_, j) => ({ j })) });</script>';
    // M2c: a shop to act on. Its search (a GET form) lands on its results, which echo what was searched.
    const shop = /^\/shop\/results\?q=([a-z0-9]*)$/.exec(req.url ?? '');
    // The owner's default (2026-11-23): a page of everyday controls, for how often a harmless action sends data. Its
    // "third party" is the same server by another name (localhost), so it's another site.
    const port = (server.address() as AddressInfo).port;
    const third = `http://localhost:${port}`;
    const noise =
      '<title>Inbox</title><main><script>addEventListener("click", () => navigator.sendBeacon("' + third + '/collect", "click"), true);' +
      'const post = (u) => fetch(u, { method: "POST", body: "x" });</script>' +
      '<label><input type=checkbox onchange="post(\'/prefs\')"> Dark mode</label>' +
      '<button onclick="post(\'/messages/1/read\')">Mark as read</button>' +
      '<button onclick="post(\'/posts/1/like\')">Like</button>' +
      '<button onclick="fetch(\'/more\')">Show more</button>' +
      '<div role=tablist><button role=tab onclick="0">Details</button><button role=tab onclick="0">Reviews</button></div>' +
      '<details><summary>Shipping info</summary>Free over $50.</details>' +
      '<a href="/noise" ping="' + third + '/ping">Next page</a>' +
      // A frame of another site (localhost: another process), which saves when the page tells it to.
      '<iframe id=fr src="' + third + '/frame" title="Sync"></iframe><button onclick="document.getElementById(\'fr\').contentWindow.postMessage(\'save\', \'*\')">Sync</button>' +
      '</main>';
    const frame = '<title>Sync</title><script>addEventListener("message", () => fetch("/frame-save", { method: "POST", body: "x" }));</script>';
    // The send watch's cost: a page of 60 images (each a request through it).
    const heavy = '<title>Heavy</title>' + Array.from({ length: 60 }, (_, i) => `<img src="/img/${i}.svg" width=8 height=8>`).join('');
    if (/^\/img\/\d+\.svg$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
      return;
    }
    if (req.url === '/elsewhere')
      return void (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }),
      res.end(`<title>Elsewhere</title><main><form method=post action="${third}/collect"><label>Note <input name=n></label><button>Submit order</button></form></main>`));
    const body = req.url === '/heavy'
      ? heavy
      : req.url === '/noise'
      ? noise
      : req.url === '/frame'
        ? frame
      : rows
      ? rowsPage(Number(rows[1]))
      : shop
        ? shopResults(shop[1]!)
        : req.url === '/texts'
          ? texts
          : req.url === '/noisy'
            ? noisy
            : pages[req.url ?? '/'];
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
    type Seen = { agent: number; yours: number; after: number; late: string[]; paused: boolean; shown: boolean; refused: boolean } | null;
    type Hook = { chordTestHooks: { agentInputSpike(u: string, e: unknown[], t?: string, unchecked?: boolean): Promise<Seen> } };
    const send = (events: unknown[], text?: string, unchecked = false) =>
      app.evaluate((_electron, [url, events, text, unchecked]) => (globalThis as unknown as Hook).chordTestHooks.agentInputSpike(url, events, text, unchecked), [
        `${site.origin}/act`,
        events,
        text,
        unchecked,
      ] as const);
    const click = (x: number, y: number) => [
      { type: 'mouseMove', x, y },
      { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
    ];
    // A click: each event seen while the send runs, none after.
    const clicked = await send(click(120, 40));
    expect(clicked).toMatchObject({ yours: 0, after: 0, paused: false, shown: false });
    expect(clicked!.agent).toBeGreaterThan(0);
    // The wheel: seen while the send runs too; the scroll it starts comes after (gesture events, from the page's
    // renderer), and is nothing any of Chord's listeners for your hands act on (a press of a key or a button).
    const wheeled = await send([{ type: 'mouseWheel', x: 120, y: 40, deltaX: 0, deltaY: -40 }]);
    test.info().annotations.push({ type: 'late after the wheel', description: wheeled!.late.join(' ') || 'none' });
    expect(wheeled).toMatchObject({ yours: 0, paused: false });
    expect(wheeled!.agent).toBeGreaterThan(0);
    expect(wheeled!.late.filter((t) => /^(mouseDown|mouseUp|keyDown|keyUp|rawKeyDown|char)$/.test(t))).toEqual([]);
    // Into the field: text inserted as one piece, then Enter (keys of press_key's list only).
    const typed = await send([...click(120, 100), { type: 'keyDown', keyCode: 'Return' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Return' }], 'hé');
    expect(typed).toMatchObject({ yours: 0, after: 0, paused: false, refused: false });
    const log = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    await expect.poll(log).toContain('click:true');
    const text = await log();
    expect(text).toContain('keydown-Enter:true');
    expect(text).toContain('beforeinput-insertText:true');
    expect(text).not.toContain(':false');
    // Escape, though plain Escape is one of Chord's shortcuts too (Stop loading): an agent's goes to the page as it is.
    expect(await send([{ type: 'keyDown', keyCode: 'Escape' }, { type: 'keyUp', keyCode: 'Escape' }])).toMatchObject({ yours: 0, after: 0, refused: false });
    await expect.poll(log).toContain('keydown-Escape:true');
    // Nothing of Chord's ran for it: no pause, and no bar but the working one, now gone.
    await expect(shell.getByRole('status').filter({ hasText: /Paused/ })).toHaveCount(0);

    // Ctrl+W (⌘W): never sent for an agent; and if one ever were, Chord's shortcuts stop it, so neither the page nor
    // the ⋯ menu's accelerators get it. Its tab, and your tabs, stay open.
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    const ctrlW = [{ type: 'keyDown', keyCode: 'W', modifiers: [mod] }, { type: 'keyUp', keyCode: 'W', modifiers: [mod] }];
    const yours = shell.getByRole('tree', { name: 'Unpinned tabs' }).getByRole('treeitem');
    const before = await yours.count();
    expect(await send(ctrlW)).toMatchObject({ refused: true, agent: 0, yours: 0 });
    expect(await send(ctrlW, undefined, true)).toMatchObject({ refused: false, yours: 0, after: 0 });
    await shell.waitForTimeout(500);
    expect((await mcp.call('list_tabs')).text).toContain('"a1"');
    expect(await yours.count()).toBe(before);
    expect(await log()).not.toContain('keydown-w');
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
