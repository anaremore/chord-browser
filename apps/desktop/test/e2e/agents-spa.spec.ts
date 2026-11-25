/**
 * An agent acting in a single-page app (S18; Neon's factory audit, item 5): the React app in test/spa, bundled here
 * with rolldown and served for every route. Small static pages never re-render, so the owner's hand test found what no
 * E2E had (#117: refs on a page that redraws). This journey holds what Chord does on such a page: each action does
 * what was asked, to the element asked for, or says why not in words the agent can act on. Never another element.
 *
 * Where a ref's element was replaced by the page (a re-keyed list, a hover that swaps the button), Chord refuses
 * today; finding the element again (#117, M2g) may turn those into clicks. Either passes, as long as it's the element
 * asked for: the page's log says what it got.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ACT_REFUSALS } from '@chord/core';
import { expect, test } from '@playwright/test';
import { build } from 'rolldown';
import { failOnMainErrors } from './main-errors';
import { isShell, pageWhere } from './a11y-kit';
import { answerConnect, answerSite, CODEX, launch, refOf, relay, serving } from './agents-kit';

failOnMainErrors();

let site: { server: Server; origin: string };

test.beforeAll(async () => {
  const bundle = await build({
    input: resolve(import.meta.dirname, '../spa/App.tsx'),
    write: false,
    platform: 'browser',
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
    output: { format: 'iife' },
    logLevel: 'warn',
  });
  const script = bundle.output[0].code;
  const html = '<!doctype html><meta charset=utf-8><title>Shop</title><div id=root></div><script src="/spa.js"></script>';
  const server = createServer((req, res) => {
    if (req.url === '/spa.js') return void (res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }), res.end(script));
    // Every route is the app: it draws the one in the address (a deep link, a reload, Back).
    if (req.url === '/spa' || req.url?.startsWith('/spa/')) return void (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(html));
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  site = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
test.afterAll(() => site.server.close());

type Done = { data: { done: string; navigated: boolean; url: string; page_id: string; note?: string } };

test('a single-page app: controlled fields, nodes replaced under a ref, a portal, a dialog that arrives, shadow DOM and client-side routes', async () => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    await expect.poll(() => serving(app)).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const opening = mcp.call('open_tab', { url: `${site.origin}/spa` });
    await answerConnect(app, 'Codex', 'Allow once');
    await opening;
    await shell.getByRole('region', { name: 'Codex’s tabs' }).getByRole('button', { name: /Shop/ }).click();
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    /** The page's own log of what it got (its "Activity" lines), in its text. */
    const page = async () => (JSON.parse((await mcp.call('read_tab', { tab_id: 'a1' })).text) as { content: string }).content;
    const act = async (tool: string, args: Record<string, unknown> = {}) => (await mcp.call(tool, { tab_id: 'a1', ...args })).text;
    const done = (text: string) => (JSON.parse(text) as Done).data;

    const home = await snap();
    // The app's own tree: the sticky header's links, every section's controls, a field's state never its value.
    expect(home).toContain('- banner\n  - navigation "Shop"');
    expect(home).toContain('textbox "Name" [ref=');
    expect(home).toContain('button "More actions" [ref=');

    // Controlled fields: React owns the value, and what typing put in is what it keeps. The digits-only field throws
    // the letters away; what's saved is what the page took.
    const typing = act('type', { ref: refOf(home, 'textbox "Name"'), text: 'Ada' });
    await answerSite(app, 'Codex', 'Allow for now');
    expect(done(await typing).done).toBe('Typed in “Name”');
    expect(done(await act('type', { ref: refOf(home, 'textbox "Zip code"'), text: 'ab123cd45' })).done).toBe('Typed in “Zip code”');
    expect(done(await act('click', { ref: refOf(home, 'button "Save profile"') })).done).toBe('Clicked “Save profile”');
    expect(await page()).toContain('saved Ada, 12345');

    // A list the page re-keys every 300 ms: the button asked for is a new element by now. Refused, or (once the
    // element can be found again) clicked; never its neighbor.
    const apples = await act('click', { ref: refOf(home, 'button "Pick apples"') });
    if (apples.startsWith('{')) expect(await page()).toContain('picked apples');
    else expect(apples).toBe(ACT_REFUSALS.changed);
    expect(await page()).not.toContain('picked pears');

    // A button the page replaces as the pointer arrives (a hover card): the new one is where the click would land.
    // Today Chord says it's covered, by the button's own name; never clicked unasked.
    const details = await act('click', { ref: refOf(home, 'button "Details"') });
    if (details.startsWith('{')) expect(await page()).toContain('opened details');
    else expect([ACT_REFUSALS.changed, ACT_REFUSALS.covered('button “Details”')]).toContain(details);

    // A portal: the menu renders into the body, outside the app's tree, and its items have refs like any others.
    expect(done(await act('click', { ref: refOf(home, 'button "More actions"') })).done).toBe('Clicked “More actions”');
    const menu = await snap();
    expect(menu).toContain('button "More actions" [ref=');
    expect(menu).toMatch(/- menu "More actions"\n {2}- menuitem "Rename" \[ref=e\d+\]\n {2}- menuitem "Duplicate" \[ref=e\d+\]/);
    expect(done(await act('click', { ref: refOf(menu, 'menuitem "Duplicate"') })).done).toBe('Clicked “Duplicate”');
    expect(await page()).toContain('menu duplicate');

    // Shadow DOM: a custom element's button, in an open shadow root, is in the outline and takes a click.
    expect(done(await act('click', { ref: refOf(menu, 'button "Add one"') })).done).toBe('Clicked “Add one”');
    expect(await page()).toContain('stepped');

    // A dialog that arrives after the snapshot, over the button the agent took a ref to: refused, by the dialog's
    // name; closed, the same ref works.
    const offers = await snap();
    expect(done(await act('click', { ref: refOf(offers, 'button "Show offers"') })).done).toBe('Clicked “Show offers”');
    await expect.poll(page).toContain('Get our newsletter');
    expect(await act('click', { ref: refOf(offers, 'button "Remind me later"') })).toBe(ACT_REFUSALS.covered('dialog “Newsletter”'));
    expect(await page()).not.toContain('reminded later');
    const covered = await snap();
    expect(covered).toContain('- dialog "Newsletter"');
    expect(done(await act('click', { ref: refOf(covered, 'button "No thanks"') })).done).toBe('Clicked “No thanks”');
    expect(done(await act('click', { ref: refOf(covered, 'button "Remind me later"') })).done).toBe('Clicked “Remind me later”');
    expect(await page()).toContain('reminded later');
    // Far below the sticky header: scrolled to, and clicked.
    expect(done(await act('click', { ref: refOf(covered, 'button "See all reviews"') })).done).toBe('Clicked “See all reviews”');
    expect(await page()).toContain('saw reviews');

    // A client-side route (pushState): the result says the page changed, with its new address; refs from before are
    // stale; the new route's are good; Back returns to the app's home.
    const before = await snap();
    const routed = done(await act('click', { ref: refOf(before, 'link "Orders"') }));
    expect(routed).toMatchObject({ done: 'Clicked “Orders”', navigated: true, url: `${site.origin}/spa/orders`, note: 'The page changed: call snapshot again before using refs from before.' });
    expect(await act('click', { ref: refOf(before, 'button "Save profile"') })).toBe('That ref is from an earlier snapshot. Call snapshot again, then use its refs.');
    const orders = await snap();
    expect(orders).toContain('heading "Orders" [level=1]');
    expect(done(await act('click', { ref: refOf(orders, 'button "Show parcel 7"') })).done).toBe('Clicked “Show parcel 7”');
    expect(await page()).toContain('opened parcel 7');
    expect(done(await act('back'))).toMatchObject({ done: 'Went back', navigated: true, url: `${site.origin}/spa` });
    expect(await snap()).toContain('heading "Home" [level=1]');

    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
