/**
 * Providers' recipes (S17, phase 3D; packages/core/src/password-recipes.ts), the agent in Playwright's own headless
 * Chromium with a fake bridge, as agent.spec.ts runs it, on pages served at the providers' hosts. The pages are Chord's
 * own minimal markup, shaped as each provider's step is, with the ids and names its recipe needs: nothing of theirs.
 *
 * - **Each step:** Google's identifier and password steps (their Next outside the form, which the click rule never sees),
 *   Microsoft's, Okta's and Auth0's: the fields' roles, and Next's candidate with what was typed.
 * - **Only adds:** the same markup on a host without a recipe (and one that only ends like a provider's) gets the generic
 *   detector's reading; a recipe's submit that reads as a show-password toggle, is pressed, or sits in the password's
 *   own wrapper is still never a submit; a recipe never turns a sign-up into a sign-in.
 * - **Frames first:** a sandboxed frame at the provider's host is never used, and another site's frame of it neither; an
 *   unsandboxed same-origin one is, with its recipe.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

let script = '';
let recorder = '';
/** The pages served, by URL without its query. */
let pages: Record<string, string> = {};
test.beforeAll(async () => {
  script = await bundleAgent({ entry: join(import.meta.dirname, 'agent-entry.ts'), minify: false });
  recorder = await bundleAgent({ entry: join(import.meta.dirname, 'sandbox-recorder.ts'), minify: true });
});
test.beforeEach(async ({ context }) => {
  pages = {};
  await context.addInitScript({ content: recorder });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    const body = pages[`${url.origin}${url.pathname}`];
    return body === undefined ? route.abort() : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
});

type Message = [string, Record<string, unknown>];
interface AgentTest {
  start(): void;
  messages(): Message[];
  clear(): void;
}
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body style="margin:0">${body}</body></html>`;
const api = (page: Page) => ({
  clear: () => page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.clear()),
  of: async (channel: string) => (await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.messages())).filter(([c]) => c === channel).map(([, p]) => p),
  settle: () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150))))),
});
/** A page at `url` (and any others, by URL), with the agent started on it. */
async function open(page: Page, url: string, body: string, more: Record<string, string> = {}) {
  pages = { [url]: html(body), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, html(v)])) };
  await page.goto(url);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.start());
  const a = api(page);
  await a.settle();
  return a;
}
/**
 * What a step's submit sent: a sign-in's `candidate` (a field left after typing sends a `blur` one, not a submit), or a
 * first step's `step` (its username, for the password step after it).
 */
const submits = async (a: ReturnType<typeof api>) => [...(await a.of('step')), ...(await a.of('candidate')).filter((c) => c['signal'] !== 'blur')];

// Shaped as Google's steps are: the form holds the fields; Next is a button in its own wrapper, after the form.
const GOOGLE_IDENTIFIER =
  '<form id="f" onsubmit="return false"><input id="identifierId" type="email" name="identifier" aria-label="Email or phone"></form>' +
  '<div id="identifierNext"><div><button type="button"><span>Next</span></button></div></div>';
const GOOGLE_PASSWORD =
  '<form id="f" onsubmit="return false"><input type="email" name="identifier" value="ada@example.com" hidden>' +
  '<div><input type="password" name="Passwd" aria-label="Enter your password"></div><label><input type="checkbox" id="show"> Show password</label></form>' +
  '<div id="passwordNext"><div><button type="button"><span>Next</span></button></div></div>';
const GOOGLE = 'https://accounts.google.com/v3/signin/identifier';

test('Google’s identifier step: Next, outside the form, submits the first step: its email goes to main', async ({ page }) => {
  const a = await open(page, GOOGLE, GOOGLE_IDENTIFIER);
  await page.locator('#identifierId').click();
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'username-only', role: 'username' });
  await page.locator('#identifierId').fill('ada@example.com');
  await a.clear();
  // On Next's inner span, as a person clicks it.
  await page.locator('#identifierNext span').click();
  await a.settle();
  const c = await submits(a);
  expect(c).toHaveLength(1);
  expect(c[0]).toEqual({ formId: expect.any(String), signal: 'button', username: 'ada@example.com' });
});

test('Google’s password step: the password’s role, and Next submits it with the carried email', async ({ page }) => {
  const a = await open(page, 'https://accounts.google.com/v3/signin/challenge/pwd', GOOGLE_PASSWORD);
  await page.locator('input[name="Passwd"]').click();
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-in', role: 'current-password' });
  await page.locator('input[name="Passwd"]').fill('secret pass');
  await a.clear();
  // The page's own show-password checkbox is never a submit.
  await page.locator('#show').click();
  await a.settle();
  expect(await submits(a)).toEqual([]);
  await page.locator('#passwordNext button').click();
  await a.settle();
  const c = await submits(a);
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ signal: 'button', kind: 'sign-in', values: { username: 'ada@example.com', password: 'secret pass' } });
});

test('the same markup on a host without a recipe, or one that only ends like Google’s: Next is not a submit', async ({ page }) => {
  for (const url of ['https://sign-in.example/identifier', 'https://accounts.google.com.example/identifier', 'https://notaccounts.google.com/identifier']) {
    const a = await open(page, url, GOOGLE_IDENTIFIER);
    await page.locator('#identifierId').fill('ada@example.com');
    await a.clear();
    await page.locator('#identifierNext button').click();
    await a.settle();
    expect(await submits(a), url).toEqual([]);
  }
});

test('a recipe’s submit that reads as a toggle, is pressed, or is the password’s own eye: never a submit', async ({ page }) => {
  // Google's selector on a show-password button (its words), and on a pressed one.
  for (const button of ['<button type="button" aria-label="Show password">o</button>', '<button type="button" aria-pressed="false">Next</button>']) {
    const a = await open(
      page,
      'https://accounts.google.com/v3/signin/challenge/pwd',
      '<form id="f" onsubmit="return false"><input type="email" name="identifier" value="ada@example.com" hidden><input type="password" name="Passwd" aria-label="Password"></form>' +
        `<div id="passwordNext">${button}</div>`,
    );
    await page.locator('input[name="Passwd"]').fill('secret pass');
    await a.clear();
    await page.locator('#passwordNext button').click();
    await a.settle();
    expect(await submits(a), button).toEqual([]);
  }
  // Microsoft's selector on the eye in the password's own wrapper.
  const a = await open(
    page,
    'https://login.live.com/ppsecure/post.srf',
    '<form id="f" onsubmit="return false"><input type="email" name="loginfmt" aria-label="Email"><span><input type="password" name="passwd" aria-label="Password"><button type="button" id="idSIButton9">o</button></span></form>',
  );
  await page.locator('input[name="passwd"]').fill('secret pass');
  await a.clear();
  await page.locator('#idSIButton9').click();
  await a.settle();
  expect(await submits(a)).toEqual([]);
});

test('a recipe never makes a sign-up a sign-in: a new password and its confirmation keep their roles', async ({ page }) => {
  const a = await open(
    page,
    'https://dev-ada.us.auth0.com/u/signup/password',
    '<form id="f" onsubmit="return false"><h1>Create your account</h1><input id="username" name="username" type="email" aria-label="Email" autocomplete="username">' +
      '<input id="password" name="password" type="password" aria-label="Password" autocomplete="new-password"><input id="confirm" name="confirm" type="password" aria-label="Confirm password" autocomplete="new-password">' +
      '<button type="submit" name="action" value="default">Continue</button></form>',
  );
  await page.locator('#password').click();
  await a.settle();
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-up', role: 'new-password' });
});

test('Microsoft’s, Okta’s and Auth0’s steps: their fields’ roles, and one candidate for Next', async ({ page }) => {
  const steps = [
    {
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      body: '<form id="f" onsubmit="return false"><input type="email" name="loginfmt" aria-label="Email, phone, or Skype"><input type="submit" id="idSIButton9" value="Next"></form>',
      field: 'input[name="loginfmt"]',
      next: '#idSIButton9',
      want: { kind: 'username-only', role: 'username' },
    },
    {
      url: 'https://login.live.com/ppsecure/post.srf',
      body: '<form id="f" onsubmit="return false"><input type="email" name="loginfmt" value="ada@example.com" hidden><input type="password" name="passwd" aria-label="Password"><input type="submit" id="idSIButton9" value="Sign in"></form>',
      field: 'input[name="passwd"]',
      next: '#idSIButton9',
      want: { kind: 'sign-in', role: 'current-password' },
    },
    {
      url: 'https://ada.okta.com/signin',
      body: '<form id="f" onsubmit="return false"><input id="okta-signin-username" name="username" aria-label="Username"><input id="okta-signin-password" name="password" type="password" aria-label="Password"><input type="submit" id="okta-signin-submit" value="Sign in"></form>',
      field: '#okta-signin-password',
      next: '#okta-signin-submit',
      want: { kind: 'sign-in', role: 'current-password' },
    },
    {
      url: 'https://ada.okta.com/oauth2/default/v1/authorize',
      body: '<form id="f" onsubmit="return false"><input name="identifier" aria-label="Username"><input type="submit" value="Next"></form>',
      field: 'input[name="identifier"]',
      next: 'input[type="submit"]',
      want: { kind: 'username-only', role: 'username' },
    },
    {
      url: 'https://dev-ada.us.auth0.com/u/login/identifier',
      body: '<form id="f" onsubmit="return false"><input id="username" name="username" type="text" aria-label="Email address"><button type="submit" name="action" value="default">Continue</button></form>',
      field: '#username',
      next: 'button[name="action"]',
      want: { kind: 'username-only', role: 'username' },
    },
  ];
  for (const s of steps) {
    const a = await open(page, s.url, s.body);
    await page.locator(s.field).click();
    await a.settle();
    expect((await a.of('focus')).at(-1), s.url).toMatchObject(s.want);
    await page.locator(s.field).fill(s.want.role === 'username' ? 'ada@example.com' : 'secret pass');
    await a.clear();
    await page.locator(s.next).click();
    await a.settle();
    expect(await submits(a), s.url).toHaveLength(1);
  }
});

const frame = (src: string, extra = '') => `<iframe id="fr" src="${src}" ${extra} style="width:400px;height:300px"></iframe>`;

test('frames first: a sandboxed frame at Google’s host, and another site’s frame of it, are never used; a same-origin one is', async ({ page }) => {
  const login = 'https://accounts.google.com/v3/signin/identifier';
  for (const [top, extra] of [
    ['https://accounts.google.com/', 'sandbox="allow-same-origin allow-scripts allow-forms"'],
    ['https://sign-in.example/', ''],
  ] as const) {
    const a = await open(page, top, frame(login, extra), { [login]: GOOGLE_IDENTIFIER });
    const fr = page.frameLocator('#fr');
    await fr.locator('#identifierId').click();
    await fr.locator('#identifierId').fill('ada@example.com');
    await fr.locator('#identifierNext button').click();
    await a.settle();
    expect(await a.of('focus'), top + extra).toEqual([]);
    expect(await a.of('candidate'), top + extra).toEqual([]);
  }
  // The control: unsandboxed, same origin, its recipe applies in the frame.
  const a = await open(page, 'https://accounts.google.com/', frame(login), { [login]: GOOGLE_IDENTIFIER });
  const fr = page.frameLocator('#fr');
  await fr.locator('#identifierId').fill('ada@example.com');
  await a.clear();
  await fr.locator('#identifierNext button').click();
  await a.settle();
  expect(await submits(a)).toEqual([{ formId: expect.any(String), signal: 'button', username: 'ada@example.com' }]);
});
