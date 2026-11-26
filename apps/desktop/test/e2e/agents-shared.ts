/** What agents' E2E specs share (split from agents.spec.ts, #213): the relay, the cards, launching Chord with Agents, and the test site (startAgentSite). */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { watchForMainErrors } from './main-errors';
import { isPopover, isSettings, pageWhere, runAction } from './a11y-kit';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const appDir = resolve(import.meta.dirname, '../..');

export type Hooks = { chordTestHooks: { agents(): Promise<{ serving: string | null; connections: number; restricted: number | null }>; agentsStopAll(): void } };

/** The hooks are set once main has started its services: wait for them. */
export const agents = async (app: ElectronApplication) => {
  await expect.poll(() => app.evaluate(() => Boolean((globalThis as unknown as Partial<Hooks>).chordTestHooks))).toBe(true);
  return app.evaluate(() => (globalThis as unknown as Hooks).chordTestHooks.agents());
};

export async function launch(profile: string, env: Record<string, string>): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, CHORD_E2E_HOOKS: '1', ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, '--no-first-run'], env: childEnv, cwd: appDir }));
}

/** `chord mcp` from the development build, as an agent starts it (the profile by CHORD_USER_DATA, as in development). */
export function relay(profile: string) {
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

export const CODEX = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '0.160.1' } };

export const CLAUDE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.328' } };

/** The connect card in the window's popover, for that agent. */
export const cardOf = (popover: Page, name: string) => popover.getByRole('alertdialog', { name: `${name} wants to use Chord` });

/** Answer the card as you would: once it's shown (its buttons wait a moment before they take a click). */
export async function answer(app: ElectronApplication, name: string, button: 'Deny' | 'Allow once' | 'Always allow' | 'Close'): Promise<void> {
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
export const refOf = (outline: string, line: string) => {
  const found = outline.split('\n').find((l) => l.trim().startsWith(`- ${line} [ref=`));
  if (!found) throw new Error(`No "${line}" in\n${outline}`);
  return /\[ref=(e\d+)\]/.exec(found)![1]!;
};

/* ---------- Acting (S18 M2c) ---------- */

export const siteCardOf = (popover: Page, name: string) => popover.getByRole('alertdialog', { name: new RegExp(`^Let ${name} click and type on `) });

/** A list of rows of links, buttons and text: `rows` of 5 elements each. */
const rowsPage = (rows: number) =>
  `<title>Rows</title><main><h1>Rows</h1><ul>${Array.from({ length: rows }, (_, i) => `<li><a href="/r${i}">Row ${i}</a> <span>Note ${i}</span> <button>Act ${i}</button></li>`).join('')}</ul></main>`;

/**
 * Times are held where they were measured: in the Linux container (no CI variable) and on reference hardware
 * (CHORD_PERF_ENFORCE=1). On CI's shared runners they're reported, never failed, as perf.spec.ts's are
 * (docs/testing/performance.md): a time is the runner's load as much as Chord's, and these budgets failed ten CI runs
 * in two days (2026-11-22 to 24: medians of 27 against 25 ms, worsts of 77 against 60 and 128 against 90) with no
 * change to the snapshot. Every count stays checked everywhere.
 */
export const TIMES_HELD = !process.env['CI'] || process.env['CHORD_PERF_ENFORCE'] === '1';

/** A time under its budget where times are held; elsewhere, one over it is reported on the test, never failed. */
export function within(ms: number, budget: number, seen: string): void {
  if (TIMES_HELD) expect(ms, seen).toBeLessThan(budget);
  else if (ms >= budget) test.info().annotations.push({ type: 'over budget (reported on CI)', description: `${ms.toFixed(1)} ms, budget ${budget} ms: ${seen}` });
}

/** Settings → Agents, opened from the window. */
export async function agentsSettings(app: ElectronApplication, shell: Page): Promise<Page> {
  await runAction(shell, 'app.settings');
  const settings = await pageWhere(app, isSettings);
  await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Agents' }).click();
  await expect(settings.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Agents');
  return settings;
}

/** What reached the test site that changes something (S18 M2d): each form posted, each delete address asked for. */
export const reached: string[] = [];

export async function startAgentSite(): Promise<{ server: Server; origin: string }> {
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
    // The same page, its answer at the top (#206: a reading journey whose answer is near the start, as an article's lead).
    '/article50-lead':
      '<title>Fifty sections</title><main><h1>Fifty sections</h1>' +
      Array.from({ length: 50 }, (_, i) => `<section aria-label="Section ${i + 1}"><h2>Section ${i + 1}</h2><p>${i === 1 ? 'The first word is juniper. ' : ''}${'This paragraph is here to make the section as long as a real one, with nothing to find in it. '.repeat(12)}</p></section>`).join('') +
      '</main>',
    // #205's measure, on the page as it was then (#207 makes a section named by aria-label a region, which collapses as
    // rows alike): its sections plain, never regions.
    '/article50-plain':
      '<title>Fifty sections</title><main><h1>Fifty sections</h1>' +
      Array.from({ length: 50 }, (_, i) => `<section><h2>Section ${i + 1}</h2><p>${i === 36 ? 'The code word is saffron. ' : ''}${'This paragraph is here to make the section as long as a real one, with nothing to find in it. '.repeat(12)}</p></section>`).join('') +
      '</main>',
    // #207: parts read by their container refs, and what a part's read never gives.
    '/parts':
      '<title>Parts</title><main><nav aria-label="Site"><a href="/">Home</a></nav>' +
      '<section aria-label="Orders"><h2>Orders</h2><p>Shown words: order 12 shipped.</p>' +
      '<p style="display:none">hidden-display</p><p style="visibility:hidden">hidden-visibility</p><p style="opacity:0">hidden-opacity</p><p hidden>hidden-attribute</p><div inert><p>hidden-inert</p></div>' +
      '<input aria-label="Note" value="field-value-secret"><textarea aria-label="Message">textarea-secret</textarea>' +
      '<div contenteditable="true">editor-secret</div><div role="textbox">aria-textbox-secret</div><span role="searchbox">aria-searchbox-secret</span><div role="combobox">aria-combobox-secret</div>' +
      '<iframe title="Chat" srcdoc="<p>frame-inside-secret</p>"></iframe><button>Cancel order</button></section>' +
      '<article aria-label="Story"><p>Story words.</p></article><table aria-label="Prices"><tr><td>Tea</td><td>3</td></tr></table>' +
      // Parts the page read never enters (round 1 of #260): an off-screen wrapper, a button, a hidden wrapper shown by CSS,
      // an ARIA text field, an inert wrapper, a display: contents part that's hidden; a part that is a shadow host; and
      // sections whose label is empty or names nothing (no region).
      '<div style="position:absolute;left:-10000px;top:-10000px"><section aria-label="Offscreen"><p>offscreen-secret</p></section></div>' +
      '<button><section aria-label="In a button"><p>button-secret</p></section></button>' +
      '<div hidden style="display:block"><section aria-label="Hidden shown"><p>hiddenshown-secret</p></section></div>' +
      '<div role="combobox"><section aria-label="In a combobox"><p>combobox-part-secret</p></section></div>' +
      '<div inert><section aria-label="Inert part"><p>inert-part-secret</p></section></div>' +
      '<section aria-label="Contents hidden" style="display:contents;visibility:hidden"><p>contents-secret</p></section>' +
      '<div id="shadowhost" role="region" aria-label="Shadowed"></div><script>document.getElementById("shadowhost").attachShadow({ mode: "open" }).innerHTML = "<p>shadow-words</p>";</script>' +
      '<section aria-label=""><p>empty-label-words</p></section><section aria-labelledby="no-such-id"><p>dangling-label-words</p></section>' +
      // Parts the test changes after the snapshot (round 2 of #260): each wrapper made inert, hidden but shown by CSS, an
      // editor; a shadow host made inert; a part adopted into the frame; a part made inert itself.
      '<div id="w-inert"><section aria-label="Inert later"><p>inertlater-secret</p></section></div>' +
      '<div id="w-hidden"><section aria-label="Hidden later"><p>hiddenlater-secret</p></section></div>' +
      '<div id="w-editor"><section aria-label="Editor later"><p>editorlater-secret</p></section></div>' +
      '<div id="w-shadow"></div><script>document.getElementById("w-shadow").attachShadow({ mode: "open" }).innerHTML = "<section aria-label=\\"In a shadow\\"><p>shadowpart-secret</p></section>";</script>' +
      '<section id="adopted" aria-label="Adopted"><p>adopted-secret</p></section>' +
      '<section id="self-inert" aria-label="Self inert"><p>selfinert-secret</p></section></main>',
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
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
