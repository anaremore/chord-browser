/**
 * The password detector in Chord (S17 §13, layer 3, as far as phase 1's detector goes; the
 * menu, the save card and filling come with the vault). With detection turned on through the
 * test hook, as the vault's switch will:
 *
 * - a page with no sign-in field never wakes the agent, and turning detection off takes it
 *   away at the next load;
 * - on a sign-in page the agent wakes in world 4440 only: the page's own world sees no
 *   bridge, and the page's DOM is exactly as it was;
 * - focus reports the field's role and box; a sign-in that navigates to a page without the
 *   form is `signedIn`, one that shows the form again is `failed`; a formless sign-in whose
 *   form goes after its `fetch` is `signedIn`, with the request's status as a hint;
 * - a show-password toggle and a "Forgot password?" button aren't submits, and one submit
 *   (a click that submits the form) is one `submitted`;
 * - a sign-in form inside a frame gets no agent and sends nothing (phase 1 is the main frame);
 * - a forged message (an origin or a value in the payload) is refused;
 * - **no event carries a value**: the username and password typed never reach main.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, pageWhere, startSite, type Site } from './a11y-kit';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const USER = 'ada@example.com';
/** Longer than main waits after a page stops loading to decide a sign-in (saving.ts, SETTLE_MS). */
const SETTLE_WAIT_MS = 2000;
const SECRET = 'correct horse battery staple';

const signIn = (action: string) =>
  `<title>Sign in</title><h1>Sign in</h1><form id="f" action="${action}" method="post">` +
  '<label for="u">Email</label><input id="u" name="email" type="email">' +
  '<label for="p">Password</label><input id="p" name="password" type="password">' +
  '<button id="go">Sign in</button></form>';
const PAGES = {
  '/nothing': '<title>Nothing</title><form><input type="search" id="q" placeholder="Search"></form><p>No sign-in here.</p>',
  '/plain': signIn('/welcome'),
  '/welcome': '<title>Welcome</title><p>Signed in.</p>',
  // A sign-in that fails: the same form comes back.
  '/wrong': signIn('/wrong'),
  // No <form>: a script signs in with fetch, reads the reply and takes the form away.
  '/spa':
    '<title>App</title><div id="box"><h2>Log in</h2><input id="u" type="email" aria-label="Email"><input id="p" type="password" aria-label="Password">' +
    '<button id="go" type="button">Log in</button></div>' +
    "<script>document.getElementById('go').addEventListener('click', async () => { const r = await fetch('/api/session', { method: 'POST' }); await r.text(); document.getElementById('box').remove(); });</script>",
  '/api/session': '{"ok":true}',
  // A show-password toggle and a help button in the form, beside its submit button.
  '/toggle':
    '<title>Log in</title><h1>Log in</h1><form action="/welcome" method="post">' +
    '<input id="u" name="email" type="email" aria-label="Email">' +
    '<span class="field"><input id="p" name="password" type="password" aria-label="Password"><button id="eye" type="button" aria-label="Show password">\u{1F441}</button></span>' +
    '<button id="forgot" type="button">Forgot password?</button><button id="go">Log in</button></form>',
  // The only sign-in form is in a same-origin frame.
  '/framed': '<title>Framed</title><p>A page with a frame.</p><iframe id="frame" src="/plain" width="600" height="400"></iframe>',
};

interface Hooks {
  passwordsEnabled(on: boolean, profileIds?: string[]): void;
  passwordEvents(): Record<string, unknown>[];
  clearPasswordEvents(): void;
}
const enable = (app: ElectronApplication, on: boolean) => app.evaluate((_electron, value) => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.passwordsEnabled(value), on);
const clear = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.clearPasswordEvents());
const events = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { chordTestHooks: Hooks }).chordTestHooks.passwordEvents());
const types = async (app: ElectronApplication) => (await events(app)).map((e) => e['type']);

/** Runs `code` in the page's world 4440 (the agent's), from main. */
const inAgentWorld = (app: ElectronApplication, url: string, code: string) =>
  app.evaluate(({ webContents }, [u, c]) => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(u))!.executeJavaScriptInIsolatedWorld(4440, [{ code: c }]), [url, code] as const);

let site: Site;
test.beforeAll(async () => {
  site = await startSite(PAGES);
});
test.afterAll(() => site.server.close());

test('passwords: the agent wakes only on sign-in pages, adds nothing, and tells main what you did without a value', async () => {
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/nothing`, CHORD_E2E_HOOKS: '1' });
  try {
    let page: Page = await pageWhere(app, (u) => u.endsWith('/nothing'));
    await enable(app, true);
    await page.reload();
    // No sign-in field: the sentinel stays asleep, even with the search box focused.
    await page.focus('#q');
    await page.waitForTimeout(300);
    expect(await inAgentWorld(app, `${site.origin}/nothing`, 'typeof chordPasswords')).toBe('undefined');

    // A sign-in page: the agent wakes in its own world, and nothing of it is in the page's.
    await page.goto(`${site.origin}/plain`);
    const before = await page.evaluate(() => document.documentElement.outerHTML);
    await expect.poll(() => inAgentWorld(app, `${site.origin}/plain`, 'typeof chordPasswords')).toBe('object');
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>)['chordPasswords'])).toBe('undefined');

    // Focus: the role and the field's box, as the page measures it.
    await page.focus('#u');
    await expect.poll(() => types(app)).toContain('focus');
    const focus = (await events(app)).find((e) => e['type'] === 'focus')!;
    const box = await page.evaluate(() => {
      const r = document.getElementById('u')!.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    expect(focus).toMatchObject({ role: 'username', kind: 'sign-in', origin: site.origin, rect: box, zoomFactor: 1 });

    // A sign-in that worked: typed, submitted, and the next page doesn't show the form.
    await page.fill('#u', USER);
    await page.fill('#p', SECRET);
    // Woken, focused and typed in: the page's markup is exactly what it was (no attribute, class, element or style).
    expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
    await page.press('#p', 'Enter');
    await page.waitForURL(/\/welcome$/);
    await expect.poll(() => types(app), { timeout: 10_000 }).toContain('signedIn');
    expect((await events(app)).find((e) => e['type'] === 'signedIn')).toMatchObject({ how: 'navigation', kind: 'sign-in', origin: site.origin });

    // A sign-in that failed: the same form comes back.
    await clear(app);
    page = await pageWhere(app, (u) => u.endsWith('/welcome'));
    await page.goto(`${site.origin}/wrong`);
    await page.fill('#u', USER);
    await page.fill('#p', 'wrong password');
    await page.click('#go');
    await expect.poll(() => types(app), { timeout: 10_000 }).toContain('failed');
    expect((await events(app)).find((e) => e['type'] === 'failed')).toMatchObject({ why: 'reappeared' });
    expect(await types(app)).not.toContain('signedIn');

    // No <form>: the button's click is the signal, and the form going after the fetch is the success, with its status as a hint.
    await clear(app);
    await page.goto(`${site.origin}/spa`);
    await page.fill('#u', USER);
    await page.fill('#p', SECRET);
    await page.click('#go');
    await expect.poll(() => types(app), { timeout: 12_000 }).toContain('signedIn');
    const all = await events(app);
    expect(all.find((e) => e['type'] === 'submitted')).toMatchObject({ signal: 'button' });
    expect(all.find((e) => e['type'] === 'signedIn')).toMatchObject({ how: 'form-gone', hint: 'response-ok' });

    // A show-password toggle and "Forgot password?" aren't submits; the form's own button is, once.
    await clear(app);
    await page.goto(`${site.origin}/toggle`);
    await page.fill('#u', USER);
    await page.fill('#p', SECRET);
    await page.click('#eye');
    await page.click('#forgot');
    await page.waitForTimeout(500);
    expect(await types(app)).not.toContain('submitted');
    await page.click('#go');
    await page.waitForURL(/\/welcome$/);
    await expect.poll(() => types(app), { timeout: 10_000 }).toContain('signedIn');
    expect((await types(app)).filter((t) => t === 'submitted')).toEqual(['submitted']);

    // A sign-in form in a frame: no agent in the page (its preload doesn't run in frames), nothing reported.
    await clear(app);
    await page.goto(`${site.origin}/framed`);
    const frame = page.frameLocator('#frame');
    await frame.locator('#u').fill(USER);
    await frame.locator('#p').fill(SECRET);
    await frame.locator('#p').press('Enter');
    await expect(frame.locator('p')).toHaveText('Signed in.');
    await page.waitForTimeout(SETTLE_WAIT_MS);
    expect(await inAgentWorld(app, `${site.origin}/framed`, 'typeof chordPasswords')).toBe('undefined');
    expect(await events(app)).toEqual([]);

    // Forged payloads from the agent's own world: an origin of the page's choosing, a value. Both refused.
    await page.goto(`${site.origin}/plain`);
    await expect.poll(() => inAgentWorld(app, `${site.origin}/plain`, 'typeof chordPasswords')).toBe('object');
    await clear(app);
    await inAgentWorld(
      app,
      `${site.origin}/plain`,
      `chordPasswords.send('focus', { formId: 'f1', kind: 'sign-in', role: 'username', rect: { x: 0, y: 0, width: 9, height: 9 }, origin: 'https://bank.example' });
       chordPasswords.send('candidate', { formId: 'f1', kind: 'sign-in', signal: 'submit', username: null, password: { type: 'password', id: 'p', name: 'password' }, newPassword: null, hasUsername: false, hasPassword: true, value: 'x' });
       chordPasswords.send('focus', { formId: 'f1', kind: 'sign-in', role: 'username', rect: { x: 0, y: 0, width: 9, height: 9 } });`,
    );
    // The last one is well formed: once it's in, the two before it were dropped, not delayed.
    await expect.poll(() => types(app)).toEqual(['focus']);
    expect((await events(app))[0]).toMatchObject({ origin: site.origin });

    // Nothing that reached main holds what you typed.
    const json = JSON.stringify(await events(app)) + JSON.stringify(all);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(SECRET);

    // Off: the sentinel is gone from the next load.
    await enable(app, false);
    await page.reload();
    await page.waitForTimeout(300);
    expect(await inAgentWorld(app, `${site.origin}/plain`, 'typeof chordPasswords')).toBe('undefined');
  } finally {
    await app.close();
  }
});
