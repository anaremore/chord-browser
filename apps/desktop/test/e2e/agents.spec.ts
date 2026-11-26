/**
 * Outside agents end to end (S18 M1b–d): a Chord serving its endpoint (Settings
 * → Agents, or CHORD_AGENTS=1 in development builds), and `chord mcp` (the same
 * executable, its relay) started as an agent starts it. The connect card in the
 * popover lets it in: Deny, Allow once, Always allow (no card next time, until
 * those sign-ins are gone). Then its Agent chord, its tools, the bar and Stop.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { failOnMainErrors } from './main-errors';
import { audit, capturesDir, closeSettings, dispatch, expectClean, isOverlay, isPopover, isSettings, isShell, pageWhere, pressReal, runAction, settle, where } from './a11y-kit';
import { CLAUDE, CODEX, type Hooks, agents, agentsSettings, answer, cardOf, launch, reached, relay, siteCardOf, startAgentSite } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

const DENIED = 'The user denied this connection in Chord. Stop using Chord’s tools and tell the user.';

const NO_AGENTS = 'No agents yet. Copy a line above into your terminal to connect one.';

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
