/**
 * Same-origin frames, read (#210, PR 1 of 3: docs/decisions/S18-m2g-timed-pages/frames.md). An agent's snapshot shows a
 * same-origin frame's contents with refs, under the frame's line; every action on one is refused for now (*not yet*);
 * a frame that went elsewhere makes its refs stale; other origins and sandboxed frames stay unread.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { ACT_REFUSALS, ELEMENT_REFUSALS } from '@chord/core';
import { failOnMainErrors } from './main-errors';
import { isPopover, pageWhere } from './a11y-kit';
import { CODEX, agents, launch, reached, relay, startAgentSite } from './agents-shared';

failOnMainErrors();

let site: Awaited<ReturnType<typeof startAgentSite>>;
test.beforeAll(async () => {
  site = await startAgentSite();
});
test.afterAll(() => site.server.close());

/** An agent's calls, each with every card it raises allowed as the user would. */
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

type Look = { tab_id: string; content: string };

/** The lines under a frame's line (deeper than it), up to the next line that isn't: what the outline shows inside it. */
function inside(content: string, title: string): string[] {
  const lines = content.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*- iframe "${title}"`).test(l));
  if (at < 0) return [];
  const depth = lines[at]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.search(/\S/) <= depth) break;
    out.push(l.trim());
  }
  return out;
}
const refIn = (lines: string[], line: string) => new RegExp(`^- ${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[ref=(e\\d+)\\]`).exec(lines.find((l) => l.startsWith(`- ${line} [ref=`)) ?? '')?.[1];

async function agentOn(run: (ctx: { app: ElectronApplication; mcp: ReturnType<typeof relay>; allowed: Awaited<ReturnType<typeof allowing>>; open: (path: string) => Promise<Look>; inTab: (url: string, js: string) => Promise<unknown> }) => Promise<void>) {
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const app = await launch(profile, { CHORD_AGENTS: '1' });
  try {
    await expect.poll(async () => (await agents(app)).serving).toBeTruthy();
    const mcp = relay(profile);
    await mcp.request('initialize', CODEX);
    const allowed = await allowing(app, mcp);
    const open = async (path: string) => {
      const look = JSON.parse((await allowed('open_tab', { url: `${site.origin}${path}`, snapshot: true })).text) as Look;
      // The frames load after the top: the snapshot the test reads is taken once they're in.
      await new Promise((r) => setTimeout(r, 800));
      return { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    };
    const inTab = (url: string, js: string) => app.evaluate(({ webContents }, [u, code]) => webContents.getAllWebContents().find((c) => c.getURL() === u)!.executeJavaScript(code), [url, js] as const);
    await run({ app, mcp, allowed, open, inTab });
    mcp.child.stdin!.end();
    await mcp.exited;
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test('a same-origin frame’s contents, with refs, under its line; never what the page hides; no part refs inside (F1)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ open }) => {
    const { content } = await open('/frame-form');
    const lines = inside(content, 'Order form');
    expect(lines.length, content).toBeGreaterThan(0);
    expect(refIn(lines, 'textbox "Name"'), content).toBeDefined();
    expect(refIn(lines, 'combobox "Size"'), content).toBeDefined();
    expect(refIn(lines, 'button "Send order"'), content).toBeDefined();
    for (const hidden of ['Hidden secret', 'Ghost button', 'Inert button', 'Closed secret']) expect(content, hidden).not.toContain(hidden);
    // Read-only parts get no box ref inside a frame (frames.md: not in this slice).
    expect(lines.find((l) => l.includes('region "Order details"')), content).not.toMatch(/\[ref=/);
  });
});

test('a frame that isn’t shown (0×0, off the page) is never entered (B4); an editor frame is one field, what’s typed never read (B2)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open }) => {
    const hidden = await open('/frame-hidden');
    expect(hidden.content).toContain('iframe "Zero" [contents not read: not shown]');
    expect(hidden.content).toContain('iframe "Away" [contents not read: not shown]');
    expect(hidden.content).not.toContain('Widget go');
    const editor = await open('/frame-editor');
    for (const typed of ['typed secret words', 'draft secret words']) expect(editor.content, typed).not.toContain(typed);
    expect(editor.content).toMatch(/textbox "Message body"/);
    expect(editor.content).toMatch(/textbox "Rich note"/);
    // Sensitive by their frame's name, as at the top (#320's SF2): no ref, and said what they are.
    expect(editor.content).toContain('textbox "Card number" [payment detail: the user fills it]');
    expect(editor.content).toContain('textbox "Password" [password: the user signs in]');
    for (const typed of ['4242', 'hunter2']) expect(editor.content, typed).not.toContain(typed);
    // Sensitive by the editor's own label too (round 2, Fable's S1): a "Notes" frame whose body is a "Card number" field,
    // and an untitled one whose body is a "Password": no ref, said what they are.
    const lineOf = (pattern: RegExp) => editor.content.split('\n').find((l) => pattern.test(l)) ?? '';
    expect(lineOf(/textbox "Notes"/), editor.content).toContain('[payment detail: the user fills it]');
    expect(lineOf(/textbox "Notes"/)).not.toContain('[ref=');
    expect(editor.content).toMatch(/- textbox \[password: the user signs in\]/);
    for (const typed of ['4111', 's3cret']) expect(editor.content, typed).not.toContain(typed);
    expect(JSON.parse((await allowed('wait_for', { tab_id: editor.tab_id, text: 'typed secret', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
    // Its non-editable island and its direct text: never read, by the snapshot or wait_for; a chip in it is no button
    // to wait for. Its line is: a textbox named as its frame (#320's NSF1).
    for (const words of ['island secret', 'direct secret', 'Mention chip']) expect(editor.content, words).not.toContain(words);
    for (const words of ['island secret', 'direct secret']) expect(JSON.parse((await allowed('wait_for', { tab_id: editor.tab_id, text: words, timeout_ms: 800 })).text), words).toMatchObject({ data: { met: false } });
    expect(JSON.parse((await allowed('wait_for', { tab_id: editor.tab_id, role: 'button', name: 'Mention chip', timeout_ms: 800 })).text)).toMatchObject({ data: { met: false } });
    expect(JSON.parse((await allowed('wait_for', { tab_id: editor.tab_id, role: 'textbox', name: 'Message body', timeout_ms: 2000 })).text)).toMatchObject({ data: { met: true } });
  });
});

test('a card form in a frame is described as the same form at the top (F10)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ open }) => {
    const strip = (lines: string[]) => lines.map((l) => l.replace(/ \[ref=e\d+\]/, '').trim()).filter((l) => /textbox|button/.test(l));
    const top = (await open('/card-top')).content.split('\n');
    const framed = inside((await open('/frame-card')).content, 'Payment');
    expect(strip(framed), framed.join('\n')).toEqual(strip(top));
  });
});

test('every action on a ref inside a frame is refused for now, and nothing reaches the frame (PR 1: not yet)', async () => {
  test.setTimeout(90_000);
  reached.length = 0;
  await agentOn(async ({ allowed, open, inTab }) => {
    const { tab_id, content } = await open('/frame-form');
    const lines = inside(content, 'Order form');
    const send = refIn(lines, 'button "Send order"')!;
    const name = refIn(lines, 'textbox "Name"')!;
    const size = refIn(lines, 'combobox "Size"')!;
    expect([send, name, size].every(Boolean), content).toBe(true);
    const calls: [string, Record<string, unknown>][] = [
      ['click', { ref: send }],
      ['hover', { ref: send }],
      ['type', { ref: name, text: 'Ada' }],
      ['press_key', { ref: name, key: 'Enter' }],
      ['select_option', { ref: size, option: 'M' }],
    ];
    for (const [tool, args] of calls) {
      const out = await allowed(tool, { tab_id, ...args });
      expect([out.isError, out.text], tool).toEqual([true, ACT_REFUSALS.inFrame]);
    }
    const batched = await allowed('batch', { tab_id, steps: [{ tool: 'click', ref: send }] });
    expect(JSON.parse(batched.text)).toMatchObject({ data: { step: 1, why: ACT_REFUSALS.inFrame } });
    expect(await inTab(`${site.origin}/frame-form`, 'document.querySelector("iframe").contentDocument.getElementById("log").textContent')).toBe('');
    // Nothing typed, nothing chosen (#320's N4).
    expect(await inTab(`${site.origin}/frame-form`, '(() => { const d = document.querySelector("iframe").contentDocument; return [d.querySelector("input[name=name]").value, d.querySelector("select").value]; })()')).toEqual(['', 'S']);
    expect(reached.filter((r) => r.includes('frame-order'))).toEqual([]);
  });
});

test('nested frames are read three deep; a fourth is listed, never entered', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ open }) => {
    const { content } = await open('/frame-nested');
    const outer = inside(content, 'Outer');
    expect(refIn(outer, 'button "Outer go"'), content).toBeDefined();
    const inner = inside(content, 'Inner');
    expect(refIn(inner, 'button "Inner go"'), content).toBeDefined();
    expect(content).toContain('button "Deepest go"');
    expect(content).toContain('iframe "Too deep" [contents not read: too deep]');
    expect(content).not.toContain('Too deep go');
  });
});

test('a frame that went elsewhere after the snapshot: its refs are stale, nothing pressed in either page (F2)', async () => {
  test.setTimeout(120_000);
  await agentOn(async ({ mcp, allowed, open, inTab }) => {
    const host = `${site.origin}/frame-goes`;
    const other = site.origin.replace('127.0.0.1', 'localhost');
    // To another site.
    let look = await open('/frame-goes');
    let go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    expect(go, look.content).toBeDefined();
    await inTab(host, `document.getElementById("w").src = ${JSON.stringify(`${other}/frame-widget`)}`);
    await new Promise((r) => setTimeout(r, 800));
    let out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'to another site').toEqual([true, ELEMENT_REFUSALS.stale]);
    // Its next snapshot: another site's frame, unread.
    look = { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    expect(look.content).toContain('iframe "Widget" [contents not accessible: another site]');
    // To another page of the same site (a new document): stale too.
    await inTab(host, `document.getElementById("w").src = "/frame-widget?again"`);
    await new Promise((r) => setTimeout(r, 800));
    look = { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    expect(go, look.content).toBeDefined();
    await inTab(host, `document.getElementById("w").src = "/frame-widget?third"`);
    await new Promise((r) => setTimeout(r, 800));
    out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'to another page').toEqual([true, ELEMENT_REFUSALS.stale]);
    // Retitled in place, its document the same (#320's SF3): another frame by its name: changed, never not yet.
    look = { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    expect(go, look.content).toBeDefined();
    await inTab(host, 'document.getElementById("w").title = "Payments"');
    out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'retitled').toEqual([true, ACT_REFUSALS.changed]);
    // Moved to another item with moveBefore (its document kept): changed.
    await inTab(host, 'document.getElementById("w").title = "Widget"');
    look = { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    expect(go, look.content).toBeDefined();
    const moved = await inTab(host, '(() => { const w = document.getElementById("w"); const to = document.getElementById("shelfB"); if (typeof to.moveBefore !== "function") return "no moveBefore"; const before = w.contentDocument; to.moveBefore(w, null); return w.contentDocument === before ? "kept" : "reloaded"; })()');
    expect(moved, 'moveBefore keeps the frame’s document').toBe('kept');
    out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'moved to another item').toEqual([true, ACT_REFUSALS.changed]);
    // Removed.
    look = { tab_id: look.tab_id, content: (JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as Look).content };
    go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    await inTab(host, 'document.getElementById("w").remove()');
    out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'removed').toEqual([true, ELEMENT_REFUSALS.stale]);
  });
});

test('a sandboxed frame, a frame of another origin, and any frame of an opaque top stay unread (F9, B1)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ mcp, allowed, open, inTab }) => {
    const { content } = await open('/frame-other');
    expect(content).toContain('iframe "Boxed" [contents not accessible: another site]');
    expect(content).toContain('iframe "Elsewhere" [contents not accessible: another site]');
    expect(content).not.toContain('Widget go');
    const opaque = await open('/frame-opaque');
    expect(opaque.content).toContain('iframe "Inner" [contents not accessible: another site]');
    expect(opaque.content).not.toContain('Inside');
    expect(opaque.content).toContain('iframe "Blank" [contents not accessible: another site]');
    expect(opaque.content).not.toContain('Blank inside');
    // Another origin relaxed by document.domain (a.localhost and b.a.localhost): readable, never entered.
    const relaxedUrl = site.origin.replace('127.0.0.1', 'a.localhost') + '/frame-dd';
    const relaxed = JSON.parse((await allowed('open_tab', { url: relaxedUrl })).text) as { tab_id?: string; data?: { tab_id?: string } };
    const relaxedTab = relaxed.data?.tab_id ?? relaxed.tab_id!;
    await new Promise((r) => setTimeout(r, 1200));
    // The frame really is readable from the top (else this proves nothing).
    expect(await inTab(relaxedUrl, 'document.querySelector("iframe").contentDocument.body.textContent')).toContain('Relaxed inside');
    const relaxedLook = (JSON.parse((await mcp.call('snapshot', { tab_id: relaxedTab })).text) as Look).content;
    expect(relaxedLook).toContain('iframe "Relaxed" [contents not accessible: another site]');
    expect(relaxedLook).not.toContain('Relaxed inside');
  });
});

test('frames by their tag, in the snapshot and wait_for alike: a frameset’s frames and a role=presentation iframe are read; a frame’s fallback never; a role never hides another site (#320’s NSF2)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open }) => {
    const set = await open('/frame-set');
    expect(set.content, 'a frameset’s frames read').toContain('button "Widget go"');
    expect(JSON.parse((await allowed('wait_for', { tab_id: set.tab_id, role: 'button', name: 'Widget go', timeout_ms: 3000 })).text)).toMatchObject({ data: { met: true } });
    const plain = await open('/frame-presentation');
    expect(plain.content, 'an iframe whose role is presentation: still a frame, read').toContain('button "Shown inside"');
    expect(JSON.parse((await allowed('wait_for', { tab_id: plain.tab_id, text: 'Plain words inside', timeout_ms: 3000 })).text)).toMatchObject({ data: { met: true } });
    for (const fallback of ['Fallback never shown', 'Fallback pressable words']) expect(plain.content, fallback).not.toContain(fallback);
    expect(JSON.parse((await allowed('wait_for', { tab_id: plain.tab_id, text: 'Fallback never shown', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
    // role=button: a frame all the same, never a button with a ref.
    expect(plain.content).toContain('iframe "Pressable"');
    expect(plain.content).not.toMatch(/button "Pressable"/);
    // role=region of another origin: still said to be another site.
    expect(plain.content).toContain('iframe "Regional" [contents not accessible: another site]');
    // A frame in a button, a label, an aria-labelledby target: its fallback is in no name (round 2, Neon).
    expect(plain.content, 'in a button').toMatch(/button "Buy" \[ref=/);
    expect(plain.content, 'in a label').toMatch(/textbox "Gift note" \[ref=/);
    expect(plain.content, 'labelledby').toMatch(/textbox "Coupon" \[ref=/);
    expect(plain.content, 'in a link').toMatch(/link "Link words" \[ref=/);
    expect(plain.content, 'in a heading').toContain('heading "Heading words"');
    expect(plain.content).not.toContain('Fallback in');
  });
});

test('a frame whose own document is hidden (its html or body: hidden, aria-hidden, display, inert, visibility, opacity) is never read, by the snapshot or wait_for; nor a top whose body is hidden, while aria-hidden alone on the top’s body is read (#320’s NSF3; round 2, Fable’s S3)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open }) => {
    const docs = await open('/frame-hidden-doc');
    for (const go of ['Body hidden go', 'Aria hidden go', 'Display none go', 'Inert go', 'Invisible go', 'Clear go', 'body hidden words']) expect(docs.content, go).not.toContain(go);
    for (const title of ['Body hidden', 'Html aria-hidden', 'Body none', 'Body inert', 'Body invisible', 'Body clear']) expect(docs.content, title).toContain(`iframe "${title}" [contents not read: not shown]`);
    expect(JSON.parse((await allowed('wait_for', { tab_id: docs.tab_id, role: 'button', name: 'Body hidden go', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
    expect(JSON.parse((await allowed('wait_for', { tab_id: docs.tab_id, text: 'body hidden words', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
    const top = await open('/top-hidden');
    expect(top.content).not.toContain('Top hidden go');
    expect(JSON.parse((await allowed('wait_for', { tab_id: top.tab_id, role: 'button', name: 'Top hidden go', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
    // aria-hidden on the top's body hides nothing on screen: read, and waited for (round 2, Fable's S3). A frame's still
    // isn't (above).
    const shownTop = await open('/top-aria-hidden');
    expect(shownTop.content).toMatch(/button "Top aria go" \[ref=/);
    expect(JSON.parse((await allowed('wait_for', { tab_id: shownTop.tab_id, text: 'top aria words', timeout_ms: 2000 })).text)).toMatchObject({ data: { met: true } });
  });
});

test('shown() is the frame’s own: a fixed button past the frame’s width gets no ref; one scrolled up out of its view still does; wait_for never sees into a frame not shown (#320’s NSF4)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open }) => {
    const scrolled = await open('/frame-scrolled');
    const inner = inside(scrolled.content, 'Scroller');
    expect(refIn(inner, 'button "Up top"'), scrolled.content).toBeDefined();
    expect(refIn(inner, 'button "Far fixed"'), scrolled.content).toBeUndefined();
    const hidden = await open('/frame-hidden');
    expect(JSON.parse((await allowed('wait_for', { tab_id: hidden.tab_id, role: 'button', name: 'Widget go', timeout_ms: 1000 })).text)).toMatchObject({ data: { met: false } });
  });
});

test('a node moved between a frame and the top after the snapshot: refused, never pressed where it went (B5)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open, inTab }) => {
    const url = `${site.origin}/frame-adopt`;
    let look = await open('/frame-adopt');
    const move = /button "Move me" \[ref=(e\d+)\]/.exec(look.content)?.[1];
    expect(move, look.content).toBeDefined();
    await inTab(url, 'window.intoFrame()');
    let out = await allowed('click', { tab_id: look.tab_id, ref: move! });
    expect(out.isError, 'into a frame').toBe(true);
    expect([ACT_REFUSALS.changed, ELEMENT_REFUSALS.stale], 'into a frame').toContain(out.text);
    look = await open('/frame-adopt');
    const go = refIn(inside(look.content, 'Widget'), 'button "Widget go"');
    expect(go, look.content).toBeDefined();
    await inTab(url, 'window.outOfFrame()');
    out = await allowed('click', { tab_id: look.tab_id, ref: go! });
    expect([out.isError, out.text], 'out of a frame').toEqual([true, ELEMENT_REFUSALS.stale]);
    expect(await inTab(url, 'document.getElementById("f").contentDocument.getElementById("log").textContent')).toBe('');
  });
});

test('a frame’s fallback is no part of a row’s words: patched, the row’s button still acts (#273’s rows with #320’s NSF2)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open, inTab }) => {
    const url = `${site.origin}/frame-in-row`;
    const look = await open('/frame-in-row');
    const cancel = /button "Cancel" \[ref=(e\d+)\]/.exec(look.content)?.[1];
    expect(cancel, look.content).toBeDefined();
    await inTab(url, 'window.patchFallback()');
    const out = await allowed('click', { tab_id: look.tab_id, ref: cancel! });
    expect([out.isError, out.text.slice(0, 80)]).toEqual([false, expect.any(String)]);
    expect(await inTab(url, 'document.getElementById("log").textContent')).toBe(' cancel');
  });
});

test('a huge frame counts in the snapshot’s budgets: cut, and said so (F11)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ mcp, open }) => {
    const look = await open('/frame-huge');
    const raw = JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as { content: string; note?: string; data?: { note?: string } };
    expect(raw.content).toContain('iframe "Huge"');
    expect(raw.content).not.toContain('Past the end');
    expect(JSON.stringify(raw), 'the cut said').toMatch(/too big|cut short|more than/i);
  });
});

test('an editor frame past a full ref budget is cut, and said so; never silently left without a ref (#320’s NN1)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ mcp, open }) => {
    const look = await open('/frame-editor-full');
    // On a slow CPU the snapshot's time budget can cut the walk before it reaches the frame (said: too big to read
    // whole). That's the time budget, not this: take it again (a warm page walks faster), at most 3 times.
    let raw = { content: '' };
    for (let i = 0; i < 3 && !raw.content.includes('textbox "Late body"'); i++) {
      raw = JSON.parse((await mcp.call('snapshot', { tab_id: look.tab_id })).text) as { content: string };
      if (!raw.content.includes('textbox "Late body"')) expect(JSON.stringify(raw), 'cut short only by time').toMatch(/too big to read whole/);
    }
    expect(raw.content).toContain('textbox "Late body"');
    expect(JSON.stringify(raw), 'the cut said').toMatch(/Only the first 2000/);
  });
});

test('wait_for sees inside a same-origin frame: a button and a text drawn late', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open, inTab }) => {
    const { tab_id } = await open('/frame-late');
    // Woken by the frame's change itself (its document watched, SF1): a wait shorter than one look's chunk (1 s), the
    // drawing 400 ms into it. Unwatched, its only look comes before the drawing, and it ends unmet. No stopwatch: it
    // holds on one slow CPU too.
    const short = allowed('wait_for', { tab_id, role: 'button', name: 'Late in frame', timeout_ms: 950 });
    await new Promise((r) => setTimeout(r, 400));
    await inTab(`${site.origin}/frame-late`, 'document.querySelector("iframe").contentWindow.drawLate()');
    expect(JSON.parse((await short).text), 'woken inside the frame').toMatchObject({ data: { met: true } });
    // Its ref, by the wait's outline (met at once now).
    const button = JSON.parse((await allowed('wait_for', { tab_id, role: 'button', name: 'Late in frame', timeout_ms: 8000, snapshot: true })).text) as { content?: string; data?: { met?: boolean; page_changes?: { lines?: string[] } } };
    const shown = button.content ?? (button.data?.page_changes?.lines ?? []).join('\n');
    expect(shown, JSON.stringify(button)).toMatch(/button "Late in frame" \[ref=e\d+\]/);
    expect(JSON.parse((await allowed('wait_for', { tab_id, text: 'Ready now', timeout_ms: 5000 })).text)).toMatchObject({ data: { met: true } });
  });
});

test('refind never crosses frames: a twin in a sibling frame is never acted on; a top ref moved into a frame is never found there (F12)', async () => {
  test.setTimeout(120_000);
  await agentOn(async ({ mcp, allowed, open, inTab }) => {
    const twins = await open('/frame-twins');
    const left = refIn(inside(twins.content, 'Left'), 'button "Go"');
    const right = refIn(inside(twins.content, 'Right'), 'button "Go"');
    expect([left, right].every(Boolean), twins.content).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    for (const ref of [left!, right!]) expect((await allowed('click', { tab_id: twins.tab_id, ref })).isError).toBe(true);
    // Both held still, a new snapshot; then Left's button removed, Right's kept (B6): Left's ref is changed, never
    // Right's button; Right's own is not yet (never a twin's ambiguous).
    await inTab(`${site.origin}/frame-twins`, '[...document.querySelectorAll("iframe")].forEach((f) => f.contentWindow.holdStill())');
    const still = (JSON.parse((await mcp.call('snapshot', { tab_id: twins.tab_id })).text) as Look).content;
    const leftNow = refIn(inside(still, 'Left'), 'button "Go"');
    const rightNow = refIn(inside(still, 'Right'), 'button "Go"');
    expect([leftNow, rightNow].every(Boolean), still).toBe(true);
    await inTab(`${site.origin}/frame-twins`, 'document.querySelector("iframe[title=Left]").contentWindow.removeGo()');
    const gone = await allowed('click', { tab_id: twins.tab_id, ref: leftNow! });
    expect([gone.isError, gone.text], 'Left, gone').toEqual([true, ACT_REFUSALS.changed]);
    const kept = await allowed('click', { tab_id: twins.tab_id, ref: rightNow! });
    expect([kept.isError, kept.text], 'Right').toEqual([true, ACT_REFUSALS.inFrame]);
    expect(await inTab(`${site.origin}/frame-twins`, '[...document.querySelectorAll("iframe")].map((f) => f.contentDocument.getElementById("log").textContent).join("|")')).toBe('|');
    // A top button the page moves (the live node) into a frame: refused, never pressed in there (B5).
    const top = await open('/frame-swallows');
    const fold = /button "Fold" \[ref=(e\d+)\]/.exec(top.content)?.[1];
    expect(fold, top.content).toBeDefined();
    await inTab(`${site.origin}/frame-swallows`, 'window.swallow()');
    await new Promise((r) => setTimeout(r, 500));
    const out = await allowed('click', { tab_id: top.tab_id, ref: fold! });
    expect(out.isError).toBe(true);
    expect([ACT_REFUSALS.changed, ELEMENT_REFUSALS.stale]).toContain(out.text);
  });
});

test('a same-origin frame put over a top button still covers it (F3)', async () => {
  test.setTimeout(90_000);
  await agentOn(async ({ allowed, open, inTab }) => {
    const { tab_id, content } = await open('/frame-decoy');
    const pay = /button "Pay" \[ref=(e\d+)\]/.exec(content)?.[1];
    expect(pay, content).toBeDefined();
    const out = await allowed('click', { tab_id, ref: pay! });
    expect(out.text).toBe(ACT_REFUSALS.covered('frame “Decoy”'));
    expect(await inTab(`${site.origin}/frame-decoy`, 'document.getElementById("log").textContent')).toBe('');
  });
});
