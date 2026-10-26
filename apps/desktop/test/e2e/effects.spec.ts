/**
 * Effects (DESIGN.md §7.15, ARCHITECTURE.md §9), end to end: your own CSS, an
 * element hidden with the picker, a preset, Dry/Wet for the site and for every
 * site, a navigation, an unsafe patch stripped (a server that counts requests
 * must never hear from Chord), Ask Duet with the fake Claude Code
 * (fake-claude.mjs) writing two patches, each item switched off and on, a
 * patch and a hidden element edited, a reload and a relaunch, and a private
 * window that keeps nothing; the card captured in light and dark. Then the
 * cost of applying Effects on a heavy page, measured and printed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { audit, capturesDir, dispatch, expectClean, fakeClaude, isOverlay, isPopover, isShell, launch, newPage, pageWhere, runAction, startSite, where, type Finding, type Site } from './a11y-kit';
import { framesOf, longestTask, trace } from './frames';
import { failOnMainErrors } from './main-errors';

failOnMainErrors();

const NEWS = (title: string) =>
  `<title>${title}</title><style>body { margin: 0; font: 16px sans-serif } #masthead { position: sticky; top: 0; height: 60px; background: rgb(200, 200, 200) }` +
  ' main { width: 480px; padding: 20px } #sidebar { position: absolute; left: 560px; top: 100px; width: 200px; height: 300px; background: rgb(40, 40, 220) }' +
  ' #consent { position: fixed; left: 0; right: 0; bottom: 0; height: 80px; background: rgb(250, 250, 200) }</style>' +
  '<header id="masthead">Masthead</header><main><h1>Headline</h1><p>Body text.</p><form><input id="secret" value="hunter2-effects"></form><aside id="promo">Promo</aside></main>' +
  '<aside id="sidebar">Sidebar</aside><div id="consent" class="cookie-banner">We use cookies</div>';

/** A page with about 24,000 elements, for what applying Effects costs. */
const HEAVY =
  '<title>Heavy</title><style>.card { padding: 8px; border-bottom: 1px solid rgb(220, 220, 220) } .card h2 { font-size: 18px }</style>' +
  Array.from({ length: 3000 }, (_, i) => `<div class="card c${i % 7}"><h2>Story ${i}</h2><p>Some text for story ${i}, long enough to wrap a little.</p><ul><li>one</li><li>two</li><li>three</li></ul><a href="#s${i}">More</a></div>`).join('');

let site: Site;
/** Stands in for anything a stylesheet could fetch: it counts every request it gets. */
let evil: { server: Server; url: string; hits: string[] };
test.beforeAll(async () => {
  site = await startSite({ '/news': NEWS('News'), '/news/2': NEWS('News 2'), '/heavy': HEAVY });
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  evil = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
});
test.afterAll(() => {
  site.server.close();
  evil.server.close();
});

const host = () => new URL(site.origin).host;

/** The tab page at this address (a private window's has its own). */
const pageAt = (app: ElectronApplication, url: string) => pageWhere(app, (u) => u === url);

const style = (page: Page, selector: string, property: string) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s)!).getPropertyValue(p), [selector, property] as const);

/** Your CSS's field (its switch is named for it too). */
const yourCss = (card: Locator) => card.getByRole('textbox', { name: 'Your CSS' });

/** The card as it looks at rest, into test-results/captures; from its top unless it's showing an editor. */
async function capture(card: Locator, name: string, fromTop = true): Promise<void> {
  if (fromTop) await card.evaluate((el) => el.lastElementChild!.scrollTo(0, 0));
  await card.screenshot({ path: join(capturesDir, `${name}.png`), animations: 'disabled' });
}

async function openCard(shell: Page, popover: Page): Promise<Locator> {
  await runAction(shell, 'effects.open');
  const card = popover.getByRole('dialog', { name: `Effects on ${host()}` });
  await expect(card).toBeVisible();
  return card;
}

async function navigate(shell: Page, url: string): Promise<void> {
  const { tabId } = await where(shell);
  await dispatch(shell, { t: 'tab.navigate', nodeId: tabId, url });
}

const sessionFiles = (config: string) => {
  const projects = join(config, 'projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).flatMap((dir) => readdirSync(join(projects, dir)).filter((f) => f.endsWith('.jsonl')));
};

test('Effects: your CSS, a hidden element, a preset, Dry/Wet, navigating, an unsafe patch, Ask Duet, each one switched and edited, reloading and relaunching, and a private window that keeps nothing', async () => {
  test.setTimeout(300_000);
  const profile = mkdtempSync(join(tmpdir(), 'chord-e2e-'));
  const config = mkdtempSync(join(tmpdir(), 'chord-claude-'));
  const env = {
    CHORD_HOME_URL: `${site.origin}/news`,
    CHORD_DUET_CLAUDE: fakeClaude,
    CHORD_DUET_CODEX: join(config, 'no-codex'),
    CLAUDE_CONFIG_DIR: config,
    FAKE_CLAUDE_EVIL: evil.url,
  };
  // Light first; the relaunch comes back dark, so the card is captured and audited in both.
  let app = await launch({ ...env, CHORD_APPEARANCE: 'light' }, { profile });
  mkdirSync(capturesDir, { recursive: true });
  const findings: Finding[] = [];
  try {
    let shell = await pageWhere(app, isShell);
    let popover = await pageWhere(app, isPopover);
    const overlay = await pageWhere(app, isOverlay);
    let news = await pageAt(app, `${site.origin}/news`);
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 0, 0)');
    // No Effects yet: nothing beside the address.
    await expect(shell.getByRole('button', { name: /^Effects:/ })).toHaveCount(0);

    // Your CSS applies as you type; what would fetch is left out, and the card says so.
    let card = await openCard(shell, popover);
    await yourCss(card).fill(`main h1 { color: rgb(255, 0, 0) }\nbody { background-image: url(${evil.url}/typed.png) }\n@import url(${evil.url}/typed.css);`);
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    await expect(card).toContainText('Left out url() on line 2, @import on line 3. Effects never load files.');
    expect(await style(news, 'body', 'background-image')).toBe('none');
    await expect(shell.getByRole('button', { name: 'Effects: wet' })).toBeVisible();

    // Its own switch: off, the page as it was, your CSS kept; on, back.
    const own = card.getByRole('switch', { name: 'Use your CSS' });
    await own.click();
    await expect(own).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 0, 0)');
    await expect(yourCss(card)).toHaveValue(/rgb\(255, 0, 0\)/);
    await expect(shell.getByRole('button', { name: 'Effects: wet' })).toBeVisible();
    await own.press('Space');
    await expect(own).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');

    // Hide an element: the card steps aside for the picker, a click hides what's under the pointer, Done brings it back.
    await card.getByRole('button', { name: 'Hide an element…' }).click();
    await expect(card).toHaveCount(0);
    const picker = overlay.getByRole('dialog', { name: `Hide elements on ${host()}` });
    await expect(picker).toBeVisible();
    const pane = await overlay.evaluate((name) => document.querySelector(`[role="dialog"][aria-label="${name}"] > div`)!.getBoundingClientRect().toJSON() as DOMRect, `Hide elements on ${host()}`);
    await overlay.mouse.move(pane.x + 660, pane.y + 250);
    await expect(picker).toContainText('aside#sidebar');
    await overlay.mouse.click(pane.x + 660, pane.y + 250);
    await expect.poll(() => style(news, '#sidebar', 'display')).toBe('none');
    await expect(picker).toContainText('1 hidden');
    await overlay.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(shell.getByRole('region', { name: 'Notifications' })).toContainText(`Hid an element on ${host()}`);
    card = popover.getByRole('dialog', { name: `Effects on ${host()}` });
    await expect(card).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'aside#sidebar' })).toBeVisible();

    // A preset: sticky bars stop sticking and the cookie banner goes.
    await card.getByRole('button', { name: 'No sticky bars' }).click();
    await expect(card.getByRole('button', { name: 'No sticky bars' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => style(news, '#consent', 'display')).toBe('none');
    expect(await style(news, '#masthead', 'position')).toBe('relative');

    // Dry: the site as it comes, everything kept; Wet: back.
    await card.getByRole('radio', { name: 'Dry' }).click();
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 0, 0)');
    expect(await style(news, '#sidebar', 'display')).toBe('block');
    await expect(shell.getByRole('button', { name: 'Effects: dry' })).toBeVisible();
    await card.getByRole('radio', { name: 'Wet' }).click();
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');

    // Dry everywhere (the command bar's action), and wet again from the card.
    await runAction(shell, 'effects.everywhere');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 0, 0)');
    await expect(card).toContainText('Every site is dry.');
    await card.getByRole('button', { name: 'Make every site wet' }).click();
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');

    // Another page on the site gets them on its first paint; another site doesn't.
    await card.getByRole('button', { name: 'Close Effects' }).click();
    await navigate(shell, `${site.origin}/news/2`);
    const second = await pageAt(app, `${site.origin}/news/2`);
    await expect.poll(() => style(second, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    expect(await style(second, '#sidebar', 'display')).toBe('none');
    await navigate(shell, `${site.other}/news`);
    const other = await pageAt(app, `${site.other}/news`);
    await expect.poll(() => other.title()).toBe('News');
    expect(await style(other, 'h1', 'color')).toBe('rgb(0, 0, 0)');
    await expect(shell.getByRole('button', { name: /^Effects:/ })).toHaveCount(0);

    // Ask Duet: set up with the fake Claude Code, which reads the outline and answers with a patch that tries a fetch.
    await navigate(shell, `${site.origin}/news`);
    news = await pageAt(app, `${site.origin}/news`);
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    await runAction(shell, 'duet.toggle');
    const panel = shell.getByRole('complementary', { name: 'Duet' });
    await panel.getByRole('button', { name: 'Use this' }).first().click();
    await panel.getByRole('button', { name: 'Got it' }).click();
    await runAction(shell, 'duet.toggle');
    card = await openCard(shell, popover);
    const ask = card.getByRole('textbox', { name: 'Ask Duet to restyle this site' });
    await ask.fill('Make the headline green');
    await ask.press('Enter');
    await expect(card.getByRole('listitem').filter({ hasText: 'Green headline' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 128, 0)');
    await expect(card).toContainText('Chord left out url() on line 1 from Duet’s patch.');
    // What Duet got: the page's outline as an untrusted tool result, never a form field's value.
    const outline = JSON.parse(readFileSync(join(config, 'effects-outline.json'), 'utf8')) as { trust: string; outline: string; current_effects_css: string };
    expect(outline.trust).toBe('untrusted');
    expect(outline.outline).toContain('header#masthead');
    expect(outline.outline).toContain('"Headline"');
    expect(outline.outline).toContain('input#secret[type=text]');
    // What's hidden (the sidebar, by your Effects) isn't in it.
    expect(outline.outline).not.toContain('aside#sidebar');
    expect(JSON.stringify(outline)).not.toContain('hunter2-effects');
    expect(outline.current_effects_css).toContain('rgb(255, 0, 0)');
    // Nothing of the request stays with the provider.
    await expect.poll(() => sessionFiles(config)).toEqual([]);

    // A second patch, whose long name the row cuts short, with all of it in the tooltip.
    await ask.fill('Mario Bros theme, please');
    await ask.press('Enter');
    const mario = card.getByRole('listitem').filter({ hasText: 'Mario Bros theme' });
    await expect(mario).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => style(news, 'body', 'background-color')).toBe('rgb(92, 148, 252)');
    expect(await style(news, 'h1', 'color')).toBe('rgb(0, 128, 0)');
    const marioName = mario.getByText(/^Mario Bros theme/);
    expect(await marioName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(marioName).toHaveAttribute('title', 'Mario Bros theme: a sky-blue page, with white paragraphs and blocky headings\nYou asked: Mario Bros theme, please');
    await expect.poll(() => sessionFiles(config)).toEqual([]);
    await capture(card, 'effects-card-long-name-light');

    // Each patch has its own switch: Green headline off, and the headline is your CSS's red again; on, green. The other stays.
    const green = card.getByRole('switch', { name: 'Use “Green headline”' });
    await green.click();
    await expect(green).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    expect(await style(news, 'body', 'background-color')).toBe('rgb(92, 148, 252)');
    await green.click();
    await expect(green).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(0, 128, 0)');

    // The other edited: renamed, its CSS changed as you type, the page following; what would fetch is left out, and said.
    await card.getByRole('button', { name: /^Edit “Mario Bros theme/ }).click();
    const editor = card.getByRole('group', { name: /^Editing / });
    const editorName = editor.getByRole('textbox', { name: 'Name' });
    const editorCss = editor.getByRole('textbox', { name: 'CSS' });
    await expect(editorName).toBeFocused();
    // As Duet wrote it, with nothing that fetches and without the !important joining adds.
    await expect(editorCss).toHaveValue(/^body \{\n {2}background-color: rgb\(92, 148, 252\);\n\}/);
    await expect(editorCss).not.toHaveValue(/!important/);
    await editorName.fill('Night sky');
    await editorCss.fill(`body { background-color: rgb(20, 20, 60) }\nmain p { color: rgb(240, 240, 240); background-image: url(${evil.url}/edited.png) }`);
    await expect.poll(() => style(news, 'body', 'background-color')).toBe('rgb(20, 20, 60)');
    expect(await style(news, 'p', 'color')).toBe('rgb(240, 240, 240)');
    expect(await style(news, 'p', 'background-image')).toBe('none');
    await expect(editor).toContainText('Left out url() on line 2. Effects never load files.');
    await expect(card.getByRole('switch', { name: 'Use “Night sky”' })).toBeVisible();
    await editor.scrollIntoViewIfNeeded();
    await capture(card, 'effects-card-editing-light', false);
    findings.push(...(await audit(popover, 'Effects card, editing a patch', { appearance: 'light' })));
    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(editor).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit “Night sky”' })).toBeFocused();

    // A hidden element's selector, as if it matched too much (every aside), then narrowed to the one meant, and renamed.
    await card.getByRole('button', { name: 'Edit aside#sidebar' }).click();
    const selector = editor.getByRole('textbox', { name: 'Selector' });
    await expect(selector).toBeFocused();
    await selector.fill('aside');
    await expect.poll(() => style(news, '#promo', 'display')).toBe('none');
    expect(await style(news, '#sidebar', 'display')).toBe('none');
    await selector.fill('aside#promo');
    await editor.getByRole('textbox', { name: 'Name' }).fill('Promo');
    await expect.poll(() => style(news, '#sidebar', 'display')).toBe('block');
    expect(await style(news, '#promo', 'display')).toBe('none');
    // Esc closes the editor, not the card, and the keyboard goes back to the row's Edit.
    await popover.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Edit Promo' })).toBeFocused();
    // Its switch: off, it shows; on, hidden again.
    const promo = card.getByRole('switch', { name: 'Hide Promo' });
    await promo.click();
    await expect.poll(() => style(news, '#promo', 'display')).toBe('block');
    await promo.click();
    await expect.poll(() => style(news, '#promo', 'display')).toBe('none');

    // Left so, with Green headline off: a reload keeps all of it.
    await green.click();
    await expect(green).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    await capture(card, 'effects-card-light');
    findings.push(...(await audit(popover, 'Effects card with items', { appearance: 'light' })));
    const left = async () => {
      await expect.poll(() => style(news, 'body', 'background-color')).toBe('rgb(20, 20, 60)');
      expect(await style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
      expect(await style(news, 'p', 'color')).toBe('rgb(240, 240, 240)');
      expect(await style(news, '#promo', 'display')).toBe('none');
      expect(await style(news, '#sidebar', 'display')).toBe('block');
      expect(await style(news, '#consent', 'display')).toBe('none');
    };
    await news.reload();
    await left();
    await card.getByRole('button', { name: 'Close Effects' }).click();

    // A relaunch: all of it comes back, from the first paint, each switch as it was left.
    await app.close();
    app = await launch({ ...env, CHORD_APPEARANCE: 'dark' }, { profile });
    shell = await pageWhere(app, isShell);
    popover = await pageWhere(app, isPopover);
    news = await pageAt(app, `${site.origin}/news`);
    await left();
    card = await openCard(shell, popover);
    await expect(yourCss(card)).toHaveValue(/rgb\(255, 0, 0\)/);
    await expect(card.getByRole('switch', { name: 'Use your CSS' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('button', { name: 'No sticky bars' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('switch', { name: 'Use “Green headline”' })).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByRole('switch', { name: 'Use “Night sky”' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('switch', { name: 'Hide Promo' })).toHaveAttribute('aria-checked', 'true');
    await capture(card, 'effects-card-dark');
    findings.push(...(await audit(popover, 'Effects card with items (dark)', { appearance: 'dark' })));
    await card.getByRole('button', { name: 'Edit “Night sky”' }).click();
    const reopened = card.getByRole('group', { name: 'Editing “Night sky”' });
    await expect(reopened.getByRole('textbox', { name: 'CSS' })).toHaveValue(/rgb\(20, 20, 60\)/);
    await expect(reopened).toContainText('Left out url() on line 2. Effects never load files.');
    await reopened.scrollIntoViewIfNeeded();
    await capture(card, 'effects-card-editing-dark', false);
    await reopened.getByRole('button', { name: 'Done' }).click();
    await card.getByRole('button', { name: 'Close Effects' }).click();
    expectClean(findings);

    // A private window uses what you saved, and keeps what you change there to itself.
    const normalOverlay = await pageWhere(app, isOverlay);
    await runAction(shell, 'window.newPrivate');
    const privateShell = await newPage(app, isShell, [shell]);
    // A new window opens with its command bar: the page goes in there.
    const privateOverlay = await newPage(app, isOverlay, [normalOverlay]);
    await expect(privateOverlay.getByRole('dialog')).toBeVisible();
    await privateOverlay.getByRole('combobox').fill(`${site.origin}/news/2`);
    await privateOverlay.keyboard.press('Enter');
    const privatePage = await pageAt(app, `${site.origin}/news/2`);
    await expect.poll(() => style(privatePage, 'body', 'background-color')).toBe('rgb(20, 20, 60)');
    expect(await style(privatePage, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    const privatePopover = await newPage(app, isPopover, [popover]);
    await runAction(privateShell, 'effects.open');
    const privateCard = privatePopover.getByRole('dialog', { name: `Effects on ${host()}` });
    await expect(privateCard).toContainText('Changes here last until this window closes.');
    await expect(privateCard.getByRole('textbox', { name: 'Ask Duet to restyle this site' })).toHaveCount(0);
    await yourCss(privateCard).fill('main h1 { color: rgb(0, 0, 255) }');
    await expect.poll(() => style(privatePage, 'h1', 'color')).toBe('rgb(0, 0, 255)');
    // The normal window's page didn't change.
    expect(await style(news, 'h1', 'color')).toBe('rgb(255, 0, 0)');
    // The window's own page goes as it closes, so the call never answers.
    await runAction(privateShell, 'window.close').catch(() => {});
    await expect.poll(() => app.windows().filter((p) => isShell(p.url())).length).toBe(1);
    await app.close();

    // Nothing from the private window was saved; nothing ever reached the server a fetch would.
    const db = new DatabaseSync(join(profile, 'chord.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT host, css, css_on, hidden, duet, compiled FROM effect').all() as { host: string; css: string; css_on: number; hidden: string; duet: string; compiled: string }[];
      expect(rows.map((r) => r.host)).toEqual([host()]);
      expect(rows[0]!.css).toContain('rgb(255, 0, 0)');
      expect(rows[0]!.css).not.toContain('rgb(0, 0, 255)');
      expect(rows[0]!.css_on).toBe(1);
      expect((JSON.parse(rows[0]!.hidden) as { selector: string; label: string; on: boolean }[]).map(({ selector, label, on }) => ({ selector, label, on }))).toEqual([{ selector: 'aside#promo', label: 'Promo', on: true }]);
      expect((JSON.parse(rows[0]!.duet) as { summary: string; on: boolean }[]).map(({ summary, on }) => ({ summary, on }))).toEqual([
        { summary: 'Green headline', on: false },
        { summary: 'Night sky', on: true },
      ]);
      // Your edited patch is kept as you wrote it; what's inserted never has what would fetch.
      expect(rows[0]!.duet).toContain('edited.png');
      expect(rows[0]!.compiled).not.toMatch(/url\(|@import/i);
      expect(rows[0]!.compiled).toContain('rgb(20, 20, 60)');
      expect(rows[0]!.compiled).not.toContain('rgb(0, 128, 0)');
    } finally {
      db.close();
    }
    expect(evil.hits).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});

/**
 * What applying Effects costs on a page with about 24,000 elements (ARCHITECTURE.md
 * §1): main's part (finding the stylesheet, `insertCSS` answering), the
 * sanitizer's worker, and the page's own style and layout work, from a trace.
 * Printed for the record; CI's machines are too noisy to fail on.
 */
test('Effects on a heavy page: what applying them costs', async () => {
  test.setTimeout(120_000);
  const app = await launch({ CHORD_HOME_URL: `${site.origin}/heavy`, CHORD_E2E_HOOKS: '1' });
  try {
    const shell = await pageWhere(app, isShell);
    const popover = await pageWhere(app, isPopover);
    const heavy = await pageAt(app, `${site.origin}/heavy`);
    await expect.poll(() => heavy.evaluate(() => document.querySelectorAll('*').length)).toBeGreaterThan(20_000);
    const elements = await heavy.evaluate(() => document.querySelectorAll('*').length);
    const pid = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.getOSProcessId(), `${site.origin}/heavy`);
    const cdp = await heavy.context().newCDPSession(heavy);
    const work = (events: Awaited<ReturnType<typeof trace>>) => {
      const frames = framesOf(events, pid);
      return {
        styleLayout: Math.round(frames.reduce((t, f) => t + f.styleLayout, 0) * 10) / 10,
        paint: Math.round(frames.reduce((t, f) => t + f.paint, 0) * 10) / 10,
        longestTask: Math.round(longestTask(events, pid).ms * 10) / 10,
      };
    };

    // Each navigation's share: the page loaded again three times (medians), first dry, then with your CSS (41 rules),
    // then with each preset added in turn.
    const css = ['.card h2 { color: rgb(10, 20, 30) }', ...Array.from({ length: 20 }, (_, i) => `.c${i % 7} h2:nth-of-type(1) { letter-spacing: 0.0${i + 1}em }\n#s${i} { display: none }`)].join('\n');
    const marked = () => heavy.evaluate(() => getComputedStyle(document.querySelector('.card h2')!).color);
    const frame = () => heavy.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const median = (values: number[]) => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! * 10) / 10;
    const reloads = async () => {
      const runs: ReturnType<typeof work>[] = [];
      for (let i = 0; i < 3; i++) {
        const events = await trace(cdp, async () => {
          await heavy.reload();
          await frame();
        });
        runs.push(work(events));
      }
      return { styleLayout: median(runs.map((r) => r.styleLayout)), paint: median(runs.map((r) => r.paint)), longestTask: median(runs.map((r) => r.longestTask)) };
    };
    const loads: Record<string, ReturnType<typeof work>> = {};
    // Two loads first, so caches and the JIT are warm for every measured one.
    await reloads();
    loads['none'] = await reloads();
    let card = await openCard(shell, popover);
    await yourCss(card).fill(css);
    await expect.poll(marked).toBe('rgb(10, 20, 30)');
    await card.getByRole('button', { name: 'Close Effects' }).click();
    loads['your CSS'] = await reloads();
    for (const name of ['Reading width', 'Dark', 'No sticky bars']) {
      card = await openCard(shell, popover);
      await card.getByRole('button', { name }).click();
      await expect(card.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      await card.getByRole('button', { name: 'Close Effects' }).click();
      loads[`+ ${name}`] = await reloads();
    }
    expect(await marked()).toBe('rgb(10, 20, 30)');

    // Applying all of it at once on a page that's already there: Dry, then Wet, traced.
    card = await openCard(shell, popover);
    await card.getByRole('radio', { name: 'Dry' }).click();
    await expect.poll(marked).not.toBe('rgb(10, 20, 30)');
    await frame();
    const applied = await trace(cdp, async () => {
      await card.getByRole('radio', { name: 'Wet' }).click();
      await expect.poll(marked, { intervals: [16] }).toBe('rgb(10, 20, 30)');
      await frame();
    });
    await card.getByRole('button', { name: 'Close Effects' }).click();
    // And dry again, all of it kept: what loading costs without them, measured last.
    await runAction(shell, 'effects.everywhere');
    await expect.poll(marked).not.toBe('rgb(10, 20, 30)');
    loads['dry, at the end'] = await reloads();
    await runAction(shell, 'effects.everywhere');

    const hooks = (await app.evaluate(() => (globalThis as unknown as { chordTestHooks: { effects(): { timings: { lookup: number; insert: number; bytes: number }[]; compile: number[] } } }).chordTestHooks.effects())) as {
      timings: { lookup: number; insert: number; bytes: number }[];
      compile: number[];
    };
    const ms = (n: number) => Math.round(n * 100) / 100;
    const report = {
      elements,
      stylesheetBytes: Math.max(0, ...hooks.timings.map((t) => t.bytes)),
      mainLookupMs: { median: ms(median(hooks.timings.map((t) => t.lookup))), max: ms(Math.max(0, ...hooks.timings.map((t) => t.lookup))) },
      insertCssAnsweredMs: { median: median(hooks.timings.map((t) => t.insert)), max: ms(Math.max(0, ...hooks.timings.map((t) => t.insert))) },
      sanitizerMs: { median: ms(median(hooks.compile)), max: ms(Math.max(0, ...hooks.compile)) },
      applyingAllOnce: work(applied),
      loads,
    };
    console.log(`[effects] ${JSON.stringify(report)}`);
    // Main only looks up a string: well under a millisecond, whatever the page.
    expect(report.mainLookupMs.max).toBeLessThan(5);
  } finally {
    await app.close();
  }
});
