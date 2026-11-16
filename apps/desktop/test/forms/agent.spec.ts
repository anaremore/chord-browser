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
  expect(await a.of('filled')).toEqual([{ formId: 'f1', ok: false }]);
  expect(await page.inputValue('#p')).toBe('');
});
