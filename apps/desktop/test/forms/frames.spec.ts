/**
 * Same-origin frames (S17 §4, phase 3C), the agent in Playwright's own headless Chromium with a fake bridge, as
 * agent.spec.ts runs it: the top document's agent reaches into each frame it may use and runs one there.
 *
 * - **Used:** a same-origin frame (http(s), the top's origin, no `sandbox`), nested up to 3 levels, 20 frames at most:
 *   its focus with the field's box in the tab's pixels, its forms in the page's one report, its fill, its submit, its
 *   formless button, a frame added later, a frame that navigates to another page of the origin, and the watch's `gone`
 *   when the frame navigates after a submit.
 * - **Never:** another site's frame, a sandboxed one (`allow-same-origin` too), `srcdoc`, `about:blank`, `data:`, a fourth
 *   level, a 21st frame.
 * - **Checked at every use:** a frame given a `sandbox` attribute between focus and submit gives no candidate, and one
 *   that goes to another site between the menu and the fill gets nothing.
 * - **The top realm's setter:** a frame whose own `HTMLInputElement.prototype.value` setter is patched still gets the
 *   fill, and its page sees `input` and `change`.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

const ORIGIN = 'http://frames.test';
const OTHER = 'http://other.test';
let script = '';
/** The pages served, by path, for both origins. */
let pages: Record<string, string> = {};
test.beforeAll(async () => {
  script = await bundleAgent({ entry: join(import.meta.dirname, 'agent-entry.ts'), minify: false });
});
test.beforeEach(async ({ context }) => {
  pages = {};
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN && url.origin !== OTHER) return route.abort();
    const body = pages[url.pathname];
    return body === undefined ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
});

type Message = [string, Record<string, unknown>];
interface AgentTest {
  start(): void;
  fill(payload: unknown): void;
  messages(): Message[];
  clear(): void;
}
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Frames</title></head><body style="margin:0">${body}</body></html>`;
const SIGN_IN = (id = 'f') =>
  `<form id="${id}" onsubmit="return false"><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"><button id="go">Sign in</button></form>`;
/** A frame at `src`, 400 by 200, at a known place. */
const frame = (src: string, extra = '') => `<iframe id="fr" src="${src}" ${extra} style="position:absolute;left:50px;top:80px;width:400px;height:200px;border:3px solid #000;padding:5px"></iframe>`;

async function open(page: Page, top: string, more: Record<string, string> = {}) {
  pages = { '/page': html(top), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, html(v)])) };
  await page.goto(`${ORIGIN}/page`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.start());
  const a = api(page);
  await a.settle();
  return a;
}
const api = (page: Page) => ({
  clear: () => page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.clear()),
  of: async (channel: string) => (await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.messages())).filter(([c]) => c === channel).map(([, p]) => p),
  settle: () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150))))),
  fill: (formId: unknown) =>
    page.evaluate((p) => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.fill(p), {
      formId,
      username: 'ada@example.com',
      password: 'pw-one',
      highlight: { color: 'red', ms: 10, stagger: 0, easing: 'linear' },
    }),
});
/** The last `forms` report's form ids. */
const formIds = async (a: ReturnType<typeof api>) => ((await a.of('forms')).at(-1)?.['forms'] as { formId: string }[] | undefined)?.map((f) => f.formId) ?? [];

test('a same-origin frame’s sign-in: its focus in the tab’s pixels, its form in the one report, the fill, and the submit’s values', async ({ page }) => {
  const a = await open(page, `<h1>Top</h1>${frame('/login')}`, { '/login': `${SIGN_IN()}<script>for (const id of ['u', 'p']) for (const t of ['input', 'change']) document.getElementById(id).addEventListener(t, () => (window.seen = (window.seen || []).concat(id + ':' + t)));</script>` });
  const fr = page.frameLocator('#fr');
  await fr.locator('#p').click();
  await a.settle();
  const focus = (await a.of('focus')).at(-1)!;
  expect(focus).toMatchObject({ kind: 'sign-in', role: 'current-password' });
  // The field's box, offset by the frame's: its place, its 3 px border and its 5 px padding.
  const want = await page.evaluate(() => {
    const f = document.getElementById('fr') as HTMLIFrameElement;
    const r = f.getBoundingClientRect();
    const p = f.contentDocument!.getElementById('p')!.getBoundingClientRect();
    return { x: r.left + 3 + 5 + p.left, y: r.top + 3 + 5 + p.top, width: p.width, height: p.height };
  });
  expect(focus['rect']).toEqual(want);
  expect(await formIds(a)).toContain(focus['formId']);
  await a.fill(focus['formId']);
  await a.settle();
  expect((await a.of('filled')).at(-1)).toMatchObject({ ok: true });
  expect(await fr.locator('#u').inputValue()).toBe('ada@example.com');
  expect(await fr.locator('#p').inputValue()).toBe('pw-one');
  expect(await page.evaluate(() => (document.getElementById('fr') as HTMLIFrameElement & { contentWindow: { seen?: string[] } }).contentWindow.seen)).toEqual(['u:input', 'u:change', 'p:input', 'p:change']);
  await a.clear();
  await fr.locator('#p').fill('typed pass');
  await fr.locator('#p').press('Enter');
  await a.settle();
  const c = (await a.of('candidate')).find((x) => x['signal'] !== 'blur');
  expect(c).toMatchObject({ formId: focus['formId'], signal: 'enter', values: { username: 'ada@example.com', password: 'typed pass' } });
});

test('the frame’s page patched its own HTMLInputElement value setter: the fill still goes in, and the page sees input and change', async ({ page }) => {
  const a = await open(page, frame('/login'), {
    '/login': `${SIGN_IN()}<script>
      Object.defineProperty(HTMLInputElement.prototype, 'value', { set() { window.blocked = true; }, get() { return ''; }, configurable: true });
      for (const t of ['input', 'change']) document.getElementById('p').addEventListener(t, () => (window.seen = (window.seen || []).concat(t)));
    </script>`,
  });
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  await a.fill((await a.of('focus')).at(-1)!['formId']);
  await a.settle();
  expect((await a.of('filled')).at(-1)).toMatchObject({ ok: true });
  const seen = await page.evaluate(() => {
    const w = (document.getElementById('fr') as HTMLIFrameElement).contentWindow as unknown as { seen?: string[]; blocked?: boolean; document: Document };
    const p = w.document.getElementById('p')!;
    return { value: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(p)), 'value') ? 'patched' : '', seen: w.seen, blocked: !!w.blocked, real: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(p) };
  });
  expect(seen).toMatchObject({ seen: ['input', 'change'], blocked: false, real: 'pw-one' });
});

// Frames the agent never uses: nothing of theirs reaches main.
for (const [name, top, more] of [
  ['another site’s frame', frame(`${OTHER}/login`), { '/login': SIGN_IN() }],
  ['a sandboxed frame with allow-same-origin', frame('/login', 'sandbox="allow-same-origin allow-scripts allow-forms"'), { '/login': SIGN_IN() }],
  ['a sandboxed frame without it', frame('/login', 'sandbox="allow-scripts allow-forms"'), { '/login': SIGN_IN() }],
  ['a srcdoc frame', `<iframe id="fr" srcdoc='${SIGN_IN()}' style="width:400px;height:200px"></iframe>`, {}],
  ['an about:blank frame its page wrote a sign-in into', `<iframe id="fr" style="width:400px;height:200px"></iframe><script>document.getElementById('fr').contentDocument.body.innerHTML = '${SIGN_IN()}';</script>`, {}],
  ['a data: frame', `<iframe id="fr" src="data:text/html,${encodeURIComponent(SIGN_IN())}" style="width:400px;height:200px"></iframe>`, {}],
] as const) {
  test(`${name}: no form, no focus`, async ({ page }) => {
    const a = await open(page, `<h1>Top</h1>${top}`, more);
    await a.clear();
    await page.frameLocator('#fr').locator('#p').click();
    await page.frameLocator('#fr').locator('#p').fill('secret pass');
    await page.frameLocator('#fr').locator('#p').press('Enter');
    await a.settle();
    expect(await a.of('focus')).toEqual([]);
    expect(await a.of('candidate')).toEqual([]);
    expect(await formIds(a)).toEqual([]);
  });
}

/** Frames `n` deep: `/l1` holds `/l2`, and so on, the last holding the sign-in. */
const nested = (n: number) => {
  const more: Record<string, string> = {};
  for (let i = 1; i <= n; i++) more[`/l${i}`] = i === n ? SIGN_IN() : `<iframe id="fr" src="/l${i + 1}" style="width:420px;height:240px"></iframe>`;
  return more;
};
const deepField = (page: Page, n: number) => {
  let loc = page.frameLocator('#fr');
  for (let i = 1; i < n; i++) loc = loc.frameLocator('#fr');
  return loc.locator('#p');
};
for (const [n, used] of [
  [2, true],
  [3, true],
  [4, false],
] as const) {
  test(`a sign-in ${n} frames deep: ${used ? 'used' : 'past the 3 levels, never used'}`, async ({ page }) => {
    const a = await open(page, `<iframe id="fr" src="/l1" style="width:440px;height:260px"></iframe>`, nested(n));
    await deepField(page, n).click();
    await a.settle();
    expect((await a.of('focus')).length > 0).toBe(used);
    if (used) {
      await a.fill((await a.of('focus')).at(-1)!['formId']);
      await a.settle();
      expect((await a.of('filled')).at(-1)).toMatchObject({ ok: true });
      expect(await deepField(page, n).inputValue()).toBe('pw-one');
    }
  });
}

test('21 frames: the first 20 are used, the 21st never', async ({ page }) => {
  const frames = Array.from({ length: 21 }, (_, i) => `<iframe id="fr${i}" src="/login" style="width:300px;height:120px"></iframe>`).join('');
  const a = await open(page, frames, { '/login': SIGN_IN() });
  await page.frameLocator('#fr19').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toHaveLength(1);
  await a.clear();
  await page.frameLocator('#fr20').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
});

test('a frame added after the agent started, and a frame that navigates to another page of the site: both used', async ({ page }) => {
  const a = await open(page, '<h1>Top</h1>', { '/login': SIGN_IN(), '/login2': SIGN_IN('g') });
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<iframe id="fr" src="/login" style="width:400px;height:200px"></iframe>'));
  await page.frameLocator('#fr').locator('#p').waitFor();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  const first = (await a.of('focus')).at(-1)!['formId'];
  expect(first).toBeTruthy();
  await page.evaluate(() => ((document.getElementById('fr') as HTMLIFrameElement).src = '/login2'));
  await page.frameLocator('#fr').locator('form#g #p').waitFor();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  const second = (await a.of('focus')).at(-1)!['formId'];
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  // The old page's form is gone from the report; the new one's is in it.
  const ids = await formIds(a);
  expect(ids).toContain(second);
  expect(ids).not.toContain(first);
});

test('a formless sign-in in a frame: its button submits, with the values', async ({ page }) => {
  const a = await open(page, frame('/login'), {
    '/login': '<div><input id="u" name="email" type="email" aria-label="Email"><input id="p" name="password" type="password" aria-label="Password"><button id="go" type="button">Sign in</button></div>',
  });
  const fr = page.frameLocator('#fr');
  await fr.locator('#u').fill('ada@example.com');
  await fr.locator('#p').fill('secret pass');
  await a.clear();
  await fr.locator('#go').click();
  await a.settle();
  expect((await a.of('candidate')).find((c) => c['signal'] === 'button')).toMatchObject({ values: { username: 'ada@example.com', password: 'secret pass' } });
});

test('focus moves from the top’s field into a frame’s: the frame’s focus is the last word, no stray blur after it', async ({ page }) => {
  const a = await open(page, `${SIGN_IN('top')}${frame('/login')}`, { '/login': SIGN_IN() });
  await page.locator('#top #p').click();
  await a.settle();
  await a.clear();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  const last = (await page.evaluate(() => (globalThis as unknown as { chordAgentTest: AgentTest }).chordAgentTest.messages())).filter(([c]) => c === 'focus' || c === 'blur').at(-1);
  expect(last?.[0]).toBe('focus');
});

// Re-checked at every use.
test('the frame is given a sandbox attribute between focus and submit: no candidate', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  const fr = page.frameLocator('#fr');
  await fr.locator('#p').fill('secret pass');
  await page.evaluate(() => document.getElementById('fr')!.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms'));
  await a.clear();
  await fr.locator('#p').press('Enter');
  await a.settle();
  expect(await a.of('candidate')).toEqual([]);
});

test('the frame goes to another site between the menu and the fill: nothing is written there', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  pages['/away'] = html(SIGN_IN());
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  const formId = (await a.of('focus')).at(-1)!['formId'];
  await page.evaluate((src) => ((document.getElementById('fr') as HTMLIFrameElement).src = src), `${OTHER}/away`);
  await page.waitForTimeout(500);
  await a.clear();
  await a.fill(formId);
  await a.settle();
  expect((await a.of('filled')).at(-1)).toMatchObject({ ok: false });
  expect(await page.frameLocator('#fr').locator('#p').inputValue()).toBe('');
});

test('the frame navigates after its sign-in’s submit: the watch says gone, as for the top document', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': SIGN_IN(), '/welcome': '<p>Welcome</p>' });
  const fr = page.frameLocator('#fr');
  await fr.locator('#u').fill('ada@example.com');
  await fr.locator('#p').fill('secret pass');
  await a.clear();
  await fr.locator('#p').press('Enter');
  await a.settle();
  await page.evaluate(() => ((document.getElementById('fr') as HTMLIFrameElement).src = '/welcome'));
  await expect.poll(() => a.of('gone'), { timeout: 8000 }).toHaveLength(1);
});

test('30 other sites’ ad frames beside the top’s sign-in: nothing of theirs, and the top’s form works', async ({ page }) => {
  const ads = Array.from({ length: 30 }, (_, i) => `<iframe src="${OTHER}/ad${i % 3}" style="width:100px;height:50px"></iframe>`).join('');
  const a = await open(page, `${SIGN_IN()}${ads}`, { '/ad0': SIGN_IN(), '/ad1': '<p>Ad</p>', '/ad2': '<p>Ad</p>' });
  await page.locator('#p').click();
  await a.settle();
  expect(await formIds(a)).toHaveLength(1);
  expect((await a.of('focus')).at(-1)).toMatchObject({ kind: 'sign-in' });
});
