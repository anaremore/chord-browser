/** Outside agents on pages that change (S18 M2c, M2g): refs found again or refused, first looks, timed pages, wait_for, the token eval, a game, a press tried again. Split from agents.spec.ts (#213). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { ACT_REFUSALS } from '@chord/core';
import { failOnMainErrors } from './main-errors';
import { isPopover, pageWhere } from './a11y-kit';
import { CODEX, agents, answer, appDir, launch, reached, refOf, relay, siteCardOf, startAgentSite } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

/** An agent's calls, each with every card it raises allowed as the user would (round 1 of #247: one helper, not two). */
async function allowing(app: ElectronApplication, mcp: ReturnType<typeof relay>) {
  const popover = await pageWhere(app, isPopover);
  return async (name: string, args: Record<string, unknown>) => {
    const calling = mcp.call(name, args);
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
}

/**
 * wait_for's answer, met or not, and the lines to find refs in: the outline (no snapshot of the page before), or what
 * changed since (M2g-1), its gone lines left out.
 */
function waitAnswer(text: string): { met: boolean; lines: string } {
  const w = JSON.parse(text) as { content?: string; wait?: { met: boolean }; data?: { met: boolean; page_changes?: { lines?: string[] } } };
  if (w.content !== undefined) return { met: w.wait?.met === true, lines: w.content };
  return { met: w.data?.met === true, lines: (w.data?.page_changes?.lines ?? []).filter((l) => !l.startsWith('- ')).map((l) => l.slice(2)).join('\n') };
}

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
    // Two buttons named alike in one place: never a guess, and said so (#211).
    expect((await mcp.call('click', { tab_id: 'a1', ref: refOf(outline, 'button "Bet"') })).text).toBe(ACT_REFUSALS.ambiguous);
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
    // open_tab's snapshot: true (M2g-2 slice 3a, #204): the first look comes with the tab, no call of its own.
    // read_tab by a part's ref (#207).
    const readsParts = Boolean((tools as unknown as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find((t) => t.name === 'read_tab')?.inputSchema.properties['ref']);
    const opensLooking = Boolean((tools as unknown as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find((t) => t.name === 'open_tab')?.inputSchema.properties['snapshot']);
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
     * Opens a tab and looks at it, as an agent knowing nothing of the page would: with snapshot: true where open_tab takes
     * it (one call), else open_tab and then snapshot (two).
     */
    const look = async (path: string): Promise<{ tab: string; outline: string }> => {
      if (!opensLooking) {
        const tab = await open(path);
        return { tab, outline: outlineOf((await ask('snapshot', { tab_id: tab })).text) };
      }
      const opened = await act('open_tab', { url: `${site.origin}${path}`, snapshot: true });
      tabs++;
      const body = JSON.parse(opened.text) as { tab_id?: string; content?: string; data?: { no_outline?: string } };
      if (!body.tab_id || body.content === undefined) throw new Error(`open_tab gave no outline: ${body.data?.no_outline ?? opened.text}`);
      return { tab: body.tab_id, outline: body.content };
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

    /** The hand, by the refs of the first look. */
    const played = async (tab: string, o: string) => {
      await act('click', { tab_id: tab, ref: refOf(o, 'generic "Call"') });
      await act('type', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), text: '20' });
      await act('press_key', { tab_id: tab, ref: refOf(o, 'textbox "Bet"'), key: 'Enter' });
      await act('click', { tab_id: tab, ref: refOf(o, 'generic "Raise"') });
      const log = String(await inPage('/game', 'document.getElementById("log").textContent'));
      return /Call.*bet 20.*Raise/.test(log);
    };
    await journey('bot game, one hand', async () => {
      if (lean && opensLooking) {
        const { tab, outline } = await look('/game');
        return played(tab, outline);
      }
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
      return played(tab, o);
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
      // The first look with the tab, where open_tab takes snapshot: true.
      const tab = lean && opensLooking ? (await look('/timed?others=1500')).tab : await open('/timed?others=1500');
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
      if (lean && !opensLooking) await ask('snapshot', { tab_id: tab });
      for (let turn = 0; lean && turn < 2; turn++) {
        const waited = waitAnswer((await ask('wait_for', { tab_id: tab, role: 'generic', name: 'Call', snapshot: true, timeout_ms: 20_000 })).text);
        await act('click', { tab_id: tab, ref: refOf(waited.lines, 'generic "Call"') });
      }
      const log = String(await inPage('/timed', 'document.getElementById("log").textContent'));
      return (log.match(/Call after/g) ?? []).length === 2 && !log.includes('auto-folded');
    });
    await journey('a 20-field form', async () => {
      const { tab, outline: o } = await look('/form20');
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
      // #154's first look waits for it to draw (snapshot's, and open_tab's with snapshot: true).
      const first = await look('/drawn');
      const tab = first.tab;
      let o = first.outline;
      // Empty at first look: an agent looks again.
      for (let i = 0; i < 5 && !o.includes('Join table'); i++) {
        await new Promise((r) => setTimeout(r, 400));
        o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
      }
      await act('click', { tab_id: tab, ref: refOf(o, 'button "Join table"') });
      return String(await inPage('/drawn', 'document.getElementById("log").textContent')).includes('joined');
    });
    await journey('a 300-row list', async () => {
      // Looking as it opens where open_tab takes snapshot: true (the lean build's way).
      const { tab, outline: first300 } = lean && opensLooking ? await look('/rows-300') : { tab: await open('/rows-300'), outline: '' };
      if (!lean) {
        const o = outlineOf((await ask('snapshot', { tab_id: tab })).text);
        return (await act('click', { tab_id: tab, ref: refOf(o, 'button "Act 150"') })).text.startsWith('{');
      }
      // As an agent would (B-8): it looks first; the outline shows 5 rows of 300 and says how many more, so it asks for
      // the one it wants by its words (find), then clicks it by its ref.
      const o = opensLooking ? first300 : outlineOf((await ask('snapshot', { tab_id: tab })).text);
      if (o.includes('Act 150')) throw new Error('the 300 rows weren’t collapsed');
      const found = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Act 150' })).text);
      const clicked = await act('click', { tab_id: tab, ref: refOf(found, 'button "Act 150"') });
      return clicked.text.startsWith('{');
    });
    // M2g-2 slice 1: the honest baseline's new journeys. Every one looks first.
    await journey('reading one section of 50', async () => {
      // #207: asked about section 37, an agent looks at the page as it opens, finds the section by its words, and reads
      // just it by its ref; where read_tab takes no ref, it reads the page in ranges until it finds it.
      if (lean && readsParts) {
        const { tab: opened } = await look('/article50');
        const found = outlineOf((await ask('snapshot', { tab_id: opened, find: 'Section 37', text: false })).text);
        const part = /region "Section 37" \[ref=(c\d+)\]/.exec(found)?.[1];
        if (!part) throw new Error(`no ref for section 37 in ${found}`);
        const read = JSON.parse((await ask('read_tab', { tab_id: opened, ref: part })).text) as { content: string };
        return /The code word is (\w+)\./.exec(read.content)?.[1] === 'saffron';
      }
      const tab = await open('/article50');
      // As an agent reads a long page: the first range, then the next, until it finds what it was asked for.
      let start = 0;
      for (let i = 0; i < 30; i++) {
        const read = JSON.parse((await ask('read_tab', { tab_id: tab, start })).text) as { content: string; range: { end: number; total: number } };
        const found = /The code word is (\w+)\./.exec(read.content);
        if (found) return found[1] === 'saffron';
        if (read.range.end >= read.range.total) return false;
        start = read.range.end;
      }
      return false;
    });
    // #206: the answer near the top of a long page (the article's lead): one range, as long as the default is.
    await journey('reading the start of a long page', async () => {
      const tab = await open('/article50-lead');
      let start = 0;
      for (let i = 0; i < 12; i++) {
        const read = JSON.parse((await ask('read_tab', { tab_id: tab, start })).text) as { content: string; range: { end: number; total: number } };
        const found = /The first word is (\w+)\./.exec(read.content);
        if (found) return found[1] === 'juniper';
        if (read.range.end >= read.range.total) return false;
        start = read.range.end;
      }
      return false;
    });
    const effects = async (path: string, noDiff: boolean) => {
      const first = await look(path);
      const tab = first.tab;
      let o = first.outline;
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
      // It looks first (the outline shows 5 of 300 rows).
      const { tab } = await look('/orders300');
      // The outline shows 5 of 300 rows: the agent asks for what it wants by its words, as find takes them today.
      const found = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Cancel' })).text).split('\n');
      // A flat find (#208): each line with its item. Twenty of three hundred: the line after says to narrow it by the
      // item's words, and the agent does. (A build without it: the tree, each match under its row.)
      let cancel = found.find((l) => l.includes('button "Cancel"') && l.includes('(in row "Order 150")'));
      if (!cancel && found.some((l) => l.includes('more matches: make find narrower'))) {
        cancel = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Cancel 150' })).text)
          .split('\n')
          .find((l) => l.includes('button "Cancel"') && l.includes('(in row "Order 150")'));
      }
      if (!cancel) {
        const row = found.findIndex((l) => l.includes('row "Order 150"'));
        cancel = row < 0 ? undefined : found.slice(row).find((l) => l.includes('button "Cancel"'));
      }
      if (!cancel) return false;
      await act('click', { tab_id: tab, ref: /\[ref=(e\d+)\]/.exec(cancel)![1]! });
      return String(await inPage('/orders300', 'document.getElementById("log").textContent')).trim() === 'cancelled 150';
    });
    // Round 1 of #263: the same, its rows plain (no name: a row is labelled by its first text).
    await journey('a broad find, plain rows (300 unnamed rows, each with Cancel)', async () => {
      // It looks first (the outline shows 5 of 300 rows).
      const { tab } = await look('/orders300-plain');
      // The outline shows 5 of 300 rows: the agent asks for what it wants by its words, as find takes them today.
      const found = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Cancel' })).text).split('\n');
      // A flat find (#208): each line with its item. Twenty of three hundred: the line after says to narrow it by the
      // item's words, and the agent does. (A build without it: the tree, each match under its row.)
      let cancel = found.find((l) => l.includes('button "Cancel"') && l.includes('(in row "Order 150")'));
      if (!cancel && found.some((l) => l.includes('more matches: make find narrower'))) {
        cancel = outlineOf((await ask('snapshot', { tab_id: tab, find: 'Cancel 150' })).text)
          .split('\n')
          .find((l) => l.includes('button "Cancel"') && l.includes('(in row "Order 150")'));
      }
      if (!cancel) {
        const row = found.findIndex((l) => l.includes('row "Order 150"'));
        cancel = row < 0 ? undefined : found.slice(row).find((l) => l.includes('button "Cancel"'));
      }
      if (!cancel) return false;
      await act('click', { tab_id: tab, ref: /\[ref=(e\d+)\]/.exec(cancel)![1]! });
      return String(await inPage('/orders300-plain', 'document.getElementById("log").textContent')).trim() === 'cancelled 150';
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

test('open_tab and navigate with snapshot: true: the page as snapshot gives it, in the same answer, its refs good to act by (M2g-2 slice 3a, #204)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    type Look = { source: string; trust: string; tab_id: string; url: string; content: string; open_tab?: Record<string, unknown>; navigate?: Record<string, unknown> };

    // A page that draws itself 600 ms after it loads: open_tab's outline waited for it (#154's first look), and its ref
    // is good to click by.
    const opened = await allowed('open_tab', { url: `${site.origin}/drawn`, snapshot: true });
    expect(opened.isError).toBe(false);
    const lobby = JSON.parse(opened.text) as Look;
    expect(lobby).toMatchObject({ source: 'web_snapshot', trust: 'untrusted', url: `${site.origin}/drawn`, open_tab: {} });
    const join = refOf(lobby.content, 'button "Join table"');
    expect((await allowed('click', { tab_id: lobby.tab_id, ref: join })).isError).toBe(false);
    await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.getElementById("log").textContent'), `${site.origin}/drawn`)).toContain('joined');

    // navigate there and look in one call: the outline, every read rule of snapshot's (a password, code or card field has
    // its line and no ref; what's in a field never shows); the action's own words under navigate.
    const went = await allowed('navigate', { tab_id: lobby.tab_id, url: `${site.origin}/snap`, snapshot: true });
    expect(went.isError).toBe(false);
    const snap = JSON.parse(went.text) as Look;
    expect(snap).toMatchObject({ source: 'web_snapshot', trust: 'untrusted', tab_id: lobby.tab_id, url: `${site.origin}/snap`, navigate: { navigated: true } });
    expect(snap.navigate!['note']).toBeUndefined();
    const lines = snap.content.split('\n').map((l) => l.trim());
    expect(lines).toContain('- textbox "Password" [password: the user signs in]');
    expect(lines).toContain('- textbox "Code" [one-time code: the user types it]');
    for (const never of ['hunter2-secret', 'secret-note-value', '4242']) expect(snap.content).not.toContain(never);
    // Its refs are the tab's latest: one of them acts.
    expect((await allowed('click', { tab_id: lobby.tab_id, ref: refOf(snap.content, 'button "Start a return"') })).isError).toBe(false);
    // Without it, as before: the action's answer alone.
    const plain = JSON.parse((await allowed('navigate', { tab_id: lobby.tab_id, url: `${site.origin}/drawn` })).text) as { source?: string; data: Record<string, unknown> };
    expect(plain.source).toBeUndefined();
    expect(plain.data).toMatchObject({ navigated: true });
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('snapshot with text: false: the page’s structure without its text, a fraction of the size, its refs good to act by (M2g-2 slice 3b, #205)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const tabOf = (text: string) => (JSON.parse(text) as { data: { tab_id: string } }).data.tab_id;
    type Snap = { trust: string; source: string; content: string; refs: number };

    // The 50-section page: the whole outline, then its structure alone (what a model is sent: the result's text).
    // (The page as #205 measured it: its sections plain. #207 makes named ones regions, which collapse as rows alike.)
    const article = tabOf((await allowed('open_tab', { url: `${site.origin}/article50-plain` })).text);
    const full = await mcp.call('snapshot', { tab_id: article });
    const outline = await mcp.call('snapshot', { tab_id: article, text: false });
    const fullSnap = JSON.parse(full.text) as Snap;
    const outlineSnap = JSON.parse(outline.text) as Snap;
    expect(outlineSnap).toMatchObject({ trust: 'untrusted', source: 'web_snapshot' });
    expect(fullSnap.content).toMatch(/- text: "This paragraph/);
    expect(outlineSnap.content).not.toMatch(/- text:/);
    expect(outlineSnap.content).toMatch(/- heading "Section 1" \[level=2\]/);
    expect(outlineSnap.content).toBe(fullSnap.content.split('\n').filter((l) => !/^\s*- text:/.test(l)).join('\n'));
    const smaller = 1 - outline.text.length / full.text.length;
    console.log(`[#205] /article50-plain: full snapshot ${full.text.length} chars (~${Math.ceil(full.text.length / 4)} tokens), text: false ${outline.text.length} chars (~${Math.ceil(outline.text.length / 4)} tokens): ${(smaller * 100).toFixed(1)}% smaller; outline alone ${fullSnap.content.length} → ${outlineSnap.content.length} chars (${((1 - outlineSnap.content.length / fullSnap.content.length) * 100).toFixed(1)}% smaller)`);
    // #205's Done when: at least 70% smaller than the full snapshot, as sent (a size, never a time).
    expect(smaller).toBeGreaterThanOrEqual(0.7);

    // A page to act on: its outline without text, then a ref from it.
    const game = tabOf((await allowed('open_tab', { url: `${site.origin}/game` })).text);
    const look = JSON.parse((await mcp.call('snapshot', { tab_id: game, text: false })).text) as Snap;
    expect(look.content).not.toMatch(/- text:/);
    const clicked = await allowed('click', { tab_id: game, ref: refOf(look.content, 'generic "Call"') });
    expect(clicked.isError).toBe(false);
    await expect.poll(() => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.getElementById("log").textContent'), `${site.origin}/game`)).toContain('Call');
    // No full snapshot of the page to compare with: the action says so.
    expect((JSON.parse(clicked.text) as { data: { page_changes?: { note?: string } } }).data.page_changes?.note).toBe('You have no full snapshot of this page to compare with, so what changed can’t be told: call snapshot without text: false to see it.');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('read_tab by a part’s container ref: just its shown text, as the page read leaves things out, never a field, an editor or a frame; refused when the part changed, and by every acting tool (M2g-2, #207)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const tab = (JSON.parse((await allowed('open_tab', { url: `${site.origin}/parts` })).text) as { data: { tab_id: string } }).data.tab_id;
    const inPage = (code: string) => app.evaluate(({ webContents }, [url, js]) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript(js), [`${site.origin}/parts`, code] as const);
    const outline = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as { content: string }).content;
    // Each container its c ref: a named section (a region), a navigation, an article, a table.
    const partRef = (line: string) => new RegExp(`${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[ref=(c\\d+)\\]`).exec(outline)?.[1];
    for (const line of ['region "Orders"', 'navigation "Site"', 'article "Story"', 'table "Prices"']) expect(partRef(line), line).toMatch(/^c\d+$/);
    const orders = partRef('region "Orders"')!;

    // Just its shown text, with which part it is, untrusted.
    const part = JSON.parse((await mcp.call('read_tab', { tab_id: tab, ref: orders })).text) as { trust: string; content: string; part: { ref: string; role: string; name: string } };
    expect(part).toMatchObject({ trust: 'untrusted', part: { ref: orders, role: 'region', name: 'Orders' } });
    expect(part.content).toContain('Shown words: order 12 shipped.');
    expect(part.content).not.toContain('Story words');
    // Never what CSS hides, `hidden`, `inert`; never a field's value, an editor's contents, an ARIA text field's
    // (whatever its tag), nor a frame's inside.
    const hidden = ['hidden-display', 'hidden-visibility', 'hidden-opacity', 'hidden-attribute'];
    const sensitive = ['hidden-inert', 'field-value-secret', 'textarea-secret', 'editor-secret', 'aria-textbox-secret', 'aria-searchbox-secret', 'aria-combobox-secret', 'frame-inside-secret'];
    for (const never of [...hidden, ...sensitive]) expect(part.content, never).not.toContain(never);
    // Both ways with the page read: what it leaves out of the page, the part's read leaves out too, and what it shows,
    // the part's does. The page read keeps inert text, as it always has (round 1 of #260): a part's read is a subset.
    const whole = (JSON.parse((await mcp.call('read_tab', { tab_id: tab })).text) as { content: string }).content;
    for (const never of hidden) expect(whole, never).not.toContain(never);
    expect(whole).toContain('Shown words: order 12 shipped.');
    expect(whole).toContain('hidden-inert');

    // Never more than the page read gives (rounds 1 and 2 of #260): a part inside something the page read never enters
    // gets no ref (its read would always be refused), and its words are never read. Where the page read leaves them out
    // too, it does.
    const STALE = 'That part has changed since your snapshot, or the page moved on: call snapshot again.';
    const EDITOR = 'That part is an editor: what shows in it is what’s typed there, so it isn’t read.';
    const unread: [string, string, boolean][] = [
      // [the part, its words, whether the page read leaves them out too]
      ['Offscreen', 'offscreen-secret', true],
      ['In a button', 'button-secret', true],
      ['Hidden shown', 'hiddenshown-secret', true],
      ['Contents hidden', 'contents-secret', true],
      ['In a combobox', 'combobox-part-secret', false],
      ['Inert part', 'inert-part-secret', false],
    ];
    for (const [name, words, pageLeavesOut] of unread) {
      expect(partRef(`region "${name}"`), name).toBeUndefined();
      if (pageLeavesOut) expect(whole, name).not.toContain(words);
    }
    // Changed after the snapshot (round 2 of #260): each had its ref, and its read now is refused, never read.
    const later: [string, string, string, string][] = [
      // [the part, its words, what the page does, what it says]
      ['Inert later', 'inertlater-secret', 'document.getElementById("w-inert").inert = true', STALE],
      ['Hidden later', 'hiddenlater-secret', 'const w = document.getElementById("w-hidden"); w.hidden = true; w.style.display = "block"', STALE],
      ['Editor later', 'editorlater-secret', 'document.getElementById("w-editor").contentEditable = "true"', EDITOR],
      ['In a shadow', 'shadowpart-secret', 'document.getElementById("w-shadow").inert = true', STALE],
      ['Adopted', 'adopted-secret', 'document.querySelector("iframe").contentDocument.body.appendChild(document.getElementById("adopted"))', STALE],
      ['Self inert', 'selfinert-secret', 'document.getElementById("self-inert").inert = true', STALE],
    ];
    const laterRefs = later.map(([name]) => partRef(`region "${name}"`));
    for (const [i, [name]] of later.entries()) expect(laterRefs[i], name).toMatch(/^c\d+$/);
    for (const [, , change] of later) await inPage(`${change}; 0`);
    for (const [i, [name, words, , says]] of later.entries()) {
      const read = await mcp.call('read_tab', { tab_id: tab, ref: laterRefs[i] });
      expect(read.isError, name).toBe(true);
      expect(read.text, name).toBe(says);
      expect(read.text, name).not.toContain(words);
    }
    // A part that is a shadow host reads its shadow root.
    const shadowed = JSON.parse((await mcp.call('read_tab', { tab_id: tab, ref: partRef('region "Shadowed"')! })).text) as { content: string };
    expect(shadowed.content).toContain('shadow-words');
    // A section whose label is empty, or names nothing, is no region.
    expect(outline).not.toMatch(/- region(?: "")? \[ref=/);

    // Read-only: an acting tool given a c ref refuses it, and nothing is pressed.
    const PART_ACT = 'A c ref names a part of a page to read with read_tab, never one to act on: use an element’s ref (e1, e2…).';
    await inPage('window.__pressed = 0; document.querySelector("button").addEventListener("click", () => window.__pressed++); 0');
    const clicked = await allowed('click', { tab_id: tab, ref: orders });
    expect(clicked.isError).toBe(true);
    expect(clicked.text).toBe(PART_ACT);
    expect(await inPage('window.__pressed')).toBe(0);

    // The part renamed since the snapshot: refused as stale, never read.
    await inPage('document.querySelector("section").setAttribute("aria-label", "Returns"); 0');
    const renamed = await mcp.call('read_tab', { tab_id: tab, ref: orders });
    expect(renamed.isError).toBe(true);
    expect(renamed.text).toBe(STALE);

    // A page that's all editor (designMode): never read this way.
    const again = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as { content: string }).content;
    const story = /article "Story" \[ref=(c\d+)\]/.exec(again)![1]!;
    await inPage('document.designMode = "on"; 0');
    const editor = await mcp.call('read_tab', { tab_id: tab, ref: story });
    expect(editor.isError).toBe(true);
    expect(editor.text).toBe('That part is an editor: what shows in it is what’s typed there, so it isn’t read.');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a control drawn late is waited for, then its ref acts; look-alikes are told apart by their item, or refused, never guessed (#211)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const logOf = (path: string) => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('document.getElementById("log").textContent'), `${site.origin}${path}`) as Promise<string>;
    type Look = { tab_id: string; content: string };

    // Late: not there at the first look; wait_for it, then its ref (shown by the wait's answer) acts.
    const lobby = JSON.parse((await allowed('open_tab', { url: `${site.origin}/late`, snapshot: true })).text) as Look;
    expect(lobby.content).not.toContain('Join table');
    // Met: what changed since the first look (or the outline), with the button's ref.
    const answered = JSON.parse((await allowed('wait_for', { tab_id: lobby.tab_id, role: 'button', name: 'Join table', snapshot: true, timeout_ms: 10_000 })).text) as { content?: string; data?: { page_changes?: { lines?: string[] } } };
    const waited = answered.content ?? (answered.data?.page_changes?.lines ?? []).join('\n');
    const join = /button "Join table" \[ref=(e\d+)\]/.exec(waited)?.[1];
    expect(join, waited).toBeDefined();
    expect((await allowed('click', { tab_id: lobby.tab_id, ref: join! })).isError).toBe(false);
    await expect.poll(() => logOf('/late')).toContain('joined');
    // A styled checkbox drawn late (the box unseen, its label shown): waited for as the snapshot sees it, never timed out.
    const agreed = await allowed('wait_for', { tab_id: lobby.tab_id, role: 'checkbox', name: 'Agree to the rules', timeout_ms: 5000 });
    expect(JSON.parse(agreed.text), agreed.text).toMatchObject({ data: { met: true } });

    // Look-alikes in named sections, redrawn every 100 ms: a find by the section's words names the one meant, and its
    // ref acts on that one, found again after the redraw.
    const drafts = JSON.parse((await allowed('open_tab', { url: `${site.origin}/twins?once`, snapshot: true })).text) as Look;
    const found = JSON.parse((await mcp.call('snapshot', { tab_id: drafts.tab_id, find: 'Delete Draft B' })).text) as Look;
    const draftB = /button "Delete" \[ref=(e\d+)\] \(in region "Draft B"\)/.exec(found.content)?.[1];
    expect(draftB, found.content).toBeDefined();
    // One redraw, from the test (never a race with a timer on one slow CPU).
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('window.redraw()'), `${site.origin}/twins?once`);
    const deleted = await allowed('click', { tab_id: drafts.tab_id, ref: draftB! });
    expect(deleted.isError, deleted.text).toBe(false);
    await expect.poll(() => logOf('/twins?once')).toBe(' deleted B');

    // In unnamed list items, told apart by what each row says (#268): B's ref, found again after a redraw (one, from
    // the test: never a race with a timer on one slow CPU), deletes B.
    const plain = JSON.parse((await allowed('open_tab', { url: `${site.origin}/twins-plain?once`, snapshot: true })).text) as Look;
    const second = [...plain.content.matchAll(/button "Delete" \[ref=(e\d+)\]/g)][1]?.[1];
    expect(second, plain.content).toBeDefined();
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('window.redraw()'), `${site.origin}/twins-plain?once`);
    const plainDeleted = await allowed('click', { tab_id: plain.tab_id, ref: second! });
    expect(plainDeleted.isError, plainDeleted.text).toBe(false);
    await expect.poll(() => logOf('/twins-plain?once')).toBe(' deleted B');

    // Rows that say the same (alike in every way the page keeps), in a snapshot cut short (more on the page than it
    // reads): after a redraw, which one was meant can't be told. Refused, saying how to choose; nothing deleted.
    const cut = JSON.parse((await allowed('open_tab', { url: `${site.origin}/twins-cut`, snapshot: true })).text) as Look;
    const cutSecond = [...cut.content.matchAll(/button "Delete" \[ref=(e\d+)\]/g)][1]?.[1];
    expect(cutSecond, cut.content.slice(0, 400)).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    const cutRefused = await allowed('click', { tab_id: cut.tab_id, ref: cutSecond! });
    expect(cutRefused.isError).toBe(true);
    expect(cutRefused.text).toBe(ACT_REFUSALS.ambiguous);
    expect(await logOf('/twins-cut')).toBe('');

    // One at the first look, two alike by the time it's clicked: found again twice over, refused the same way.
    const later = JSON.parse((await allowed('open_tab', { url: `${site.origin}/twin-later`, snapshot: true })).text) as Look;
    const deletes = [...later.content.matchAll(/button "Delete" \[ref=(e\d+)\]/g)].map((m) => m[1]);
    expect(deletes, later.content).toHaveLength(1);
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript('window.twin()'), `${site.origin}/twin-later`);
    await new Promise((r) => setTimeout(r, 300));
    const twice = await allowed('click', { tab_id: later.tab_id, ref: deletes[0]! });
    expect(twice.isError).toBe(true);
    expect(twice.text).toBe(ACT_REFUSALS.ambiguous);
    expect(await logOf('/twin-later')).toBe('');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a stale ref never acts on another row: ids by position, a row replaced by another, a row patched in place (#268)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const inPage = (js: string) => app.evaluate(({ webContents }, [url, code]) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.executeJavaScript(code), [`${site.origin}/rows`, js] as const) as Promise<unknown>;
    const log = async () => String(await inPage('document.getElementById("log").textContent'));
    type Look = { tab_id: string; content: string };
    const tab = (JSON.parse((await allowed('open_tab', { url: `${site.origin}/rows`, snapshot: true })).text) as Look).tab_id;
    /** The page as `draw` leaves it, a snapshot, then the Cancel in the row that says `order`: its ref. */
    const cancelIn = async (draw: string, order: string) => {
      await inPage(draw);
      const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab, find: `Cancel Order ${order}` })).text) as Look).content;
      const ref = new RegExp(`button "Cancel" \\[ref=(e\\d+)\\] \\(in listitem "Order ${order}"\\)`).exec(content)?.[1];
      expect(ref, content).toBeDefined();
      return ref!;
    };

    // Ids by position: A removed, B takes act-0 and cancel-0. A's ref never cancels B.
    let ref = await cancelIn('rows(["A", "B"])', 'A');
    await inPage('rows(["B"])');
    let out = await allowed('click', { tab_id: tab, ref });
    // Found again only in a row that says something else (B's, in A's old place): that, with its way out.
    expect([out.isError, out.text, await log()], 'ids by position').toEqual([true, ACT_REFUSALS.rowChanged, '']);

    // The only row, replaced by another: A's ref never cancels B.
    ref = await cancelIn('rows(["A"])', 'A');
    await inPage('rows(["B"])');
    out = await allowed('click', { tab_id: tab, ref });
    expect([out.isError, out.text, await log()], 'a row replaced').toEqual([true, ACT_REFUSALS.rowChanged, '']);

    // The same nodes, the row's text patched (index keys): caught at the action, never a refind's to catch.
    ref = await cancelIn('rows(["A"])', 'A');
    await inPage('patch("B")');
    out = await allowed('click', { tab_id: tab, ref });
    // The same node, its row saying something else now: its own refusal (#268's review).
    expect([out.isError, out.text, await log()], 'a row patched in place').toEqual([true, ACT_REFUSALS.rowChanged, '']);

    // Rows with no ids, reordered: the buttons are alike in place and shape, and only what each row says finds A's again
    // (#268's review, N2): it cancels A, never B.
    ref = await cancelIn('plain(["A", "B"])', 'A');
    await inPage('plain(["B", "A"])');
    out = await allowed('click', { tab_id: tab, ref });
    expect(out.isError, out.text).toBe(false);
    expect(await log(), 'rows with no ids, reordered').toBe(' cancel Order A');
    await inPage('document.getElementById("log").textContent = ""');

    // And the row the ref was shown in, redrawn just the same: still found again, and acted on.
    ref = await cancelIn('rows(["A", "B"])', 'B');
    await inPage('rows(["A", "B"])');
    out = await allowed('click', { tab_id: tab, ref });
    expect(out.isError, out.text).toBe(false);
    expect(await log()).toBe(' cancel Order B');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('#268’s review: a later snapshot never rebinds an old ref to a patched row (an action’s diff, a find)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const url = `${site.origin}/p-index`;
    const inPage = (js: string) => app.evaluate(({ webContents }, [u, code]) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript(code), [url, js] as const) as Promise<unknown>;
    const log = async () => String(await inPage('document.getElementById("log").textContent'));
    type Look = { tab_id: string; content: string };
    const first = JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look;
    const tab = first.tab_id;
    const refsIn = (content: string) => [...content.matchAll(/button "Cancel" \[ref=(e\d+)\]/g)].map((m) => m[1]!);
    // The agent's own action patches the list (index keys): its diff names the patched nodes; the ref shown in Order B's
    // row, its node now Order C's, never cancels C.
    let refs = refsIn(first.content);
    expect((await allowed('click', { tab_id: tab, ref: refs[0]! })).isError).toBe(false);
    expect(await log()).toBe(' cancel:Order A');
    const b = await allowed('click', { tab_id: tab, ref: refs[1]! });
    expect([b.isError, b.text, await log()], 'after the action’s diff').toEqual([true, ACT_REFUSALS.rowChanged, ' cancel:Order A']);
    // The page patches by itself; the agent runs a find for something else; its old ref, shown in Order A's row, never
    // cancels B.
    await inPage('document.getElementById("log").textContent = ""; setData(["A", "B", "C"])');
    refs = refsIn((JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content);
    await inPage('setData(["B", "C"])');
    await mcp.call('snapshot', { tab_id: tab, find: 'Cancel Order C' });
    const c = await allowed('click', { tab_id: tab, ref: refs[0]! });
    expect([c.isError, c.text, await log()], 'after a find').toEqual([true, ACT_REFUSALS.rowChanged, '']);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('#268’s review: what a row says, case by case: an item inside an item, deep, in a shadow root, pictures, links, long, hidden, empty, a ticker, an editor', async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const url = `${site.origin}/p-rows`;
    const inPage = (js: string) => app.evaluate(({ webContents }, [u, code]) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript(code), [url, js] as const) as Promise<unknown>;
    const log = async () => String(await inPage('document.getElementById("log").textContent'));
    type Look = { tab_id: string; content: string };
    const tab = (JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look).tab_id;
    const R = (n: string, html: string, pre = '', post = '') => ({ n, html, pre, post });
    type Row = ReturnType<typeof R>;
    const draws = (rs: Row[]) => `rows(${JSON.stringify(rs)})`;
    const linkLi = ['<ul><li><a href="#d">Details</a> ', '</li></ul>'] as const;
    const plainLi = ['<ul><li>', '</li></ul>'] as const;
    const sec = ['<section>', '</section>'] as const;
    const deep = (n: number) => ['<div>'.repeat(n), '</div>'.repeat(n)] as const;
    const SHADOW = 'document.querySelectorAll(".sh").forEach((s) => { if (!s.shadowRoot) s.attachShadow({ mode: "open" }); s.shadowRoot.textContent = s.dataset.t; })';
    const sh = (t: string) => `<span class=sh data-t="${t}"></span>`;
    const img = (alt: string) => `<img alt="${alt}" width=40 height=40>`;
    const LONG = 'GitHub [acme/widgets] Re: Fix the flaky login test on Windows runners';
    // (Longer than the 240 characters a row reads: if it were read, it alone would be the row's words.)
    const HIDDEN = `<span hidden>${'Select this row to archive, delete, move or share it with a teammate. '.repeat(4)}</span>`;
    // Text before the heading (round 2 of #273, Carbon): never what decides whether the heading is read.
    const BEFORE = (n: number) => `<p>${'w'.repeat(n)}</p>`;
    const EMPTIES = '<span></span>'.repeat(45);
    // [what, rows drawn, extra script, the row whose Cancel is picked, what the page does then, what's expected: the
    // refusal, or the row it cancels].
    const cases: [string, Row[], string, number, string, string][] = [
      ['an inner item with a link every row has, ids by position', [R('A', 'Order A', ...linkLi), R('B', 'Order B', ...linkLi)], '', 0, draws([R('B', 'Order B', ...linkLi)]), 'refused'],
      ['an inner item with a link every row has, patched in place', [R('A', 'Order A', ...linkLi)], '', 0, 'patch(0, { n: "B", html: "Order B" })', 'refused'],
      ['an inner item that says nothing, ids by position', [R('A', 'Order A', ...plainLi), R('B', 'Order B', ...plainLi)], '', 0, draws([R('B', 'Order B', ...plainLi)]), 'refused'],
      ['an unnamed section in the row, patched in place', [R('A', 'Order A', ...sec)], '', 0, 'patch(0, { n: "B", html: "Order B" })', 'refused'],
      ['words in an open shadow root, patched in place', [R('A', sh('Order A'))], SHADOW, 0, 'document.getElementById("rows").children[0].dataset.n = "B"; document.querySelector(".sh").shadowRoot.textContent = "Order B"', 'refused'],
      ['a picture’s words, ids by position', [R('A', img('Ada Lovelace')), R('B', img('Bob Moog'))], '', 0, draws([R('B', img('Bob Moog'))]), 'refused'],
      ['a link’s aria-label, ids by position', [R('A', '<a href="#a" aria-label="Order A">…</a>'), R('B', '<a href="#b" aria-label="Order B">…</a>')], '', 0, draws([R('B', '<a href="#b" aria-label="Order B">…</a>')]), 'refused'],
      ['alike in their first 60 characters, ids by position', [R('A', `${LONG} A`), R('B', `${LONG} B`)], '', 0, draws([R('B', `${LONG} B`)]), 'refused'],
      ['45 empty spans first, ids by position', [R('A', `${EMPTIES}Order A`), R('B', `${EMPTIES}Order B`)], '', 0, draws([R('B', `${EMPTIES}Order B`)]), 'refused'],
      ['60 hidden characters first, ids by position', [R('A', `${HIDDEN}Order A`), R('B', `${HIDDEN}Order B`)], '', 0, draws([R('B', `${HIDDEN}Order B`)]), 'refused'],
      // Rows that say nothing but their button (#268's review, S5): same-named, never looked for again; called by a name
      // nothing else has, looked for and acted on; that name given a twin since, never acted on.
      ['rows that say nothing, same-named buttons, ids by position', [R('A', ''), R('B', '')], '', 0, draws([R('B', '')]), 'empty'],
      ['a row that says nothing, redrawn the same (S5: never looked for, a new snapshot shows the row)', [R('A', '')], '', 0, draws([R('A', '')]), 'empty'],
      ['a row that says nothing, its button named like nothing else, then a twin drawn beside it (no ids)', [R('A', '')], 'plainRows([{ n: "A", html: "" }])', 0, 'plainRows([{ n: "A", html: "" }, { n: "B", html: "" }])', 'refused'],
      // A same-named row drawn since, ids by position: the new one first (B takes cancel-0, the old place and shape),
      // or after. Never acted on (round 2: S5, no exemption by name).
      ['a row that says nothing, named like nothing else; then a same-named row drawn first, ids by position', [R('A', '')], '', 0, draws([R('B', ''), R('A', '')]), 'refused'],
      ['a row that says nothing, named like nothing else; then a same-named row drawn after, ids by position', [R('A', '')], '', 0, draws([R('A', ''), R('B', '')]), 'refused'],
      // Round 2 (Fable's N3): contenteditable="false" isn't an editor; a heading every row has, then what differs.
      ['words in contenteditable="false", patched in place', [R('A', '<span contenteditable="false">Order A</span>')], '', 0, 'patch(0, { n: "B", html: "<span contenteditable=\\"false\\">Order B</span>" })', 'refused'],
      ['the same heading on every row, the text differs, patched in place', [R('A', '<h3>Order</h3><span>Alice, 2 shirts</span>')], '', 0, 'patch(0, { n: "B", html: "<h3>Order</h3><span>Bob, 1 hat</span>" })', 'refused'],
      ['the same heading on every row, the text differs, ids by position', [R('A', '<h3>Order</h3><span>Alice</span>'), R('B', '<h3>Order</h3><span>Bob</span>')], '', 0, draws([R('B', '<h3>Order</h3><span>Bob</span>')]), 'refused'],
      // Round 2 (Carbon): 233 characters, and more than 240, of text before the heading that tells the rows apart.
      ['233 characters before the heading, ids by position', [R('A', `${BEFORE(233)}<h3>Order A</h3>`), R('B', `${BEFORE(233)}<h3>Order B</h3>`)], '', 0, draws([R('B', `${BEFORE(233)}<h3>Order B</h3>`)]), 'refused'],
      ['300 characters before the heading, ids by position', [R('A', `${BEFORE(300)}<h3>Order A</h3>`), R('B', `${BEFORE(300)}<h3>Order B</h3>`)], '', 0, draws([R('B', `${BEFORE(300)}<h3>Order B</h3>`)]), 'refused'],
      ['a heading of only an icon (its title never the words), ids by position', [R('A', '<h3><svg width=10 height=10><title>Star</title></svg></h3><span>Order A</span>'), R('B', '<h3><svg width=10 height=10><title>Star</title></svg></h3><span>Order B</span>')], '', 0, draws([R('B', '<h3><svg width=10 height=10><title>Star</title></svg></h3><span>Order B</span>')]), 'refused'],
      ['a progress bar in the row moves on', [R('A', 'Order A <span role=progressbar>40%</span>')], '', 0, 'document.querySelector("[role=progressbar]").textContent = "41%"', 'A'],
      ['60 divs deep, nothing changed', [R('A', 'Order A', ...deep(60))], '', 0, '0', 'A'],
      ['70 divs deep, nothing changed', [R('A', 'Order A', ...deep(70))], '', 0, '0', 'A'],
      ['70 divs deep, nothing changed, again', [R('A', 'Order A', ...deep(70))], '', 0, '0', 'A'],
      ['the same row redrawn just the same', [R('A', 'Order A'), R('B', 'Order B')], '', 1, draws([R('A', 'Order A'), R('B', 'Order B')]), 'B'],
    ];
    for (const [what, drawn, extra, pick, then, expected] of cases) {
      await inPage(`document.getElementById("log").textContent = ""; ${draws(drawn)}; ${extra || '0'}`);
      const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
      const ref = [...content.matchAll(/button "Cancel" \[ref=(e\d+)\]/g)].map((m) => m[1]!)[pick];
      expect(ref, `${what}: ${content}`).toBeDefined();
      await inPage(then);
      const out = await allowed('click', { tab_id: tab, ref: ref! });
      if (expected === 'refused') {
        expect(out.isError, `${what}: ${out.text}`).toBe(true);
        expect([ACT_REFUSALS.changed, ACT_REFUSALS.rowChanged, ACT_REFUSALS.ambiguous, ACT_REFUSALS.rowEmpty], what).toContain(out.text);
        expect(await log(), what).toBe('');
      } else if (expected === 'empty') {
        expect([out.isError, out.text, await log()], what).toEqual([true, ACT_REFUSALS.rowEmpty, '']);
      } else {
        expect(out.isError, `${what}: ${out.text}`).toBe(false);
        expect(await log(), what).toBe(` cancel:${expected}`);
      }
    }

    // Round 2 (Fable's N3): the item itself hosts the open shadow root (a web-component row), its words in there.
    await inPage('(() => { const ul = document.getElementById("rows"); ul.innerHTML = ""; document.getElementById("log").textContent = ""; const h = document.createElement("x-row"); h.setAttribute("role", "listitem"); h.dataset.n = "A"; h.id = "host"; const r = h.attachShadow({ mode: "open" }); r.innerHTML = "<span>Order A</span> <button>Cancel</button>"; r.querySelector("button").onclick = () => { document.getElementById("log").textContent += " cancel:" + h.dataset.n; }; ul.append(h); })()');
    const hosted = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const hostRef = /button "Cancel" \[ref=(e\d+)\]/.exec(hosted)?.[1];
    expect(hostRef, hosted).toBeDefined();
    await inPage('(() => { const h = document.getElementById("host"); h.dataset.n = "B"; h.shadowRoot.querySelector("span").textContent = "Order B"; })()');
    const hostOut = await allowed('click', { tab_id: tab, ref: hostRef! });
    expect(hostOut.isError, `a web-component row, patched: ${hostOut.text}`).toBe(true);
    expect(await log()).toBe('');

    // Round 2 (Fable's N4): a keyed list inside an unnamed section. Cancelling row 1 leaves the others' nodes, and
    // their refs: the section's words never read into the rows (an item nested in it is its own), so its other rows'
    // refs still act, and the action's diff stays small.
    await inPage('(() => { const ul = document.getElementById("rows"); const sct = document.createElement("section"); ul.replaceWith(sct); sct.append(ul); ul.innerHTML = ""; for (let i = 1; i <= 30; i++) { const li = document.createElement("li"); li.dataset.n = String(i); li.innerHTML = "<span>Order " + i + "</span> <button>Cancel</button>"; li.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("log").textContent += " cancel:" + li.dataset.n; li.remove(); }); ul.append(li); } document.getElementById("log").textContent = ""; })()');
    const listed = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const keyed = [...listed.matchAll(/button "Cancel" \[ref=(e\d+)\]/g)].map((m) => m[1]!);
    expect(keyed.length, listed).toBeGreaterThan(0);
    // (The outline folds rows alike: row 30's ref by a find.)
    const found30 = (JSON.parse((await mcp.call('snapshot', { tab_id: tab, find: 'Cancel Order 30' })).text) as Look).content;
    const ref30 = /button "Cancel" \[ref=(e\d+)\] \(in listitem "Order 30"\)/.exec(found30)?.[1];
    expect(ref30, found30).toBeDefined();
    const first = await allowed('click', { tab_id: tab, ref: keyed[0]! });
    expect(first.isError, first.text).toBe(false);
    const changes = (JSON.parse(first.text) as { data: { page_changes?: { lines?: string[]; changed?: number } } }).data.page_changes;
    expect(changes?.lines?.length ?? 99, JSON.stringify(changes).slice(0, 300)).toBeLessThan(8);
    const last = await allowed('click', { tab_id: tab, ref: ref30! });
    expect(last.isError, `row 30's ref after row 1 went: ${last.text}`).toBe(false);
    expect(await log()).toBe(' cancel:1 cancel:30');
    await inPage('(() => { const ul = document.getElementById("rows"); const sct = ul.parentElement; if (sct.localName === "section") sct.replaceWith(ul); })()');
    // Carbon's round 4: rows whose own words are in a nested section and whose button is in another, in a list in an
    // unnamed section. Cancelling row 1 leaves the others' keys: the section never reads its rows again once an inner
    // level found the row's words.
    await inPage('(() => { const sct = document.createElement("section"); sct.id = "csec"; const ul = document.createElement("ul"); sct.append(ul); document.querySelector("main").append(sct); for (let i = 1; i <= 30; i++) { const li = document.createElement("li"); li.dataset.n = String(i); li.innerHTML = "<section>Order " + i + "</section><section><button>Drop</button></section>"; li.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("log").textContent += " drop:" + li.dataset.n; li.remove(); }); ul.append(li); } document.getElementById("log").textContent = ""; })()');
    const carbonLook = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const drops = [...carbonLook.matchAll(/button "Drop" \[ref=(e\d+)\]/g)].map((m) => m[1]!);
    expect(drops.length, carbonLook).toBeGreaterThan(0);
    const dropped = await allowed('click', { tab_id: tab, ref: drops[0]! });
    expect(dropped.isError, dropped.text).toBe(false);
    const dropChanges = (JSON.parse(dropped.text) as { data: { page_changes?: { lines?: string[]; changed?: number } } }).data.page_changes;
    expect(dropChanges?.lines?.length ?? 99, JSON.stringify(dropChanges).slice(0, 300)).toBeLessThan(8);
    await inPage('document.getElementById("csec")?.remove()');
    // The same with a keyed table's rows (tr) in an unnamed section.
    await inPage('(() => { const sct = document.createElement("section"); sct.id = "tsec"; const tb = document.createElement("table"); sct.append(tb); document.querySelector("main").append(sct); for (let i = 1; i <= 30; i++) { const tr = tb.insertRow(); tr.dataset.n = String(i); tr.innerHTML = "<td>Line " + i + "</td><td><button>Remove</button></td>"; tr.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); document.getElementById("log").textContent += " remove:" + tr.dataset.n; tr.remove(); }); } document.getElementById("log").textContent = ""; })()');
    const tableLook = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const removes = [...tableLook.matchAll(/button "Remove" \[ref=(e\d+)\]/g)].map((m) => m[1]!);
    expect(removes.length, tableLook).toBeGreaterThan(0);
    const firstRemoved = await allowed('click', { tab_id: tab, ref: removes[0]! });
    expect(firstRemoved.isError, firstRemoved.text).toBe(false);
    const tableChanges = (JSON.parse(firstRemoved.text) as { data: { page_changes?: { lines?: string[] } } }).data.page_changes;
    expect(tableChanges?.lines?.length ?? 99, JSON.stringify(tableChanges).slice(0, 300)).toBeLessThan(8);
    await inPage('document.getElementById("tsec")?.remove()');

    // Typing in an editor in an unnamed row: what's typed is never the row's words; its button still acts after.
    for (const [what, html] of [
      ['a plain contenteditable', 'Note <div class=ed contenteditable aria-label="Note text" style="min-height:20px;min-width:120px;border:1px solid"></div>'],
      ['an editable cell with words in it', '<span class=ed contenteditable aria-label="Name" style="display:inline-block;min-width:120px;border:1px solid">Alice</span>'],
    ] as const) {
      await inPage(`document.getElementById("log").textContent = ""; ${draws([R('A', html)])}`);
      for (const attempt of [1, 2]) {
        const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
        const box = /textbox "(?:Note text|Name)" \[ref=(e\d+)\]/.exec(content)?.[1];
        const press = /button "Cancel" \[ref=(e\d+)\]/.exec(content)?.[1];
        expect([box, press].every(Boolean), content).toBe(true);
        const typed = await allowed('type', { tab_id: tab, ref: box!, text: `hello ${attempt}` });
        expect(typed.isError, `${what}, try ${attempt}: ${typed.text}`).toBe(false);
        if (attempt === 2) {
          const pressed = await allowed('click', { tab_id: tab, ref: press! });
          expect(pressed.isError, `${what}: ${pressed.text}`).toBe(false);
          expect(await log()).toBe(' cancel:A');
        }
      }
    }
    // A row that counts what's typed into its field: the text went in, so never "changed": it may have worked.
    await inPage(`document.getElementById("log").textContent = ""; ${draws([R('A', '<span class=count>0 characters</span> <textarea class=ed aria-label="Note text" oninput="this.closest(&quot;li&quot;).querySelector(&quot;.count&quot;).textContent = this.value.length + &quot; characters&quot;"></textarea>')])}`);
    const counted = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const note = /textbox "Note text" \[ref=(e\d+)\]/.exec(counted)?.[1];
    const typed = await allowed('type', { tab_id: tab, ref: note!, text: 'hello' });
    expect(await inPage('document.querySelector(".ed").value')).toBe('hello');
    expect(typed.text, 'a counter in the row').not.toBe(ACT_REFUSALS.changed);
    if (typed.isError) expect(typed.text).toMatch(/may or may not have worked/);
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('#268’s review, round 3: a row’s words in an item nested in it are its own; a row whose nearest item says nothing is never looked for', async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const url = `${site.origin}/p-rows`;
    const inPage = (js: string) => app.evaluate(({ webContents }, [u, code]) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript(code), [url, js] as const) as Promise<unknown>;
    const log = async () => String(await inPage('document.getElementById("log").textContent'));
    type Look = { tab_id: string; content: string };
    const tab = (JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look).tab_id;
    const R = (n: string, html: string, pre = '', post = '') => ({ n, html, pre, post });
    type Row = ReturnType<typeof R>;
    const draws = (rs: Row[]) => `rows(${JSON.stringify(rs)})`;
    const one = async (drawn: string, pick: number, then: string) => {
      await inPage(`document.getElementById("log").textContent = ""; ${drawn}`);
      const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
      const ref = [...content.matchAll(/button "Cancel" \[ref=(e\d+)\]/g)].map((m) => m[1]!)[pick];
      expect(ref, content).toBeDefined();
      await inPage(then);
      const out = await allowed('click', { tab_id: tab, ref: ref! });
      return { out, logged: await log() };
    };
    const REFUSED = [ACT_REFUSALS.changed, ACT_REFUSALS.rowChanged, ACT_REFUSALS.ambiguous, ACT_REFUSALS.rowEmpty];
    // The row's own words in an item nested in it (Fable, round 3): read by its nearest item, never skipped.
    const shapes: [string, (o: string) => string][] = [
      ['<section>words</section> beside the button', (o) => `<section>Order ${o}</section>`],
      ['a card body <section><h3>words</h3><p>…</p></section>', (o) => `<section><h3>Order ${o}</h3><p>2 shirts</p></section>`],
      ['<article>words</article>', (o) => `<article>Order ${o}</article>`],
      ['a nested list of the row’s details', (o) => `<ul><li>Order ${o}</li><li>2 shirts</li></ul>`],
      ['a nested layout table', (o) => `<table><tr><td>Order ${o}</td></tr></table>`],
      ['<div role=row>words</div>', (o) => `<div role="row">Order ${o}</div>`],
      ['some words outside, the telling ones in a nested section', (o) => `Order <section>${o}</section>`],
    ];
    for (const [what, html] of shapes) {
      let r = await one(draws([R('A', html('A'))]), 0, `patch(0, ${JSON.stringify({ n: 'B', html: html('B') })})`);
      expect([r.out.isError, r.logged], `${what}, patched in place: ${r.out.text}`).toEqual([true, '']);
      expect(REFUSED, what).toContain(r.out.text);
      r = await one(draws([R('A', html('A')), R('B', html('B'))]), 0, draws([R('B', html('B'))]));
      expect([r.out.isError, r.logged], `${what}, ids by position: ${r.out.text}`).toEqual([true, '']);
      r = await one(draws([R('A', html('A')), R('B', html('B'))]), 1, draws([R('A', html('A')), R('B', html('B'))]));
      expect([r.out.isError, r.logged], `${what}, the same rows redrawn (B's ref): ${r.out.text}`).toEqual([false, ' cancel:B']);
    }
    // Words every row shares beside the button, the row's own in a sibling item (Fable's round 4): the items above read
    // sections, articles and divs (only nested rows are skipped), so the row's words count.
    const SHARED: [string, (o: string) => Row][] = [
      ['<section>words</section> <section>Actions <button>', (o) => R(o, `<section>Order ${o}</section>`, '<section><span>Actions</span> ', '</section>')],
      ['<section>words</section> <section><a>Details</a> <button>', (o) => R(o, `<section>Order ${o}</section>`, '<section><a href="#d">Details</a> ', '</section>')],
      ['a card: <section><h3>words</h3><p>…</p></section> <section><a>View</a> <button>', (o) => R(o, `<section><h3>Order ${o}</h3><p>2 shirts</p></section>`, '<section><a href="#v">View</a> ', '</section>')],
      ['<section>words</section> <ul><li>Danger zone <button>', (o) => R(o, `<section>Order ${o}</section>`, '<ul><li><span>Danger zone</span> ', '</li></ul>')],
      ['three levels: <section>words</section> <section><ul><li><a>Details</a> <button>', (o) => R(o, `<section>Order ${o}</section>`, '<section><ul><li><a href="#d">Details</a> ', '</li></ul></section>')],
      ['<article>words</article> <div role=row><img alt="Actions"> <button>', (o) => R(o, `<article>Order ${o}</article>`, '<div role="row"><img alt="Actions" width=8 height=8> ', '</div>')],
    ];
    for (const [what, row] of SHARED) {
      let r = await one(draws([row('A')]), 0, `patch(0, ${JSON.stringify({ n: 'B', html: row('B').html })})`);
      expect([r.out.isError, r.logged], `${what}, patched in place: ${r.out.text}`).toEqual([true, '']);
      r = await one(draws([row('A'), row('B')]), 0, draws([row('B')]));
      expect([r.out.isError, r.logged], `${what}, ids by position: ${r.out.text}`).toEqual([true, '']);
      r = await one(draws([row('A')]), 0, draws([row('B')]));
      expect([r.out.isError, r.logged], `${what}, the lone row replaced: ${r.out.text}`).toEqual([true, '']);
    }
    // The words in one nested item, the button in another: the button's nearest item says nothing, so never looked for.
    for (const [what, pre, post] of [
      ['<section>words</section> <section><button>', '<section>', '</section>'],
      ['<section>words</section> <div><ul><li><button>', '<div><ul><li>', '</li></ul></div>'],
    ] as const) {
      const html = (o: string) => `<section>Order ${o}</section>`;
      let r = await one(draws([R('A', html('A'), pre, post)]), 0, `patch(0, ${JSON.stringify({ n: 'B', html: html('B') })})`);
      expect([r.out.isError, r.logged], `${what}, patched in place: ${r.out.text}`).toEqual([true, '']);
      r = await one(draws([R('A', html('A'), pre, post), R('B', html('B'), pre, post)]), 0, draws([R('B', html('B'), pre, post)]));
      expect([r.out.isError, r.logged], `${what}, ids by position: ${r.out.text}`).toEqual([true, '']);
    }
    // Rows that say nothing in a group that says something (a count, a section's heading; an article, a dialog): the
    // group never tells its rows apart, so the rows are never looked for (S5 by the nearest item: Carbon's round 3).
    for (const [what, wrap] of [
      ['a section with a count', '<section><p>2 orders</p></section>'],
      ['a section with a heading', '<section><h2>Orders</h2></section>'],
      ['an unnamed article', '<article><p>Your orders</p></article>'],
      ['an unnamed dialog', '<div role="dialog"><p>Pick an order</p></div>'],
    ] as const) {
      await inPage(`(() => { const ul = document.getElementById("rows"); const t = document.createElement("template"); t.innerHTML = ${JSON.stringify(wrap)}; const w = t.content.firstElementChild; w.id = "wrap"; ul.replaceWith(w); w.append(ul); })()`);
      let r = await one(draws([R('A', ''), R('B', '')]), 0, draws([R('B', '')]));
      expect([r.out.isError, r.out.text, r.logged], `${what}: ids by position`).toEqual([true, ACT_REFUSALS.rowEmpty, '']);
      r = await one(draws([R('A', '')]), 0, draws([R('B', '')]));
      expect([r.out.isError, r.out.text, r.logged], `${what}: a lone row replaced`).toEqual([true, ACT_REFUSALS.rowEmpty, '']);
      r = await one(draws([R('A', '')]), 0, draws([R('B', ''), R('A', '')]));
      expect([r.out.isError, r.out.text, r.logged], `${what}: a same-named row drawn first`).toEqual([true, ACT_REFUSALS.rowEmpty, '']);
      await inPage('(() => { const w = document.getElementById("wrap"); w.replaceWith(document.getElementById("rows")); })()');
    }
    // Input that went in, then its row redrawn with nothing to tell it by (Carbon's round 3): never "nothing was done".
    // Enter in a reply box that sends and redraws its row; a date that saves on change and redraws its row.
    await inPage('(() => { const ul = document.getElementById("rows"); const draw = () => { ul.innerHTML = "<li><textarea aria-label=\\"Reply\\"></textarea></li><li><input type=date aria-label=\\"Due\\"></li>"; const t = ul.querySelector("textarea"); t.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("log").textContent += " sent: " + t.value; setTimeout(draw, 0); } }); const d = ul.querySelector("input"); d.addEventListener("change", () => { document.getElementById("log").textContent += " due: " + d.value; draw(); }); }; draw(); document.getElementById("log").textContent = ""; })()');
    let boxes = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const reply = /textbox "Reply" \[ref=(e\d+)\]/.exec(boxes)?.[1];
    expect(reply, boxes).toBeDefined();
    expect((await allowed('type', { tab_id: tab, ref: reply!, text: 'ship it' })).isError).toBe(false);
    const sent = await allowed('press_key', { tab_id: tab, ref: reply!, key: 'Enter' });
    expect(await log()).toContain('sent: ship it');
    expect([sent.isError, sent.text], 'Enter that sent, its row redrawn').toEqual([true, expect.stringMatching(/may not have worked|may or may not have worked/)]);
    boxes = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const due = /textbox "Due" \[ref=(e\d+)\]/.exec(boxes)?.[1] ?? /"Due" \[ref=(e\d+)\]/.exec(boxes)?.[1];
    expect(due, boxes).toBeDefined();
    const dated = await allowed('type', { tab_id: tab, ref: due!, text: '2026-11-26' });
    expect(await log()).toContain('due: 2026-11-26');
    expect([dated.isError, dated.text], 'a date that saved, its row redrawn').toEqual([true, expect.stringMatching(/may or may not have worked/)]);
    // An unnamed dialog reused for another order: its words in a section, its button in a footer.
    await inPage('(() => { document.getElementById("rows").innerHTML = ""; document.getElementById("log").textContent = ""; const d = document.createElement("div"); d.id = "dlg"; d.setAttribute("role", "dialog"); d.dataset.n = "A"; d.innerHTML = "<section><p id=q>Delete Order A?</p></section><footer><button>Delete</button></footer>"; d.querySelector("button").onclick = () => { document.getElementById("log").textContent += " delete:" + d.dataset.n; }; document.querySelector("main").append(d); })()');
    const dialog = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const del = /button "Delete" \[ref=(e\d+)\]/.exec(dialog)?.[1];
    expect(del, dialog).toBeDefined();
    await inPage('(() => { const d = document.getElementById("dlg"); d.dataset.n = "B"; document.getElementById("q").textContent = "Delete Order B?"; })()');
    const reused = await allowed('click', { tab_id: tab, ref: del! });
    expect([reused.isError, await log()], `a reused dialog: ${reused.text}`).toEqual([true, '']);
    await inPage('document.getElementById("dlg")?.remove()');
    // The same, its button in a second section that says what every such dialog says (Fable's round 4).
    await inPage('(() => { document.getElementById("log").textContent = ""; const d = document.createElement("div"); d.id = "dlg"; d.setAttribute("role", "dialog"); d.dataset.n = "A"; d.innerHTML = "<section><p id=q>Delete Order A?</p></section><section><p>This can’t be undone.</p><button>Delete</button></section>"; d.querySelector("button").onclick = () => { document.getElementById("log").textContent += " delete:" + d.dataset.n; }; document.querySelector("main").append(d); })()');
    const dialog2 = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
    const del2 = /button "Delete" \[ref=(e\d+)\]/.exec(dialog2)?.[1];
    expect(del2, dialog2).toBeDefined();
    await inPage('(() => { const d = document.getElementById("dlg"); d.dataset.n = "B"; document.getElementById("q").textContent = "Delete Order B?"; })()');
    const reused2 = await allowed('click', { tab_id: tab, ref: del2! });
    expect([reused2.isError, await log()], `a reused dialog, its button beside shared words: ${reused2.text}`).toEqual([true, '']);
    await inPage('document.getElementById("dlg")?.remove()');
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('#268’s review: rows whose words tick: marked tickers (role=timer, aria-live) left out; an unmarked one refused, saying to tell the user', async () => {
  test.setTimeout(150_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    type Look = { tab_id: string; content: string };
    const refOfButton = (content: string, name: string) => new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`).exec(content)?.[1];
    // A ticker that replaces its row's nodes (round 2 of #273, Carbon): found again only in a row that says something
    // else now: rowChanged, with its way out (never just changed).
    {
      const url = `${site.origin}/p-timer?replace=1&ms=300`;
      const tab = (JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look).tab_id;
      const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
      const ref = refOfButton(content, 'Bid');
      expect(ref, content).toBeDefined();
      await new Promise((r) => setTimeout(r, 1000));
      const out = await allowed('click', { tab_id: tab, ref: ref! });
      expect([out.isError, out.text], 'a ticker that replaces its nodes').toEqual([true, ACT_REFUSALS.rowChanged]);
    }
    // Twins (two rows alike) that tick by replacing their nodes (Carbon, round 4): found again only in rows that say
    // something else now, so rowChanged with its way out, never just changed.
    {
      const url = `${site.origin}/p-timer?replace=1&twins=1&ms=300`;
      const tab = (JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look).tab_id;
      const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
      const ref = refOfButton(content, 'Bid');
      expect(ref, content).toBeDefined();
      await new Promise((r) => setTimeout(r, 1000));
      const out = await allowed('click', { tab_id: tab, ref: ref! });
      expect([out.isError, out.text], 'twins that tick by replacing their nodes').toEqual([true, ACT_REFUSALS.rowChanged]);
    }
    for (const mark of ['timer', 'live', '']) {
      const url = `${site.origin}/p-timer?mark=${mark}&ms=300`;
      const tab = (JSON.parse((await allowed('open_tab', { url, snapshot: true })).text) as Look).tab_id;
      const log = async () => String(await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript('document.getElementById("log").textContent'), url));
      for (const name of ['Stay signed in', 'Bid']) {
        const content = (JSON.parse((await mcp.call('snapshot', { tab_id: tab })).text) as Look).content;
        const ref = refOfButton(content, name);
        expect(ref, content).toBeDefined();
        await new Promise((r) => setTimeout(r, 1000));
        const out = await allowed('click', { tab_id: tab, ref: ref! });
        if (mark) {
          expect(out.isError, `${mark} ${name}: ${out.text}`).toBe(false);
          expect(await log()).toContain(name);
        } else {
          expect([out.isError, out.text], `unmarked ${name}`).toEqual([true, ACT_REFUSALS.rowChanged]);
          expect(ACT_REFUSALS.rowChanged).toMatch(/tell the user/);
        }
      }
    }
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

test('a place is what the snapshot saw: a role the page changes before the task after it never finds another element (round 1 of #270, B1)', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const url = `${site.origin}/role-twins`;
    const opening = mcp.call('open_tab', { url });
    await answer(app, 'Codex', 'Allow once');
    expect((await opening).text, 'open_tab opened its tab').toMatch(/^\{/);
    const popover = await pageWhere(app, isPopover);
    const inPage = (code: string) => app.evaluate(({ webContents }, [u, js]) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript(js), [url, code] as const);
    const log = () => inPage('document.getElementById("log").textContent') as Promise<string>;
    const beforeFinish = (code: string) => app.evaluate((_e, [u, c]) => (globalThis as unknown as { chordTestHooks: { agentBeforeFinish(u: string, c: string): Promise<boolean> } }).chordTestHooks.agentBeforeFinish(u, c), [url, code] as const);
    const snap = async () => (JSON.parse((await mcp.call('snapshot', { tab_id: 'a1' })).text) as { content: string }).content;
    // The site's card, once (a click no case below needs): Allow for now. (Pick, never Confirm: a risky step's card would wait.)
    const first = await snap();
    const allowing = mcp.call('click', { tab_id: 'a1', ref: refOf(first, 'button "Pick"') });
    const siteCard = siteCardOf(popover, 'Codex');
    await expect(siteCard).toBeVisible({ timeout: 15_000 });
    await popover.waitForTimeout(600);
    await siteCard.getByRole('button', { name: 'Allow for now', exact: true }).click();
    await allowing;
    await inPage('location.reload()');
    await expect.poll(log).toBe('');

    // Twin rows: in the gap, Order A goes, row 1 draws Order B's Cancel, row 2 becomes presentation. Read live, the twins'
    // places would differ, and Order A's Cancel would be found again in row 1: Order B's. As the walk saw them, they're
    // twins, and Order A's ref is never found again.
    await beforeFinish(`document.getElementById('w1').innerHTML = '<button onclick="log(\\'cancel B\\')">Cancel</button>'; document.getElementById('w2').setAttribute('role', 'presentation'); document.getElementById('w2').innerHTML = '';`);
    const rows = await snap();
    const cancelA = refOf(rows, 'button "Cancel"');
    const cancelling = await mcp.call('click', { tab_id: 'a1', ref: cancelA });
    expect(await log(), cancelling.text).not.toContain('cancel B');

    // A repurposed container: twin toolbars, each with its Pick. In the gap the second becomes an (empty) dialog, and
    // the first draws another Pick. Read live, the first toolbar's Pick would be unique, and found again in the new
    // button. As the walk saw them they're twins, and it's never found again.
    await inPage('location.reload()');
    await expect.poll(log).toBe('');
    await beforeFinish(`const d = document.getElementById('c2'); d.setAttribute('role', 'dialog'); d.innerHTML = ''; document.getElementById('c1').innerHTML = '<button onclick="log(\\'confirm other\\')">Pick</button>';`);
    const bars = await snap();
    const confirming = await mcp.call('click', { tab_id: 'a1', ref: refOf(bars, 'button "Pick"') });
    expect(await log(), confirming.text).not.toContain('confirm other');
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
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('twin') })).text).toBe(ACT_REFUSALS.ambiguous);
    expect(await log()).toBe('');
    // Twins at the snapshot already, redrawn as the pointer arrives: the same refusal, never changed (#211's review).
    expect((await mcp.call('click', { tab_id: 'a1', ref: await ready('twins') })).text).toBe(ACT_REFUSALS.ambiguous);
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
    // Two Deletes, one per unnamed row, told apart by what each row says (#268): Row one's, gone, is found only in
    // Row two's place, whose row says something else: rowChanged.
    o = await snap();
    await mode('gone1');
    await refused('a Delete of two', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Delete"') }), ACT_REFUSALS.rowChanged);
    // Both gone: no look-alike left, so changed, never "it has a look-alike" (#211's review).
    await mode('');
    o = await snap();
    await mode('gone2');
    await refused('both Deletes gone', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Delete"') }));
    // A twin appears: two matches, refused.
    await mode('');
    o = await snap();
    await mode('twin');
    await refused('a twin', mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Check"') }), ACT_REFUSALS.ambiguous);
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
    // Each item kind, found again in the same item as the page redraws: a named row in a region (the walk's items and
    // the act's are the same).
    await mode('');
    o = await snap();
    await new Promise((r) => setTimeout(r, 400));
    const seat = await mcp.call('click', { tab_id: 'a1', ref: refOf(o, 'button "Take seat"') });
    expect(JSON.parse(seat.text), 'Take seat').toMatchObject({ data: { done: 'Clicked “Take seat”', refound: expect.any(String) } });
    // A row in a section named by aria-labelledby, and a list item in a named dialog, each unnamed and saying nothing
    // but its button (#268's review, S5: the planner's call, no exemption by name): nothing of its own tells it from
    // another row's (a swap of ids by position, a lone row replaced), so once redrawn it's never looked for. The refusal
    // says to take a new snapshot and use its ref at once, which acts (one extra snapshot, the cost), or to tell the user
    // if it's refused again.
    for (const name of ['Fold here', 'Show cards']) {
      await mode('');
      o = await snap();
      await new Promise((r) => setTimeout(r, 400));
      await refused(`${name}, its row saying nothing`, mcp.call('click', { tab_id: 'a1', ref: refOf(o, `button "${name}"`) }), ACT_REFUSALS.rowEmpty);
      await mode('!');
      const fresh = await mcp.call('click', { tab_id: 'a1', ref: refOf(await snap(), `button "${name}"`) });
      expect(JSON.parse(fresh.text), `${name}, its new ref`).toMatchObject({ data: { done: `Clicked “${name}”` } });
    }
    // And in another (a section's heading, a row's or a dialog's name changed): refused, the nearest named item or not.
    for (const [m2, name, says] of [['lab', 'Fold here', ACT_REFUSALS.rowEmpty], ['seat', 'Take seat', STALE], ['hand', 'Show cards', ACT_REFUSALS.rowEmpty]] as const) {
      await mode('');
      o = await snap();
      await mode(m2);
      await refused(`${name} in another item`, mcp.call('click', { tab_id: 'a1', ref: refOf(o, `button "${name}"`) }), says);
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
