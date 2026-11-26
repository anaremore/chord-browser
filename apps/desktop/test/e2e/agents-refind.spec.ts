/** Outside agents on pages that change (S18 M2c, M2g): refs found again or refused, first looks, timed pages, wait_for, the token eval, a game, a press tried again. Split from agents.spec.ts (#213). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
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
