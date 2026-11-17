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
  // Count the agent's scans: each reads the document's controls once.
  await page.evaluate(() => {
    const qsa = Document.prototype.querySelectorAll;
    (globalThis as unknown as { scans: number }).scans = 0;
    Document.prototype.querySelectorAll = function (this: Document, selector: string) {
      if (selector === 'input, select, textarea') (globalThis as unknown as { scans: number }).scans++;
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
