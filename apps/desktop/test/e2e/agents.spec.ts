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

/**
 * wait_for's answer, met or not, and the lines to find refs in: the outline (no snapshot of the page before), or what
 * changed since (M2g-1), its gone lines left out.
 */
function waitAnswer(text: string): { met: boolean; lines: string } {
  const w = JSON.parse(text) as { content?: string; wait?: { met: boolean }; data?: { met: boolean; page_changes?: { lines?: string[] } } };
  if (w.content !== undefined) return { met: w.wait?.met === true, lines: w.content };
  return { met: w.data?.met === true, lines: (w.data?.page_changes?.lines ?? []).filter((l) => !l.startsWith('- ')).map((l) => l.slice(2)).join('\n') };
}

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
    // coming back to Chord, your page has the focus, never the agent's, nor a view of Chord's that isn't shown (macOS
    // made the hidden popover the window's first responder as it came back, on arm64 and Intel: window.ts'
    // keepFocusOffParked gives it to your page).
    // On macOS a window's focus() asks the OS to activate Chord, and macOS 14's cooperative activation may say no to an
    // app sent behind (CI's macOS x64 runner did, three times: nothing focused for 3 s). Coming back is what a click on
    // Chord does, which activates it: app.focus with steal (activateIgnoringOtherApps), then the window.
    const inFront = (front: boolean) =>
      app.evaluate(({ app: electronApp, BaseWindow }, f) => {
        const w = BaseWindow.getAllWindows()[0]!;
        if (!f) return w.blur();
        if (process.platform === 'darwin') electronApp.focus({ steal: true });
        w.focus();
      }, front);
    await inFront(false);
    await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Step up"') });
    await inFront(true);
    await expect.soft.poll(focused, { message: 'coming back to Chord', timeout: 3000 }).toBe(yours);

    // A tab switch (Claude's S7, round 4 of #112): your tab had the focus when the agent's was parked; you go to
    // another tab; the agent acts. The focus goes to the page you see, never back to the one you left.
    {
      const { windowId } = await where(shell);
      await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/notes` });
      const left = `${site.origin}/notes`;
      await pageWhere(app, (url) => url.startsWith(left));
      await expect
        .poll(async () => {
          await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.focus(), left);
          return focused();
        })
        .toBe(left);
      await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Step up"') });
      await expect.soft.poll(focused, { message: 'your tab, before the switch', timeout: 2000 }).toBe(left);
      await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/act` });
      const seen = `${site.origin}/act`;
      await pageWhere(app, (url) => url.startsWith(seen));
      await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Step up"') });
      await new Promise((r) => setTimeout(r, 500));
      expect(await focused(), 'after a tab switch, never the tab you left').not.toBe(left);
    }

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
    // dialogs (alert shows Chord's own, not answered at once), no debugger, and the typing guard only as every tab of
    // yours has it, dormant until the assistant types there (S18 M2e-2a).
    await shell.getByRole('button', { name: 'Keep', exact: true }).click();
    const settingsOf = () =>
      app.evaluate(async ({ webContents }, url) => {
        const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith(url) && !x.isDestroyed());
        if (!c) return null;
        return { guard: await c.executeJavaScriptInIsolatedWorld(999, [{ code: 'typeof globalThis.__chordAgentGuard' }]), debugger: c.debugger.isAttached() };
      }, `${site.origin}/neon`);
    await expect.poll(settingsOf, { timeout: 15_000 }).toEqual({ guard: 'object', debugger: false });
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
    const sendsTo = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);

    // The first action on the site: the site card (it still asks before risky steps, it says), then the step card.
    let outline = await snap();
    const placing = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Place order · $48.20"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await expect(siteCard).toContainText('It asks before it submits, pays, sends or deletes, and when its pages post data.');
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const order = stepCardOf(popover, new RegExp(`^Place the order on ${host.replace(/\./g, '\\.')}\\?$`));
    await expect(order).toBeVisible({ timeout: 15_000 });
    await expect(order).toContainText('Codex is about to click “Place order · $48.20”.');
    // Only what the submit sends: the select, the filled note (no colon), the checked radio; not Small, Large, the
    // unchecked box nor the empty card field (the owner's test of 982ce10).
    await expect(order).toContainText('Goes with it: Shipping, Gift note, Medium');
    await expect(order).not.toContainText('Small');
    await expect(order).not.toContainText('Gift wrap');
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
    // Round 4: a button inside an open shadow root, in a form that posts: asks as its submit.
    expect((await withStep(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Next step"') }), /^Submit this form on /, 'Don’t')).text).toBe(STEP_NO);
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
    await expect(siteCard).toContainText('It asks before it submits, pays, sends or deletes, and when its pages post data.');
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await first).text)).toMatchObject({ data: { done: 'Clicked “Details”' } });
    // A toggle that saves (a same-site POST): held, one card; Allow sends it.
    const ownSite = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);
    const toggled = await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'checkbox "Dark mode"') }), ownSite, 'Allow');
    expect(JSON.parse(toggled.text)).toMatchObject({ data: { done: 'Clicked “Dark mode”' } });
    await expect.poll(() => reached.includes('POST /prefs')).toBe(true);
    // Like: Don't drops it.
    expect((await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Like"') }), ownSite, 'Don’t')).text).toBe(STEP_NO);
    // A frame of another site that sends on the page's word: held from its own process, and the card says where.
    const frameSends = await withCard(mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Sync"') }), /^Send data to 2 sites\?$|^Send data to (http:\/\/)?localhost/, 'Don’t');
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
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const STEP_NO = 'The user said no to this step. Don’t try it another way; ask the user what to do.';
    const card = (title: RegExp) => popover.getByRole('alertdialog', { name: title });
    const withCard = async (call: Promise<{ text: string }>, title: RegExp, button: 'Allow' | 'Don’t') => {
      await expect(card(title)).toBeVisible({ timeout: 15_000 });
      await popover.waitForTimeout(600);
      await card(title).getByRole('button', { name: button, exact: true }).click();
      return call;
    };
    const ownSite = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);
    // The site card first, on a click that sends nothing.
    const first = mcp.call('snapshot', { tab_id: 'a1' });
    await first;
    // A dedicated worker reads, never sends, in an agent's tab (its requests aren't the page's hold's to see: #112
    // review 3): its POST fails at once, no card, nothing reaches the site.
    const working = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Worker"') });
    {
      const siteCard = siteCardOf(popover, 'Codex');
      const early = await Promise.race([working.then((r) => r.text), siteCard.waitFor({ timeout: 15_000 }).then(() => null)]);
      expect(early, 'the site card, not an answer').toBeNull();
      await popover.waitForTimeout(600);
      await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    }
    expect(JSON.parse((await working).text)).toMatchObject({ data: { done: 'Clicked “Worker”' } });
    await expect.poll(read).toContain('worker: A worker can’t send data from a tab an agent is using.');
    // In a real worker too (round 4): its XHR, a worker it starts, and its trying to put fetch back: none sends.
    for (const [button, says] of [
      ['Worker XHR', 'xhr: A worker can’t send data'],
      ['Nested worker', 'nested worker: A worker can’t send data'],
      ['Worker puts fetch back', 'putback: A worker can’t send data'],
    ] as const) {
      expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), `button "${button}"`) })).text)).toMatchObject({ data: { done: `Clicked “${button}”` } });
      await expect.poll(read, { message: button }).toContain(says);
    }
    // An OPTIONS that carries a body, by fetch and by XHR: held, its card, Don't drops it.
    for (const name of ['Options with a body', 'Options XHR with a body']) {
      const clicking = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), `button "${name}"`) });
      await expect(card(ownSite), `${name}'s send card`).toBeVisible({ timeout: 15_000 });
      expect((await withCard(clicking, ownSite, 'Don’t')).text, name).toBe(STEP_NO);
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(reached.filter((r) => !r.startsWith('GET'))).toEqual([]);
    // No shared workers in an agent's tab (one is the site's, shared with your tabs): the page finds none.
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Shared worker"') })).text)).toMatchObject({ data: { done: 'Clicked “Shared worker”' } });
    expect(await read()).toContain('no shared worker');
    // A click that moves the app's address (pushState) and saves: the Allow given counts (Neon's S16).
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/spa` })).text)).toMatchObject({ data: { navigated: true } });
    const saving = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Save and go on"') });
    expect(JSON.parse((await withCard(saving, ownSite, 'Allow')).text)).toMatchObject({ data: { done: 'Clicked “Save and go on”' } });
    await expect.poll(() => reached.includes('POST /spa-save')).toBe(true);
    reached.length = 0;
    // A link whose page posts as it loads: its card's Allow sends it (the final pass: not stale for the action's own going).
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/goes` })).text)).toMatchObject({ data: { navigated: true } });
    const onward = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'link "Onward"') });
    expect(JSON.parse((await withCard(onward, ownSite, 'Allow')).text)).toMatchObject({ data: { done: 'Clicked “Onward”', navigated: true } });
    await expect.poll(() => reached.includes('POST /loaded-save')).toBe(true);
    reached.length = 0;
    // An allowed POST that a 307 sends to another site: asked again, for that site; Don't keeps it from there.
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/redirects` })).text)).toMatchObject({ data: { navigated: true } });
    const redirected = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Redirected"') });
    await withCard(Promise.resolve({ text: '' }), ownSite, 'Allow');
    const otherSite = new RegExp(`^Send data to http://${third.replace(/\./g, '\\.')}\\?$`);
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
    const ownSite = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);
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

test('round 4 of #112: a page closed by the agent sends nothing on its way out; an agent’s tab has no shared workers, deferred sends or service workers, in any frame', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/leaving` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    // Closed by the agent: its pagehide's keepalive POST and beacon never arrive.
    expect((await mcp.call('close_tab', { tab_id: 'a1' })).isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 1500));
    expect(reached.filter((r) => r.includes('/bye'))).toEqual([]);
    // What the page, a frame its script made, and a sandboxed frame find.
    expect((await mcp.call('open_tab', { url: `${site.origin}/lookout` })).text).toMatch(/^\{/);
    const read = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a2' })).text) as { content: string }).content;
    for (const where of ['sandboxed:', 'srcdoc:', 'samesandbox:', 'cross:']) await expect.poll(read, { timeout: 10_000, message: where }).toContain(where);
    const content = await read();
    // Every frame (a plain srcdoc, a sandboxed one of the same origin, another site's), even with the page's own
    // malformed Permissions-Policy (the final pass: it's replaced, never joined).
    for (const where of ['page', 'blank', 'srcdoc', 'samesandbox', 'cross']) expect(content, where).toContain(`${where}:undefined/undefined/false`);
    // A passkey dialog: refused by the tab's policy (Chord doesn't sign agents in), and the agent hears of it.
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a2' })).text) as { content: string }).content;
    const keying = mcp.call('click', { tab_id: 'a2', ref: refOf(outline, 'button "Use a key"') });
    const keyCard = siteCardOf(await pageWhere(app, isPopover), 'Codex');
    await expect(keyCard).toBeVisible({ timeout: 15_000 });
    await (await pageWhere(app, isPopover)).waitForTimeout(600);
    await keyCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const keyed = await keying;
    await expect.poll(read).toContain('key:NotAllowedError');
    const heard = [...keyed.held, ...(await mcp.call('list_tabs')).held].join(' | ');
    expect(heard).toContain('a passkey or sign-in dialog');
    expect(content, 'sandboxed').toMatch(/sandboxed:[A-Za-z]+\/SecurityError\/SecurityError/);
    // Whatever fetchLater did there, nothing it queued arrives once the agent closes the tab.
    expect((await mcp.call('close_tab', { tab_id: 'a2' })).isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`[round 4] sandboxed frame: ${/sandboxed:[^ ]+/.exec(content)?.[0]}; reached: ${JSON.stringify(reached)}`);
    expect(reached.filter((r) => r.includes('later'))).toEqual([]);
    // open_tab to an address that deletes: asked once, as that step, and its load isn't asked again (Neon's S12).
    const popover = await pageWhere(app, isPopover);
    const deleting = mcp.call('open_tab', { url: `${site.origin}/items/9/delete` });
    const step = popover.getByRole('alertdialog', { name: /^Delete this on / });
    await expect(step).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await step.getByRole('button', { name: 'Allow', exact: true }).click();
    expect((await deleting).text, 'open_tab opened it').toMatch(/^\{/);
    await popover.waitForTimeout(1000);
    await expect(popover.getByRole('alertdialog')).toHaveCount(0);
    expect(reached.filter((r) => r.includes('/items/9/delete'))).toEqual(['GET /items/9/delete']);
    // A crashed agent tab isn't reloaded (Neon's 4): its hold would be armed again only after its page loaded.
    const crashed = `${site.origin}/items/9/delete`;
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.forcefullyCrashRenderer(), crashed);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)?.isCrashed() ?? null, crashed)).toBe(true);
    expect(reached.filter((r) => r.includes('/items/9/delete'))).toEqual(['GET /items/9/delete']);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('extensions never list an agent’s tab in chrome.tabs (the owner, 2026-11-23); their content scripts still run there, the stated limit', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_HOME_URL: `${site.origin}/notes`, CHORD_LOAD_EXTENSION: resolve(appDir, 'test/fixtures/extension') });
  try {
    const shell = await pageWhere(app, isShell);
    await pageWhere(app, (url) => url === `${site.origin}/notes`);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/act` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    // The extension's own view of the tabs, from its popup.
    const button = shell.locator('[data-placement="sidebar"]').getByRole('button', { name: /^Chord Test/ });
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();
    const popup = await pageWhere(app, (url) => url.startsWith('chrome-extension://') && url.endsWith('/popup.html'));
    const urls = await popup.evaluate(() => (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ url?: string }[]> } } }).chrome.tabs.query({}).then((tabs) => tabs.map((t) => t.url ?? '')));
    expect(urls).toContain(`${site.origin}/notes`);
    expect(urls.filter((u) => u.startsWith(`${site.origin}/act`))).toEqual([]);
    // The stated limit: its content script (session-wide, as an agent's tab shares the chord's sign-ins) runs there too.
    const injected = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.documentElement.dataset.chordTestExtension ?? null'), `${site.origin}/act`);
    expect(injected).toBe('injected');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('your own tab on a site with a service worker, and an agent’s tab there: what you send never asks; what it sends is held, never sent through the worker (Claude’s review 3 of #112)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    // Your own tab registers the site's service worker (which sends every POST on for its pages), and is controlled.
    const { windowId } = await where(shell);
    await dispatch(shell, { t: 'tab.open', windowId, url: `${site.origin}/mailbox` });
    const mailbox = await pageWhere(app, (url) => url.startsWith(`${site.origin}/mailbox`));
    await mailbox.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => undefined));
    await expect.poll(() => mailbox.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
    // An agent's tab on that site.
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/noise` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    // You send mail, through the worker: it goes, and no card asks.
    await mailbox.evaluate(() => fetch('/user-mail', { method: 'POST', body: 'hello' }).then((r) => r.status));
    expect(reached).toContain('POST /user-mail');
    await expect(popover.getByRole('alertdialog', { name: /^Send data to / })).toHaveCount(0);
    // The agent's page sends: never through the worker (bypassed), so held, its card; Don't keeps it from the site.
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const liking = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Like"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const sendCard = popover.getByRole('alertdialog', { name: /^Send data to / });
    await expect(sendCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await sendCard.getByRole('button', { name: 'Don’t', exact: true }).click();
    expect((await liking).text).toBe('The user said no to this step. Don’t try it another way; ask the user what to do.');
    await new Promise((r) => setTimeout(r, 300));
    expect(reached).not.toContain('POST /posts/1/like');
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
    const ownSite = popover.getByRole('alertdialog', { name: new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`) });
    const polls = () => reached.filter((r) => r === 'POST /poll').length;
    // The poll's card: Allow until done.
    await expect(ownSite).toBeVisible({ timeout: 15_000 });
    // Its four buttons (Show me, Don't, Allow until done, Allow) all inside the card, none cut (the owner's demo, #112).
    const box = (await ownSite.boundingBox())!;
    const buttons = ownSite.getByRole('button').filter({ hasNotText: /^$/ });
    expect(await buttons.allTextContents()).toEqual(expect.arrayContaining(['Show me', 'Don’t', 'Allow until done', 'Allow']));
    for (const button of await buttons.all()) {
      const b = (await button.boundingBox())!;
      expect(b.x, await button.textContent() ?? '').toBeGreaterThanOrEqual(box.x - 0.5);
      expect(b.x + b.width, await button.textContent() ?? '').toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
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
    const other = popover.getByRole('alertdialog', { name: new RegExp(`^Send data to http://${third.replace(/\./g, '\\.')}\\?$`) });
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

test('a table that redraws its buttons: a ref whose node was replaced is found again, once, by role, name, place and target; duplicates and a changed target refuse (the owner’s bug #2)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/table` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const read = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    const STALE = 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.';
    // The page's own log of what its buttons did (never their words).
    const tableLog = async () => String(await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.getElementById("log").textContent'), `${site.origin}/table`));
    const outline = await snap();
    // The table redraws (every 300 ms): the snapshot's nodes are gone before the click.
    await new Promise((r) => setTimeout(r, 700));
    const folding = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Fold"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const folded = JSON.parse((await folding).text) as { data: { done: string; refound?: string } };
    expect(folded.data.done).toBe('Clicked “Fold”');
    expect(folded.data.refound).toBe('The page had redrawn that element; Chord found it again by its role, name, place and target.');
    await expect.poll(read).toContain('Fold');
    // A key on a redrawn button, from the same (older) snapshot. A redraw between its check and its keydown on a slow
    // machine (the full tier's Windows arm64) is tried again by Chord itself: nothing reached the page (round 6).
    await new Promise((r) => setTimeout(r, 700));
    // Done (and the page saw it), or the page redrew it between its keydown and the rest: then said so, never done.
    const keyed = (await mcp.call('press_key', { tab_id: 'a1', ref: refOf(outline, 'button "Call"'), key: 'Enter' })).text;
    if (keyed.startsWith('{')) {
      expect(JSON.parse(keyed)).toMatchObject({ data: { done: 'Pressed Enter in “Call”' } });
      await expect.poll(tableLog).toBe(' Fold Call');
    } else expect(keyed).toBe('The page redrew that element while the key went in, so it may not have worked. Call snapshot and check before pressing it again.');
    // A risky step on a redrawn button: its card names the element found, the page redraws it while the card is up,
    // and the step's checked again before the click (stepShape): it goes, once.
    const deleting = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Delete row"') });
    const step = popover.getByRole('alertdialog', { name: /^Delete this on / });
    await expect(step).toBeVisible({ timeout: 15_000 });
    await expect(step).toContainText('Codex is about to click “Delete row”.');
    await popover.waitForTimeout(700);
    await step.getByRole('button', { name: 'Allow', exact: true }).click();
    const deleted = JSON.parse((await deleting).text) as { data: { done: string; refound?: string } };
    expect(deleted.data.done).toBe('Clicked “Delete row”');
    expect(deleted.data.refound).toBeTruthy();
    await expect.poll(read).toContain('Delete row');
    // Two buttons named alike in one place: never a guess.
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Bet"') })).text).toBe(STALE);
    // Raise, now in a form that buys: not the element the snapshot named.
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Switch"') })).text)).toMatchObject({ data: { done: 'Clicked “Switch”' } });
    await new Promise((r) => setTimeout(r, 700));
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Raise"') })).text).toBe(STALE);
    expect(reached.filter((r) => r.includes('buy-chips'))).toEqual([]);
    expect(await read()).not.toContain('Raise');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a control the page renames in place, or behind a diff too big to show: its old ref never acts on it (round 1 of #145, B1)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/rename` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const CHANGED = 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.';
    const inPage = (js: string) => app.evaluate(({ webContents }, [url, code]) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript(code), [`${site.origin}/rename`, js] as const);
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const draft = refOf(outline, 'button "Draft 1"');
    const other = refOf(outline, 'button "Other"');
    // Renamed in place (the same node): the diff shows it gone and the new one, with a new ref.
    await inPage('document.getElementById("d").textContent = "Production DB"; 0');
    const hovering = mcp.call('hover', { tab_id: 'a1', ref: other });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    const hovered = JSON.parse((await hovering).text) as { data: { page_changes: { lines: string[] } } };
    expect(hovered.data.page_changes.lines).toContain(`- - button "Draft 1" [ref=${draft}]`);
    const renamed = hovered.data.page_changes.lines.find((l) => l.startsWith('+ - button "Production DB"'));
    expect(renamed).toBeTruthy();
    expect(renamed).not.toContain(`[ref=${draft}]`);
    // The old ref never acts on it.
    expect((await mcp.call('click', { tab_id: 'a1', ref: draft })).text).toBe(CHANGED);
    expect(await inPage('document.getElementById("log").textContent')).toBe('');
    // Renamed again, behind a diff too big to show (70 rows more): still never by the ref the agent last saw.
    const production = /\[ref=(e\d+)\]/.exec(renamed!)![1]!;
    await inPage('document.getElementById("d").textContent = "Drop all"; const list = document.getElementById("list"); for (let i = 0; i < 70; i++) { const li = document.createElement("li"); li.textContent = "Row " + i; list.append(li); } 0');
    const big = JSON.parse((await mcp.call('hover', { tab_id: 'a1', ref: other })).text) as { data: { page_changes: { note?: string } } };
    expect(big.data.page_changes.note).toBe('Much of the page changed: call snapshot to see it.');
    expect((await mcp.call('click', { tab_id: 'a1', ref: production })).text).toBe(CHANGED);
    expect(await inPage('document.getElementById("log").textContent')).toBe('');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the first look at a tab just opened: a page that draws itself after it loads gives its outline and its picture, never an empty one (the owner, 2026-11-24)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    /** The share of a PNG's pixels that are near black (0 to 1). */
    const dark = (b64: string) =>
      app.evaluate(({ nativeImage }, data) => {
        const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
        const px = img.toBitmap();
        let black = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i]! < 16 && px[i + 1]! < 16 && px[i + 2]! < 16) black++;
        return px.length ? black / (px.length / 4) : 1;
      }, b64);
    for (const round of [0, 1, 2]) {
      const opening = mcp.call('open_tab', { url: `${site.origin}/lobby?r=${round}` });
      if (round === 0) await answer(app, 'Codex', 'Allow once');
      const opened = JSON.parse((await opening).text) as { data: { tab_id: string } };
      const tab = opened.data.tab_id;
      const began = Date.now();
      const shot = (await mcp.request('tools/call', { name: 'tab_screenshot', arguments: { tab_id: tab } })).result as { content: { type: string; data?: string; text?: string }[] };
      const image = shot.content.find((c) => c.type === 'image');
      const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as { content: string }).content;
      console.log(`[first look] round ${round}: picture ${image ? `${Math.round((await dark(image.data!)) * 100)}% black` : shot.content[0]?.text}, outline ${JSON.stringify(outline.slice(0, 120))}, ${Date.now() - began} ms`);
      expect(image, 'a picture').toBeDefined();
      expect(await dark(image!.data!), 'not black').toBeLessThan(0.5);
      expect(outline).toContain('button "Join table"');
    }
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a timed table: played as an agent does today (polling snapshots), then with wait_for and its outline, no sleeps; where each move’s time goes (M2g-1)', async () => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/timed` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text).toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const inPage = (code: string) => app.evaluate(({ webContents }, [prefix, js]) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))!.executeJavaScript(js), [`${site.origin}/timed`, code] as const);
    const phases = () => app.evaluate(() => (globalThis as unknown as { chordTestHooks: { agentPhaseTimes(): Promise<{ tool: string; phase: string; ms: number }[]> } }).chordTestHooks.agentPhaseTimes());
    const timed = async <T,>(f: () => Promise<T>) => {
      const t0 = Date.now();
      const out = await f();
      return { out, ms: Date.now() - t0 };
    };
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    let siteAllowed = false;
    /** Call, by its ref in `outline`; the site card answered the first time. */
    const call = async (outline: string) => {
      const clicking = timed(() => mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'generic "Call"') }));
      if (!siteAllowed) {
        const siteCard = siteCardOf(popover, 'Codex');
        await expect(siteCard).toBeVisible({ timeout: 15_000 });
        await popover.waitForTimeout(600);
        await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
        siteAllowed = true;
      }
      const click = await clicking;
      expect(click.out.text).toMatch(/^\{/);
      await expect.poll(() => inPage('document.getElementById("log").textContent')).toContain('Call after');
      await inPage('document.getElementById("log").textContent = ""');
      return click.ms;
    };
    const report = async (how: string, moves: number[], calls: number, laps: { tool: string; phase: string; ms: number }[]) => {
      const byPhase = new Map<string, number[]>();
      for (const l of laps) byPhase.set(`${l.tool}:${l.phase}`, [...(byPhase.get(`${l.tool}:${l.phase}`) ?? []), l.ms]);
      console.log(`[timed table] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${how}: turn start to Chord's click done, median ${med(moves)} ms; ${calls} tool calls for ${moves.length} moves (each a model round trip for an agent); phases (median ms): ${[...byPhase].map(([k, v]) => `${k} ${med(v).toFixed(0)}`).join(', ')}`);
    };
    await phases();
    // Today: a snapshot each 500 ms until it's the agent's turn (a model round trip each, and a sleep), then Call.
    {
      const moves: number[] = [];
      let calls = 0;
      for (let turn = 0; turn < 3; turn++) {
        let outline = '';
        for (;;) {
          calls++;
          outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
          if (outline.includes('generic "Call"')) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        calls++;
        await call(outline);
        if (turn > 0) moves.push(Date.now() - Number(await inPage('window.turnAt')));
      }
      await report('polling', moves, calls, await phases());
    }
    // With wait_for: one call waits for the turn's controls and gives the outline, then Call. No sleeps.
    {
      const moves: number[] = [];
      let calls = 0;
      for (let turn = 0; turn < 3; turn++) {
        calls++;
        const waited = waitAnswer((await mcp.call('wait_for', { tab_id: 'a1', role: 'generic', name: 'Call', snapshot: true, timeout_ms: 20_000 })).text);
        expect(waited.met, `turn ${turn}`).toBe(true);
        calls++;
        await call(waited.lines);
        moves.push(Date.now() - Number(await inPage('window.turnAt')));
      }
      expect(String(await inPage('document.getElementById("log").textContent'))).not.toContain('auto-folded');
      await report('wait_for', moves, calls, await phases());
      // Every move well inside the 15 s clock (Chord's share: the agent's thinking is the rest).
      expect(Math.max(...moves)).toBeLessThan(3000);
    }
    // A text, coming and going: the turn's words show, then go once it's played.
    expect(JSON.parse((await mcp.call('wait_for', { tab_id: 'a1', text: 'Your turn', timeout_ms: 20_000 })).text)).toMatchObject({ data: { met: true } });
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    await call(outline);
    expect(JSON.parse((await mcp.call('wait_for', { tab_id: 'a1', text: 'Your turn', gone: true, timeout_ms: 5_000 })).text)).toMatchObject({ data: { met: true } });
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the token eval: its journeys, each as an agent would play it with the tools this build offers; success, tool calls, tokens and wall time (the owner, 2026-11-24)', async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const popover = await pageWhere(app, isPopover);
    const tools = (await mcp.request('tools/list', {})).result['tools'] as { name: string }[];
    const toolList = JSON.stringify(tools).length;
    // Played with what this build offers: #145's tools (wait_for, batch, by name), else main's (the before: snapshots,
    // refs, polling). The same spec measures both (on main's build, a copy of it).
    const lean = tools.some((t) => t.name === 'wait_for') && tools.some((t) => t.name === 'batch');
    /** What the model gets back from each call: every result's content, counted (tokens, call by call). */
    let meter = { calls: 0, chars: 0, results: [] as number[], pictures: [] as { width: number; height: number }[] };
    /** A picture's size, from its header (a model is charged by a picture's pixels, never its base64). */
    const pictureSize = (b: Buffer): { width: number; height: number } | null => {
      // A PNG (main's pictures): its header's width and height.
      if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xc3) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    };
    /**
     * A call, metered. `noDiff`: counted as a build with no diff after an action would have sent it (its page_changes
     * left out), for the journey that plays an agent with no diff (M2g-2 slice 1).
     */
    const ask = async (name: string, args: Record<string, unknown>, opts: { noDiff?: boolean } = {}) => {
      const r = (await mcp.request('tools/call', { name, arguments: args })).result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
      meter.calls++;
      let chars = 0;
      for (const c of r.content) {
        const size = c.type === 'image' ? pictureSize(Buffer.from(c.data ?? '', 'base64')) : null;
        let counted: unknown = c;
        if (opts.noDiff && c.type === 'text' && c.text?.includes('"page_changes"')) {
          const parsed = JSON.parse(c.text) as { data?: Record<string, unknown> };
          if (parsed.data) delete parsed.data['page_changes'];
          counted = { ...c, text: JSON.stringify(parsed) };
        }
        // A picture: a token for each 750 pixels (counted here as characters, four to a token).
        chars += size ? Math.ceil((size.width * size.height) / 750) * 4 : JSON.stringify(counted).length;
        if (size) meter.pictures.push(size);
      }
      meter.chars += chars;
      meter.results.push(Math.ceil(chars / 4));
      return { text: r.content[0]?.text ?? '', error: r.isError === true };
    };
    /** A call, with any card it raises allowed as the user would (the site's for now, a step's, a connection's once). */
    const act = async (name: string, args: Record<string, unknown>, opts: { noDiff?: boolean } = {}) => {
      const calling = ask(name, args, opts);
      for (;;) {
        const card = popover.getByRole('alertdialog').first();
        const next = await Promise.race([calling.then(() => 'done' as const), card.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'card' as const)]);
        if (next === 'done') return calling;
        await popover.waitForTimeout(600);
        for (const label of ['Allow once', 'Allow for now', 'Allow']) {
          const button = card.getByRole('button', { name: label, exact: true });
          if (await button.count()) {
            await button.click();
            break;
          }
        }
        await card.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      }
    };
    const inPage = (prefix: string, code: string) => app.evaluate(({ webContents }, [p, js]) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(p))!.executeJavaScript(js), [`${site.origin}${prefix}`, code] as const);
    const outlineOf = (text: string) => (JSON.parse(text) as { content: string }).content;
    let tabs = 0;
    const open = async (path: string) => {
      const opened = await act('open_tab', { url: `${site.origin}${path}` });
      tabs++;
      return (JSON.parse(opened.text) as { data: { tab_id: string } }).data.tab_id;
    };
    /**
     * What the model reads, estimated (the plan's assumptions): each call is a model turn that sends the tool list and a
     * fixed 8,000 tokens of system prompt and history, and every result so far (each result is read again on every
     * later turn of the journey).
     */
    const CONTEXT = 8000;
    const defs = Math.ceil(toolList / 4);
    const modelInput = (results: number[]) => results.reduce((sum, _, k) => sum + defs + CONTEXT + results.slice(0, k + 1).reduce((a, b) => a + b, 0), 0);
    /**
     * The same with full-prefix prompt caching (M2g-2 slice 1), as Anthropic's API prices it: each turn's prompt is the
     * turn before's (read from the cache at 0.1 x) plus what's new (written to it at 1.25 x); the first turn writes it all.
     */
    const cachedInput = (results: number[]) => {
      let total = 0;
      let before = 0;
      results.forEach((r, k) => {
        const now = (k === 0 ? defs + CONTEXT : before) + r;
        total += k === 0 ? 1.25 * now : 0.1 * before + 1.25 * (now - before);
        before = now;
      });
      return Math.round(total);
    };
    const rows: { journey: string; success: boolean; calls: number; tokens: number; defs: number; input: number; cached: number; ms: number }[] = [];
    const journey = async (name: string, play: () => Promise<boolean>) => {
      meter = { calls: 0, chars: 0, results: [], pictures: [] };
      const began = Date.now();
      let success = false;
      try {
        success = await play();
      } catch (e) {
        console.log(`[token eval] ${name} failed: ${String(e)}`);
      }
      rows.push({ journey: name, success, calls: meter.calls, tokens: meter.results.reduce((a, b) => a + b, 0), defs, input: modelInput(meter.results), cached: cachedInput(meter.results), ms: Date.now() - began });
    };
    void tabs;

    await journey('bot game, one hand', async () => {
      const tab = await open('/game');
      if (!lean) {
        // Main's tools, played as well as they allow (round 1 of #145, SF5): one look, and its refs throughout (main
        // finds a redrawn control again too: #117).
        const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
        await act('click', { tab_id: tab, ref: refOf(o, 'generic "Call"') });
        await act('type', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), text: '20' });
        await act('press_key', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), key: 'Enter' });
        await act('click', { tab_id: tab, ref: refOf(o, 'generic "Raise"') });
        return /Call.*bet 20.*Raise/.test(String(await inPage('/game', 'document.getElementById("log").textContent')));
      }
      // As an agent would (Neon's round 1, B-8): it looks first, knowing nothing of the page, then acts by the refs it
      // saw; each action's result says what changed, so no second look.
      const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      await act('click', { tab_id: tab, ref: refOf(o, 'generic "Call"') });
      await act('type', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), text: '20' });
      await act('press_key', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), key: 'Enter' });
      await act('click', { tab_id: tab, ref: refOf(o, 'generic "Raise"') });
      const log = String(await inPage('/game', 'document.getElementById("log").textContent'));
      return /Call.*bet 20.*Raise/.test(log);
    });
    if (lean) {
      const body = await open('/aria-body');
      // Nor does wait_for look at a page's text when the page is an editor (B-3): what shows is what's typed there.
      const EDITOR = 'That page is an editor: what shows in it is what’s typed there, so wait_for looks only for an element by its role and name there.';
      expect((await ask('wait_for', { tab_id: body, text: 'Draft', timeout_ms: 1000 })).text).toBe(EDITOR);
      const design = await open('/design');
      expect((await ask('wait_for', { tab_id: design, text: 'typed secret', timeout_ms: 1000 })).text).toBe(EDITOR);
      // The page's root editable (round 1 of #145).
      const root = await open('/root-editor');
      expect((await ask('wait_for', { tab_id: root, text: 'typed root', timeout_ms: 1000 })).text).toBe(EDITOR);
      // Never what doesn't show (S-5): a frame's fallback text, a button with no size.
      const ghosts = await open('/ghosts');
      for (const want of [{ text: 'Ghost text' }, { role: 'button', name: 'Ghost' }]) {
        expect(JSON.parse((await ask('wait_for', { tab_id: ghosts, ...want, timeout_ms: 500 })).text), JSON.stringify(want)).toMatchObject({ data: { met: false } });
      }
      expect(JSON.parse((await ask('wait_for', { tab_id: ghosts, text: 'Shown text', timeout_ms: 500 })).text)).toMatchObject({ data: { met: true } });
      // A change inside an open shadow root wakes a look (N-6): met well before the page's one-second chunk ends.
      await inPage('/ghosts', 'setTimeout(() => { document.getElementById("host").shadowRoot.querySelector("p").textContent = "Shadow ready"; }, 200); 0');
      const shadow = JSON.parse((await ask('wait_for', { tab_id: ghosts, text: 'Shadow ready', timeout_ms: 3000 })).text) as { data: { met: boolean; waited_ms: number } };
      expect(shadow.data.met).toBe(true);
      expect(shadow.data.waited_ms).toBeLessThan(800);
    }
    await journey('timed table, two turns', async () => {
      const tab = await open('/timed?others=1500');
      for (let turn = 0; !lean && turn < 2; turn++) {
        // Polling (main): a snapshot each second until Call shows, then Call by its ref.
        for (;;) {
          const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
          if (o.includes('generic "Call"')) {
            await act('click', { tab_id: tab, ref: refOf(o, 'generic "Call"') });
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        // The click's own turn: the others play again before Call shows.
        await new Promise((r) => setTimeout(r, 300));
      }
      // A first look, as an agent knowing nothing of the page would (round 1 of #145, SF5); then it waits for its turn.
      if (lean) await ask('snapshot', { tab_id: tab });
      for (let turn = 0; lean && turn < 2; turn++) {
        const waited = waitAnswer((await ask('wait_for', { tab_id: tab, role: 'generic', name: 'Call', snapshot: true, timeout_ms: 20_000 })).text);
        await act('click', { tab_id: tab, ref: refOf(waited.lines, 'generic "Call"') });
      }
      const log = String(await inPage('/timed', 'document.getElementById("log").textContent'));
      return (log.match(/Call after/g) ?? []).length === 2 && !log.includes('auto-folded');
    });
    await journey('a 20-field form', async () => {
      const tab = await open('/form20');
      const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      if (!lean) {
        for (let i = 1; i <= 20; i++) await act('type', { tab_id: tab, ref: refOf(o, `textbox "Field ${i}"`), text: `v${i}` });
        return ((await inPage('/form20', '[...document.querySelectorAll("input")].map((i) => i.value).join(",")')) as string) === Array.from({ length: 20 }, (_, i) => `v${i + 1}`).join(',');
      }
      // Every field in one call (batch): each step as its own type call would go, gates and all.
      const filled = await act('batch', { tab_id: tab, steps: Array.from({ length: 20 }, (_, i) => ({ tool: 'type', ref: refOf(o, `textbox "Field ${i + 1}"`), text: `v${i + 1}` })) });
      if (filled.error) throw new Error(filled.text);
      const values = (await inPage('/form20', '[...document.querySelectorAll("input")].map((i) => i.value).join(",")')) as string;
      return values === Array.from({ length: 20 }, (_, i) => `v${i + 1}`).join(',');
    });
    // Not metered (Neon's round 1, B-8): a step that can't go, found before any step runs.
    if (lean) {
      const tab = await open('/form20?again=1');
      const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      const stopped = await act('batch', { tab_id: tab, steps: [{ tool: 'type', ref: refOf(o, 'textbox "Field 1"'), text: 'w1' }, { tool: 'type', ref: 'e999', text: 'x' }, { tool: 'type', ref: refOf(o, 'textbox "Field 3"'), text: 'w3' }] });
      // A ref never given (or from another page) is refused before step 1 runs (round 2 of #145): nothing typed.
      expect(stopped.error).toBe(true);
      expect(stopped.text).toMatch(/^Step 2: (There’s no element e999 in that tab|That ref is from an earlier snapshot)/);
      expect(await inPage('/form20?again=1', '[...document.querySelectorAll("input")].slice(0, 3).map((i) => i.value).join(",")')).toBe(',,');
    }
    await journey('a page that draws itself after it loads', async () => {
      const tab = await open('/drawn');
      let o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      // Empty at first look: an agent looks again.
      for (let i = 0; i < 5 && !o.includes('Join table'); i++) {
        await new Promise((r) => setTimeout(r, 400));
        o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      }
      await act('click', { tab_id: tab, ref: refOf(o, 'button "Join table"') });
      return String(await inPage('/drawn', 'document.getElementById("log").textContent')).includes('joined');
    });
    await journey('a 300-row list', async () => {
      const tab = await open('/rows-300');
      if (!lean) {
        const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
        return (await act('click', { tab_id: tab, ref: refOf(o, 'button "Act 150"') })).text.startsWith('{');
      }
      // As an agent would (B-8): it looks first; the outline shows 5 rows of 300 and says how many more, so it asks for
      // the one it wants by its words (find), then clicks it by its ref.
      const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      if (o.includes('Act 150')) throw new Error('the 300 rows weren’t collapsed');
      const found = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Act 150' })).text);
      const clicked = await act('click', { tab_id: tab, ref: refOf(found, 'button "Act 150"') });
      return clicked.text.startsWith('{');
    });
    // M2g-2 slice 1: the honest baseline's new journeys. Every one looks first.
    await journey('reading one section of 50', async () => {
      const tab = await open('/article50');
      // As an agent reads a long page: the first range, then the next, until it finds what it was asked for.
      let start = 0;
      for (let i = 0; i < 6; i++) {
        const read = JSON.parse((await ask('read_tab', { tab_id: tab, start })).text) as { content: string; range: { end: number; total: number } };
        const found = /The code word is (\w+)\./.exec(read.content);
        if (found) return found[1] === 'saffron';
        if (read.range.end >= read.range.total) return false;
        start = read.range.end;
      }
      return false;
    });
    const effects = async (path: string, noDiff: boolean) => {
      const tab = await open(path);
      let o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      // [a click whose effect the next step needs, the element that effect shows]
      const steps: [string, string][] = [
        ['button "Delete order 12"', 'button "Delete for good"'],
        ['button "Show details of order 15"', 'button "Refund order 15"'],
      ];
      for (const [first, then] of steps) {
        const clicked = await act('click', { tab_id: tab, ref: refOf(o, first) }, { noDiff });
        if (noDiff) {
          // No diff: it looks again to see what the click did.
          o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
          await act('click', { tab_id: tab, ref: refOf(o, then) }, { noDiff });
        } else {
          const lines = ((JSON.parse(clicked.text) as { data: { page_changes?: { lines?: string[] } } }).data.page_changes?.lines ?? []).filter((l) => !l.startsWith('- ')).map((l) => l.slice(2)).join('\n');
          await act('click', { tab_id: tab, ref: refOf(lines, then) });
        }
      }
      return String(await inPage(path, 'document.getElementById("log").textContent')).trim() === 'deleted 12 refunded 15';
    };
    await journey('an action’s effect, seen in the diff', () => effects('/effects', false));
    await journey('an action’s effect, seen by a snapshot (no diff)', () => effects('/effects?nodiff=1', true));
    await journey('a broad find (300 orders, each with Cancel)', async () => {
      const tab = await open('/orders300');
      await ask('snapshot', { tab_id: tab });
      // The outline shows 5 of 300 rows: the agent asks for what it wants by its words, as find takes them today.
      const found = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Cancel' })).text).split('\n');
      const row = found.findIndex((l) => l.includes('row "Order 150"'));
      const cancel = found.slice(row).find((l) => l.includes('button "Cancel"'));
      if (row < 0 || !cancel) return false;
      await act('click', { tab_id: tab, ref: /\[ref=(e\d+)\]/.exec(cancel)![1]! });
      return String(await inPage('/orders300', 'document.getElementById("log").textContent')).trim() === 'cancelled 150';
    });
    await journey('a picture of the view', async () => {
      const tab = await open('/game');
      await ask('tab_screenshot', { tab_id: tab });
      const [view] = meter.pictures;
      console.log(`[token eval] the view's picture: ${view?.width} x ${view?.height}`);
      return Boolean(view && view.width > 0);
    });

    // wait_for's cost on a page that renders every frame (its looks are throttled, in the page's own thread): the page's
    // frames in 3 s, without a wait and during one that's never met.
    if (lean) {
      const tab = await open('/game?raf=1');
      const frames = () => inPage('/game?raf=1', 'new Promise((done) => { let n = 0; const end = performance.now() + 3000; const f = () => { n++; if (performance.now() < end) requestAnimationFrame(f); else done(n); }; requestAnimationFrame(f); })') as Promise<number>;
      const alone = await frames();
      const [during, waited] = await Promise.all([frames(), ask('wait_for', { tab_id: tab, text: 'A text this page never shows', timeout_ms: 3000 })]);
      console.log(`[token eval] wait_for on a page rendering every frame: ${alone} frames in 3 s alone, ${during} during the wait`);
      expect(JSON.parse(waited.text)).toMatchObject({ data: { met: false } });
      // Loose (shared runners): the wait never takes the page's frames down by half.
      expect(during).toBeGreaterThan(alone / 2);
    }

    const table = [
      `| Journey | Success | Tool calls | Result tokens | Tool definitions | Model input (est.) | Cached (est.) | Wall (s) |`,
      `|---|---|---|---|---|---|---|---|`,
      ...rows.map((r) => `| ${r.journey} | ${r.success ? 'yes' : 'no'} | ${r.calls} | ${r.tokens} | ${r.defs} | ${r.input} | ${r.cached} | ${(r.ms / 1000).toFixed(1)} |`),
    ].join('\n');
    console.log(`[token eval] ${lean ? 'this build' : 'main'} ${process.env['CHORD_E2E_DISPLAY'] ?? ''}\n${table}`);
    mkdirSync(join(appDir, 'test-results'), { recursive: true });
    writeFileSync(join(appDir, 'test-results', 'token-eval.json'), JSON.stringify({ played: lean ? 'lean' : 'main', rows, toolListTokens: defs, context: CONTEXT }, null, 2));
    // Effectiveness is the gate: every journey succeeds.
    for (const r of rows) expect(r.success, r.journey).toBe(true);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a game whose action controls are pointer divs, re-rendered every 100 ms and every frame; a bet field the page takes the focus from (the owner’s retest of #117)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/game` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    // The page's own log (what its controls and its Enter did), never the controls' words.
    const logText = async () => String(await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))!.executeJavaScript('document.getElementById("log").textContent'), `${site.origin}/game`));
    let outline = await snap();
    // The real button first (the site card), as on the owner's page.
    const ranking = mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Hand rankings"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await ranking).text)).toMatchObject({ data: { done: 'Clicked “Hand rankings”' } });
    // Each control, right after a snapshot, three times over.
    for (let round = 0; round < 3; round++) {
      outline = await snap();
      for (const name of ['Fold', 'Call', 'Raise']) {
        const clicked = await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, `generic "${name}"`) });
        expect(clicked.text, `${name}, round ${round}`).toMatch(/^\{/);
        expect(JSON.parse(clicked.text)).toMatchObject({ data: { done: `Clicked “${name}”` } });
      }
    }
    await expect.poll(async () => (await logText()).match(/\b(Fold|Call|Raise)\b/g)?.join(' ')).toBe('Fold Call Raise Fold Call Raise Fold Call Raise');
    // Enter in the bet field, which the page's tick takes the focus from, three times.
    for (let round = 0; round < 3; round++) {
      outline = await snap();
      const typed = await mcp.call('type', { tab_id: 'a1', ref: refOf(outline, 'textbox "Bet"'), text: `${round + 1}0` });
      expect(typed.text, `the bet, round ${round}`).toMatch(/^\{/);
      // Enter in it, as the owner's agent pressed it (a field in no form: it asks as a submit; allowed, it goes).
      const entering = mcp.call('press_key', { tab_id: 'a1', ref: refOf(outline, 'textbox "Bet"'), key: 'Enter' });
      const card = popover.getByRole('alertdialog');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await popover.waitForTimeout(600);
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      const entered = await entering;
      expect(entered.text, `Enter in the bet, round ${round}`).toMatch(/^\{/);
      // Done, once, and said so: the page took the focus on Enter's keydown (refused, the agent pressed again: two bets).
      expect(JSON.parse(entered.text)).toMatchObject({ data: { done: 'Pressed Enter in “Bet”', focus: 'The page moved the focus away from that field after Enter. Enter was pressed once: call snapshot to see what it did, and don’t press it again.' } });
      await expect.poll(async () => (await logText()).match(/bet \d+/g)?.length ?? 0, `one bet per Enter, round ${round}`).toBe(round + 1);
    }
    expect((await logText()).match(/bet \d+/g)).toEqual(['bet 10', 'bet 20', 'bet 30']);
    // Every frame: the same controls, re-rendered at 60 Hz.
    expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/game?raf=1` })).text)).toMatchObject({ data: { navigated: true } });
    // A node replaced every frame can't be checked and pressed within one: each is clicked, or refused as changed
    // (fails closed), never another element (a stated limit). How many got through is a report.
    outline = await snap();
    const through: string[] = [];
    for (const name of ['Fold', 'Call', 'Raise', 'Fold', 'Call', 'Raise']) {
      const clicked = await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, `generic "${name}"`) });
      if (clicked.text.startsWith('{')) {
        expect(JSON.parse(clicked.text), `${name}, every frame`).toMatchObject({ data: { done: `Clicked “${name}”` } });
        through.push(name);
      } else expect(clicked.text, `${name}, every frame`).toBe('That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.');
    }
    // The log grew by exactly the names clicked, in order: never another control.
    await expect.poll(async () => (await logText()).match(/\b(Fold|Call|Raise)\b/g) ?? []).toEqual(through);
    console.log(`[game] every frame: ${through.length} of 6 clicks went through; the rest refused as changed`);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a press tried again when the page replaces the element as the pointer arrives (the review of #117, round 3)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/moves?m=once` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const inPage = (code: string) => app.evaluate(({ webContents }, [prefix, js]) => webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))!.executeJavaScript(js), [`${site.origin}/moves`, code] as const);
    const log = async () => String(await inPage('document.getElementById("log").textContent'));
    /** The page in the mode, a snapshot, armed: its Go's ref. */
    const ready = async (m: string) => {
      if (m !== 'once') expect(JSON.parse((await mcp.call('navigate', { tab_id: 'a1', url: `${site.origin}/moves?m=${m}` })).text)).toMatchObject({ data: { navigated: true } });
      const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
      await inPage('window.arm()');
      return refOf(outline, 'button "Go"');
    };
    const STALE = 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.';
    // Replaced once as the pointer arrives: the second try finds it, and clicks it (the site card first).
    const clicking = mcp.call('click', { tab_id: 'a1', ref: await ready('once') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await clicking).text)).toMatchObject({ data: { done: 'Clicked “Go”', refound: expect.any(String) } });
    expect(await log()).toBe(' Go');
    // A decoy put where it was, it lower down: the second try points at it where it is now; the decoy never.
    expect(JSON.parse((await mcp.call('click', { tab_id: 'a1', ref: await ready('decoy') })).text)).toMatchObject({ data: { done: 'Clicked “Go”', refound: expect.any(String) } });
    expect(await log()).toBe(' Go');
    // Replaced on every move: three tries, then exactly changed, and nothing clicked.
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('every') })).text).toBe(STALE);
    expect(await log()).toBe('');
    // Between tries, a closed root on it, a twin beside it, it in a form that posts: refused, nothing clicked or sent.
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('closed') })).text).toBe('Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.');
    expect(await log()).toBe('');
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('twin') })).text).toBe(STALE);
    expect(await log()).toBe('');
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('form') })).text).toBe(STALE);
    expect(await log()).toBe('');
    expect(reached.filter((r) => r.includes('wipe'))).toEqual([]);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('re-finding, narrowed (the review of #117): never a twin, a field turned sensitive, a changed target, another frame, a huge page; a node still there that changed is never looked for again', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/redraws` });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    const inPage = (code: string) => app.evaluate(({ webContents }, [url, js]) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript(js), [`${site.origin}/redraws`, code] as const);
    const mode = async (m: string) => {
      await inPage(`window.mode = ${JSON.stringify(m)}`);
      await new Promise((r) => setTimeout(r, 700));
    };
    const STALE = 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.';
    // The site card, once, on a unique button found again (the baseline).
    let o = await snap();
    await new Promise((r) => setTimeout(r, 700));
    const folding = mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Fold"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    expect(JSON.parse((await folding).text)).toMatchObject({ data: { done: 'Clicked “Fold”' } });
    const refused = async (what: string, call: Promise<{ text: string }>, says = STALE) => expect((await call).text, what).toBe(says);
    // Duplicates (two Deletes, one per row): never found again, whichever is gone.
    o = await snap();
    await mode('gone1');
    await refused('a Delete of two', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Delete"') }));
    // A twin appears: two matches, refused.
    await mode('');
    o = await snap();
    await mode('twin');
    await refused('a twin', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Check"') }));
    // Gone (zero matches), or moved into a frame (never looked in).
    await mode('');
    o = await snap();
    await mode('nocall');
    await refused('gone', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Call"') }));
    await mode('framed');
    await refused('in a frame', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Fold"') }));
    // A field turned sensitive (a password, a one-time code, a card's expiry): its shape differs, refused.
    await mode('');
    o = await snap();
    await mode('pw');
    await refused('a password now', mcp.call('type', { tab_id: 'a1', ref: refOf(o, 'textbox "Nickname"'), text: 'x' }));
    await mode('otp');
    await refused('a one-time code now', mcp.call('type', { tab_id: 'a1', ref: refOf(o, 'textbox "Code"'), text: '123' }));
    await mode('cc');
    await refused('a card month now', mcp.call('select_option', { tab_id: 'a1', ref: refOf(o, 'combobox "Month"'), option: '02' }));
    await refused('a card expiry now', mcp.call('type', { tab_id: 'a1', ref: refOf(o, 'textbox "Day"'), text: '2026-11-23' }));
    // A closed root added on redraw: found again, then refused by the check on what's inside it.
    await mode('');
    o = await snap();
    await mode('closed!');
    await refused('a closed root now', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Pass"') }), 'Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t act on it. Ask the user to.');
    // An open root whose link goes elsewhere now: refused.
    await mode('');
    o = await snap();
    await mode('relink');
    await refused('its link goes elsewhere', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Open the way"') }));
    // A swap while a risky step's card is up (Delete row into a form that wipes): refused, nothing sent.
    await mode('');
    o = await snap();
    const deleting = mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Delete row"') });
    const step = popover.getByRole('alertdialog', { name: /^Delete this on / });
    await expect(step).toBeVisible({ timeout: 15_000 });
    await mode('swapdel');
    await step.getByRole('button', { name: 'Allow', exact: true }).click();
    expect([STALE, 'The page changed what that step would do while the card was up, so nothing was done. Call snapshot again.']).toContain((await deleting).text);
    expect(reached.filter((r) => r.includes('wipe'))).toEqual([]);
    // The same control for another item (Table 4, not 3): another element, refused (the owner, 2026-11-24).
    await mode('');
    o = await snap();
    await mode('other');
    await refused('another table', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Sit out"') }));
    // Each item kind, found again in the same item as the page redraws: a row in a section named by aria-labelledby, a
    // row in a region, a list item in a dialog (the walk's items and the act's are the same).
    await mode('');
    o = await snap();
    for (const name of ['Fold here', 'Take seat', 'Show cards']) {
      await new Promise((r) => setTimeout(r, 400));
      const clicked = await mcp.call('click', { tab_id: 'a1', ref: refOf(o, `button "${name}"`) });
      expect(JSON.parse(clicked.text), name).toMatchObject({ data: { done: `Clicked “${name}”`, refound: expect.any(String) } });
    }
    // And in another (a section's heading, a row's or a dialog's name changed): refused, the nearest named item or not.
    for (const [m2, name] of [['lab', 'Fold here'], ['seat', 'Take seat'], ['hand', 'Show cards']] as const) {
      await mode('');
      o = await snap();
      await mode(m2);
      await refused(`${name} in another item`, mcp.call('click', { tab_id: 'a1', ref: refOf(o, `button "${name}"`) }));
    }
    // A node patched in place into another table (still connected, never looked for again; two Mucks: no re-finding
    // either): refused on its items, at every step.
    await mode('');
    o = await snap();
    await inPage(`document.getElementById('pt').setAttribute('aria-label', 'Table 8')`);
    await refused('patched into another table', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Muck"') }));
    await refused('patched, hovered', mcp.call('hover', { tab_id: 'a1', ref: refOf(o, 'button "Muck"') }));
    await inPage(`document.getElementById('pt').setAttribute('aria-label', 'Table 7')`);
    // A swap while a risky step's card is up that keeps the element (its place and shape) but not the step (its form
    // now asks for a card number): exactly "step changed", nothing sent (Claude's test gap).
    await mode('');
    o = await snap();
    const removing = mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Remove item"') });
    const removeCard = popover.getByRole('alertdialog', { name: /^Delete this on / });
    await expect(removeCard).toBeVisible({ timeout: 15_000 });
    await mode('fields');
    await removeCard.getByRole('button', { name: 'Allow', exact: true }).click();
    expect((await removing).text).toBe('The page changed what that step would do while the card was up, so nothing was done. Call snapshot again.');
    expect(reached.filter((r) => r.includes('/remove'))).toEqual([]);
    // A node still there that says something else, with a copy elsewhere: never looked for again.
    await mode('');
    o = await snap();
    await inPage(`document.getElementById('kb').textContent = 'Kept'; document.getElementById('keep').insertAdjacentHTML('beforeend', '<button>Keep</button>')`);
    await refused('changed, still there', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Keep"') }));
    // A huge page (30,000 elements before the button): past the budget, refused.
    o = await snap();
    await inPage('window.huge()');
    await new Promise((r) => setTimeout(r, 700));
    await refused('a huge page', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Call"') }));
    const log = String(await inPage('document.getElementById("log").textContent'));
    expect(log).not.toMatch(/Delete row|Check|Pass|Keep|Open the way|Muck/);
    // Each item kind's control clicked once (the found-again ones), never in another item.
    for (const name of ['Fold here', 'Take seat', 'Show cards']) expect(log.split(name).length - 1, name).toBe(1);
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
    // The same elements keep their refs from one snapshot to the next (M2g-1: the page's own ids).
    expect(Math.max(...[...again.content.matchAll(/ref=e(\d+)/g)].map((m) => Number(m[1])))).toBe(firstMax);

    // Budgets (docs/decisions/S18-agent-mcp.md, "M2: plan"): a typical page (about 1,500 elements) and a 20,000-element one.
    type Times = { times: number[]; after: number[]; nodes: number; keys: number; cut: Record<string, boolean> | null } | null;
    const timesOf = (url: string, runs: number) => app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentSnapshotTimes(u: string, r: number): Promise<Times> } }).chordTestHooks.agentSnapshotTimes(u, r), [url, runs] as const);
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
    for (const [path, rows, runs] of [['/rows-300', 300, 20], ['/noisy', 300, 20], ['/rows-4000', 4000, 5], ['/texts', 0, 5]] as const) {
      await mcp.call('open_tab', { url: `${site.origin}${path}` });
      const measured = (await timesOf(`${site.origin}${path}`, runs))!;
      const ms = sorted(measured.times);
      const median = ms[Math.floor(ms.length / 2)]!;
      const worst = ms[ms.length - 1]!;
      // The slow end, without its single slowest run: one pause on a shared runner (a collection, the scheduler) can take
      // one run far past it (#154's macOS x64 run: medians 25 ms, one run 213 ms), as the huge pages' median allows for.
      const p90 = ms[Math.floor(ms.length * 0.9)]!;
      const seen = `${path}: ${rows * 5} elements, ${measured.nodes} nodes, ${measured.keys} keys, cut ${JSON.stringify(measured.cut)}; median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, worst ${worst.toFixed(1)} ms (${ms.map((t) => t.toFixed(0)).join(' ')})`;
      test.info().annotations.push({ type: 'snapshot timing', description: seen });
      console.log(`[snapshot timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${seen}`);
      if (rows === 300) {
        // Every key, unless a shared runner was slow enough for the scan's own time bound (SNAPSHOT_SCAN_MS) to cut it:
        // that's the bound working, and reported like the times.
        if (TIMES_HELD || !measured.cut?.['time']) expect(measured.keys, seen).toBe(600);
        const typical = SNAPSHOT_TYPICAL_MS[`${process.platform}/${process.arch}`] ?? SNAPSHOT_TYPICAL_MS['default']!;
        within(median, typical.median, seen);
        within(p90, typical.worst, seen);
        // The refs' items, place and shape, taken in the task right after the snapshot answers (the review of #117).
        const after = sorted(measured.after);
        const afterMedian = after[Math.floor(after.length / 2)]!;
        const afterSeen = `${path}: the refs' re-find data after the snapshot, median ${afterMedian.toFixed(1)} ms (${after.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[snapshot timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${afterSeen}`);
        expect(after.every((t) => t > 0), afterSeen).toBe(true);
        within(afterMedian, typical.median, afterSeen);
        // M2c: an action's own work before its input goes (the element checked, scrolled to, hit-tested), on this page.
        type ActTimes = { times: number[]; deep: number[]; refind: number[]; refound: number; failed?: string } | null;
        const act = (await app.evaluate((_e, [u, r]) => (globalThis as unknown as { chordTestHooks: { agentActTimes(u: string, r: number): Promise<ActTimes> } }).chordTestHooks.agentActTimes(u, r), [`${site.origin}${path}`, 30] as const))!;
        expect(act.failed).toBeUndefined();
        const at = sorted(act.times);
        const actMedian = at[Math.floor(at.length / 2)]!;
        const actP95 = at[Math.floor(at.length * 0.95)]!;
        const actSeen = `${path}: an action's point step, median ${actMedian.toFixed(1)} ms, p95 ${actP95.toFixed(1)} ms (${at.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${actSeen}`);
        within(actMedian, ACT_POINT_MS.median, actSeen);
        within(actP95, ACT_POINT_MS.p95, actSeen);
        // The owner's bug #2: the same step on the element after the page replaced it with a copy (found again, or not:
        // a page of rows named alike is two matches). A report; its cap is act.ts' REFIND_MS.
        const rf = sorted(act.refind);
        const refindSeen = `${path}: the point step on a replaced element, found again ${act.refound}/${rf.length}, median ${rf[Math.floor(rf.length / 2)]!.toFixed(1)} ms, p95 ${rf[Math.floor(rf.length * 0.95)]!.toFixed(1)} ms`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${refindSeen}`);
        // Each row's button is unique there, so each is found again; well within act.ts' REFIND_MS (50 ms).
        expect(act.refound, refindSeen).toBe(rf.length);
        within(rf[Math.floor(rf.length / 2)]!, 25, refindSeen);
        // Neon's review of #110: the debugger's session a press or typing opens, on this page. The document's first
        // finds Chord's world (Runtime enabled once: the page's stored console replayed, ~1,000 entries at most on
        // /noisy); the rest don't.
        const [first, ...later] = act.deep;
        const dt = sorted(later);
        const deepMedian = dt[Math.floor(dt.length / 2)]!;
        const deepP95 = dt[Math.floor(dt.length * 0.95)]!;
        const deepSeen = `${path}: the debugger's session, first ${first!.toFixed(1)} ms, then median ${deepMedian.toFixed(1)} ms, p95 ${deepP95.toFixed(1)} ms (${dt.map((t) => t.toFixed(0)).join(' ')})`;
        console.log(`[act timing] ${process.env['CHORD_E2E_DISPLAY'] ?? ''} ${deepSeen}`);
        within(first!, ACT_DEEP_MS.first, deepSeen);
        within(deepMedian, ACT_DEEP_MS.median, deepSeen);
        within(deepP95, ACT_DEEP_MS.p95, deepSeen);
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
          within(extra, SEND_WATCH_EXTRA_MS, watchSeen);
        }
      } else {
        // The median of five: one pause in five (a garbage collection on a page of 2,000,000 text nodes) took 777 ms once
        // on main itself, its other runs 35 to 43 ms. The worst is in the message.
        within(median, SNAPSHOT_HUGE_MS, seen);
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
 * Times are held where they were measured: in the Linux container (no CI variable) and on reference hardware
 * (CHORD_PERF_ENFORCE=1). On CI's shared runners they're reported, never failed, as perf.spec.ts's are
 * (docs/testing/performance.md): a time is the runner's load as much as Chord's, and these budgets failed ten CI runs
 * in two days (2026-11-22 to 24: medians of 27 against 25 ms, worsts of 77 against 60 and 128 against 90) with no
 * change to the snapshot. Every count stays checked everywhere.
 */
const TIMES_HELD = !process.env['CI'] || process.env['CHORD_PERF_ENFORCE'] === '1';

/** A time under its budget where times are held; elsewhere, one over it is reported on the test, never failed. */
function within(ms: number, budget: number, seen: string): void {
  if (TIMES_HELD) expect(ms, seen).toBeLessThan(budget);
  else if (ms >= budget) test.info().annotations.push({ type: 'over budget (reported on CI)', description: `${ms.toFixed(1)} ms, budget ${budget} ms: ${seen}` });
}

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
/** The typical page's snapshot budget by platform: its median, and its slow end (p90 of 20 runs: never one pause). */
const SNAPSHOT_TYPICAL_MS: Record<string, { median: number; worst: number }> = {
  default: { median: 25, worst: 60 },
  'darwin/x64': { median: 45, worst: 90 },
  'darwin/arm64': { median: 40, worst: 90 },
  // The arm64 runners (#117): main measured 22.6–23.5 ms there (1.5–2.4 ms under 25); keeping each ref's item chain
  // and its shape's parts in the walk (so a page that redraws can't take re-finding away) adds about 0.6–1.5 ms
  // (3–6%, timed in one page against main), which put them at 24.4–25.1 ms.
  'linux/arm64': { median: 28, worst: 60 },
  'win32/arm64': { median: 28, worst: 60 },
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
    // M2e-1: a page that reloads itself twice, then sends itself on with a meta refresh (no hand of yours in it).
    // It waits 1.5 s each time, so the test can show it first (a tab no window shows is let go of anyway).
    '/ticker':
      '<title>Ticker</title><script>const n = Number(sessionStorage.n || 0); sessionStorage.n = n + 1; document.title = "Ticker " + n;' +
      'if (n < 2) setTimeout(() => location.reload(), 1500); else setTimeout(() => { location.href = "/refresh"; }, 1500);</script>',
    '/refresh': '<title>Refreshing</title><meta http-equiv="refresh" content="1;url=/poster#ticked">',
    // M2e-1: a page that sends once after it loads, numbered by its load in this tab (/collect?<its hash>=<n>).
    '/poster':
      '<title>Poster</title><script>const n = Number(sessionStorage.p || 0) + 1; sessionStorage.p = n; document.title = "Poster " + n;' +
      'setTimeout(() => fetch("/collect?" + location.hash.slice(1) + "=" + n, { method: "POST", body: "x" }).catch(() => {}), 300);</script>',
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
      // What goes with it (the owner's test of 982ce10): a filled note, one radio of three checked, a box left unchecked,
      // an empty card field.
      '<label>Gift note: <input name=note value="For Ada"></label> <fieldset><legend>Size</legend><label><input type=radio name=size value=s> Small</label> <label><input type=radio name=size value=m checked> Medium</label> <label><input type=radio name=size value=l> Large</label></fieldset> ' +
      '<label><input type=checkbox name=wrap> Gift wrap</label> <label>Card number <input name=card autocomplete=cc-number></label> <button>Place order · $48.20</button></form>' +
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
      // Round 4 of #112: a button in an open shadow root, inside a form that posts: the form counts.
      '<form method=post action=/shadow-next><x-next></x-next></form><script>document.querySelector("x-next").attachShadow({ mode: "open" }).innerHTML = "<button>Next step</button>";</script>' +
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
      '<button onclick="w.postMessage(\'fetch\')">Worker</button> <button onclick="w.postMessage(\'xhr\')">Worker XHR</button> ' +
      '<button onclick="w.postMessage(\'nested\')">Nested worker</button> <button onclick="w.postMessage(\'putback\')">Worker puts fetch back</button> ' +
      '<button onclick="sh ? sh.port.postMessage(1) : (log.textContent += \' no shared worker\')">Shared worker</button> ' +
      // Round 4: an OPTIONS that carries a body sends it.
      '<button onclick="fetch(\'/options-fetch\', { method: \'OPTIONS\', body: \'x\' }).catch(() => {})">Options with a body</button> ' +
      '<button onclick="const x = new XMLHttpRequest(); x.open(\'OPTIONS\', \'/options-xhr\'); x.send(\'x\')">Options XHR with a body</button>' +
      '<p id=log></p>' +
      '<script>const w = new Worker("/w.js"); w.onmessage = (e) => { log.textContent += " " + e.data; }; const sh = window.SharedWorker ? new SharedWorker("/shared.js") : null; if (sh) sh.port.start();</script></main>',
    // A link to a page that saves as it loads (the final pass: the Allow given counts, after the action's own navigation).
    '/goes': '<title>Goes</title><main><a href="/saves-on-load">Onward</a></main>',
    '/saves-on-load': '<title>Saves</title><main><p>Saved.</p><script>fetch("/loaded-save", { method: "POST", body: "x" });</script></main>',
    // A single-page app: a click that moves its address (pushState) and saves (round 4: the Allow still counts).
    '/spa': '<title>App</title><main><button onclick="history.pushState({}, \'\', \'/spa/next\'); fetch(\'/spa-save\', { method: \'POST\', body: \'x\' })">Save and go on</button></main>',
    // A page of yours on the same site as an agent's tab: the site's service worker controls both (#112 review 3).
    '/mailbox': '<title>Mailbox</title><main><h1>Mailbox</h1></main>',
    // Round 4 of #112: a page that sends as it's closed (pagehide, keepalive), and one that looks for what an agent's
    // tab never has (shared workers, deferred sends, service workers), in itself and in frames a script makes.
    '/leaving': '<title>Leaving</title><main><p>Bye.</p><script>addEventListener("pagehide", () => { fetch("/bye", { method: "POST", body: "x", keepalive: true }); navigator.sendBeacon("/bye-beacon", "x"); });</script></main>',
    '/lookout':
      '<title>Lookout</title><main><button onclick="navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16) } }).then(() => { log.textContent += \' key:given\'; }, (e) => { log.textContent += \' key:\' + e.name; })">Use a key</button><p id=log></p><script>' +
      'const what = (w) => [typeof w.SharedWorker, typeof w.fetchLater, String("serviceWorker" in w.navigator)].join("/");' +
      'log.textContent += " page:" + what(window);' +
      'const f = document.createElement("iframe"); document.body.append(f); log.textContent += " blank:" + what(f.contentWindow);' +
      'addEventListener("message", (e) => { log.textContent += " " + e.data; });' +
      // A sandboxed frame's origin is opaque: a shared worker or a service worker can't be had there (each throws or is
      // refused), and fetchLater is off in an agent's tab. What each attempt came to.
      '</script><iframe sandbox="allow-scripts" srcdoc="<script>(async () => { const r = []; try { fetchLater(&quot;/later-sandboxed&quot;, { method: &quot;POST&quot;, body: &quot;x&quot; }); r.push(&quot;queued&quot;); } catch (e) { r.push(typeof fetchLater === &quot;function&quot; ? e.name : &quot;undefined&quot;); } try { new SharedWorker(&quot;/shared.js&quot;); r.push(&quot;shared&quot;); } catch (e) { r.push(e.name); } try { await navigator.serviceWorker.register(&quot;/sw.js&quot;); r.push(&quot;registered&quot;); } catch (e) { r.push(e.name); } parent.postMessage(&quot;sandboxed:&quot; + r.join(&quot;/&quot;), &quot;*&quot;); })()</script>"></iframe>' +
      // The final pass of #112: a plain srcdoc frame, a sandboxed one of the same origin, and a frame of another site.
      '<iframe srcdoc="<script>parent.postMessage(&quot;srcdoc:&quot; + [typeof SharedWorker, typeof fetchLater, String(&quot;serviceWorker&quot; in navigator)].join(&quot;/&quot;), &quot;*&quot;)</script>"></iframe>' +
      '<iframe sandbox="allow-scripts allow-same-origin" srcdoc="<script>parent.postMessage(&quot;samesandbox:&quot; + [typeof SharedWorker, typeof fetchLater, String(&quot;serviceWorker&quot; in navigator)].join(&quot;/&quot;), &quot;*&quot;)</script>"></iframe>' +
      '<script>const x = document.createElement("iframe"); x.src = location.origin.replace("127.0.0.1", "localhost") + "/frame-report"; document.body.append(x);</script></main>',
    '/frame-report': '<script>parent.postMessage("cross:" + [typeof SharedWorker, typeof fetchLater, String("serviceWorker" in navigator)].join("/"), "*")</script>',
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
    // The owner's bug #2 (2026-11-24): a table that redraws its buttons every 300 ms (a turn timer), the same role, name
    // and place each time; two buttons named alike in one place; and, after Switch, Raise inside a form that buys.
    '/table':
      '<title>Table</title><main><button id=sw onclick="window.mode = \'buy\'">Switch</button><div id=t></div><p id=log></p><script>' +
      'const draw = () => { t.innerHTML = \'<div class=row><button>Fold</button> <button>Call</button> \' + \'<form method=post action=\' + (window.mode === \'buy\' ? \'/buy-chips\' : \'/raise\') + \'><button>Raise</button></form>\' + \'</div><div class=twins><button>Bet</button> <button>Bet</button></div><div class=danger><button>Delete row</button></div>\'; };' +
      'draw(); setInterval(draw, 300);' +
      't.addEventListener(\'click\', (e) => { if (e.target.localName === \'button\' && !e.target.form) { e.preventDefault(); log.textContent += \' \' + e.target.textContent; } });' +
      '</script></main>',
    // The review of #117: a page that redraws every 300 ms by a mode the test sets, one case each.
    // The owner's retest of #117 (2026-11-24): a game's action controls are divs with a pointer cursor, rebuilt by a
    // framework-style render every 100 ms (or every frame, ?raf), in a named table; a bet field the page takes the focus
    // from on its tick; a real button beside them.
    // A page that draws itself after it loads (an app's lobby: the owner's first look at a new tab, 2026-11-24).
    '/lobby': '<title>Lobby</title><style>body{margin:0;background:#fff}</style><div id=app></div><script>setTimeout(() => { document.getElementById("app").innerHTML = "<h1>Lobby</h1><button>Join table</button><div style=\\"background:#e33;width:600px;height:400px\\"></div>"; }, 600)</script>',
    // A timed table (M2g-1's acceptance journey): your turn comes after the others', a shot clock of 15 s then, and
    // the action controls (pointer divs, re-rendered every 100 ms) only while it's your turn. Out of time: folded.
    // The token eval (the owner, 2026-11-24): a 20-field form, and a lobby that draws itself 600 ms after it loads.
    // A name that isn't what it shows (Neon's B3 for M2g-1): never found by it.
    // A button the page renames in place (round 1 of #145, B1), and a list it grows.
    '/rename': '<title>Rename</title><main><ul id=list></ul><button id=d onclick="document.getElementById(\'log\').textContent += \' clicked \' + this.textContent">Draft 1</button><button id=x>Other</button><p id=log></p></main>',
    // M2g-2 slice 1: a long article (its answer in section 37, past read_tab's first range), a page whose clicks have
    // effects the next step needs (a dialog, a row's details), and 300 orders each with View and Cancel.
    '/article50':
      '<title>Fifty sections</title><main><h1>Fifty sections</h1>' +
      Array.from({ length: 50 }, (_, i) => `<section aria-label="Section ${i + 1}"><h2>Section ${i + 1}</h2><p>${i === 36 ? 'The code word is saffron. ' : ''}${'This paragraph is here to make the section as long as a real one, with nothing to find in it. '.repeat(12)}</p></section>`).join('') +
      '</main>',
    '/effects':
      '<title>Orders</title><main><ul id=list>' +
      [11, 12, 13, 14, 15, 16].map((n) => `<li id=o${n}>Order ${n} <button data-del=${n}>Delete order ${n}</button> <button data-show=${n}>Show details of order ${n}</button><span hidden><button data-refund=${n}>Refund order ${n}</button></span></li>`).join('') +
      '</ul><div role=dialog aria-label="Confirm" id=dlg hidden><p>Delete this order?</p><button id=yes>Delete for good</button> <button id=no>Keep</button></div><p id=log></p></main>' +
      '<script>let pending = 0; const log = (s) => { document.getElementById("log").textContent += " " + s; }; document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.del) { pending = b.dataset.del; document.getElementById("dlg").hidden = false; } else if (b.id === "yes") { document.getElementById("o" + pending).remove(); document.getElementById("dlg").hidden = true; log("deleted " + pending); } else if (b.id === "no") { document.getElementById("dlg").hidden = true; } else if (b.dataset.show) { b.parentElement.querySelector("span").hidden = false; } else if (b.dataset.refund) { log("refunded " + b.dataset.refund); } });</script>',
    '/orders300':
      '<title>Orders</title><main><table><tbody>' +
      Array.from({ length: 300 }, (_, i) => `<tr aria-label="Order ${i + 1}"><td>Order ${i + 1}</td><td><button data-n=${i + 1} data-a=view>View</button> <button data-n=${i + 1} data-a=cancel>Cancel</button></td></tr>`).join('') +
      '</tbody></table><p id=log></p></main><script>document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && b.dataset.a === "cancel") document.getElementById("log").textContent += " cancelled " + b.dataset.n; });</script>',
    '/aria-body': '<title>Editor</title><body contenteditable aria-label="Pay body">Draft</body>',
    '/root-editor': '<!doctype html><html contenteditable><head><title>Root</title></head><body><p>typed root</p></body></html>',
    '/design': '<title>Design</title><p>typed secret</p><script>document.designMode = "on";</script>',
    '/ghosts': '<title>Ghosts</title><main><p>Shown text</p><iframe srcdoc="<p>in the frame</p>">Ghost text</iframe><button style="width:0;height:0;padding:0;border:0;overflow:hidden">Ghost</button><div id=host></div></main><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<p>Shadow wait</p>";</script>',
    '/form20': `<title>Sign up</title><main><form onsubmit="return false"><h1>Sign up</h1>${Array.from({ length: 20 }, (_, i) => `<label>Field ${i + 1} <input name=f${i + 1}></label>`).join('')}</form></main>`,
    '/drawn': '<title>Lobby</title><div id=app></div><p id=log></p><script>setTimeout(() => { document.getElementById("app").innerHTML = "<h1>Lobby</h1><button>Join table</button>"; document.querySelector("#app button").onclick = () => { document.getElementById("log").textContent += " joined"; }; }, 600)</script>',
    '/timed': '<title>Timed table</title><style>.act{cursor:pointer;display:inline-block;padding:8px 12px;margin:4px;border:1px solid #888}</style><main><div role=region aria-label="Table 9"><p id=status>Waiting for the others</p><div id=controls></div></div><p id=log></p></main><script src="/timed.js"></script>',
    '/game': '<title>Game</title><style>.act{cursor:pointer;display:inline-block;padding:8px 12px;margin:4px;border:1px solid #888}</style><main><div id=table role=region aria-label="Table 3" tabindex=-1><div id=controls></div><label>Bet <input id=bet></label> <button id=rankings>Hand rankings</button></div><p id=log></p></main><script src="/game.js"></script>',
    // The press tried again (the review of #117, round 3): the page replaces its button as the pointer arrives, once
    // armed (window.arm), in the way ?m= says.
    '/moves': '<title>Moves</title><main id=m></main><p id=log></p><script src="/moves.js"></script>',
    '/redraws': '<title>Redraws</title><div id=big></div><div id=keep><button id=kb>Keep</button></div><div id=pt role=region aria-label="Table 7"><button>Muck</button> <button>Muck</button></div><main id=m></main><p id=log></p><script src="/redraws.js"></script>',
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
      '/w.js':
        'const report = (p, what) => p.then(() => postMessage(what + " sent"), (e) => postMessage(what + ": " + e.message));' +
        'onmessage = (e) => {' +
        ' if (e.data === "fetch") report(fetch("/worker-save", { method: "POST", body: "x" }), "worker");' +
        ' if (e.data === "xhr") { try { const x = new XMLHttpRequest(); x.open("POST", "/worker-xhr"); x.send("x"); postMessage("xhr sent"); } catch (err) { postMessage("xhr: " + err.message); } }' +
        ' if (e.data === "nested") { const n = new Worker("/w.js"); n.onmessage = (m) => postMessage("nested " + m.data); n.postMessage("fetch"); }' +
        ' if (e.data === "putback") { try { delete self.fetch; } catch {} try { self.fetch = () => 0; } catch {} report(fetch("/worker-putback", { method: "POST", body: "x" }), "putback"); }' +
        '};',
      '/shared.js': 'onconnect = (e) => { const port = e.ports[0]; port.onmessage = () => fetch("/shared-save", { method: "POST", body: "x" }); };',
      '/timed.js': `
        const status = document.getElementById('status');
        const c = document.getElementById('controls');
        const log = document.getElementById('log');
        const OTHERS_MS = Number(new URLSearchParams(location.search).get('others') || 3000);
        const CLOCK_MS = 15000;
        let turn = null;
        const render = () => {
          if (!turn) { c.innerHTML = ''; return; }
          const left = Math.max(0, Math.ceil((CLOCK_MS - (performance.now() - turn.at)) / 1000));
          c.innerHTML = '<div class=act>Fold</div><div class=act>Call</div><div class=act>Raise</div>';
          status.textContent = 'Your turn: ' + left + ' s';
        };
        const yourTurn = () => {
          turn = { at: performance.now(), n: (turn ? turn.n : 0) + 1 };
          window.turnAt = Date.now();
          turn.clock = setTimeout(() => { log.textContent += ' auto-folded'; others(); }, CLOCK_MS);
          render();
        };
        const others = () => {
          if (turn) clearTimeout(turn.clock);
          turn = null;
          status.textContent = 'Waiting for the others';
          render();
          setTimeout(yourTurn, OTHERS_MS);
        };
        setInterval(render, 100);
        c.addEventListener('click', (e) => {
          const a = e.target.closest('.act');
          if (!a || !turn) return;
          log.textContent += ' ' + a.textContent + ' after ' + Math.round(performance.now() - turn.at) + ' ms';
          others();
        });
        others();
      `,
      '/game.js': `
        const c = document.getElementById('controls');
        const log = document.getElementById('log');
        const render = () => { c.innerHTML = '<div class=act data-a=fold>Fold</div><div class=act data-a=call>Call</div><div class=act data-a=raise>Raise</div>'; };
        render();
        if (location.search.includes('raf')) { const frame = () => { render(); requestAnimationFrame(frame); }; requestAnimationFrame(frame); } else setInterval(render, 100);
        c.addEventListener('click', (e) => { const a = e.target.closest('.act'); if (a) log.textContent += ' ' + a.textContent; });
        document.getElementById('rankings').addEventListener('click', () => { log.textContent += ' rankings'; });
        const bet = document.getElementById('bet');
        // Enter takes the bet on its keydown, then gives the table the focus (the owner's game: round 3 of #117).
        bet.addEventListener('keydown', (e) => { if (e.key === 'Enter') { log.textContent += ' bet ' + bet.value; document.getElementById('table').focus(); } });
        // The page's tick takes the focus to its table (keyboard shortcuts), once a second.
        setInterval(() => document.getElementById('table').focus(), 1000);
      `,
      '/moves.js': `
        const m = document.getElementById('m');
        const kind = new URLSearchParams(location.search).get('m') || 'once';
        // (A closed root takes a div with a button's role: a button can't have a shadow root.)
        const go = kind === 'closed' ? '<div class=row><div role=button tabindex=0>Go</div></div>' : '<div class=row><button>Go</button></div>';
        m.innerHTML = go;
        let armed = false;
        window.arm = () => { armed = true; };
        // On the pointer's (trusted) move: once (the second try finds it), every time (never), a decoy where it was and
        // it lower down, a closed root on it, a twin beside it, it in a form that posts.
        document.addEventListener('mousemove', (e) => {
          if (!armed || !e.isTrusted) return;
          if (kind !== 'every') armed = false;
          if (kind === 'once' || kind === 'every') m.innerHTML = go;
          if (kind === 'decoy') m.innerHTML = '<div class=row><button>Fold</button></div>' + go;
          if (kind === 'closed') { m.innerHTML = go; m.querySelector('[role=button]').attachShadow({ mode: 'closed' }).innerHTML = '<span>Go</span>'; }
          if (kind === 'twin') m.innerHTML = go + go;
          if (kind === 'form') m.innerHTML = '<form method=post action=/wipe>' + go + '</form>';
        }, true);
        m.addEventListener('click', (e) => { const b = e.target.closest('button, [role=button]'); if (b) { e.preventDefault(); document.getElementById('log').textContent += ' ' + b.textContent; } });
      `,
      '/redraws.js': `
        window.mode = '';
        const m = document.getElementById('m');
        const render = () => {
          // A mode ending in ! redraws once, then holds still (a case that needs the node found to stay put).
          if (window.mode.endsWith('!') && window.drawn === window.mode) return;
          window.drawn = window.mode;
          const md = window.mode.replace('!', '');
          let h = '';
          h += md === 'framed' ? '<div class=row><iframe srcdoc="<button>Fold</button>"></iframe> <button>Call</button></div>' : '<div class=row><button>Fold</button> ' + (md === 'nocall' ? '' : '<button>Call</button>') + '</div>';
          h += '<ul>' + (md === 'gone1' ? '' : '<li><span>Row one</span> <button>Delete</button></li>') + '<li><span>Row two</span> <button>Delete</button></li></ul>';
          h += md === 'swapdel' ? '<form method=post action=/wipe><div class=danger><button>Delete row</button></div></form>' : '<div class=danger><button>Delete row</button></div>';
          h += '<label>Nickname <input type=' + (md === 'pw' ? 'password' : 'text') + '></label>';
          h += '<label>Code <input type=text' + (md === 'otp' ? ' autocomplete=one-time-code' : '') + '></label>';
          h += '<label>Month <select' + (md === 'cc' ? ' autocomplete=cc-exp-month' : '') + '><option>01</option><option>02</option></select></label>';
          h += '<label>Day <input type=date' + (md === 'cc' ? ' autocomplete=cc-exp' : '') + '></label>';
          h += '<div class=pass><div role=button tabindex=0 id=pass>Pass</div></div>';
          h += '<a href="' + (md === 'relink' ? '/elsewhere' : '/home') + '"><x-in></x-in></a>';
          h += '<div class=solo><button>Check</button></div>' + (md === 'twin' ? '<div class=solo><button>Check</button></div>' : '');
          h += '<div role=region aria-label="' + (md === 'other' ? 'Table 4' : 'Table 3') + '"><button>Sit out</button></div>';
          // Unnamed rows and list items, in named sections, regions and dialogs (the review of #117, round 3).
          h += '<section aria-labelledby=t5><h3 id=t5>' + (md === 'lab' ? 'Table 6' : 'Table 5') + '</h3><table><tr><td><button>Fold here</button></td></tr></table></section>';
          h += '<div role=region aria-label=Lobby><div role=row aria-label="' + (md === 'seat' ? 'Seat 2' : 'Seat 1') + '"><button>Take seat</button></div></div>';
          h += '<div role=dialog aria-label="' + (md === 'hand' ? 'Hand 13' : 'Hand 12') + '"><ul><li><button>Show cards</button></li></ul></div>';
          h += '<form method=post action=/remove><label>Note <input name=note></label>' + (md === 'fields' ? '<label>Card <input name=cc autocomplete=cc-number></label>' : '') + '<button>Remove item</button></form>';
          m.innerHTML = h;
          if (md === 'closed') document.getElementById('pass').attachShadow({ mode: 'closed' }).innerHTML = '<span>Pass</span>';
          m.querySelector('x-in').attachShadow({ mode: 'open' }).innerHTML = '<button>Open the way</button>';
        };
        render();
        setInterval(render, 300);
        window.huge = () => { const big = document.getElementById('big'); for (let i = 0; i < 30000; i++) { const d = document.createElement('span'); d.textContent = 'x'; big.append(d); } };
        const logClicks = (e) => { const b = e.target.closest('button, [role=button]'); if (b && !b.closest('form')) { e.preventDefault(); document.getElementById('log').textContent += ' ' + b.textContent; } };
        m.addEventListener('click', logClicks);
        document.getElementById('pt').addEventListener('click', logClicks);
      `,
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
    // Any method but a read (a preflight without a body is one: round 4 of #112).
    const sends = req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'OPTIONS' && !Number(req.headers['content-length'] ?? 0));
    if (sends || /\/delete(\b|$)/.test(req.url ?? '')) {
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
            : (pages[req.url ?? '/'] ?? pages[(req.url ?? '/').split('?')[0]!]);
    // /lookout sends a Permissions-Policy that doesn't parse (the final pass of #112: an agent's tab replaces it).
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', ...(req.url === '/lookout' ? { 'permissions-policy': '@' } : {}) });
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

    // Shown over your chord: its bar stays on, steady, while it has been at work there in the last 45 s (the owner,
    // 2026-11-24: never off and on between its actions); never paused.
    await section.getByRole('button', { name: /Release notes/ }).click();
    await expect(shell.getByRole('status').filter({ hasText: /Paused/ })).toHaveCount(0);

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

test('your hand on an agent’s tab: its row’s × and middle-click close it; an agent with no tabs has no section; the page’s own reloads never take it over (M2e-1)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/notes` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    await mcp.call('open_tab', { url: `${site.origin}/notes#two` });
    const section = shell.getByRole('region', { name: 'Codex’s tabs' });
    await expect(section.getByRole('button', { name: /Release notes/ })).toHaveCount(2);

    // The row's × (your own rows' close button: shown on hover): the agent hears the tab is gone.
    const first = section.locator('[data-agent-tab]').first();
    await first.hover();
    const close = first.locator('button[aria-label^="Close"]');
    await expect(close).toHaveCSS('opacity', '1');
    await expect(close).toHaveAttribute('title', /Close tab/);
    // For the PR: the × on an agent's row, as on your own.
    mkdirSync(capturesDir, { recursive: true });
    await shell.screenshot({ path: join(capturesDir, 'agent-tab-close.png') });
    await close.click();
    await expect(section.getByRole('button', { name: /Release notes/ })).toHaveCount(1);
    expect((await mcp.call('read_tab', { tab_id: 'a1' })).text).toBe('That tab is closed. Use list_tabs for the tabs there are now.');

    // Middle-click closes the last one: the agent is still connected, but its section goes.
    await section.locator('[data-agent-tab]').first().click({ button: 'middle' });
    await expect(section).toHaveCount(0);
    expect((JSON.parse((await mcp.call('list_tabs')).text) as { data: { tabs: unknown[] } }).data.tabs).toEqual([]);

    // Its next tab brings the section back. On screen while the page reloads itself twice, then sends itself on with a
    // meta refresh: never you (no button, key or menu of Chord's), so never paused, and what it sends is still held.
    await mcp.call('open_tab', { url: `${site.origin}/ticker` });
    await section.getByRole('button', { name: /Ticker/ }).click();
    const host = new URL(site.origin).host;
    const ownSite = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);
    const held = popover.getByRole('alertdialog', { name: ownSite });
    await expect(held).toBeVisible({ timeout: 15_000 });
    await expect(held).toContainText('Codex’s tab wants to send data to its site.');
    await expect(section.getByRole('button', { name: /Poster/ })).toBeVisible();
    await expect(shell.getByRole('status').filter({ hasText: 'Paused while you use this tab' })).toHaveCount(0);
    expect(reached.filter((r) => r.startsWith('POST /collect'))).toEqual([]);
    await popover.waitForTimeout(600);
    await held.getByRole('button', { name: 'Don’t', exact: true }).click();
    await expect(held).toHaveCount(0);
    expect(reached.filter((r) => r.startsWith('POST /collect'))).toEqual([]);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('your hand on an agent’s tab: Back, Reload (the app menu’s, the row menu’s) and a typed address each fail what it held; paused only where you see it (M2e-1)', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  reached.length = 0;
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const overlay = await pageWhere(app, isOverlay);
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mine = (await where(shell)).tabId!;
    const windowId = (await where(shell)).windowId;
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const host = new URL(site.origin).host;
    const ownSite = new RegExp(`^Send data to http://${host.replace(/\./g, '\\.')}\\?$`);
    const card = popover.getByRole('alertdialog', { name: ownSite });
    const section = shell.getByRole('region', { name: 'Codex’s tabs' });
    const paused = shell.getByRole('status').filter({ hasText: 'Paused while you use this tab' });
    const collected = () => reached.filter((r) => r.startsWith('POST /collect'));

    // [what you do, its key in the page's sends, whether you see the tab, whether the page loads again (its second send)]
    const rows: [string, string, boolean, boolean][] = [
      ['the toolbar’s Back', 'back', true, false],
      ['the app menu’s Reload', 'reload', true, true],
      ['the row menu’s Reload, on a tab no window shows', 'hidden', false, true],
      ['an address typed in the address bar', 'typed', true, false],
    ];
    let first = true;
    for (const [what, key, shown, reloads] of rows) {
      // Back needs a page behind it: the agent goes from its first page to the poster (the site card, once).
      const opening = mcp.call('open_tab', { url: `${site.origin}/${key === 'back' ? 'notes' : `poster#${key}`}` });
      if (first) await answer(app, 'Codex', 'Allow once');
      first = false;
      const opened = JSON.parse((await opening).text) as { data: { tab_id: string } };
      if (key === 'back') {
        const going = mcp.call('navigate', { tab_id: opened.data.tab_id, url: `${site.origin}/poster#back` });
        const siteCard = siteCardOf(popover, 'Codex');
        await expect(siteCard).toBeVisible({ timeout: 15_000 });
        await popover.waitForTimeout(600);
        await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
        expect((await going).isError, what).toBeFalsy();
      }
      // Its send after it loads: held, the card up.
      await expect(card, what).toBeVisible({ timeout: 15_000 });
      const row = section.locator('[data-agent-tab]').filter({ hasText: /Poster/ });
      const nodeId = (await row.getAttribute('data-agent-tab'))!;
      if (shown) await row.getByRole('button').first().click();
      else await dispatch(shell, { t: 'tab.activate', windowId, nodeId: mine });
      if (key === 'back') await shell.getByRole('button', { name: 'Back', exact: true }).click();
      else if (key === 'reload') await runAction(shell, 'nav.reload');
      else if (key === 'hidden') await shell.evaluate((id) => (window as unknown as { chord: { tab: { reload(id: string): Promise<void> } } }).chord.tab.reload(id), nodeId);
      else {
        await runAction(shell, 'address.edit');
        await overlay.keyboard.type(`${site.origin}/notes#typed`);
        await overlay.keyboard.press('Enter');
      }
      // What it held never reaches the site.
      if (shown) {
        await expect(paused, what).toBeVisible();
        await expect(card, what).toHaveCount(0);
      }
      await new Promise((r) => setTimeout(r, 800));
      expect(collected(), what).not.toContain(`POST /collect?${key}=1`);
      if (shown && reloads) {
        // The page you reloaded, while you have the tab: what it sends is yours.
        await expect.poll(collected, { message: what }).toContain(`POST /collect?${key}=2`);
      }
      if (!shown) {
        // Not paused (you can't see it): still the agent's, so the reloaded page's send is held again.
        expect((await mcp.call('read_tab', { tab_id: opened.data.tab_id })).isError, what).toBe(false);
        await expect(card, what).toBeVisible({ timeout: 15_000 });
        await popover.waitForTimeout(600);
        await card.getByRole('button', { name: 'Don’t', exact: true }).click();
        expect(collected(), what).not.toContain(`POST /collect?${key}=2`);
      }
      if (key === 'typed') await expect(section.getByRole('button', { name: /Release notes/ }), what).toBeVisible();
      if (shown) await paused.getByRole('button', { name: 'Let Codex continue' }).click();
      expect((await mcp.call('close_tab', { tab_id: opened.data.tab_id })).isError, what).toBeFalsy();
      await expect(section).toHaveCount(0);
    }
    mcp.child.stdin!.end();
    await mcp.exited;
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
