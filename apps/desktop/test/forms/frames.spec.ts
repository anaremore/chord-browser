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
let recorder = '';
/** The pages served, by path, for both origins. */
let pages: Record<string, string> = {};
/** Response headers by path (a CSP `sandbox`). */
let headers: Record<string, Record<string, string>> = {};
test.beforeAll(async () => {
  script = await bundleAgent({ entry: join(import.meta.dirname, 'agent-entry.ts'), minify: false });
  recorder = await bundleAgent({ entry: join(import.meta.dirname, 'sandbox-recorder.ts'), minify: true });
});
test.beforeEach(async ({ context }) => {
  pages = {};
  headers = {};
  // The sentinel's sandbox record, from each document's start, as the preload keeps it.
  await context.addInitScript({ content: recorder });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN && url.origin !== OTHER) return route.abort();
    const body = pages[url.pathname];
    return body === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: headers[url.pathname] ?? {}, body });
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
/**
 * Frames `n` deep, each added once the frame above it is in use (its agent watches its own frames from then): `/l1`
 * is in the page, and each level's frame is added by script into the one above, the last holding the sign-in.
 */
const deepField = (page: Page, n: number) => {
  let loc = page.frameLocator('#fr');
  for (let i = 1; i < n; i++) loc = loc.frameLocator('#fr');
  return loc.locator('#p');
};
const addNested = async (page: Page, n: number) => {
  for (let level = 1; level < n; level++) {
    // The frame at `level`, once its agent runs (a look 50 ms after its load), gets the next frame.
    await page.waitForTimeout(150);
    const parent = page.frames().find((f) => f.url().endsWith(`/l${level}`))!;
    await parent.evaluate(
      (next) =>
        new Promise<void>((done) => {
          document.body.insertAdjacentHTML('beforeend', `<iframe id="fr" src="/l${next}" style="width:420px;height:240px"></iframe>`);
          document.getElementById('fr')!.addEventListener('load', () => done(), { once: true });
        }),
      level + 1,
    );
  }
  await page.waitForTimeout(150);
};
const levels = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/l${i + 1}`, i + 1 === n ? SIGN_IN() : '<p>A level</p>']));
for (const [n, used] of [
  [2, true],
  [3, true],
  [4, false],
] as const) {
  test(`a sign-in ${n} frames deep, each frame added once the one above is in use: ${used ? 'used' : 'past the 3 levels, never used'}`, async ({ page }) => {
    const a = await open(page, `<iframe id="fr" src="/l1" style="width:440px;height:260px"></iframe>`, levels(n));
    await addNested(page, n);
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

test('a frame inside a frame that loaded before the agent woke (its history unwatched): never used, the frame above is', async ({ page }) => {
  const a = await open(page, `<iframe id="fr" src="/l1" style="width:440px;height:260px"></iframe>`, {
    '/l1': `${SIGN_IN('outer')}<iframe id="fr" src="/l2" style="width:420px;height:240px"></iframe>`,
    '/l2': SIGN_IN(),
  });
  await deepField(page, 2).click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
  await page.frameLocator('#fr').locator('#outer #p').click();
  await a.settle();
  expect(await a.of('focus')).toHaveLength(1);
});

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
  // The frame's agent starts once its frame has loaded (a look 50 ms after), and sends the focus it finds then.
  await expect.poll(async () => (await a.of('focus')).length).toBeGreaterThan(0);
  const first = (await a.of('focus')).at(-1)!['formId'];
  expect(first).toBeTruthy();
  await page.evaluate(() => ((document.getElementById('fr') as HTMLIFrameElement).src = '/login2'));
  await page.frameLocator('#fr').locator('form#g #p').waitFor();
  await page.frameLocator('#fr').locator('#p').click();
  await expect.poll(async () => (await a.of('focus')).filter((f) => f['formId'] !== first).length).toBeGreaterThan(0);
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

/* ---------- Review round 1 of #67 ---------- */

/** What the frames' hub holds (agent-entry.ts). */
const hubStats = (page: Page) => page.evaluate(() => (globalThis as unknown as { chordAgentTest: { frames(): { agents: number; forms: number; fills: number; owners: number } } }).chordAgentTest.frames());
/** Loads frames at the top, one at a time, waiting for each: `where` is `afterbegin` or `beforeend`. */
const addFrames = async (page: Page, from: number, to: number, where: 'afterbegin' | 'beforeend') => {
  for (let i = from; i < to; i++) {
    await page.evaluate(([n, at]) => {
      document.body.insertAdjacentHTML(at as InsertPosition, `<iframe id="fr${n}" src="/login?${n}" style="width:300px;height:120px"></iframe>`);
      return new Promise<void>((done) => document.getElementById(`fr${n}`)!.addEventListener('load', () => done(), { once: true }));
    }, [i, where] as const);
  }
  await page.waitForTimeout(200);
};

test('B1: 20 frames used, then 10 more added before them: they keep their slots, the new ones are skipped', async ({ page }) => {
  const a = await open(page, '<h1>Top</h1>', { '/login': SIGN_IN() });
  await addFrames(page, 0, 20, 'beforeend');
  expect((await hubStats(page))?.agents).toBe(20);
  await addFrames(page, 20, 30, 'afterbegin');
  await a.settle();
  expect((await hubStats(page))?.agents).toBe(20);
  // A frame added past 20 is never used; one of the first 20 still is.
  await a.clear();
  await page.frameLocator('#fr25').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
  await page.frameLocator('#fr5').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toHaveLength(1);
});

test('B2: an about:blank frame written with document.open() (its address becomes the page’s): never used', async ({ page }) => {
  const a = await open(
    page,
    `<iframe id="fr" style="width:400px;height:200px"></iframe><script>
      const d = document.getElementById('fr').contentDocument;
      d.open();
      d.write('${SIGN_IN()}');
      d.close();
    </script>`,
  );
  // The test's premise: the written document has the page's address.
  expect(await page.evaluate(() => (document.getElementById('fr') as HTMLIFrameElement).contentDocument!.URL)).toBe(`${ORIGIN}/page`);
  await a.clear();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
  expect(await formIds(a)).toEqual([]);
});

test('B3: a frame loaded sandboxed, its attribute then removed (the flags stay till it navigates), and another frame loading: never used', async ({ page }) => {
  const a = await open(page, frame('/login', 'sandbox="allow-same-origin allow-scripts allow-forms"'), { '/login': SIGN_IN(), '/other': '<p>Other</p>' });
  await page.evaluate(() => document.getElementById('fr')!.removeAttribute('sandbox'));
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<iframe id="other" src="/other"></iframe>');
    return new Promise<void>((done) => document.getElementById('other')!.addEventListener('load', () => done(), { once: true }));
  });
  await page.waitForTimeout(200);
  await a.clear();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
});

test('B4: a frame reloaded within the site 10 times, then removed: its listeners, agents, forms and fills all go', async ({ page }) => {
  // Counted on the top's document and window, from before the agent starts.
  await page.addInitScript(() => {
    const counts = { scroll: 0, resize: 0 };
    (globalThis as unknown as { listenerCounts: typeof counts }).listenerCounts = counts;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const key = (target: EventTarget, type: string) => (target === document && type === 'scroll' ? 'scroll' : target === window && type === 'resize' ? 'resize' : null);
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      const k = key(this, type);
      if (k) counts[k]++;
      return add.call(this, type, ...(rest as [EventListener]));
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      const k = key(this, type);
      if (k) counts[k]--;
      return remove.call(this, type, ...(rest as [EventListener]));
    };
  });
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  const counts = () => page.evaluate(() => ({ ...(globalThis as unknown as { listenerCounts: { scroll: number; resize: number } }).listenerCounts }));
  await page.frameLocator('#fr').locator('#p').waitFor();
  const withOne = await counts();
  for (let i = 0; i < 10; i++) {
    await page.evaluate((n) => {
      const f = document.getElementById('fr') as HTMLIFrameElement;
      f.src = `/login?${n}`;
      return new Promise<void>((done) => f.addEventListener('load', () => done(), { once: true }));
    }, i);
  }
  await page.waitForTimeout(200);
  expect(await counts()).toEqual(withOne);
  expect((await hubStats(page))?.agents).toBe(1);
  await page.evaluate(() => document.getElementById('fr')!.remove());
  await page.waitForTimeout(200);
  await a.settle();
  // The top's own agent's listeners only, and nothing of the frame's in the hub.
  const left = await counts();
  expect(left.scroll).toBe(withOne.scroll - 1);
  expect(left.resize).toBe(withOne.resize - 1);
  expect(await hubStats(page)).toMatchObject({ agents: 0, fills: 1 });
  expect(await formIds(a)).toEqual([]);
});

test('a frame scaled by a CSS transform: the focus box is where the field is drawn', async ({ page }) => {
  const a = await open(page, frame('/login', 'class="half"') + '<style>.half { transform: scale(0.5); transform-origin: 0 0; }</style>', { '/login': SIGN_IN() });
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  const rect = (await a.of('focus')).at(-1)!['rect'] as { x: number; y: number; width: number; height: number };
  const want = await page.evaluate(() => {
    const f = document.getElementById('fr') as HTMLIFrameElement;
    const r = f.getBoundingClientRect();
    const s = r.width / f.offsetWidth;
    const p = f.contentDocument!.getElementById('p')!.getBoundingClientRect();
    return { x: r.left + (3 + 5) * s + p.left * s, y: r.top + (3 + 5) * s + p.top * s, width: p.width * s, height: p.height * s };
  });
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(rect[k]).toBeCloseTo(want[k], 1);
});

/* ---------- Review round 2 of #67: provenance fixed when the document was made ---------- */

/** No focus, no form and no fill from the frame `#fr`'s field: the frame isn't used. */
const notUsed = async (page: Page, a: ReturnType<typeof api>) => {
  await a.clear();
  await page.frameLocator('#fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
  expect(await formIds(a)).toEqual([]);
};
const FORM = `'<form><input id="p" name="password" type="password" aria-label="Password"></form>'`;

test('P2f: a frame on a real page, then sent to a javascript: URL by its src (same address, no response): never used', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  await page.evaluate((form) => ((document.getElementById('fr') as HTMLIFrameElement).src = `javascript:${form}`), FORM);
  await page.waitForTimeout(300);
  // The premise: the address is still the real page's.
  expect(await page.evaluate(() => (document.getElementById('fr') as HTMLIFrameElement).contentDocument!.URL)).toBe(`${ORIGIN}/login`);
  await notUsed(page, a);
});

test('P2f by location: the frame’s window sent to a javascript: URL: never used', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  await page.evaluate((form) => void ((document.getElementById('fr') as HTMLIFrameElement).contentWindow!.location.href = `javascript:${form}`), FORM);
  await page.waitForTimeout(300);
  await notUsed(page, a);
});

test('P2g: a real page, rewritten by the top with document.open() before the agent wakes: never used', async ({ page }) => {
  pages = { '/login': html('<p>Real</p>') };
  const a = await open(
    page,
    `${frame('/login')}<script>
      document.getElementById('fr').addEventListener('load', () => {
        const d = document.getElementById('fr').contentDocument;
        d.open();
        d.write('${SIGN_IN()}');
        d.close();
      }, { once: true });
    </script>`,
    { '/login': '<p>Real</p>' },
  );
  await page.waitForTimeout(200);
  await notUsed(page, a);
});

test('nit 4: a frame in use, rewritten with document.open() (by the top, and by itself): released, its form leaves the report', async ({ page }) => {
  for (const by of ['top', 'self'] as const) {
    const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
    await page.frameLocator('#fr').locator('#p').click();
    await a.settle();
    const theirs = (await formIds(a))[0];
    expect(theirs).toBeTruthy();
    await page.evaluate((who) => {
      const f = document.getElementById('fr') as HTMLIFrameElement;
      const d = f.contentDocument!;
      const w = f.contentWindow as Window & { eval(code: string): unknown };
      if (who === 'top') {
        d.open();
        d.write('<p>Gone</p>');
        d.close();
      } else w.eval("document.open(); document.write('<p>Gone</p>'); document.close();");
    }, by);
    await page.waitForTimeout(300);
    // Released at once (its document's children changed), before any look at the frames.
    expect((await hubStats(page))?.agents).toBe(0);
    // The page's next report (the top's form, here none) is made without the frame's.
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input id="poke" name="email" type="email">'));
    await page.locator('#poke').click();
    await a.settle();
    expect(await formIds(a)).not.toContain(theirs);
    expect((await hubStats(page))?.agents).toBe(0);
  }
});

test('P3a: a frame loaded sandboxed, its attribute removed at its load, before the agent wakes: never used', async ({ page }) => {
  const a = await open(page, `<iframe id="fr" src="/login" sandbox="allow-same-origin allow-scripts allow-forms" onload="this.removeAttribute('sandbox')" style="width:400px;height:200px"></iframe>`, { '/login': SIGN_IN() });
  await notUsed(page, a);
});

test('P3b: a frame inserted with a sandbox attribute, removed in the same task while the agent runs: never used', async ({ page }) => {
  const a = await open(page, '<h1>Top</h1>', { '/login': SIGN_IN() });
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        document.body.insertAdjacentHTML('beforeend', '<iframe id="fr" src="/login" sandbox="allow-same-origin allow-scripts allow-forms" style="width:400px;height:200px"></iframe>');
        const f = document.getElementById('fr')!;
        f.removeAttribute('sandbox');
        f.addEventListener('load', () => done(), { once: true });
      }),
  );
  await page.waitForTimeout(200);
  await notUsed(page, a);
});

test('a frame sandboxed by a CSP header without allow-same-origin (its window’s origin opaque): never used', async ({ page }) => {
  headers['/login'] = { 'content-security-policy': 'sandbox allow-scripts allow-forms' };
  const a = await open(page, frame('/login'), { '/login': SIGN_IN() });
  await notUsed(page, a);
});

test('a frame whose page called history.pushState (its address no longer the navigation’s): refused, failing closed', async ({ page }) => {
  const a = await open(page, frame('/login'), { '/login': `${SIGN_IN()}<script>history.pushState({}, '', '/login/step-2');</script>` });
  await notUsed(page, a);
});

test('a frame inside an open shadow root (no record of its attribute): never used', async ({ page }) => {
  const a = await open(page, `<x-shell id="shell"></x-shell><script>document.getElementById('shell').attachShadow({ mode: 'open' }).innerHTML = '<iframe id="fr" src="/login" style="width:400px;height:200px"></iframe>';</script>`, {
    '/login': SIGN_IN(),
  });
  await a.clear();
  await page.locator('#shell >> #fr').waitFor();
  await page.frameLocator('#shell >> #fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
});

for (const [name, style] of [
  ['a CSS zoom', 'zoom: 2'],
  ['a rotation', 'transform: rotate(10deg)'],
  ['a skew', 'transform: skewX(10deg)'],
  ['a rotation on its parent', ''],
] as const) {
  test(`a frame under ${name}: no focus box (no menu in the wrong place)`, async ({ page }) => {
    const top = style ? `<style>#fr { ${style}; }</style>${frame('/login')}` : `<div style="rotate: 5deg">${frame('/login')}</div>`;
    const a = await open(page, top, { '/login': SIGN_IN() });
    await a.clear();
    await page.frameLocator('#fr').locator('#p').click({ force: true });
    await a.settle();
    expect(await a.of('focus')).toEqual([]);
  });
}

/* ---------- Review round 3 of #67: a document its watcher didn't see from its start gets nothing ---------- */

const SANDBOX = 'allow-same-origin allow-scripts allow-forms';
/** Moves `f` into `to` keeping its window (`moveBefore`), or says the browser has no `moveBefore`. */
const MOVE = `(f, to) => (typeof to.moveBefore === 'function' ? (to.moveBefore(f, null), true) : false)`;

for (const sandboxed of [true, false]) {
  test(`BL1: a frame loaded in an open shadow root${sandboxed ? ', sandboxed, its attribute removed there' : ' (no sandbox)'}, then moved into the page’s tree with moveBefore: never used`, async ({ page }) => {
    const a = await open(
      page,
      `<x-shell id="shell"></x-shell><div id="dst"></div><script>
        const root = document.getElementById('shell').attachShadow({ mode: 'open' });
        root.innerHTML = '<iframe id="fr" src="/login" ${sandboxed ? `sandbox="${SANDBOX}"` : ''} style="width:400px;height:200px"></iframe>';
        const f = root.getElementById('fr');
        f.addEventListener('load', () => {
          f.removeAttribute('sandbox');
          window.moved = (${MOVE})(f, document.getElementById('dst'));
        }, { once: true });
      </script>`,
      { '/login': SIGN_IN() },
    );
    test.skip(!(await page.evaluate(() => (window as unknown as { moved?: boolean }).moved)), 'this Chromium has no moveBefore');
    // The premise: in the page's tree now, no attribute, the same window.
    expect(await page.evaluate(() => !!document.querySelector('#dst > #fr') && !document.getElementById('fr')!.hasAttribute('sandbox'))).toBe(true);
    await notUsed(page, a);
  });
}

test('BL1 nested (X18): in a frame in use, a frame loaded in a shadow root, sandboxed, its attribute removed there, moved into the frame’s tree: never used', async ({ page }) => {
  const a = await open(page, `<iframe id="l1" src="/l1" style="width:440px;height:260px"></iframe>`, { '/l1': '<div id="dst"></div>', '/l1-poke': '<p>.</p>', '/login': SIGN_IN() });
  await page.waitForTimeout(200);
  const outer = page.frames().find((f) => f.url().endsWith('/l1'))!;
  const moved = await outer.evaluate(
    ([sandbox, move]) =>
      new Promise<boolean>((done) => {
        const host = document.createElement('x-shell');
        document.body.append(host);
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<iframe id="fr" src="/login" sandbox="${sandbox}" style="width:400px;height:200px"></iframe>`;
        const f = root.getElementById('fr')!;
        f.addEventListener(
          'load',
          () => {
            f.removeAttribute('sandbox');
            done((eval(move) as (f: Element, to: Element) => boolean)(f, document.getElementById('dst')!));
          },
          { once: true },
        );
      }),
    [SANDBOX, MOVE] as const,
  );
  test.skip(!moved, 'this Chromium has no moveBefore');
  // Another frame loading in /l1's own tree: a look at the frames, which now finds the moved one.
  await outer.evaluate(
    () =>
      new Promise<void>((done) => {
        document.body.insertAdjacentHTML('beforeend', '<iframe id="poke" src="/l1-poke"></iframe>');
        document.getElementById('poke')!.addEventListener('load', () => done(), { once: true });
      }),
  );
  await page.waitForTimeout(200);
  await a.clear();
  await page.frameLocator('#l1').frameLocator('#fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
});

test('BL2: a frame’s 101st frame, loaded sandboxed and its attribute removed at its load, before the agent woke: never used', async ({ page }) => {
  // Another site's fillers: none of them takes one of the 20 slots, and all of them count toward a look's 100.
  const fillers = `<iframe src="${OTHER}/filler" style="width:20px;height:20px"></iframe>`.repeat(100);
  const a = await open(page, `<iframe id="l1" src="/l1" style="width:440px;height:600px"></iframe>`, {
    '/l1': `${fillers}<iframe id="fr" src="/login" sandbox="${SANDBOX}" onload="this.removeAttribute('sandbox')" style="width:400px;height:200px"></iframe>`,
    '/filler': '<p>.</p>',
    '/l1-poke': '<p>.</p>',
    '/login': SIGN_IN(),
  });
  // The fillers go, and a frame of the site loads in /l1's own tree: the next look reaches the 101st frame, which loaded
  // before the frame's agent was watching.
  await page.waitForTimeout(200);
  await page.frames().find((f) => f.url().endsWith('/l1'))!.evaluate(
    () =>
      new Promise<void>((done) => {
        for (const f of [...document.querySelectorAll('iframe:not(#fr)')]) f.remove();
        document.body.insertAdjacentHTML('beforeend', '<iframe id="poke" src="/l1-poke"></iframe>');
        document.getElementById('poke')!.addEventListener('load', () => done(), { once: true });
      }),
  );
  await page.waitForTimeout(300);
  await a.clear();
  await page.frameLocator('#l1').frameLocator('#fr').locator('#p').click();
  await a.settle();
  expect(await a.of('focus')).toEqual([]);
});
