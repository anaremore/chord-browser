/**
 * M2d's follow-ups, PR 1 (#115: docs/decisions/S18-m2g-timed-pages/m2d-followups.md). An agent's page never makes Chord
 * fetch an icon from an address it picks (M1); a send held by its card between actions never goes when the tab closes,
 * by the agent or by you (M4).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { failOnMainErrors } from './main-errors';
import { isPopover, isShell, pageWhere } from './a11y-kit';
import { ACT_REFUSALS } from '@chord/core';
import { CODEX, agents, asked, iconCookies, launch, reached, relay, startAgentSite } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

/** An agent's calls, each card it raises allowed as the user would, except the Send data card (left up). */
async function allowing(app: ElectronApplication, mcp: ReturnType<typeof relay>) {
  const popover = await pageWhere(app, isPopover);
  return async (name: string, args: Record<string, unknown>) => {
    const calling = mcp.call(name, args);
    for (;;) {
      const card = popover.getByRole('alertdialog').first();
      const next = await Promise.race([calling.then(() => 'done' as const), card.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'card' as const)]);
      if (next === 'done') return calling;
      if (/^Send data to /.test((await card.getAttribute('aria-label')) ?? (await card.textContent()) ?? '')) return calling;
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
}

test('an agent’s page never makes Chord fetch an icon from another origin, nor follow its own icon’s redirect (#115, M1)', async () => {
  test.setTimeout(90_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    asked.length = 0;
    expect((await allowed('open_tab', { url: `${site.origin}/icons-other` })).text).toMatch(/^\{/);
    // Its own icon is fetched (the fetch path ran), never the other origin's named before it.
    await expect.poll(() => asked.filter((a) => a.endsWith(' /fav-own.png')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(asked.filter((a) => a.includes('/fav-other.png'))).toEqual([]);
    expect((await allowed('open_tab', { url: `${site.origin}/icons-redirect` })).text).toMatch(/^\{/);
    await expect.poll(() => asked.filter((a) => a.endsWith(' /fav-redirect')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1000));
    // The redirect is never followed: the other origin's target never asked.
    expect(asked.filter((a) => a.includes('/fav-target.png'))).toEqual([]);
    // Its own icon, with a cookie of its own origin set: fetched with no Cookie header (credentials 'omit': #322's N5).
    iconCookies.length = 0;
    expect((await allowed('open_tab', { url: `${site.origin}/icons-cookie` })).text).toMatch(/^\{/);
    await expect.poll(() => iconCookies.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(iconCookies).toEqual(iconCookies.map(() => ''));
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a send held by its card in an action never goes when its tab closes, by the agent or by you; the card goes, and the click answers (#322, Opus’s N1)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const popover = await pageWhere(app, isPopover);
    const shell = await pageWhere(app, isShell);
    const sendCard = popover.getByRole('alertdialog', { name: /^Send data to / });
    for (const how of ['agent', 'you'] as const) {
      reached.length = 0;
      const opened = JSON.parse((await allowed('open_tab', { url: `${site.origin}/now-send`, snapshot: true })).text) as { tab_id: string; content: string };
      const ref = /button "Save now" \[ref=(e\d+)\]/.exec(opened.content)?.[1];
      expect(ref, opened.content).toBeDefined();
      // The click's page sends at once: held, the click waiting on its card (the site card answered, as the user would).
      const clicking = allowed('click', { tab_id: opened.tab_id, ref: ref! });
      await expect(sendCard).toBeVisible({ timeout: 15_000 });
      if (how === 'agent') expect((await mcp.call('close_tab', { tab_id: opened.tab_id })).isError).toBeFalsy();
      else {
        const row = shell.getByRole('region', { name: 'Codex’s tabs' }).locator('[data-agent-tab]').first();
        await row.hover();
        await row.locator('button[aria-label^="Close"]').click();
      }
      await expect(sendCard).toBeHidden({ timeout: 10_000 });
      // The click answers (whatever it says), never left waiting.
      await clicking;
      await new Promise((r) => setTimeout(r, 2000));
      expect(reached.filter((r) => r.includes('now-post')), `closed by ${how}`).toEqual([]);
    }
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a send held by its card between actions never goes when its tab closes, by the agent or by you; the card goes (#115, M4)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const popover = await pageWhere(app, isPopover);
    const shell = await pageWhere(app, isShell);
    const sendCard = popover.getByRole('alertdialog', { name: /^Send data to / });
    for (const how of ['agent', 'you'] as const) {
      reached.length = 0;
      const opened = JSON.parse((await allowed('open_tab', { url: `${site.origin}/later-send`, snapshot: true })).text) as { tab_id: string; content: string };
      const ref = /button "Save later" \[ref=(e\d+)\]/.exec(opened.content)?.[1];
      expect(ref, opened.content).toBeDefined();
      // The click answers at once; its page sends 1.5 s later: held, its card up between actions.
      const clicked = await allowed('click', { tab_id: opened.tab_id, ref: ref! });
      expect(clicked.isError, clicked.text).toBe(false);
      await expect(sendCard).toBeVisible({ timeout: 15_000 });
      if (how === 'agent') expect((await mcp.call('close_tab', { tab_id: opened.tab_id })).isError).toBeFalsy();
      else {
        const row = shell.getByRole('region', { name: 'Codex’s tabs' }).locator('[data-agent-tab]').first();
        await row.hover();
        await row.locator('button[aria-label^="Close"]').click();
      }
      await expect(sendCard).toBeHidden({ timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 2000));
      expect(reached.filter((r) => r.includes('later-post')), `closed by ${how}`).toEqual([]);
    }
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** Within `ms`, or 'timed out': a renderer stuck in a print dialog never answers. */
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timed out'> => Promise.race([p, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))]);

test('an agent’s tab never prints: every way a page asks is refused, the page goes on, and the agent hears it (#115 PR 2, B3)', async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const cases = ['print', 'deleted', 'frame-print', 'frame-print-on-top', 'srcdoc-print', 'exec', 'exec-upper', 'exec-deleted', 'exec-frame', 'exec-frame-on-top', 'exec-flip', 'assign-strict', 'assign-exec-strict', 'print-later', 'print-twice', 'nested-blank', 'silence-parent', 'silence-proto', 'afterprint', 'silence-cancel', 'silence-remove'];
    for (const c of cases) {
      const opened = JSON.parse((await allowed('open_tab', { url: `${site.origin}/print-ways?c=${c}`, snapshot: true })).text) as { tab_id: string; content: string };
      const ref = /button "Try" \[ref=(e\d+)\]/.exec(opened.content)?.[1];
      expect(ref, opened.content).toBeDefined();
      const held: string[] = [];
      const clicked = await within(allowed('click', { tab_id: opened.tab_id, ref: ref! }), 20_000);
      expect(clicked, c).not.toBe('timed out');
      if (clicked !== 'timed out') held.push(...clicked.held);
      // print-later prints 1.2 s after the click answered: between actions.
      await new Promise((r) => setTimeout(r, c === 'print-later' ? 2500 : 800));
      // The page went on, and its renderer still answers (a print dialog would hold it).
      const read = await within(mcp.call('read_tab', { tab_id: opened.tab_id }), 15_000);
      expect(read, c).not.toBe('timed out');
      if (read !== 'timed out') {
        expect(read.isError, `${c}: ${read.text}`).toBeFalsy();
        held.push(...read.held);
        const content = (JSON.parse(read.text) as { content: string }).content;
        expect(content, c).toContain(`after ${c}`);
        // A page's own wrapping, in strict code, never throws, and is ignored (#336, Opus's S2).
        // A page's own wrapping never throws (#336, Opus's S2). execCommand's is ignored; print's own, a writable value,
        // is the page's own function from then on (Opus's NS1: a page may declare its own print), never the native one.
        if (c.startsWith('assign')) expect(content, c).not.toMatch(/threw/);
        if (c === 'assign-exec-strict') expect(content, c).not.toMatch(/replaced/);
        if (c === 'assign-strict') expect(content, c).toMatch(/replaced/);
        if (c === 'print-later') expect(content, c).toContain('printed-later');
        if (c === 'afterprint') expect(content, c).toContain('beforeprint afterprint');
      }
      // Each way said, in Chord's words (#336, Fable's S3 and N6): the held notes' details, as the agent reads them.
      const details = held.flatMap((h) => {
        try {
          return ((JSON.parse(h) as { held?: { detail: string }[] }).held ?? []).map((n) => n.detail);
        } catch {
          return [h];
        }
      });
      if (c === 'exec') expect(details, c).toContain('the page tried to print (document.execCommand("print")); Chord doesn’t print for agents');
      if (c === 'print-twice') {
        expect(details, c).toContain('the page tried to print (window.print()); Chord doesn’t print for agents');
        expect(details, c).toContain('the page tried to print (document.execCommand("print")); Chord doesn’t print for agents');
      }
      // exec-flip's command reads as "copy" the one time it's turned into a string, so it's a copy, not a print: what
      // it pins is that the page goes on (the original, given the raw argument, would read "print" the second time).
      // (exec-flip is a copy; assign-strict calls the page's own print, never the native one.)
      if (c !== 'exec-flip' && c !== 'assign-strict') expect(held.join(' | '), c).toMatch(/tried to print/);
      expect((await mcp.call('close_tab', { tab_id: opened.tab_id })).isError, c).toBeFalsy();
    }
    // The wrapper's shape, as native (#336, Opus's N5).
    const shape = JSON.parse((await allowed('open_tab', { url: `${site.origin}/print-ways?c=exec-shape`, snapshot: true })).text) as { tab_id: string; content: string };
    await allowed('click', { tab_id: shape.tab_id, ref: /button "Try" \[ref=(e\d+)\]/.exec(shape.content)![1]! });
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: shape.tab_id })).text) as { content: string }).content).toContain('length=1 symbol=TypeError none=TypeError');
    // A page that declares its own print (a function, then a var): its scripts run, and call its own (Opus's NS1).
    const declared = JSON.parse((await allowed('open_tab', { url: `${site.origin}/print-declare`, snapshot: true })).text) as { tab_id: string };
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: declared.tab_id })).text) as { content: string }).content).toContain('own ran var');
    // Copying still works: only print is refused.
    const copy = JSON.parse((await allowed('open_tab', { url: `${site.origin}/print-ways?c=copy`, snapshot: true })).text) as { tab_id: string; content: string };
    await allowed('click', { tab_id: copy.tab_id, ref: /button "Try" \[ref=(e\d+)\]/.exec(copy.content)![1]! });
    expect((JSON.parse((await mcp.call('read_tab', { tab_id: copy.tab_id })).text) as { content: string }).content).toContain('copy=true');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('another site’s frame (its own process) in an agent’s tab never prints either; the agent hears a frame tried (#115 PR 2, B3)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const opened = JSON.parse((await allowed('open_tab', { url: `${site.origin}/print-host`, snapshot: true })).text) as { tab_id: string };
    await new Promise((r) => setTimeout(r, 2000));
    // The frame's own renderer still answers (a dialog would hold it), and its page went on.
    const answer = await app.evaluate(async ({ webContents }) => {
      const tab = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/print-host'));
      const frame = tab?.mainFrame.framesInSubtree.find((f) => f.url.endsWith('/print-self'));
      if (!frame) return 'no frame';
      return Promise.race([frame.executeJavaScript('document.getElementById("s").textContent'), new Promise((r) => setTimeout(() => r('timed out'), 5000))]);
    });
    expect(answer).toBe('printed-on');
    const held = (await mcp.call('read_tab', { tab_id: opened.tab_id })).held.join(' | ');
    expect(held).toMatch(/a frame from http:\/\/localhost:\d+ tried to print/);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a crashed agent tab, reloaded by you (its Reload): the hold is armed again before the page’s first script runs, and the tab is yours (#115 PR 2, B4)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const shell = await pageWhere(app, isShell);
    const url = `${site.origin}/crash-probe`;
    const opened = JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as { tab_id: string };
    // What the page's first script found, read from main (the agent can't read the tab once it's yours).
    const probe = () =>
      app.evaluate(({ webContents }, u) => {
        const tab = webContents.getAllWebContents().find((c) => c.getURL() === u);
        return tab && !tab.isCrashed() ? (tab.executeJavaScript('document.getElementById("probe")?.textContent ?? ""') as Promise<string>) : Promise.resolve('');
      }, url);
    const first = await probe();
    expect(first, 'armed for its first load').toContain('lacks=true printStub=true');
    // You look at it, and its renderer crashes: "This page stopped working", with Reload.
    await shell.getByRole('region', { name: 'Codex’s tabs' }).locator('[data-agent-tab]').first().click();
    await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.forcefullyCrashRenderer(), url);
    const stopped = shell.getByRole('alert').filter({ hasText: 'This page stopped working.' });
    await expect(stopped).toBeVisible({ timeout: 15_000 });
    await stopped.getByRole('button', { name: 'Reload' }).click();
    // The new page ran with the hold's script already in it (a reload that loads first, then arms, runs it without).
    await expect.poll(async () => (await probe().catch(() => '')).match(/load=(\w+)/)?.[1], { timeout: 20_000 }).not.toBe(first.match(/load=(\w+)/)?.[1]);
    expect(await probe(), 'armed before the reload ran').toContain('lacks=true printStub=true');
    // Your reload is a take-over (the planner's call, Argon's B4 part 3): the agent is paused there.
    const read = await mcp.call('read_tab', { tab_id: opened.tab_id });
    expect([read.isError, read.text]).toEqual([true, 'The user is using this tab right now. Wait for them to finish, then call this tool again.']);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a crashed agent tab the agent loads again (navigate): refused, said as a tab that stopped working, and nothing its page would send is sent (#115 PR 2, B4)', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const popover = await pageWhere(app, isPopover);
    const url = `${site.origin}/crash-probe`;
    const opened = JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as { tab_id: string };
    await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.forcefullyCrashRenderer(), url);
    await expect.poll(() => app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((c) => c.getURL() === u)?.isCrashed() ?? null, url), { timeout: 10_000 }).toBe(true);
    reached.length = 0;
    // The agent loads its crashed tab again: the new page posts to another site at once.
    const going = allowed('navigate', { tab_id: opened.tab_id, url: `${site.origin}/crash-sends` });
    const sendCard = popover.getByRole('alertdialog', { name: /^Send data to / });
    const outcome = await Promise.race([sendCard.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'card'), going.then((r) => `answered: ${r.text.slice(0, 160)}`)]);
    await new Promise((r) => setTimeout(r, 1500));
    // Refused outright, and said why (the tab stopped working, never a busy DevTools window): never sent unasked.
    expect(reached.filter((r) => r.includes('crash-post')), String(outcome)).toEqual([]);
    expect(outcome).toBe(`answered: ${ACT_REFUSALS.crashed}`);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
