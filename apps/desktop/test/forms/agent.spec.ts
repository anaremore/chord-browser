/**
 * The passwords agent itself (src/passwords/agent), in Playwright's own headless Chromium with a
 * fake bridge: what it would send main, for what a person and a page do. Playwright's input is
 * trusted, as a person's is; a page's own script is played by `page.evaluate`.
 *
 * - Focus moved in a loop: one message a frame, the last state; a carousel scrolling elsewhere: none.
 * - One submit (Enter, then the form's `submit`): one candidate, with what was typed. Leaving
 *   the password field: a candidate only after typing in it, at most once a second, and never
 *   with a value.
 * - Buttons: a `type="button"` that signs in counts; a show-password eye doesn't.
 * - Fields added in a loop: `forms` at most once a frame.
 * - A smooth scroll: focus at most every 100 ms, and the last one is the field's final box.
 * - A form or document whose properties a page clobbered (`<input name="childNodes">`,
 *   `<form name="addEventListener">`) doesn't stop detection.
 * - Filling (S17 §5): the form the menu was shown for gets the values, the page's own script
 *   sees `input` and `change`, and the markup is untouched; a password field that turned into
 *   text, one that's hidden or off screen, or a form that's gone gets nothing.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

const ORIGIN = 'http://agent.test';
let script = '';
let body = '';
test.beforeAll(async () => {
  script = await bundleAgent({ entry: join(import.meta.dirname, 'agent-entry.ts'), minify: false });
});
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    route.request().url().startsWith(`${ORIGIN}/`) ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }) : route.abort(),
  );
});

type Message = [string, Record<string, unknown>];
interface AgentTest {
  start(): void;
  fill(payload: unknown): void;
  messages(): Message[];
  clear(): void;
}
const api = (page: Page) => ({
  messages: () => page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.messages()),
  clear: () => page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.clear()),
  of: async (channel: string) => (await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.messages())).filter(([c]) => c === channel).map(([, p]) => p),
  /** Two animation frames and the fallback timer: anything the agent coalesces has gone out. */
  settle: () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150))))),
});

async function open(page: Page, html: string) {
  body = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body>${html}</body></html>`;
  await page.goto(`${ORIGIN}/page`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.start());
  const a = api(page);
  await a.settle();
  return a;
}

const SIGN_IN =
  '<h1>Sign in</h1><form id="f" action="/session"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"><button id="go">Sign in</button></form>';

test('focus moved in a loop: one message a frame, the last state; scrolling elsewhere: none', async ({ page }) => {
  const a = await open(page, `${SIGN_IN}<div id="carousel" style="overflow:auto;width:200px;height:50px"><div style="width:5000px;height:40px"></div></div><div style="height:3000px"></div>`);
  await a.clear();
  await page.evaluate(() => {
    const u = document.getElementById('u') as HTMLInputElement;
    const p = document.getElementById('p') as HTMLInputElement;
    for (let i = 0; i < 1000; i++) {
      u.focus();
      p.focus();
    }
  });
  await a.settle();
  const focus = await a.of('focus');
  expect(focus).toHaveLength(1);
  expect(focus[0]).toMatchObject({ role: 'current-password', kind: 'sign-in' });
  expect(await a.of('blur')).toEqual([]);

  // A carousel scrolling while the field has focus: the field didn't move, so nothing goes out.
  await a.clear();
  for (let i = 1; i <= 20; i++) {
    await page.evaluate((x) => void (document.getElementById('carousel')!.scrollLeft = x * 40), i);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
  }
  await a.settle();
  expect(await a.messages()).toEqual([]);
  // The page scrolling moves the field: its new box, once.
  await page.evaluate(() => window.scrollBy(0, 30));
  await a.settle();
  expect(await a.of('focus')).toHaveLength(1);
});

test('one submit is one candidate; leaving the password field sends one only after typing, at most once a second', async ({ page }) => {
  const a = await open(page, SIGN_IN);
  // The page's script handles the form itself (no navigation, so the test can count).
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'secret pass');
  await a.clear();
  await page.press('#p', 'Enter');
  await a.settle();
  const submits = await a.of('candidate');
  expect(submits).toHaveLength(1);
  expect(submits[0]).toMatchObject({ signal: 'enter', hasUsername: true, hasPassword: true, password: { type: 'password', id: 'p', name: 'password' } });
  // What was typed goes with the submit's candidate, for the save card, and in no other message.
  expect(submits[0]!['values']).toEqual({ username: 'ada@example.com', password: 'secret pass' });
  expect(JSON.stringify((await a.messages()).filter(([c]) => c !== 'candidate'))).not.toMatch(/ada@example\.com|secret pass/);

  // Leaving the field after typing: one candidate. Moving focus back and forth without typing: none.
  await page.waitForTimeout(1100);
  await page.fill('#p', 'secret pass 2');
  await a.clear();
  await page.focus('#u');
  expect((await a.of('candidate')).map((c) => c['signal'])).toEqual(['blur']);
  // Leaving the field sends no value: only a submit does.
  expect(JSON.stringify(await a.messages())).not.toMatch(/ada@example\.com|secret pass/);
  await a.clear();
  await page.evaluate(() => {
    for (let i = 0; i < 50; i++) {
      (document.getElementById('p') as HTMLInputElement).focus();
      (document.getElementById('u') as HTMLInputElement).focus();
    }
  });
  expect(await a.of('candidate')).toEqual([]);
  // Typing again and leaving within a second: still none (once a second); after it, one.
  await page.fill('#p', 'secret pass 3');
  await page.focus('#u');
  expect(await a.of('candidate')).toEqual([]);
  await page.waitForTimeout(1100);
  await page.fill('#p', 'secret pass 4');
  await page.focus('#u');
  expect((await a.of('candidate')).map((c) => c['signal'])).toEqual(['blur']);
});

test('buttons: a type="button" that signs in counts, a show-password eye and "Forgot password?" don\'t', async ({ page }) => {
  const a = await open(
    page,
    '<form id="f"><input id="u" name="user" aria-label="Username"><span><input id="p" name="pw" type="password" aria-label="Password"><button id="eye" type="button" aria-label="Show password">o</button></span>' +
      '<button id="forgot" type="button">Forgot password?</button><button id="go" type="button">Sign in</button></form>',
  );
  await page.fill('#u', 'ada');
  await page.fill('#p', 'secret pass');
  await a.clear();
  // Clicking takes focus from the password field: that's the blur candidate, not a submit.
  const submits = async (x: typeof a) => (await x.of('candidate')).map((c) => c['signal']).filter((signal) => signal !== 'blur');
  await page.click('#eye');
  await page.click('#forgot');
  expect(await submits(a)).toEqual([]);
  await page.click('#go');
  expect(await submits(a)).toEqual(['button']);

  // A form's only button counts, whatever it says.
  const b = await open(page, '<form><input id="u" name="user" aria-label="Username"><input id="p" name="pw" type="password" aria-label="Password"><button id="only" type="button">→</button></form>');
  await page.fill('#u', 'ada');
  await page.fill('#p', 'secret pass');
  await b.clear();
  await page.click('#only');
  expect(await submits(b)).toEqual(['button']);
});

test('fields added and focused in a loop: forms at most once a frame', async ({ page }) => {
  const a = await open(page, SIGN_IN);
  await a.clear();
  await page.evaluate(() => {
    const form = document.getElementById('f')!;
    for (let i = 0; i < 200; i++) {
      const input = document.createElement('input');
      input.name = `extra${i}`;
      form.append(input);
      input.focus();
    }
  });
  await a.settle();
  expect((await a.of('forms')).length).toBeLessThanOrEqual(2);
});

test('a form whose own properties a page clobbered doesn\'t stop detection', async ({ page }) => {
  const a = await open(
    page,
    '<div><form id="odd"><input name="childNodes"><input name="getAttribute"><input name="querySelectorAll"><input name="parentElement"></form></div>' +
      '<form id="real"><label for="u">Username</label><input id="u" name="user"><label for="p">Password</label><input id="p" name="pw" type="password"><button>Log in</button></form>',
  );
  // The scan ran when the agent started: its first forms message names the real form's password.
  const reported = (await a.of('forms')).flatMap((m) => m['forms'] as Record<string, unknown>[]);
  expect(reported).toContainEqual(expect.objectContaining({ kind: 'sign-in', password: { type: 'password', id: 'p', name: 'pw' } }));
});

test('a smooth scroll: focus at most every 100 ms, and the last one is where the field ends up', async ({ page }) => {
  const a = await open(page, `${SIGN_IN}<div style="height:3000px"></div>`);
  await page.focus('#p');
  await a.settle();
  await a.clear();
  const started = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => (window.scrollBy(0, 5), done()))));
  }
  const ms = Date.now() - started;
  await page.waitForTimeout(250);
  const focus = await a.of('focus');
  const box = await page.evaluate(() => {
    const r = document.getElementById('p')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  expect(focus.length).toBeGreaterThan(0);
  expect(focus.at(-1)!['rect']).toEqual(box);
  // Within the rate main allows (20 a second, a burst of 10): at most one every 100 ms, and the trailing one.
  expect(focus.length).toBeLessThanOrEqual(Math.ceil(ms / 100) + 2);
});

test("a document whose own properties a page clobbered doesn't stop detection", async ({ page }) => {
  const a = await open(
    page,
    '<form name="addEventListener"></form><form name="querySelectorAll"></form><form name="activeElement"></form><img name="title" alt=""><img name="body" alt="">' +
      '<form id="real"><input id="u" name="user" aria-label="Username"><input id="p" name="pw" type="password" aria-label="Password"><button>Log in</button></form>',
  );
  const reported = (await a.of('forms')).flatMap((m) => m['forms'] as Record<string, unknown>[]);
  expect(reported).toContainEqual(expect.objectContaining({ kind: 'sign-in', password: { type: 'password', id: 'p', name: 'pw' } }));
  // Its listeners are on: focus is reported.
  await page.focus('#p');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ role: 'current-password' });
});

const FILL = { formId: 'f1', username: 'ada@example.com', password: 'secret pass', highlight: { color: 'rgb(200, 0, 100)', ms: 50, stagger: 0, easing: 'linear' } };
const fill = (page: Page, payload: unknown) => page.evaluate((p) => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.fill(p), payload);

test('a fill: the values in, the page sees typing, nothing added to the page', async ({ page }) => {
  const a = await open(page, SIGN_IN);
  await page.evaluate(() => {
    const seen: string[] = [];
    (globalThis as unknown as { seen: string[] }).seen = seen;
    for (const id of ['u', 'p']) for (const type of ['input', 'change']) document.getElementById(id)!.addEventListener(type, () => seen.push(`${id}:${type}`));
  });
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.inputValue('#u')).toBe('ada@example.com');
  expect(await page.inputValue('#p')).toBe('secret pass');
  expect(await page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).toEqual(['u:input', 'u:change', 'p:input', 'p:change']);
  // The outline is an animation, not a style or attribute: the markup is as it was.
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  // Submitting what was filled: the candidate is the save card's, as typed.
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  await page.press('#p', 'Enter');
  await a.settle();
  expect((await a.of('candidate'))[0]).toMatchObject({ signal: 'enter', values: { username: 'ada@example.com', password: 'secret pass' } });
});

test('a fill writes nothing when the form isn’t as the menu showed it', async ({ page }) => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ['the password field is text now (a show-password toggle)', "document.getElementById('p').type = 'text'"],
    ['the password field is hidden', "document.getElementById('p').style.display = 'none'"],
    ['the fields are under an invisible layer of their own', "document.getElementById('f').style.opacity = '0'"],
    ['the form is gone', "document.getElementById('f').remove()"],
    ['the form was replaced by a copy', "const f = document.getElementById('f'); f.replaceWith(f.cloneNode(true))"],
    ['another form’s id', '', { formId: 'f9' }],
    ['no password', '', { password: '' }],
  ];
  for (const [name, change, over] of cases) {
    const a = await open(page, SIGN_IN);
    if (change) await page.evaluate(change);
    await a.clear();
    await fill(page, { ...FILL, ...over });
    const filled = await a.of('filled');
    expect(filled.map((f) => f['ok']), name).toEqual(over?.['password'] === '' ? [] : [false]);
    const values = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value));
    expect(values.join(''), name).toBe('');
  }
});

test('a fill on a page scrolled away from the form writes nothing', async ({ page }) => {
  const a = await open(page, `${SIGN_IN}<div style="height:5000px"></div>`);
  await page.evaluate(() => window.scrollTo(0, 4000));
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: false, reason: 'changed' }]);
  expect(await page.inputValue('#p')).toBe('');
});

test('never half a fill: a password field the fill has no password for gets the form nothing, and says why', async ({ page }) => {
  const { password: _password, ...noPassword } = FILL;
  const cases: [string, string, unknown, { ok: boolean; reason?: string }, string][] = [
    // Main thought it a first step (`username-only`), but the form has a password field after all.
    ['main sent no password to a sign-in form', SIGN_IN, noPassword, { ok: false, reason: 'password' }, ''],
    // The detector read the form's only password as a new one: the saved password has nowhere it may go.
    [
      'the only password field reads as a new one',
      '<form id="f"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Create a password"><button>Log in</button></form>',
      FILL,
      { ok: false, reason: 'password' },
      '',
    ],
    // A real first step: no password field, so no password, and the username goes in.
    [
      'a first step',
      '<form id="f"><input id="u" name="email" type="email" aria-label="Email"><button>Next</button></form>',
      noPassword,
      { ok: true },
      'ada@example.com',
    ],
  ];
  for (const [name, html, payload, outcome, written] of cases) {
    const a = await open(page, html);
    await a.clear();
    await fill(page, payload);
    expect(await a.of('filled'), name).toEqual([{ formId: 'f1', ...outcome }]);
    const values = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value));
    expect(values.join(''), name).toBe(written);
  }
});

test('hidden fields: a first step carrying a hidden password field, and a hidden duplicate of the fields', async ({ page }) => {
  const { password: _password, ...noPassword } = FILL;
  // A first step whose next step's password field is in the page, hidden: username-only, filled without a password.
  let a = await open(
    page,
    '<div id="step"><input id="u" type="email" name="email" autocomplete="username" aria-label="Email"><input id="p" type="password" name="password" style="display:none"><button type="button">Next</button></div>',
  );
  await page.focus('#u');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'username-only', role: 'username' });
  await a.clear();
  await fill(page, noPassword);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.inputValue('#u')).toBe('ada@example.com');
  // The next step shown in place: the password field, focused, is classed as it is now.
  await page.evaluate(() => {
    (document.getElementById('u') as HTMLElement).style.display = 'none';
    (document.getElementById('p') as HTMLElement).style.display = '';
  });
  await a.clear();
  await page.focus('#p');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-in', role: 'current-password' });

  // A hidden copy of the sign-in fields before the shown ones, with the same autocomplete: the shown pair has the roles.
  a = await open(
    page,
    '<div hidden><input id="uc" type="email" autocomplete="username"><input id="pc" type="password" autocomplete="current-password"></div>' +
      '<div><input id="u" type="email" autocomplete="username webauthn" aria-label="Email or phone"><input id="p" type="password" autocomplete="current-password" aria-label="Password"><button>Sign in</button></div>',
  );
  await page.focus('#u');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-in', role: 'username' });
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.evaluate(() => ['u', 'p', 'uc', 'pc'].map((id) => (document.getElementById(id) as HTMLInputElement).value))).toEqual(['ada@example.com', 'secret pass', '', '']);
});

test('a one-step sign-in that shows its password field when the email takes focus: a fresh focus says sign-in, and a pick fills both', async ({ page }) => {
  const a = await open(
    page,
    '<form id="f"><input id="u" type="email" name="email" aria-label="Email"><input id="p" type="password" name="password" aria-label="Password" style="display:none"><button>Log in</button></form>',
  );
  // The page's own script: the password field shows once the email has focus.
  await page.evaluate(() => document.getElementById('u')!.addEventListener('focus', () => ((document.getElementById('p') as HTMLElement).style.display = '')));
  await a.clear();
  await page.focus('#u');
  await a.settle();
  const focus = await a.of('focus');
  // The last word main has: a sign-in now (main reads it when you pick), the email still the username.
  expect(focus.at(-1)).toMatchObject({ formId: 'f1', kind: 'sign-in', role: 'username' });
  expect((await a.of('forms')).at(-1)?.['forms']).toEqual([expect.objectContaining({ formId: 'f1', kind: 'sign-in' })]);
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.inputValue('#u')).toBe('ada@example.com');
  expect(await page.inputValue('#p')).toBe('secret pass');
});

test('a first step whose password field waits transparent in the same form: no password to it, then a sign-in once it shows', async ({ page }) => {
  const { password: _password, ...noPassword } = FILL;
  const a = await open(
    page,
    '<form id="f"><div id="one"><input id="u" type="email" name="login" autocomplete="username webauthn" aria-label="Email"><input type="submit" value="Next"></div>' +
      '<div id="two" style="opacity:0"><input id="p" type="password" name="passwd" aria-label="Password"></div></form>',
  );
  await page.focus('#u');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'username-only', role: 'username' });
  await a.clear();
  await fill(page, noPassword);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.inputValue('#u')).toBe('ada@example.com');
  // Next, as the page does it: the first pane fades out, the password's in.
  await page.evaluate(() => {
    (document.getElementById('one') as HTMLElement).style.cssText = 'opacity:0';
    (document.getElementById('two') as HTMLElement).style.cssText = '';
  });
  await a.clear();
  await page.focus('#p');
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-in', role: 'current-password' });
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await page.inputValue('#p')).toBe('secret pass');
});

test('a password step carrying the username from the step before: the password alone goes in, for that account only', async ({ page }) => {
  // The username field as such steps carry it: read-only and shown, read-only and hidden, or only hidden.
  const steps: [string, string][] = [
    ['read-only, shown', '<input id="u" type="text" name="username" autocomplete="username" readonly value="ada@example.com" aria-label="Email">'],
    ['read-only, hidden', '<input id="u" type="text" name="username" autocomplete="username" readonly value="ada@example.com" style="display:none">'],
    ['hidden', '<input id="u" type="text" name="username" autocomplete="username" value="ada@example.com" style="display:none">'],
  ];
  for (const [name, field] of steps) {
    const html = `<h1>Enter your password</h1><form id="f">${field}<input id="p" type="password" name="password" autocomplete="current-password" aria-label="Password"><button>Continue</button></form>`;
    let a = await open(page, html);
    await a.clear();
    await fill(page, FILL);
    expect(await a.of('filled'), name).toEqual([{ formId: 'f1', ok: true }]);
    expect(await page.inputValue('#p'), name).toBe('secret pass');
    expect(await page.inputValue('#u'), name).toBe('ada@example.com');
    // Another account picked than the one the step carries: nothing.
    a = await open(page, html);
    await a.clear();
    await fill(page, { ...FILL, username: 'grace@example.com' });
    expect(await a.of('filled'), name).toEqual([{ formId: 'f1', ok: false, reason: 'changed' }]);
    expect(await page.inputValue('#p'), name).toBe('');
  }
  // Read-only and empty: the form changed under the menu, as before.
  const a = await open(page, '<form id="f"><input id="u" type="email" name="email" readonly aria-label="Email"><input id="p" type="password" name="password" aria-label="Password"><button>Sign in</button></form>');
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: false, reason: 'changed' }]);
});

test('main sent a password and the form has none now: refused as changed, nothing written', async ({ page }) => {
  const a = await open(page, SIGN_IN);
  await page.evaluate(() => document.getElementById('p')!.remove());
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: false, reason: 'changed' }]);
  expect(await page.inputValue('#u')).toBe('');
});

test('a field hidden at the last scan, focused within the scan gap: classed again once, at the next flush', async ({ page }) => {
  body = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body><form id="f"><input id="u" type="email" name="email" aria-label="Email"><input id="p" type="password" name="password" aria-label="Password" style="display:none"><button>Log in</button></form></body></html>`;
  await page.goto(`${ORIGIN}/page`);
  // Count the agent's scans: each reads the document's controls once, by a walk into open shadow roots (the first scan,
  // and every one on a page with roots) or the document's own querySelectorAll (a page without).
  await page.evaluate(() => {
    const g = globalThis as unknown as { scans: number };
    g.scans = 0;
    const walker = Document.prototype.createTreeWalker;
    Document.prototype.createTreeWalker = function (this: Document, root: Node, ...rest: [number?, NodeFilter?]) {
      if (root instanceof Document) g.scans++;
      return walker.call(this, root, ...rest);
    } as typeof walker;
    const qsa = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (this: Document, selector: string) {
      if (selector === 'input, select, textarea') g.scans++;
      return qsa.call(this, selector);
    } as typeof qsa;
  });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.start());
  const a = api(page);
  await a.settle();
  await a.clear();
  const scans = () => page.evaluate(() => (globalThis as unknown as { scans: number }).scans);
  const before = await scans();
  await page.evaluate(() => {
    // A field the agent doesn't know yet: a scan now, so the next focus is within the gap.
    const extra = document.createElement('input');
    extra.id = 'extra';
    document.body.append(extra);
    extra.focus();
    const p = document.getElementById('p') as HTMLElement;
    p.style.display = '';
    p.focus();
    // Still focused, and still neither shown nor focusable to the next scan: the re-class must not run again each frame.
    p.style.visibility = 'hidden';
  });
  // Many frames: one scan for the new field, one for the focus's re-class, and none after.
  for (let i = 0; i < 5; i++) await a.settle();
  expect((await scans()) - before).toBe(2);
});

/* ---------- phase 2: generated passwords, sign-up and change forms (S17 §6) ---------- */

const SIGN_UP =
  '<h1>Create your account</h1><form id="f"><input id="u" name="email" type="email" aria-label="Email"><input id="n" name="password" type="password" autocomplete="new-password" aria-label="Create a password" passwordrules="minlength: 12; required: digit;" minlength="10" maxlength="64"><input id="c" name="confirm" type="password" autocomplete="new-password" aria-label="Confirm password"><button>Sign up</button></form>';
const CHANGE =
  '<h1>Change your password</h1><form id="f"><input id="o" name="current" type="password" autocomplete="current-password" aria-label="Current password"><input id="n" name="new" type="password" autocomplete="new-password" aria-label="New password"><input id="c" name="confirm" type="password" autocomplete="new-password" aria-label="Confirm new password"><button>Change password</button></form>';
const GENERATED = { formId: 'f1', generated: 'Gen3rated-Pa55-word-x', highlight: FILL.highlight };
const values = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('input')].map((i) => [i.id, i.value])));

test('a new password’s field says its rules at focus, never its value', async ({ page }) => {
  const a = await open(page, SIGN_UP);
  await page.fill('#n', 'typed already');
  await page.focus('#u');
  await a.settle();
  await a.clear();
  await page.focus('#n');
  await a.settle();
  const focus = (await a.of('focus')).at(-1)!;
  expect(focus).toMatchObject({ kind: 'sign-up', role: 'new-password', rules: { passwordrules: 'minlength: 12; required: digit;', minLength: 10, maxLength: 64 } });
  expect(JSON.stringify(await a.messages())).not.toContain('typed already');
  // An account's field says nothing of rules.
  await page.focus('#u');
  await a.settle();
  expect((await a.of('focus')).find((f) => f['role'] === 'username')).not.toHaveProperty('rules');
});

test('a generated password: into the new password’s field and the confirmation’s, nothing else, as typing', async ({ page }) => {
  for (const [name, html, filled] of [
    ['a sign-up', SIGN_UP, { u: '', n: GENERATED.generated, c: GENERATED.generated }],
    ['a change form: never the current password', CHANGE, { o: '', n: GENERATED.generated, c: GENERATED.generated }],
    ['a second step’s confirmation alone', '<form id="f"><input id="c" type="password" autocomplete="new-password" aria-label="Confirm your password"><button>Continue</button></form>', { c: GENERATED.generated }],
  ] as const) {
    const a = await open(page, html);
    await page.evaluate(() => {
      const seen: string[] = [];
      (globalThis as unknown as { seen: string[] }).seen = seen;
      for (const el of document.querySelectorAll('input')) for (const type of ['input', 'change']) el.addEventListener(type, () => seen.push(`${el.id}:${type}`));
    });
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    await a.clear();
    await fill(page, GENERATED);
    expect(await a.of('filled'), name).toEqual([{ formId: 'f1', ok: true }]);
    expect(await values(page), name).toEqual(filled);
    expect((await page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen)).length, name).toBe(Object.values(filled).filter(Boolean).length * 2);
    expect(await page.evaluate(() => document.documentElement.outerHTML), name).toBe(before);
  }
});

test('a generated password goes only into a visible type=password field', async ({ page }) => {
  const cases: [string, string, { ok: boolean; n: string; c: string }][] = [
    ['the new password’s field is text now (a show-password toggle)', "document.getElementById('n').type = 'text'", { ok: false, n: '', c: '' }],
    ['the new password’s field is hidden', "document.getElementById('n').style.display = 'none'", { ok: false, n: '', c: '' }],
    ['the form is under an invisible layer', "document.getElementById('f').style.opacity = '0'", { ok: false, n: '', c: '' }],
    ['the confirmation is text now: the form changed', "document.getElementById('c').type = 'text'", { ok: false, n: '', c: '' }],
    ['the confirmation is hidden (a later step): the new one alone', "document.getElementById('c').style.visibility = 'hidden'", { ok: true, n: GENERATED.generated, c: '' }],
  ];
  for (const [name, change, want] of cases) {
    const a = await open(page, SIGN_UP);
    await page.evaluate(change);
    await a.clear();
    await fill(page, GENERATED);
    expect((await a.of('filled')).map((f) => f['ok']), name).toEqual([want.ok]);
    const got = await values(page);
    expect([got['u'], got['n'], got['c']], name).toEqual(['', want.n, want.c]);
  }
});

test('a fill main never sends is refused whole: a generated password with an account’s values, or an empty one', async ({ page }) => {
  for (const payload of [
    { ...GENERATED, username: 'ada' },
    { ...GENERATED, password: 'x' },
    { ...GENERATED, generated: '' },
    { ...FILL, intoNew: 'yes' },
  ]) {
    const a = await open(page, SIGN_UP);
    await a.clear();
    await fill(page, payload);
    expect(await a.of('filled')).toEqual([]);
    expect(Object.values(await values(page)).join('')).toBe('');
  }
});

test('an account picked on a new password’s field (intoNew): a form with no current password takes it there; picked elsewhere, nothing', async ({ page }) => {
  const READ_AS_NEW =
    '<form id="f"><input id="u" name="email" type="email" aria-label="Email"><input id="n" name="password" type="password" aria-label="Create a password"><button>Log in</button></form>';
  let a = await open(page, READ_AS_NEW);
  await a.clear();
  await fill(page, { ...FILL, intoNew: true });
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
  expect(await values(page)).toEqual({ u: 'ada@example.com', n: 'secret pass' });
  a = await open(page, READ_AS_NEW);
  await a.clear();
  await fill(page, FILL);
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: false, reason: 'password' }]);
  // A change form: the account's password goes into its current field, whichever field the menu was on, and the new
  // password and its confirmation stay empty, yours to choose (review round 1 of #53).
  for (const payload of [FILL, { ...FILL, intoNew: true as const }]) {
    a = await open(page, CHANGE);
    await a.clear();
    await fill(page, payload);
    expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: true }]);
    expect(await values(page)).toEqual({ o: 'secret pass', n: '', c: '' });
  }
});

test('a change form’s submit carries its current password beside the new one, for main to find the account', async ({ page }) => {
  const a = await open(page, CHANGE);
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  await page.fill('#o', 'old-Password-1');
  await page.fill('#n', 'new-Password-2');
  await page.fill('#c', 'new-Password-2');
  await a.clear();
  await page.press('#c', 'Enter');
  await a.settle();
  expect((await a.of('candidate'))[0]).toMatchObject({ kind: 'change', signal: 'enter', values: { username: '', password: 'new-Password-2', current: 'old-Password-1' } });
  // A sign-up's has none.
  const b = await open(page, SIGN_UP);
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  await page.fill('#u', 'ada@example.com');
  await page.fill('#n', 'new-Password-2');
  await page.fill('#c', 'new-Password-2');
  await b.clear();
  await page.press('#c', 'Enter');
  await b.settle();
  const candidate = (await b.of('candidate'))[0]!;
  expect(candidate).toMatchObject({ kind: 'sign-up', values: { username: 'ada@example.com', password: 'new-Password-2' } });
  expect(candidate['values']).not.toHaveProperty('current');
});

/* ---------- Phase 3A: a first step's username, and formless submits (S17 §4, §6) ---------- */

const FIRST_STEP =
  '<h1>Sign in</h1><form id="f"><input id="u" name="identifier" type="email" autocomplete="username" aria-label="Email"><button id="next">Next</button></form>';

const stepPages: { name: string; html: string; type: string; press: 'Enter' | 'click'; step: boolean }[] = [
  { name: 'a first step, Next in its form', html: FIRST_STEP, type: 'ada@example.com', press: 'click', step: true },
  { name: 'a first step, Enter', html: FIRST_STEP, type: 'ada@example.com', press: 'Enter', step: true },
  {
    name: 'a formless first step, its Continue a plain div',
    html: '<h1>Log in</h1><div><input id="u" name="email" type="email" aria-label="Email"><div id="next" tabindex="0">Continue</div></div>',
    type: 'ada@example.com',
    press: 'click',
    step: true,
  },
  {
    name: 'one or two digits: never a username',
    html: '<h1>Sign in</h1><form id="f"><input id="u" name="username" autocomplete="username" aria-label="Username"><button id="next">Next</button></form>',
    type: '42',
    press: 'click',
    step: false,
  },
  {
    name: 'a search box',
    html: '<form id="f" role="search"><input id="u" name="q" type="search" aria-label="Search"><button id="next">Search</button></form>',
    type: 'ada@example.com',
    press: 'click',
    step: false,
  },
  {
    name: 'a newsletter email',
    html: '<h2>Subscribe to our newsletter</h2><form id="f" class="newsletter"><input id="u" name="email" type="email" aria-label="Email"><button id="next">Subscribe</button></form>',
    type: 'ada@example.com',
    press: 'click',
    step: false,
  },
  {
    name: 'a sign-up first step',
    html: '<h1>Create your account</h1><form id="f"><input id="u" name="email" type="email" aria-label="Email"><button id="next">Create account</button></form>',
    type: 'ada@example.com',
    press: 'click',
    step: false,
  },
];

for (const c of stepPages) {
  test(`a first step's username: ${c.name}`, async ({ page }) => {
    const a = await open(page, c.html);
    await page.evaluate(() => document.querySelector('form')?.addEventListener('submit', (e) => e.preventDefault()));
    await page.fill('#u', c.type);
    await a.clear();
    if (c.press === 'Enter') await page.press('#u', 'Enter');
    else await page.click('#next');
    await a.settle();
    const steps = await a.of('step');
    if (c.step) {
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ username: c.type });
      expect(steps[0]!['signal']).toMatch(c.press === 'Enter' ? /^enter$/ : /^(button|submit)$/);
    } else expect(steps).toEqual([]);
    // No other message carries what was typed.
    expect(JSON.stringify((await a.messages()).filter(([ch]) => ch !== 'step'))).not.toContain(`"${c.type}"`);
  });
}

test("a first step's username: once per submit; an email the site put there counts, at your submit only", async ({ page }) => {
  const a = await open(page, FIRST_STEP);
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  // The site remembered the email: not typed, still yours, and sent only at your click.
  await page.evaluate(() => void ((document.getElementById('u') as HTMLInputElement).value = 'remembered@example.com'));
  await a.settle();
  expect(await a.of('step')).toEqual([]);
  // A submit the page's script makes (untrusted) is no signal.
  await page.evaluate(() => document.getElementById('next')!.click());
  await a.settle();
  expect(await a.of('step')).toEqual([]);
  await page.click('#next');
  await a.settle();
  expect((await a.of('step')).map((s) => s['username'])).toEqual(['remembered@example.com']);
  await page.waitForTimeout(1100);
  await page.fill('#u', 'ada@example.com');
  await a.clear();
  // Enter, then the click: one submit within a second.
  await page.press('#u', 'Enter');
  await page.click('#next');
  await a.settle();
  expect(await a.of('step')).toHaveLength(1);
});

const FIELDS = '<input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password">';
const plainClicks: { name: string; html: string; signal: boolean }[] = [
  { name: 'a formless sign-in whose button is a div with the pointer', html: `<div>${FIELDS}<div id="go" style="cursor:pointer">Sign in</div></div>`, signal: true },
  { name: 'a span inside such a div', html: `<div>${FIELDS}<div style="cursor:pointer"><span id="go">Log in</span></div></div>`, signal: true },
  { name: 'Continue, with a tabindex', html: `<div>${FIELDS}<div id="go" tabindex="0">Continue</div></div>`, signal: true },
  { name: 'a div that shows no sign it can be pressed', html: `<div>${FIELDS}<div id="go">Sign in</div></div>`, signal: false },
  {
    name: 'a "Sign up" div on a sign-in form',
    html: '<h1>Sign in</h1><div><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" autocomplete="current-password" aria-label="Password"><div id="go" style="cursor:pointer">Sign up</div><button>Sign in</button></div>',
    signal: false,
  },
  { name: 'a question', html: `<div>${FIELDS}<div id="go" style="cursor:pointer">New here? Sign in</div></div>`, signal: false },
  { name: 'a heading', html: `<div><h1 id="go" style="cursor:pointer">Sign in</h1>${FIELDS}<button>Go</button></div>`, signal: false },
  { name: 'a link that reads "Log in"', html: `<div>${FIELDS}<a id="go" href="#">Log in</a></div>`, signal: false },
  { name: 'a show-password toggle drawn as a div', html: `<div>${FIELDS}<div id="go" style="cursor:pointer">Show</div></div>`, signal: false },
  // Review of 3A-1.
  { name: 'a div with role=link that reads "Log in"', html: `<div>${FIELDS}<div id="go" role="link" tabindex="0">Log in</div></div>`, signal: false },
  { name: 'a span inside a role=link', html: `<div>${FIELDS}<div role="link" tabindex="0"><span id="go">Sign in</span></div></div>`, signal: false },
  { name: '"Sign in with SSO" drawn as a div', html: `<div>${FIELDS}<div id="go" style="cursor:pointer">Sign in with SSO</div></div>`, signal: false },
  { name: '"Continue with passkey" drawn as a div', html: `<div>${FIELDS}<div id="go" style="cursor:pointer">Continue with passkey</div></div>`, signal: false },
  { name: '"Single sign-on" as a button beside the fields', html: `<div>${FIELDS}<button id="go" type="button">Single sign-on</button><button type="button">Sign in</button></div>`, signal: false },
  {
    name: 'a "Sign in" div far from the fields',
    html: `<div><div><div><div><div><div><div><div>${FIELDS}</div></div></div></div></div></div></div></div><div id="go" style="cursor:pointer">Sign in</div>`,
    signal: false,
  },
];

for (const c of plainClicks) {
  test(`a click as a submit signal: ${c.name}`, async ({ page }) => {
    const a = await open(page, c.html);
    await page.fill('#u', 'ada@example.com');
    await page.fill('#p', 'secret pass');
    await a.clear();
    await page.click('#go');
    await a.settle();
    const submits = (await a.of('candidate')).filter((x) => x['signal'] !== 'blur');
    expect(submits.map((x) => x['signal'])).toEqual(c.signal ? ['button'] : []);
  });
}

test('a first step whose password field the last scan saw hidden, but typed in: its submit is a sign-in candidate, not a first step', async ({ page }) => {
  // A transparent password field in a form whose submit says Next: a first step to the scan, until it's typed in.
  const a = await open(page, '<h1>Sign in</h1><form id="f"><input id="u" name="email" type="email" autocomplete="username" aria-label="Email"><input id="p" name="passwd" type="password" style="opacity:0"><button id="next">Next</button></form>');
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  expect((await a.of('forms')).at(-1)?.['forms']).toEqual([expect.objectContaining({ kind: 'username-only' })]);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'secret pass');
  await a.clear();
  await page.press('#p', 'Enter');
  await a.settle();
  expect(await a.of('step')).toEqual([]);
  const submits = (await a.of('candidate')).filter((x) => x['signal'] !== 'blur');
  expect(submits).toHaveLength(1);
  expect(submits[0]!['values']).toMatchObject({ username: 'ada@example.com', password: 'secret pass' });
});

test("a plain div's submit made by the page's script (an untrusted click or Enter): no first step's username, no candidate", async ({ page }) => {
  const a = await open(page, '<h1>Log in</h1><div><input id="u" name="email" type="email" aria-label="Email"><div id="next" tabindex="0">Continue</div></div>');
  await page.fill('#u', 'ada@example.com');
  await a.clear();
  await page.evaluate(() => {
    document.getElementById('next')!.click();
    document.getElementById('next')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    document.getElementById('u')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  });
  await a.settle();
  expect(await a.of('step')).toEqual([]);
  expect(await a.of('candidate')).toEqual([]);
  // The same Continue clicked by a person: the first step's username.
  await page.click('#next');
  await a.settle();
  expect((await a.of('step')).map((m) => m['username'])).toEqual(['ada@example.com']);
});

/* ---------- Phase 3A-2: did a sign-in with no navigation work? (S17 §6 step 3) ---------- */

const BOX = `<div id="box">${FIELDS}<button id="go">Sign in</button></div>`;
/** Fields with no id or name: only their words say what they are. */
const NAMELESS = '<div id="box"><input type="email" aria-label="Email"><input type="password" aria-label="Password"><button id="go">Sign in</button></div>';
const IN_BOX = { user: '#box input[type=email]', pass: '#box input[type=password]' };
/** A sign-in form and a sign-up form whose fields are named the same, with no ids. */
const SIGN_IN_AND_UP = (tag: 'form' | 'div') =>
  `<${tag} id="box"><input name="email" type="email" aria-label="Email"><input name="password" type="password" aria-label="Password"><button id="go" type="button">Sign in</button></${tag}>` +
  `<${tag} id="signup"><h2>New here?</h2><input name="email" type="email" aria-label="Email"><input name="password" type="password" aria-label="Choose a password"><button type="button">Sign up</button></${tag}>`;
/** What replaces `#box` after the click: one thing 50 ms on, or several, each that long after the last. */
type Then = string | readonly (readonly [ms: number, html: string])[];
/** A spinner standing in for the form while the request runs: `#box` again, so what follows replaces it. */
const SPINNER = '<div id="box" class="spinner" role="status">Signing in…</div>';
const afterSubmit: { name: string; start?: string; fields?: { user: string; pass: string }; then: Then; gone: boolean; add?: string }[] = [
  { name: 'a wrong password: the form drawn again with an error banner', then: `<p role="alert">Wrong password</p>${BOX}`, gone: false },
  { name: 'it worked: the form gone, a welcome in its place', then: '<h1>Welcome</h1>', gone: true },
  { name: 'it worked: another page of the app, with a search box', then: '<h1>Inbox</h1><input type="search" name="q">', gone: true },
  {
    name: 'it worked, a sign-up form beside it stays shown, its password named the same',
    start: SIGN_IN_AND_UP('form'),
    fields: IN_BOX,
    then: '<h1>Welcome</h1>',
    gone: true,
  },
  {
    name: 'it worked on a formless page, a sign-up panel beside it stays shown',
    start: SIGN_IN_AND_UP('div'),
    fields: IN_BOX,
    then: '<h1>Welcome</h1>',
    gone: true,
  },
  {
    name: 'fields with no id or name: it worked, and the app’s next view has a password field of its own',
    start: NAMELESS,
    fields: IN_BOX,
    then: '<h1>Security</h1><input type="password" aria-label="New password"><button>Change</button>',
    gone: true,
  },
  { name: 'fields with no id or name: a wrong password, drawn again with the same words', start: NAMELESS, fields: IN_BOX, then: `<p role="alert">Wrong password</p>${NAMELESS}`, gone: false },
  // Review round 2 of #59.
  {
    name: 'a wrong password, drawn again with a framework’s new generated ids (mat-input-1 to mat-input-3)',
    then: `<p role="alert">Wrong password</p><div id="box"><input id="u3" name="email" type="email" aria-label="Email"><input id="p3" name="password" type="password" aria-label="Password"><button>Sign in</button></div>`,
    gone: false,
  },
  {
    name: 'a wrong password, drawn again with a new id and its name dropped',
    then: `<p role="alert">Wrong password</p><div id="box"><input id="u3" type="email" aria-label="Email"><input id="p3" type="password" aria-label="Password"><button>Sign in</button></div>`,
    gone: false,
  },
  {
    name: 'a formless password field with no id, name or words, drawn again',
    start: '<div id="box"><input type="email"><input type="password"><button id="go">Sign in</button></div>',
    fields: IN_BOX,
    then: '<p role="alert">Wrong password</p><div id="box"><input type="email"><input type="password"><button>Sign in</button></div>',
    gone: false,
  },
  {
    name: 'it worked, and a sign-up panel added after the last scan stays shown, its password described the same',
    add: '<div id="signup"><h2>New here?</h2><input name="password" type="password" aria-label="Password"><button>Sign up</button></div>',
    then: '<h1>Welcome</h1>',
    gone: true,
  },
  { name: 'a spinner stands in for the form, then the form is back with Wrong password', then: [[50, SPINNER], [900, `<p role="alert">Wrong password</p>${BOX}`]], gone: false },
  { name: 'a spinner stands in for the form, then the app’s dashboard', then: [[50, SPINNER], [900, '<h1>Dashboard</h1><p>Welcome back.</p>']], gone: true },
];

for (const c of afterSubmit) {
  test(`after a submit: ${c.name}`, async ({ page }) => {
    test.setTimeout(30_000);
    const a = await open(page, c.start ?? BOX);
    // Added by the page's script after the agent's last scan (nothing focused or typed since).
    if (c.add) await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), c.add);
    const steps = typeof c.then === 'string' ? [[50, c.then] as const] : c.then;
    await page.evaluate((steps) => {
      document.getElementById('go')!.addEventListener('click', () => {
        let at = 0;
        for (const [ms, html] of steps) setTimeout(() => (document.getElementById('box')!.outerHTML = html), (at += ms));
      });
    }, steps);
    const fields = c.fields ?? { user: '#u', pass: '#p' };
    await page.fill(fields.user, 'ada@example.com');
    await page.fill(fields.pass, 'a pass');
    await a.clear();
    await page.click('#go');
    // The submit was seen, so what follows is the watch's answer, not silence.
    await expect.poll(async () => (await a.of('candidate')).filter((x) => x['signal'] !== 'blur').length, { timeout: 3000 }).toBe(1);
    if (c.gone) {
      // After the page has been quiet a while (GONE_QUIET_UNANSWERED_MS here: no request answered).
      await expect.poll(() => a.of('gone'), { timeout: 6000 }).toHaveLength(1);
      expect(await a.of('still')).toEqual([]);
    } else {
      // Not gone at the redraw (that would offer to save a failed sign-in), and still there at the watch's end.
      await expect.poll(() => a.of('still'), { timeout: 12_000 }).toHaveLength(1);
      expect(await a.of('gone')).toEqual([]);
    }
  });
}

/* ---------- Review round 3 of #59: requests, a <form> that stays, a page that never stops ---------- */

/** The page's own requests, answered when and how the test says: the beacon at once, the sign-in later. */
async function serveRequests(page: Page, routes: Record<string, { status: number; after: number }>) {
  for (const [path, { status, after }] of Object.entries(routes))
    await page.route(`${ORIGIN}${path}`, async (route) => {
      await new Promise((done) => setTimeout(done, after));
      await route.fulfill({ status, contentType: 'application/json', body: '{}' });
    });
}
/** The click: the page's script empties `#box` (or puts `html` there) and makes its requests, reading each body (M0 Q7). */
const onClick = (page: Page, html: string, requests: string[]) =>
  page.evaluate(
    ([html, requests]) => {
      document.getElementById('go')!.addEventListener('click', () => {
        setTimeout(() => (document.getElementById('box')!.outerHTML = html), 50);
        for (const path of requests) void fetch(path, { method: 'POST' }).then((r) => r.text());
      });
    },
    [html, requests] as const,
  );
/** The order the agent said things in: `hint:200`, `gone`… */
const said = async (a: Awaited<ReturnType<typeof open>>) =>
  (await a.messages()).filter(([c]) => c === 'hint' || c === 'gone' || c === 'still').map(([c, p]) => (c === 'hint' ? `hint:${String(p['status'])}` : c));

test('a beacon answers 200 at once, the sign-in 401 at 1.2 s: the 401 reaches main before any gone, so main vetoes', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/beacon': { status: 200, after: 0 }, '/auth': { status: 401, after: 1200 } });
  const a = await open(page, BOX);
  await onClick(page, '<div id="box"></div>', ['/beacon', '/auth']);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 8000 }).toContain('hint:401');
  await page.waitForTimeout(2500);
  const order = await said(a);
  // The beacon's 200 didn't shorten the wait: whatever the watch says comes after the 401 (the tracker's veto).
  expect(order.indexOf('hint:401')).toBeGreaterThan(order.indexOf('hint:200'));
  if (order.includes('gone')) expect(order.indexOf('gone')).toBeGreaterThan(order.indexOf('hint:401'));
});

test('a sign-in slower than the quiet wait, behind a busy spinner: no gone while it runs, still once the form is back', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/auth': { status: 401, after: 2500 } });
  const a = await open(page, BOX);
  await page.evaluate((box) => {
    document.getElementById('go')!.addEventListener('click', () => {
      setTimeout(() => (document.getElementById('box')!.outerHTML = '<div id="box" aria-busy="true">Signing in…</div>'), 50);
      void fetch('/auth', { method: 'POST' })
        .then((r) => r.text())
        .then(() => (document.getElementById('box')!.outerHTML = `<p role="alert">Wrong password</p>${box}`));
    });
  }, BOX);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  await page.waitForTimeout(2300);
  expect(await said(a)).toEqual([]);
  await expect.poll(() => said(a), { timeout: 12_000 }).toEqual(['hint:401', 'still']);
});

test('a sign-in slower than the quiet wait, with nothing shown while it runs: gone first, and the late 401 still goes to main', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/auth': { status: 401, after: 2500 } });
  const a = await open(page, BOX);
  await onClick(page, '<div id="box"></div>', ['/auth']);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  // The agent can't see a request until it's answered: it says gone after the quiet wait, then reports the 401,
  // which main takes as the sign-in taken back (saving.ts, LATE_ERROR_MS).
  await expect.poll(() => said(a), { timeout: 8000 }).toEqual(['gone', 'hint:401']);
});

const FORM_STAYS = (inside: string) => `<form id="f" onsubmit="return false"><div id="box">${inside}<button id="go" type="button">Sign in</button></div></form>`;
const BARE = '<input type="email"><input type="password">';
const formStays: { name: string; inside: string; fields?: { user: string; pass: string }; then: string; gone: boolean }[] = [
  { name: 'fields with nothing to know them by, drawn again inside it', inside: BARE, fields: IN_BOX, then: `<p role="alert">Wrong password</p><div id="box">${BARE}<button>Sign in</button></div>`, gone: false },
  { name: 'fields with nothing to know them by, then a new password’s view inside it', inside: BARE, fields: IN_BOX, then: '<div id="box"><h2>Choose a new password</h2><input type="password" autocomplete="new-password"><button>Save</button></div>', gone: true },
  { name: 'a named field, then a new password’s view inside it with the same name', inside: FIELDS, then: '<div id="box"><input name="password" type="password" autocomplete="new-password" aria-label="New password"><button>Save</button></div>', gone: true },
  { name: 'labelled fields, then another view inside it whose password is labelled otherwise', inside: '<input type="email" aria-label="Email"><input type="password" aria-label="Password">', fields: IN_BOX, then: '<div id="box"><input type="password" aria-label="Confirm your PIN"><button>Go</button></div>', gone: true },
];

for (const c of formStays) {
  test(`after a submit, the <form> staying in the page: ${c.name}`, async ({ page }) => {
    test.setTimeout(30_000);
    const a = await open(page, FORM_STAYS(c.inside));
    await onClick(page, c.then, []);
    const fields = c.fields ?? { user: '#u', pass: '#p' };
    await page.fill(fields.user, 'ada@example.com');
    await page.fill(fields.pass, 'a pass');
    await a.clear();
    await page.click('#go');
    await expect.poll(() => said(a), { timeout: 12_000 }).toEqual([c.gone ? 'gone' : 'still']);
  });
}

test('a page that never stops changing after the form went: gone only at the watch’s end', async ({ page }) => {
  test.setTimeout(30_000);
  const a = await open(page, BOX);
  await page.evaluate(() => {
    document.getElementById('go')!.addEventListener('click', () => {
      setTimeout(() => (document.getElementById('box')!.outerHTML = '<ul id="feed"></ul>'), 50);
      setInterval(() => document.getElementById('feed')?.insertAdjacentHTML('beforeend', '<li>news</li>'), 200);
    });
  });
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  const at = Date.now();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 15_000 }).toEqual(['gone']);
  expect(Date.now() - at).toBeGreaterThan(9000);
});

/* ---------- Review round 4 of #59, as 3A-2's requirements ---------- */

test('three of the page’s own answers (200s) before a late 401: the 401 still reaches main (errors have their own cap)', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/a': { status: 200, after: 0 }, '/b': { status: 200, after: 50 }, '/c': { status: 200, after: 100 }, '/d': { status: 200, after: 150 }, '/auth': { status: 401, after: 900 } });
  const a = await open(page, BOX);
  await onClick(page, '<div id="box"></div>', ['/a', '/b', '/c', '/d', '/auth']);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 8000 }).toContain('hint:401');
});

test('a busy marker still shown at the watch’s end: still, not gone', async ({ page }) => {
  test.setTimeout(30_000);
  const a = await open(page, BOX);
  await onClick(page, '<div id="box" aria-busy="true">Signing in…</div>', []);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 14_000 }).toEqual(['still']);
});

test('a poll that started before the submit and answers 401 after it: not this sign-in’s', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/poll': { status: 401, after: 1200 } });
  const a = await open(page, BOX);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await page.evaluate(() => void fetch('/poll').then((r) => r.text()));
  await onClick(page, '<h1>Welcome</h1>', []);
  await a.clear();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 8000 }).toEqual(['gone']);
  await page.waitForTimeout(1500);
  expect(await said(a)).toEqual(['gone']);
});

test('after gone, a request the app starts once signed in, answered 401: not reported (only requests started before gone)', async ({ page }) => {
  test.setTimeout(30_000);
  await serveRequests(page, { '/profile': { status: 401, after: 0 } });
  const a = await open(page, BOX);
  await onClick(page, '<h1>Welcome</h1>', []);
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'a pass');
  await a.clear();
  await page.click('#go');
  await expect.poll(() => said(a), { timeout: 8000 }).toEqual(['gone']);
  await page.evaluate(() => void fetch('/profile').then((r) => r.text()));
  await page.waitForTimeout(800);
  expect(await said(a)).toEqual(['gone']);
});

/* ---------- Phase 3B: open shadow roots (S17 §4) ---------- */

/** A page whose sign-in fields are a component's: each input in an open root of its host, built by the page's script. */
const COMPONENT_FIELDS = `<h1>Sign in</h1><form id="f" action="/session"><x-field id="user"></x-field><x-field id="pass"></x-field><button id="go">Sign in</button></form>
<script>
  for (const [id, type, label] of [['user', 'email', 'Email'], ['pass', 'password', 'Password']]) {
    const root = document.getElementById(id).attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="i">' + label + '</label><input id="i" name="' + id + '" type="' + type + '">';
  }
</script>`;
const inRoot = (host: string) => `#${host} >> input`;

test('a field in an open shadow root: focus says its role, as in the page’s own tree', async ({ page }) => {
  const a = await open(page, COMPONENT_FIELDS);
  await a.clear();
  await page.click(inRoot('pass'));
  await a.settle();
  expect(await a.of('focus')).toEqual([expect.objectContaining({ role: 'current-password', kind: 'sign-in' })]);
});

test('a field in an open shadow root with focus before the agent starts (autofocus in a component): its focus is sent', async ({ page }) => {
  body = `<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body>${COMPONENT_FIELDS}</body></html>`;
  await page.goto(`${ORIGIN}/page`);
  await page.focus(inRoot('user'));
  // The page's document only knows the host has focus; the field is its root's active element.
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('user');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.start());
  const a = api(page);
  await a.settle();
  expect(await a.of('focus')).toEqual([expect.objectContaining({ role: 'username', kind: 'sign-in' })]);
});

test('a sign-in in open shadow roots: one submit is one candidate, with what was typed, and a fill goes in through the roots', async ({ page }) => {
  const a = await open(page, COMPONENT_FIELDS);
  await page.evaluate(() => document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault()));
  await page.fill(inRoot('user'), 'ada@example.com');
  await page.fill(inRoot('pass'), 'secret pass');
  await a.clear();
  await page.press(inRoot('pass'), 'Enter');
  await a.settle();
  const submits = (await a.of('candidate')).filter((c) => c['signal'] !== 'blur');
  expect(submits).toHaveLength(1);
  expect(submits[0]!['values']).toEqual({ username: 'ada@example.com', password: 'secret pass' });

  // The fill, as main sends it for the form the menu was shown for.
  await page.fill(inRoot('user'), '');
  await page.fill(inRoot('pass'), '');
  await page.click(inRoot('user'));
  await a.settle();
  const focus = (await a.of('focus')).at(-1)!;
  await page.evaluate(
    (p) => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.fill(p),
    { formId: focus['formId'], username: 'ada@example.com', password: 'pw-one', highlight: { color: 'red', ms: 10, stagger: 0, easing: 'linear' } },
  );
  await a.settle();
  expect((await a.of('filled')).at(-1)).toMatchObject({ ok: true });
  expect(await page.inputValue(inRoot('user'))).toBe('ada@example.com');
  expect(await page.inputValue(inRoot('pass'))).toBe('pw-one');
});

test('a component rendered after the first scan, on a page that had no root: its field is found once an event comes from inside it', async ({ page }) => {
  // A sign-in form in the page's own tree, scanned without roots; then the page adds a component with its own sign-in.
  const a = await open(page, SIGN_IN);
  await page.evaluate(() => {
    const host = document.createElement('x-login');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<form><label for="e">Email</label><input id="e" name="email" type="email"><label for="w">Password</label><input id="w" name="pw" type="password"><button>Log in</button></form>';
  });
  await a.clear();
  await page.click('x-login >> #w');
  await a.settle();
  expect(await a.of('focus')).toEqual([expect.objectContaining({ role: 'current-password', kind: 'sign-in' })]);
});

/** A text field that fades its empty, unfocused input under its resting label, as Material Web's outlined field does. */
const FADING_FIELDS = (hostStyle = '') => `<h1>Sign in</h1><form id="f" onsubmit="return false"><x-fade id="user" style="${hostStyle}"></x-fade><x-fade id="pass" style="${hostStyle}"></x-fade><button id="go">Sign in</button></form>
<script>
  for (const [id, type, label] of [['user', 'email', 'Email'], ['pass', 'password', 'Password']]) {
    const root = document.getElementById(id).attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host { display: block; position: relative; } span { position: absolute; left: 8px; top: 6px; } input:placeholder-shown:not(:focus) { opacity: 0; }</style><span>' + label + '</span><input id="i" name="' + id + '" type="' + type + '" placeholder=" " aria-label="' + label + '">';
  }
</script>`;

test('a component that fades its empty input under its label: the fill goes into both fields, the unfocused one too', async ({ page }) => {
  const a = await open(page, FADING_FIELDS());
  await page.click(inRoot('user'));
  await a.settle();
  const focus = (await a.of('focus')).at(-1)!;
  expect(focus).toMatchObject({ role: 'username', kind: 'sign-in' });
  await page.evaluate(
    (p) => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.fill(p),
    { formId: focus['formId'], username: 'ada@example.com', password: 'pw-one', highlight: { color: 'red', ms: 10, stagger: 0, easing: 'linear' } },
  );
  await a.settle();
  expect((await a.of('filled')).at(-1)).toMatchObject({ ok: true });
  expect(await page.inputValue(inRoot('pass'))).toBe('pw-one');
});

/** The fill as main sends it for the agent's last focus: what the agent answered. */
const fillLastFocus = async (page: Page, a: Awaited<ReturnType<typeof open>>) => {
  const focus = (await a.of('focus')).at(-1);
  expect(focus, 'the agent sent a focus for the field').toBeTruthy();
  await page.evaluate(
    (p) => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.fill(p),
    { formId: focus!['formId'], username: 'ada@example.com', password: 'pw-one', highlight: { color: 'red', ms: 10, stagger: 0, easing: 'linear' } },
  );
  await a.settle();
  return (await a.of('filled')).at(-1);
};

test('a component that hides itself (its host at opacity 0): the agent knows the field, and the fill writes nothing', async ({ page }) => {
  const a = await open(page, FADING_FIELDS('opacity: 0'));
  await page.focus(inRoot('user'));
  await a.settle();
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: false });
  expect(await page.inputValue(inRoot('pass'))).toBe('');
  expect(await page.inputValue(inRoot('user'))).toBe('');
});

/** A sign-in whose password input sits at opacity 0 in a visible component: a page's hidden field, not a resting label. */
const HIDDEN_IN_COMPONENT = (password: string) => `<h1>Sign in</h1><form id="f" onsubmit="return false"><input id="u" name="email" type="email" aria-label="Email"><x-pw id="pass"></x-pw><button>Sign in</button></form>
<script>
  const root = document.getElementById('pass').attachShadow({ mode: 'open' });
  root.innerHTML = '<style>:host { display: block; width: 240px; height: 32px; } input { opacity: 0; }</style><input id="i" name="password" type="password" aria-label="Password">';
  root.querySelector('input').value = ${JSON.stringify(password)};
</script>`;

test('an opacity-0 input with a value, in a visible component: no fill', async ({ page }) => {
  const a = await open(page, HIDDEN_IN_COMPONENT('already there'));
  await page.click('#u');
  await a.settle();
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: false });
  expect(await page.inputValue('#u')).toBe('');
});

test('an empty opacity-0 password input in an app shell’s root around the whole page: no fill', async ({ page }) => {
  const a = await open(
    page,
    `<x-app id="app"></x-app><script>
      document.getElementById('app').attachShadow({ mode: 'open' }).innerHTML = '<style>:host { display: block; }</style><h1>Sign in</h1><form onsubmit="return false"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password" style="opacity:0"><button>Sign in</button></form>';
    </script>`,
  );
  await page.click('#app >> #u');
  await a.settle();
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: false });
  expect(await page.inputValue('#app >> #p')).toBe('');
});

test('a component host with display: contents: judged at the first ancestor with a box, and filled', async ({ page }) => {
  const a = await open(page, FADING_FIELDS('display: contents'));
  await page.click(inRoot('user'));
  await a.settle();
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: true });
  expect(await page.inputValue(inRoot('pass'))).toBe('pw-one');
});

test('a form with a field named getRootNode (its own method clobbered): the agent still works', async ({ page }) => {
  const a = await open(page, '<h1>Sign in</h1><form id="f"><input name="getRootNode" type="hidden" value="x"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"><button>Sign in</button></form>');
  await a.clear();
  await page.click('#p');
  await a.settle();
  expect(await a.of('focus')).toEqual([expect.objectContaining({ role: 'current-password', kind: 'sign-in' })]);
});

/** A sign-in form wholly inside a component's open root, built by the page's script. */
const FORM_IN_ROOT = `<x-login id="login"></x-login><script>
  document.getElementById('login').attachShadow({ mode: 'open' }).innerHTML = '<h2>Log in</h2><form id="f" onsubmit="return false"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"><button id="go">Log in</button></form>';
</script>`;

test('a form in a root submitted by its script (requestSubmit): the submit inside the root is heard', async ({ page }) => {
  const a = await open(page, FORM_IN_ROOT);
  await page.fill('#login >> #u', 'ada@example.com');
  await page.fill('#login >> #p', 'secret pass');
  await a.clear();
  await page.evaluate(() => (document.getElementById('login')!.shadowRoot!.getElementById('f') as HTMLFormElement).requestSubmit());
  await a.settle();
  expect((await a.of('candidate')).map((c) => c['signal'])).toEqual(['submit']);
});

test('a form in a root that goes after its submit (inside the root): gone', async ({ page }) => {
  const a = await open(page, FORM_IN_ROOT);
  await page.evaluate(() => {
    const root = document.getElementById('login')!.shadowRoot!;
    root.getElementById('go')!.addEventListener('click', () => setTimeout(() => (root.innerHTML = '<p>Welcome</p>'), 50));
  });
  await page.fill('#login >> #u', 'ada@example.com');
  await page.fill('#login >> #p', 'secret pass');
  await a.clear();
  await page.click('#login >> #go');
  // Seen inside the root at once (the document's observer alone would wait for the watch's end).
  await expect.poll(() => a.of('gone'), { timeout: 3000 }).toHaveLength(1);
});

test('a show-password eye in a field component’s root (the input slotted): no submit', async ({ page }) => {
  const a = await open(
    page,
    `<div><input id="u" name="email" type="email" aria-label="Email"><x-pw id="pw"><input id="p" name="password" type="password" aria-label="Password"></x-pw><button>Sign in</button></div><script>
      document.getElementById('pw').attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><button id="eye" type="button"><svg width="12" height="12"></svg></button>';
    </script>`,
  );
  await page.fill('#u', 'ada@example.com');
  await page.fill('#p', 'secret pass');
  await a.clear();
  await page.click('#pw >> #eye');
  await a.settle();
  expect((await a.of('candidate')).filter((c) => c['signal'] !== 'blur')).toEqual([]);
});

/* ---------- Review round 2 of #61 ---------- */

test('a pick in the menu moves focus to the popover: the empty field it was opened on fades again, and still fills', async ({ page }) => {
  const a = await open(page, FADING_FIELDS());
  await page.click(inRoot('pass'));
  await a.settle();
  // As a click on the popover leaves it: the page's active element is still the field, which fades back to 0.
  await page.evaluate(() => {
    const input = document.getElementById('pass')!.shadowRoot!.getElementById('i') as HTMLInputElement;
    input.style.opacity = '0';
  });
  expect(await page.evaluate(() => document.getElementById('pass')!.shadowRoot!.activeElement?.id)).toBe('i');
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: true });
  expect(await page.inputValue(inRoot('pass'))).toBe('pw-one');
});

/** A password field alone in a component's root, faded (opacity 0) and broken one more way: no fill. */
const BROKEN_FADE = (inputStyle: string) => `<h1>Sign in</h1><form id="f" onsubmit="return false"><input id="u" name="email" type="email" aria-label="Email"><x-pw id="pass"></x-pw><button>Sign in</button></form>
<script>
  document.getElementById('pass').attachShadow({ mode: 'open' }).innerHTML = '<style>:host { display: block; position: relative; width: 240px; height: 32px; }</style><input id="i" name="password" type="password" aria-label="Password" style="opacity: 0; ${inputStyle}">';
</script>`;

for (const [clause, style] of [
  ['its box outside the host’s', 'position: absolute; top: 120px; left: 0;'],
  // The size is isShown's own check, after the waiver, for every field: this row pins that one.
  ['under 4 px', 'width: 2px; height: 2px; padding: 0; border: 0;'],
  ['visibility: hidden', 'visibility: hidden;'],
] as const) {
  test(`a faded password field in a visible component, ${clause}: no fill (the waiver's clause pinned)`, async ({ page }) => {
    const a = await open(page, BROKEN_FADE(style));
    await page.click('#u');
    await a.settle();
    expect(await fillLastFocus(page, a)).toMatchObject({ ok: false });
    expect(await page.inputValue('#u')).toBe('');
  });
}

test('…and the same component, faded only, fills (the rows above fail on their clause alone)', async ({ page }) => {
  const a = await open(page, BROKEN_FADE(''));
  await page.click('#u');
  await a.settle();
  expect(await fillLastFocus(page, a)).toMatchObject({ ok: true });
});

/* ---------- Review round 4 of #61: main's formless submits kept, the rescan only when nothing's known ---------- */

/** What a click on `selector` sent: the submit signals, no blurs. */
const submitsAfterClick = async (page: Page, a: Awaited<ReturnType<typeof open>>, selector: string) => {
  await a.clear();
  await page.click(selector);
  await a.settle();
  return (await a.of('candidate')).filter((c) => c['signal'] !== 'blur').map((c) => c['signal']);
};

// As on main (submitButtonFor and formlessScope are main's again): a button beside a lone formless field submits,
// whatever its words, and with none (an icon). A password field's own box holding only it and a button is its eye's
// (main's wrapper rule), so the field sits in a box of its own here.
const LONE_BUTTONS = [
  ['<button>Submit</button>', '<button id="go">Submit</button>'],
  ['a “Go” button', '<button id="go" type="button">Go</button>'],
  ['an icon-only button', '<button id="go" type="button" aria-label="Continue"><svg width="12" height="12"></svg></button>'],
  ['an <input type=submit>', '<input id="go" type="submit" value="Continue">'],
] as const;

for (const [name, button] of LONE_BUTTONS) {
  test(`a lone formless password field with ${name} beside it: the click submits (main's behaviour)`, async ({ page }) => {
    const a = await open(page, `<div><div class="field"><input id="p" name="password" type="password" aria-label="Password"></div>${button}</div>`);
    await page.fill('#p', 'secret pass');
    expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
  });

  test(`a lone formless username field with ${name} beside it: the click is its step (main's behaviour)`, async ({ page }) => {
    const a = await open(page, `<div><input id="u" name="email" type="email" aria-label="Email" autocomplete="username">${button}</div>`);
    await page.fill('#u', 'ada@example.com');
    await a.clear();
    await page.click('#go');
    await a.settle();
    expect((await a.of('step')).map((x) => x['username'])).toEqual(['ada@example.com']);
  });
}

/* ---------- Formless sign-ins whose submit or field is a component (review round 4 of #61) ---------- */

/**
 * The page's components, defined by its script, so they upgrade anywhere (inside a shell's root too):
 * - `x-tf`, a text field: its input in its root (type from `data-type`), and a slot (an eye goes there);
 * - `x-tf-rm`, the same with a "Remember me" checkbox in its root;
 * - `x-button`, a button component labelled through its slot (Material's `md-filled-button`);
 * - `x-icon`, an icon button: a wordless `<button>` in its root (Material's `md-icon-button`, an eye);
 * - `x-app`, an app shell: its root holds the `<template>` named by `data-t`.
 */
const COMPONENTS = `<script>
  const def = (name, html) => customElements.define(name, class extends HTMLElement {
    connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = html(this); }
  });
  const input = (host) => '<input id="i" type="' + host.dataset.type + '" name="' + host.id + '" aria-label="' + host.id + '">';
  def('x-tf', (host) => input(host) + '<slot></slot>');
  def('x-tf-rm', (host) => input(host) + '<label><input id="rm" type="checkbox"> Remember me</label><slot></slot>');
  def('x-button', () => '<button id="b" type="button"><slot></slot></button>');
  def('x-icon', () => '<button id="b" type="button"><svg width="12" height="12"></svg></button>');
  def('x-app', (host) => document.getElementById(host.dataset.t).innerHTML);
</script>`;
/** `body` in an app shell's root (`shell`), or as it is. */
const shelled = (body: string, shell: boolean) => (shell ? `<template id="app">${body}</template><x-app id="app-host" data-t="app"></x-app>` : body) + COMPONENTS;
/** The password field of a page: in the `#pw` component's root, or the page's own `#p`. */
const typePassword = async (page: Page, selector = '#pw >> #i') => {
  await page.fill(selector, 'secret pass');
  // Past the agent's 1 s for one submit, so a click before this one doesn't hide this one.
  await page.waitForTimeout(1100);
};

for (const shell of [false, true]) {
  const where = shell ? 'in an app shell' : 'with no shell';
  test(`scenario A ${where}: a lone Material-like field, its eye slotted, and a component Sign in: the eye isn’t a submit, nor is Sign in: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf><x-button id="go">Sign in</x-button></div>', shell));
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#eye >> #b')).toEqual([]);
    await page.waitForTimeout(1100);
    expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
  });

  test(`scenario B ${where}: a lone Material-like field, no eye, and a slot-labelled Next component: Next isn’t a submit: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><x-tf id="pw" data-type="password"></x-tf><x-button id="go">Next</x-button></div>', shell));
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
  });

  test(`a page’s own lone password field and a slot-labelled Next component beside it, ${where}: Next isn’t a submit: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><div><input id="p" name="password" type="password" aria-label="Password"></div><x-button id="go">Next</x-button></div>', shell));
    await typePassword(page, '#p');
    expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
  });

  test(`a lone field whose component holds a “Remember me” checkbox, its eye slotted, ${where}: the eye isn’t a submit, nor is Sign in: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><x-tf-rm id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf-rm><button id="go" type="button">Sign in</button></div>', shell));
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#eye >> #b')).toEqual([]);
    await page.waitForTimeout(1100);
    expect(await submitsAfterClick(page, a, '#go')).toEqual([]);
  });

  test(`several candidate buttons beside a lone field, ${where}: none is a submit, Sign in included: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(
      page,
      shelled('<div><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf><button id="forgot" type="button">Forgot password?</button><x-button id="help">Help</x-button><x-button id="go">Sign in</x-button></div>', shell),
    );
    await typePassword(page);
    for (const not of ['#eye >> #b', '#forgot', '#help >> #b']) {
      expect(await submitsAfterClick(page, a, not)).toEqual([]);
      await page.waitForTimeout(1100);
    }
    expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
  });
}

// As on main, in a shell: a button with words, or an icon with a label, beside a lone field in a box of its own.
for (const [name, button] of LONE_BUTTONS) {
  test(`a lone password field in an app shell with ${name} beside it: the click submits`, async ({ page }) => {
    const a = await open(page, shelled(`<div><div class="field"><input id="p" name="password" type="password" aria-label="Password"></div>${button}</div>`, true));
    await typePassword(page, '#p');
    expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
  });
}

test('a lone password field directly in an app shell’s root, <button>Submit</button> in the same box: no submit, as main’s wrapper rule has it in the page’s tree', async ({ page }) => {
  const a = await open(page, shelled('<input id="p" name="password" type="password" aria-label="Password"><button id="go" type="button">Submit</button>', true));
  await typePassword(page, '#p');
  expect(await submitsAfterClick(page, a, '#go')).toEqual([]);
});

test('a form component whose own root holds a lone password field and its Next: Next isn’t a submit: main’s answer (component submits deferred, a known gap)', async ({ page }) => {
  const a = await open(
    page,
    `<x-step id="step"></x-step><script>
      document.getElementById('step').attachShadow({ mode: 'open' }).innerHTML = '<input id="i" type="password" name="password" aria-label="Password"><button id="b" type="button">Next</button>';
    </script>`,
  );
  await typePassword(page, '#step >> #i');
  expect(await submitsAfterClick(page, a, '#step >> #b')).toEqual([]);
});

/** A Material-like formless sign-in: each field an x-tf (input in its root), the password's with a slotted eye. */
const MATERIAL_FORMLESS = (extraInRoot: string, nested: boolean) => `<div id="wrap"><x-m id="em" data-type="email"></x-m><x-m id="pw" data-type="password"><x-icon id="eye"></x-icon></x-m><button id="go" type="button">Sign in</button></div><script>
  for (const host of document.querySelectorAll('x-m')) {
    const input = '<input id="i" type="' + host.dataset.type + '" name="' + host.id + '" aria-label="' + host.id + '">';
    host.attachShadow({ mode: 'open' }).innerHTML = ${nested ? `'<span class="text-field"><x-field id="field">' + input + '</x-field>${extraInRoot}</span><slot></slot>'` : `input + '${extraInRoot}<slot></slot>'`};
    const field = host.shadowRoot.getElementById('field');
    if (field) field.attachShadow({ mode: 'open' }).innerHTML = '<div class="content"><slot></slot></div>';
  }
</script>${COMPONENTS}`;

for (const [name, extra, nested] of [
  ['a hidden csrf input in the field component’s root', '<input type="hidden" name="csrf" value="x">', false],
  ['Material’s real nesting (the input under a field element in the root, the eye slotted)', '', true],
] as const) {
  test(`a Material-like formless sign-in, ${name}: the eye isn’t a submit, nor is Sign in outside: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, MATERIAL_FORMLESS(extra, nested));
    await page.fill('#em >> #i', 'ada@example.com');
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#eye >> #b')).toEqual([]);
    await page.waitForTimeout(1100);
    expect(await submitsAfterClick(page, a, '#go')).toEqual([]);
  });
}

test('deep scans off (a first scan with no root), then a Sign in component attached beside the fields: its click isn’t a submit: main’s answer (component submits deferred, a known gap)', async ({ page }) => {
  const a = await open(page, `<div id="wrap"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"></div>${COMPONENTS}`);
  await page.fill('#u', 'ada@example.com');
  await typePassword(page, '#p');
  await page.evaluate(() => {
    const host = document.createElement('x-button');
    host.id = 'go';
    host.textContent = 'Sign in';
    document.getElementById('wrap')!.append(host);
  });
  expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
});

/* ---------- Review round 1 of #65 ---------- */

/** A wordless icon button, in the page's tree. */
const ICON = (id: string) => `<button id="${id}" type="button"><svg width="12" height="12"></svg></button>`;

test('P1, as on main: a wordless icon component beside the field’s box doesn’t shrink the scope, and the page’s Sign in submits', async ({ page }) => {
  const a = await open(page, `<div><div class="row"><div class="box"><input id="p" name="password" type="password" aria-label="Password"></div><x-icon id="eye"></x-icon></div><button id="go" type="button">Sign in</button></div>${COMPONENTS}`);
  await typePassword(page, '#p');
  expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
});

for (const shell of [false, true]) {
  const where = shell ? 'in an app shell' : 'in the page’s tree';
  test(`P2, ${where}: a fully wordless icon button beside a lone field in its own box, the only button: it submits, as on main`, async ({ page }) => {
    const a = await open(page, shelled(`<div><div class="field"><input id="p" name="password" type="password" aria-label="Password"></div>${ICON('go')}</div>`, shell));
    await typePassword(page, '#p');
    expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
  });

  test(`P3, ${where}: an eye component beside a field component (not slotted), Sign in beside them: the eye isn’t a submit, nor is Sign in: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><x-tf id="pw" data-type="password"></x-tf><x-icon id="eye"></x-icon><button id="go" type="button">Sign in</button></div>', shell));
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#eye >> #b')).toEqual([]);
    await page.waitForTimeout(1100);
    expect(await submitsAfterClick(page, a, '#go')).toEqual([]);
  });


  test(`a two-field component sign-in, ${where}, the eye slotted in the password’s component: the eye isn’t a submit, nor is Sign in: main’s answer (component submits deferred, a known gap)`, async ({ page }) => {
    const a = await open(page, shelled('<div><x-tf id="em" data-type="email"></x-tf><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf><x-button id="go">Sign in</x-button></div>', shell));
    await page.fill('#em >> #i', 'ada@example.com');
    await typePassword(page);
    expect(await submitsAfterClick(page, a, '#eye >> #b')).toEqual([]);
    await page.waitForTimeout(1100);
    expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
  });
}

test('a button component’s label that comes after the walk (none, then Sign in) gives no submit either way: main’s answer (component submits deferred, a known gap)', async ({ page }) => {
  const a = await open(page, `<div><x-tf id="pw" data-type="password"></x-tf><x-button id="go"></x-button></div>${COMPONENTS}`);
  await typePassword(page);
  await page.evaluate(() => void (document.getElementById('go')!.textContent = 'Sign in'));
  expect(await submitsAfterClick(page, a, '#go >> #b')).toEqual([]);
});

/* ---------- Review round 2 of #65 ---------- */

// A wordless arrow beside a lone field still submits beside a button that isn't this form's own submit (as on main).
for (const label of ['Create account', 'Sign up', 'Sign in another way', 'Sign-in options'] as const) {
  for (const component of [false, true]) {
    const other = component ? `<x-button id="other">${label}</x-button>` : `<button id="other" type="button">${label}</button>`;
    test(`a wordless arrow beside a lone password field, ${component ? 'a component' : 'a button'} saying “${label}” beside it: the arrow submits`, async ({ page }) => {
      const a = await open(page, `<div><div class="box"><input id="p" name="password" type="password" aria-label="Password"></div>${ICON('go')}${other}</div>${COMPONENTS}`);
      await typePassword(page, '#p');
      expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
    });
  }
}

test('a first step’s wordless arrow, “Sign in another way” beside it: the arrow is its step', async ({ page }) => {
  const a = await open(page, `<div><div class="box"><input id="u" name="email" type="email" aria-label="Email" autocomplete="username"></div>${ICON('go')}<button type="button">Sign in another way</button></div>`);
  await page.fill('#u', 'ada@example.com');
  await a.clear();
  await page.click('#go');
  await a.settle();
  expect((await a.of('step')).map((x) => x['username'])).toEqual(['ada@example.com']);
});

test('a phone layout’s wordless arrow, the desktop Sign in hidden beside it: the arrow submits', async ({ page }) => {
  const a = await open(page, `<div><div class="box"><input id="p" name="password" type="password" aria-label="Password"></div>${ICON('go')}<button type="button" style="display: none">Sign in</button></div>`);
  await typePassword(page, '#p');
  expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
});

for (const label of ['Sign back in', 'Sign in to view your account'] as const) {
  test(`“${label}” beside a lone password field: a submit (back and view are a toggle’s or a link’s only as the first word)`, async ({ page }) => {
    const a = await open(page, `<div><div class="box"><input id="p" name="password" type="password" aria-label="Password"></div><button id="go" type="button">${label}</button></div>`);
    await typePassword(page, '#p');
    expect(await submitsAfterClick(page, a, '#go')).toEqual(['button']);
  });
}

test('…and a “‹ Back” or “View password” button beside the field still isn’t one', async ({ page }) => {
  const a = await open(page, `<div><div class="box"><input id="p" name="password" type="password" aria-label="Password"></div><button id="back" type="button">‹ Back</button><button id="view" type="button">View password</button><button type="button">Sign in</button></div>`);
  await typePassword(page, '#p');
  expect(await submitsAfterClick(page, a, '#back')).toEqual([]);
  await page.waitForTimeout(1100);
  expect(await submitsAfterClick(page, a, '#view')).toEqual([]);
});

/* ---------- Review round 3 of #65: round 3's probe table, each row with what main gives ---------- */

/** 40 icon components (Ionic's `ion-icon`, a ripple): roots with no button (`x-ico`, defined with the inner shell). */
const ICONS_40 = '<x-ico></x-ico>'.repeat(40);
const LIGHT_FIELD = '<div class="box"><input id="p" name="password" type="password" aria-label="Password"></div>';
const LIGHT_EMAIL = '<div class="box"><input id="u" name="email" type="email" aria-label="Email" autocomplete="username"></div>';
const XTF_FIELD = '<x-tf id="pw" data-type="password"></x-tf>';
type Outcome = 'submit' | 'none' | 'step';
interface TableRow {
  readonly name: string;
  readonly body: string;
  /** The field typed in: `#p`, `#pw >> #i` (a component's), or `#u` for a first step. */
  readonly field: string;
  readonly click: string;
  readonly pr: Outcome;
  /** What main gives, with main's scan and agent (round 3's table): where main has a scope, `pr` must match it. */
  readonly main: Outcome;
}
const OTHER_LABELS = ['Help', 'Forgot password?', 'Sign in with Google', 'Create account', 'Sign up', 'Sign in another way', 'Sign-in options'] as const;
const ODD_SUBMITS = [
  ['Submit', '<button id="go" type="button">Submit</button>', 'none'],
  ['Done', '<button id="go" type="button">Done</button>', 'none'],
  ['a 5-word Sign in', '<button id="go" type="button">Sign in to your account</button>', 'submit'],
  ['Sign in in text, aria-label and title', '<button id="go" type="button" aria-label="Sign in" title="Sign in">Sign in</button>', 'submit'],
  ['Sign in at opacity 0', '<button id="go" type="button" style="opacity: 0">Sign in</button>', 'submit'],
  ['Log in to continue now', '<button id="go" type="button">Log in to continue now</button>', 'submit'],
  ['Continue', '<button id="go" type="button">Continue</button>', 'submit'],
] as const;

const TABLE: TableRow[] = [];
for (const shell of [false, true]) {
  const w = shell ? 'shell' : 'light';
  const add = (row: Omit<TableRow, 'body'> & { body: string }) => TABLE.push({ ...row, name: `${w}: ${row.name}`, body: shelled(row.body, shell) });
  // The 28 arrow combinations: a wordless arrow beside each other-way label, as a button and as a component.
  for (const label of OTHER_LABELS) {
    for (const component of [false, true]) {
      const other = component ? `<x-button>${label}</x-button>` : `<button type="button">${label}</button>`;
      add({ name: `arrow beside ${component ? 'a component' : 'a button'} “${label}”`, body: `<div>${LIGHT_FIELD}${ICON('go')}${other}</div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
    }
  }
  // First steps.
  for (const label of ['Sign in another way', 'Continue with phone', 'Continue with email'] as const) {
    add({ name: `first step: arrow beside “${label}”`, body: `<div>${LIGHT_EMAIL}${ICON('go')}<button type="button">${label}</button></div>`, field: '#u', click: '#go', pr: 'step', main: 'step' });
  }
  add({ name: 'first step: the “Continue with email” button itself', body: `<div>${LIGHT_EMAIL}${ICON('arrow')}<button id="go" type="button">Continue with email</button></div>`, field: '#u', click: '#go', pr: 'step', main: 'step' });
  // Hidden and aria-hidden buttons beside an arrow.
  add({ name: 'a hidden desktop Sign in beside a phone’s arrow', body: `<div>${LIGHT_FIELD}${ICON('go')}<button type="button" style="display: none">Sign in</button></div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
  add({ name: 'an aria-hidden, visible Sign in beside an arrow', body: `<div>${LIGHT_FIELD}${ICON('go')}<button type="button" aria-hidden="true">Sign in</button></div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
  // 40 roots in the scope.
  add({ name: '40 icon roots in the scope, a light arrow, no Sign in', body: `<div>${LIGHT_FIELD}${ICON('go')}${ICONS_40}</div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
  add({ name: '40 icon roots, a light eye, a Sign in component after them: the eye, as main', body: `<div>${LIGHT_FIELD}${ICON('eye')}${ICONS_40}<x-button>Sign in</x-button></div>`, field: '#p', click: '#eye', pr: 'submit', main: 'submit' });
  // P1 to P4.
  add({ name: 'P1: the page’s Sign in, an x-icon eye beside the field’s box', body: `<div><div class="row">${LIGHT_FIELD}<x-icon id="eye"></x-icon></div><button id="go" type="button">Sign in</button></div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
  add({ name: 'P1: …its x-icon eye', body: `<div><div class="row">${LIGHT_FIELD}<x-icon id="eye"></x-icon></div><button type="button">Sign in</button></div>`, field: '#p', click: '#eye >> #b', pr: 'none', main: 'none' });
  add({ name: 'P2: a wordless button beside a lone field in its own box, the only button', body: `<div>${LIGHT_FIELD}${ICON('go')}</div>`, field: '#p', click: '#go', pr: 'submit', main: 'submit' });
  add({ name: 'P3: a slotted eye in the field component', body: `<div><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf><button type="button">Sign in</button></div>`, field: '#pw >> #i', click: '#eye >> #b', pr: 'none', main: 'none' });
  add({ name: 'P3: …Sign in beside it', body: `<div><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf><button id="go" type="button">Sign in</button></div>`, field: '#pw >> #i', click: '#go', pr: 'submit', main: 'none' });
  add({ name: 'P4: a light eye beside a component field, Sign in beside it', body: `<div>${XTF_FIELD}${ICON('eye')}<button type="button">Sign in</button></div>`, field: '#pw >> #i', click: '#eye', pr: 'none', main: 'none' });
  add({ name: 'P4: …Sign in', body: `<div>${XTF_FIELD}${ICON('eye')}<button id="go" type="button">Sign in</button></div>`, field: '#pw >> #i', click: '#go', pr: 'submit', main: 'none' });
  add({ name: 'P4’s light twin (the page’s own field): the eye, as main', body: `<div>${LIGHT_FIELD}${ICON('eye')}<button type="button">Sign in</button></div>`, field: '#p', click: '#eye', pr: 'submit', main: 'submit' });
  // The P4 eye beside each odd submit label, and the submit itself.
  for (const [what, submit, itself] of ODD_SUBMITS) {
    add({ name: `P4’s eye beside ${what}`, body: `<div>${XTF_FIELD}${ICON('eye')}${submit}</div>`, field: '#pw >> #i', click: '#eye', pr: 'none', main: 'none' });
    add({ name: `P4: ${what} itself`, body: `<div>${XTF_FIELD}${ICON('eye')}${submit}</div>`, field: '#pw >> #i', click: '#go', pr: itself, main: 'none' });
    add({ name: `P3’s slotted eye beside ${what}`, body: `<div><x-tf id="pw" data-type="password"><x-icon id="eye"></x-icon></x-tf>${submit}</div>`, field: '#pw >> #i', click: '#eye >> #b', pr: 'none', main: 'none' });
  }
  // Probes 2, 2b and 2c, and the x-tf cookie probe, with their light twins: shells of their own, so once.
  if (!shell) {
  add({ name: 'probe 2 (inner shell): Accept cookies beside the field’s shell', body: `<div id="page"><x-app2 data-t="inner"></x-app2><button id="cookies" type="button">Accept cookies</button></div><template id="inner"><div class="row">${LIGHT_FIELD}<x-button>Sign in</x-button></div></template>`, field: '#p', click: '#cookies', pr: 'none', main: 'none' });
  add({ name: 'probe 2b: a shell field, a div Sign in, Accept cookies beside the shell', body: `<div id="page"><x-app2 data-t="inner"></x-app2><button id="cookies" type="button">Accept cookies</button></div><template id="inner"><div class="row">${LIGHT_FIELD}<div role="none" tabindex="0">Sign in</div></div></template>`, field: '#p', click: '#cookies', pr: 'none', main: 'none' });
  add({ name: 'probe 2c: a shell field (Enter only), Accept cookies beside the shell', body: `<div id="page"><x-app2 data-t="inner"></x-app2><button id="cookies" type="button">Accept cookies</button></div><template id="inner"><div class="row">${LIGHT_FIELD}</div></template>`, field: '#p', click: '#cookies', pr: 'none', main: 'none' });
  add({ name: 'x-tf cookie probe: a component field, no button near, Accept cookies', body: `<div id="page"><div class="row">${XTF_FIELD}</div><button id="cookies" type="button">Accept cookies</button></div>`, field: '#pw >> #i', click: '#cookies', pr: 'none', main: 'none' });
  add({ name: 'the x-tf cookie probe’s light twin: Accept cookies, as main', body: `<div id="page"><div class="row">${LIGHT_FIELD}</div><button id="cookies" type="button">Accept cookies</button></div>`, field: '#p', click: '#cookies', pr: 'submit', main: 'submit' });
  add({ name: 'probe 2b’s light twin: Accept cookies, as main', body: `<div id="page"><div class="row">${LIGHT_FIELD}<div role="none" tabindex="0">Sign in</div></div><button id="cookies" type="button">Accept cookies</button></div>`, field: '#p', click: '#cookies', pr: 'submit', main: 'submit' });
  }
  // Should-fix 3.
  add({ name: 'an eye labelled “Click to view password” beside a lone field', body: `<div>${LIGHT_FIELD}<button id="eye" type="button" aria-label="Click to view password"><svg width="12" height="12"></svg></button><button type="button">Sign in</button></div>`, field: '#p', click: '#eye', pr: 'none', main: 'none' });
}

/** The inner shell for probes 2 to 2c: an `x-app2` whose root is its template, defined so it upgrades in a shell too. */
const INNER_SHELL = `<script>
  customElements.define('x-app2', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = document.getElementById(this.dataset.t).innerHTML; } });
  customElements.define('x-ico', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = '<svg width="1" height="1"></svg>'; } });
</script>`;

for (const row of TABLE) {
  test(`round 3’s table, ${row.name}: ${row.main}, as main${row.pr === row.main ? '' : ` (deferred: ${row.pr}, a known gap)`}`, async ({ page }) => {
    const a = await open(page, row.body + INNER_SHELL);
    if (row.field === '#u') await page.fill('#u', 'ada@example.com');
    else await typePassword(page, row.field);
    await a.clear();
    await page.click(row.click);
    await a.settle();
    const signals = (await a.of('candidate')).filter((c) => c['signal'] !== 'blur').map((c) => c['signal']);
    const steps = await a.of('step');
    const got: Outcome = signals.includes('button') ? 'submit' : steps.length ? 'step' : 'none';
    // Main's answer everywhere (the owner's fallback for #65): `pr` is what the deferred component submits would give.
    expect(got).toBe(row.main);
  });
}
