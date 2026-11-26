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
