/** Outside agents acting (S18 M2c–d), end to end: typing, clicking and choosing in its own tab, the cards for a site, a risky step and what a page sends, and what a page does meanwhile. Split from agents.spec.ts (#213). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ACT_REFUSALS, ACT_SENDS_WAITING, sendsLater } from '@chord/core';
import { failOnMainErrors } from './main-errors';
import { dispatch, isPopover, isShell, pageWhere, pressReal, where } from './a11y-kit';
import { CLAUDE, CODEX, agents, agentsSettings, answer, appDir, launch, reached, refOf, relay, siteCardOf, startAgentSite } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

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
    // checkFloatingFocus gives it back to your page, #201).
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

test('a Send data card still up at the call’s deadline: the call answers that the step ran and what it sent waits; the card stays; Allow sends it, and the next result says so (#143)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  // A call's deadline of 4 s (CALL_WAIT_MS, 50 s for real: under Codex's 60), a card's own wait of 20 s.
  const app = await launch(profile, { CHORD_AGENTS: '1', CHORD_AGENT_CALL_WAIT_MS: '4000', CHORD_AGENT_WAIT_MS: '20000' });
  reached.length = 0;
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/noise` });
    await answer(app, 'Codex', 'Allow once');
    await opening;
    const popover = await pageWhere(app, isPopover);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    // The site card, once, so the step's own card is the Send data card.
    const first = mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'tab "Details"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    await first;
    // A toggle that saves: its Send data card, left unanswered past the call's deadline.
    const started = Date.now();
    const toggled = await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'checkbox "Dark mode"') });
    expect(Date.now() - started, 'answered by the call’s deadline, not the card’s').toBeLessThan(12_000);
    expect(toggled.isError, toggled.text).toBeFalsy();
    expect(JSON.parse(toggled.text)).toMatchObject({ data: { done: 'Clicked “Dark mode”', sending: ACT_SENDS_WAITING, loading: true } });
    // Never its outcome in the same answer.
    expect(toggled.held.some((h) => h.includes('"later"'))).toBe(false);
    // The card stays up, for the user's own time; nothing's sent yet.
    const card = popover.getByRole('alertdialog', { name: /^Send data to / });
    await expect(card).toBeVisible();
    expect(reached).not.toContain('POST /prefs');
    // Another action on that tab meanwhile: refused, saying why.
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), 'button "Like"') })).text).toBe(ACT_REFUSALS.sendsPending);
    // The user allows: it's sent, and the agent's next result says so.
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect.poll(() => reached.includes('POST /prefs')).toBe(true);
    const next = await mcp.call('snapshot', { tab_id: 'a1' });
    // Its outcome, inside the untrusted envelope (the step is in the page's words).
    const settled = next.held.map((h) => JSON.parse(h) as { trust?: string; data?: { later?: unknown } }).find((h) => h.data?.later);
    expect(settled).toEqual({ trust: 'untrusted', data: { later: [sendsLater('a1', 'click', 'Clicked “Dark mode”', 'allowed', true)] } });
    // Said once: the result after has none.
    expect((await mcp.call('snapshot', { tab_id: 'a1' })).held.some((h) => h.includes('"later"'))).toBe(false);
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
