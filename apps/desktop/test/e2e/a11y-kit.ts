/**
 * Shared by the accessibility audit (a11y.spec.ts) and the keyboard-only
 * walkthroughs (keyboard.spec.ts): launching Chord, finding its pages, and
 * running axe on them.
 *
 * axe judges contrast wherever it can see one opaque color behind text. It
 * can't behind Chord's tinted sidebar: the tint is a translucent gradient over
 * the OS material. For that text the contrast comes from the theme tokens
 * instead, the way the theme generator guarantees it (DESIGN.md §5.2): every
 * layer under the text is composited over the worst-case material, at each of
 * the gradient's sample points, and the lowest ratio counts.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { contrast, mixOklab, oklabToOklch, oklchToRgb, over, rgbToOklch, WORST_MATERIAL, type Appearance, type Oklch, type Rgb } from '@chord/tokens';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { watchForMainErrors } from './main-errors';

export const appDir = resolve(import.meta.dirname, '../..');
export const capturesDir = resolve(appDir, 'test-results', 'captures');
export const fakeClaude = resolve(import.meta.dirname, 'fake-claude.mjs');
export const fixtureExtension = resolve(appDir, 'test', 'fixtures', 'extension');

export const isShell = (url: string) => url.startsWith('chord://shell') || url.includes('/shell/index.html');
export const isOverlay = (url: string) => url.startsWith('chord://overlay') || url.includes('/overlay/index.html');
export const isPopover = (url: string) => url.startsWith('chord://popover') || url.includes('/popover/index.html');
export const isPreview = (url: string) => url.startsWith('chord://preview') || url.includes('/preview/index.html');
export const isSettings = (url: string) => url.startsWith('chord://settings') || url.includes('/settings/index.html');
export const isArchive = (url: string) => url.startsWith('chord://archive') || url.includes('/archive/index.html');
export const isMini = (url: string) => url.startsWith('chord://mini') || url.includes('/mini/index.html');

export interface Site {
  server: Server;
  /** http://127.0.0.1:port */
  origin: string;
  /** The same server as another site: http://localhost:port (for Peek and link routes). */
  other: string;
}

/** A few small pages, so nothing needs the network. `{port}` in a page is the server's port. */
export function startSite(pages: Record<string, string>): Promise<Site> {
  let port = 0;
  const server = createServer((req, res) => {
    const body = pages[(req.url ?? '/').split('?')[0]!];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ? body.replaceAll('{port}', String(port)) : 'not found');
  });
  // Every address, so both 127.0.0.1 and localhost (which may be ::1) reach it.
  return new Promise((done) =>
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      done({ server, origin: `http://127.0.0.1:${port}`, other: `http://localhost:${port}` });
    }),
  );
}

/**
 * Click a link in a page the way the mouse does, from main (Peek cancels the
 * page's own navigation, which Playwright would otherwise wait for).
 */
export async function clickLink(app: ElectronApplication, url: string, selector: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, [u, sel]) => {
      const c = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)!;
      const at = (await c.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      )) as { x: number; y: number };
      c.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      c.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    },
    [url, selector] as const,
  );
}

/** A port nothing listens on, for a page that can't load. */
export function closedPort(): Promise<number> {
  return new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}

export interface LaunchOptions {
  firstRun?: boolean;
  profile?: string;
  /** More command-line arguments: a link from another app comes after --single-argument. */
  args?: string[];
}

/** Chord with a fresh profile (a test never touches real data). Every launch watches main for errors. */
export async function launch(env: Record<string, string>, { firstRun = false, profile = mkdtempSync(join(tmpdir(), 'chord-e2e-')), args = [] }: LaunchOptions = {}): Promise<ElectronApplication> {
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), CHORD_USER_DATA: profile, ...env };
  delete childEnv['ELECTRON_RUN_AS_NODE'];
  if (firstRun) childEnv['CHORD_FIRST_RUN'] = '1';
  // On Linux, Playwright adds --no-sandbox unless told otherwise; Chord never runs without its sandbox.
  return watchForMainErrors(await electron.launch({ chromiumSandbox: true, args: [appDir, ...(firstRun ? [] : ['--no-first-run']), ...args], env: childEnv, cwd: appDir }));
}

export async function pageWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  const open = () => app.windows().filter((p) => !p.isClosed());
  await expect.poll(() => open().some((p) => match(p.url())), { timeout: 20_000 }).toBe(true);
  return open().find((p) => match(p.url()))!;
}

/** A page matching `match` that isn't one of `known` (a new window's shell, say). */
export async function newPage(app: ElectronApplication, match: (url: string) => boolean, known: readonly Page[]): Promise<Page> {
  const find = () => app.windows().find((p) => match(p.url()) && !known.includes(p));
  await expect.poll(() => Boolean(find()), { timeout: 20_000 }).toBe(true);
  return find()!;
}

interface ChordGlobal {
  chord: {
    action: { run(a: string): Promise<void> };
    overlay: { open(mode: string): Promise<void> };
    state: {
      dispatch(c: unknown): Promise<void>;
      snapshot(): Promise<{ windowId: string; state: { windows: Record<string, { activeChordId: string; activeTab: Record<string, string | null> }>; nodes: Record<string, { id: string; title?: string; url?: string; kind: string }>; chords: Record<string, { theme: { stops: { l: number; c: number; h: number }[] } }> } }>;
    };
  };
}

/**
 * Run an action from the shortcut registry the way the shell's own buttons
 * do. Playwright's key presses never reach Electron's before-input-event, so
 * reserved shortcuts (⌘T, F6, ⌘1…) can't be pressed; this is their route.
 */
export const runAction = (shell: Page, action: string) => shell.evaluate((a) => (window as unknown as ChordGlobal).chord.action.run(a), action);

export const dispatch = (shell: Page, command: unknown) => shell.evaluate((c) => (window as unknown as ChordGlobal).chord.state.dispatch(c), command);

/** The window's id, its active chord, and the active tab's id. */
export async function where(shell: Page): Promise<{ windowId: string; chordId: string; tabId: string | null }> {
  return shell.evaluate(async () => {
    const { windowId, state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    const w = state.windows[windowId]!;
    return { windowId, chordId: w.activeChordId, tabId: w.activeTab[w.activeChordId] ?? null };
  });
}

/** A tab's id by its title. */
export async function tabIdByTitle(shell: Page, title: string): Promise<string> {
  return shell.evaluate(async (t) => {
    const { state } = await (window as unknown as ChordGlobal).chord.state.snapshot();
    return Object.values(state.nodes).find((n) => n.kind === 'tab' && n.title === t)!.id;
  }, title);
}

/**
 * Press a key the way the OS delivers it, through Electron's input pipeline
 * (so before-input-event sees it: reserved shortcuts and F6 work). `match`
 * picks the WebContents by its address.
 */
export async function pressReal(app: ElectronApplication, match: string, keyCode: string, modifiers: string[] = []): Promise<void> {
  await app.evaluate(
    ({ webContents }, { match: m, keyCode: k, modifiers: mods }) => {
      const c = webContents.getAllWebContents().find((x) => x.getURL().startsWith(m));
      if (!c) throw new Error(`No web contents at ${m}`);
      c.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods as never });
      c.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods as never });
    },
    { match, keyCode, modifiers },
  );
}

/**
 * The OS's reduce motion setting, stubbed in main and sent to the renderers
 * as a real change would be; resolves once the shell has it. (CI machines
 * differ: some have it on, some off.)
 */
export async function setReducedMotion(app: ElectronApplication, shell: Page, reduce: boolean): Promise<void> {
  await app.evaluate(({ systemPreferences, nativeTheme }, r) => {
    const real = systemPreferences.getAnimationSettings.bind(systemPreferences);
    systemPreferences.getAnimationSettings = () => ({ ...real(), prefersReducedMotion: r });
    nativeTheme.emit('updated');
  }, reduce);
  await expect.poll(() => shell.evaluate(() => document.documentElement.hasAttribute('data-reduced-motion'))).toBe(reduce);
}

/** Which of Chord's views has the keyboard: a page's address, or its kind (shell, overlay, popover). */
export async function focusedView(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ webContents }) => {
    const c = webContents.getAllWebContents().find((x) => x.isFocused());
    if (!c) return null;
    const url = c.getURL();
    const kind = /(shell|overlay|popover|preview|settings|archive)(\/index\.html|\/)/.exec(url);
    return kind ? kind[1]! : url;
  });
}

/* ---------- Chord themes ---------- */

/** The capture matrix's themes (DESIGN.md §12), plus the signature Dusk. */
export const THEMES = {
  dusk: [{ l: 0.72, c: 0.12, h: 300 }, { l: 0.72, c: 0.14, h: 30 }],
  graphite: [{ l: 0.72, c: 0.015, h: 260 }],
  coral: [{ l: 0.72, c: 0.14, h: 30 }],
  aurora: [{ l: 0.72, c: 0.1, h: 165 }, { l: 0.72, c: 0.12, h: 270 }, { l: 0.72, c: 0.13, h: 330 }],
} as const satisfies Record<string, Oklch[]>;
export type ThemeName = keyof typeof THEMES;

/** Recolor the window's chord; resolves once the shell has re-themed. */
export async function setTheme(shell: Page, theme: ThemeName): Promise<void> {
  const { chordId } = await where(shell);
  // A chord can have these colors already: with no OS accent color (Linux), the first chord is Dusk.
  const current = await shell.evaluate(async (id) => (await (window as unknown as ChordGlobal).chord.state.snapshot()).state.chords[id]!.theme.stops, chordId);
  const same = JSON.stringify(current.map(({ l, c, h }) => ({ l, c, h }))) === JSON.stringify(THEMES[theme]);
  const before = await shell.evaluate(() => document.querySelector<HTMLElement>('[data-sidebar]')?.style.getPropertyValue('--color-tint') ?? '');
  await dispatch(shell, { t: 'chord.theme', chordId, theme: { stops: THEMES[theme], grain: 0.2, appearance: 'auto', themeId: null } });
  await expect
    .poll(() => shell.evaluate(() => document.querySelector<HTMLElement>('[data-sidebar]')?.style.getPropertyValue('--color-tint') ?? ''))
    .not.toBe(same || before === '' ? 'never' : before);
  // The tint crossfades; contrast is judged once it has settled.
  await shell.waitForTimeout(400);
}

/* ---------- Colors, as computed styles report them ---------- */

interface Rgba {
  rgb: Rgb;
  alpha: number;
}

const num = (s: string, scale = 1) => (s.endsWith('%') ? (Number.parseFloat(s) / 100) * scale : Number.parseFloat(s));

/** Parses the color forms Chromium's computed styles use: rgb(a), oklch, oklab, color(srgb …). */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  if (v === 'transparent') return { rgb: { r: 0, g: 0, b: 0 }, alpha: 0 };
  const m = /^(rgba?|oklch|oklab|color)\((.*)\)$/.exec(v);
  if (!m) return null;
  const [fn, body] = [m[1]!, m[2]!];
  const [main, slashAlpha] = body.split('/').map((s) => s.trim()) as [string, string | undefined];
  let parts = main.split(/[\s,]+/).filter(Boolean);
  let alpha = slashAlpha !== undefined ? num(slashAlpha) : 1;
  if (fn === 'color') {
    if (parts[0] !== 'srgb') return null;
    parts = parts.slice(1);
    return { rgb: { r: num(parts[0]!), g: num(parts[1]!), b: num(parts[2]!) }, alpha };
  }
  if (fn === 'rgb' || fn === 'rgba') {
    if (parts.length === 4) alpha = num(parts[3]!);
    return { rgb: { r: num(parts[0]!, 255) / 255, g: num(parts[1]!, 255) / 255, b: num(parts[2]!, 255) / 255 }, alpha };
  }
  const none = (s: string) => (s === 'none' ? '0' : s);
  if (fn === 'oklch') {
    return { rgb: oklchToRgb({ l: num(none(parts[0]!)), c: num(none(parts[1]!), 0.4), h: num(none(parts[2]!)) }), alpha };
  }
  return { rgb: oklchToRgb(oklabToOklch({ l: num(none(parts[0]!)), a: num(none(parts[1]!), 0.4), b: num(none(parts[2]!), 0.4) })), alpha };
}

/** Every color stop in a background-image, at the points the theme generator samples. */
function gradientSamples(image: string): Rgba[] {
  const stops = [...image.matchAll(/(?:rgba?|oklch|oklab|color)\([^()]*\)/g)].map((m) => parseColor(m[0])).filter((c): c is Rgba => c !== null && c.alpha > 0);
  const samples: Rgba[] = [];
  stops.forEach((stop, i) => {
    samples.push(stop);
    const next = stops[i + 1];
    if (!next) return;
    for (const t of [0.25, 0.5, 0.75]) {
      const mixed: Oklch = mixOklab(rgbToOklch(stop.rgb), rgbToOklch(next.rgb), t);
      samples.push({ rgb: oklchToRgb(mixed), alpha: stop.alpha + (next.alpha - stop.alpha) * t });
    }
  });
  return samples;
}

/* ---------- axe ---------- */

/** What the page reports about a piece of text axe couldn't judge for contrast. */
interface TextSample {
  selector: string;
  text: string;
  color: string;
  fontSize: number;
  fontWeight: number;
  opacity: number;
  skip: boolean;
  /** Top to bottom: what's painted under the text. */
  layers: { color: string; image: string | null; opacity: number }[];
}

/** Gathers the layers under each element's text, everything that paints included (tints don't take the pointer). */
export function sampleText(selectors: string[]): TextSample[] {
  const lifted: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    if (getComputedStyle(el).pointerEvents === 'none') {
      el.style.setProperty('pointer-events', 'auto', 'important');
      lifted.push(el);
    }
  }
  try {
    return selectors.flatMap((selector) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return [];
      const style = getComputedStyle(el);
      let opacity = 1;
      for (let n: HTMLElement | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = range.getBoundingClientRect();
      const rect = box.width > 0 ? box : el.getBoundingClientRect();
      const stack = document.elementsFromPoint(rect.left + Math.min(rect.width / 2, 6), rect.top + rect.height / 2);
      const start = Math.max(0, stack.findIndex((n) => n === el || n.contains(el) || el.contains(n)));
      const layers = stack.slice(start).map((n) => {
        const cs = getComputedStyle(n);
        return { color: cs.backgroundColor, image: cs.backgroundImage !== 'none' ? cs.backgroundImage : null, opacity: Number(cs.opacity) };
      });
      // Disabled controls are exempt from contrast (WCAG 1.4.3), and invisible text isn't text. Nor is a
      // decoration hidden from screen readers, like a site's fallback icon (a logotype: its letter is
      // ≥ 4.5:1 on its own square, tokens/theme.ts, and the row's title says what it is).
      const skip = Boolean(el.closest(':disabled, [aria-disabled="true"], [inert], [aria-hidden="true"]')) || opacity === 0 || style.visibility === 'hidden';
      return [{ selector, text: (el.textContent ?? '').trim().slice(0, 40), color: style.color, fontSize: Number.parseFloat(style.fontSize), fontWeight: Number(style.fontWeight), opacity, skip, layers }];
    });
  } finally {
    for (const el of lifted) el.style.removeProperty('pointer-events');
  }
}

/** The lowest contrast of `sample` across every point of the gradients under it, over the worst-case material. */
export function tokenContrast(sample: TextSample, appearance: Appearance): number {
  const material = oklchToRgb(WORST_MATERIAL[appearance]);
  let backgrounds: Rgb[] = [material];
  for (const layer of [...sample.layers].reverse()) {
    if (layer.opacity === 0) continue;
    const color = parseColor(layer.color);
    if (color && color.alpha > 0) backgrounds = backgrounds.map((b) => over(color.rgb, color.alpha * layer.opacity, b));
    if (layer.image) {
      const samples = gradientSamples(layer.image);
      if (samples.length > 0) backgrounds = backgrounds.flatMap((b) => samples.map((s) => over(s.rgb, s.alpha * layer.opacity, b)));
    }
  }
  const text = parseColor(sample.color);
  if (!text) return Infinity;
  return Math.min(...backgrounds.map((b) => contrast(over(text.rgb, text.alpha * sample.opacity, b), b)));
}

const large = (s: TextSample) => s.fontSize >= 24 || (s.fontSize >= 18.66 && s.fontWeight >= 700);

/** axe's incomplete reasons that aren't about the background: icon glyphs. */
const NOT_TEXT = new Set(['nonBmp', 'iconLigature']);

export interface AuditOptions {
  /** Only this part of the page. */
  include?: string;
  exclude?: string[];
  /** The chord's appearance, for the worst-case material under the tint. */
  appearance: Appearance;
}

export interface Finding {
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

/**
 * Wait for entrances and fades to finish: half-faded text is judged at its
 * half-faded color. (Endless ones, like a spinner, don't count.)
 */
export async function settle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => {});
  // Motion's springs that run in JavaScript aren't in getAnimations(); none outlasts this.
  await page.waitForTimeout(350);
}

/**
 * Run axe on a page and return serious and critical problems, plus text
 * whose contrast (from the theme tokens) is under WCAG AA. `label` names the
 * surface in failure messages.
 */
export async function audit(page: Page, label: string, options: AuditOptions): Promise<Finding[]> {
  await settle(page);
  let builder = new AxeBuilder({ page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
  if (options.include) builder = builder.include(options.include);
  for (const ex of options.exclude ?? []) builder = builder.exclude(ex);
  const results = await builder.analyze();
  const findings: Finding[] = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ rule: v.id, impact: v.impact!, help: v.help, nodes: v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(1).join(' ').trim() ?? ''}`) }));

  // Contrast axe couldn't judge (a gradient or a translucent layer underneath): from the tokens.
  const unsure = results.incomplete.find((i) => i.id === 'color-contrast');
  const selectors = (unsure?.nodes ?? [])
    .filter((n) => !n.any.some((c) => NOT_TEXT.has((c.data as { messageKey?: string } | null)?.messageKey ?? '')))
    .map((n) => String(n.target[0]));
  if (selectors.length > 0) {
    const samples = await page.evaluate(sampleText, selectors);
    const low = samples
      .filter((s) => !s.skip && s.text)
      .map((s) => ({ s, ratio: tokenContrast(s, options.appearance) }))
      .filter(({ s, ratio }) => ratio < (large(s) ? 3 : 4.5));
    if (low.length > 0) {
      findings.push({
        rule: 'token-contrast',
        impact: 'serious',
        help: 'Text over the tint must reach 4.5:1 (3:1 when large) against every point of the gradient',
        nodes: low.map(({ s, ratio }) => `${s.selector} “${s.text}” ${ratio.toFixed(2)}:1`),
      });
    }
  }
  return findings.map((f) => ({ ...f, help: `[${label}] ${f.help}` }));
}

/** Fails the test with every finding, readable. */
export function expectClean(findings: Finding[]): void {
  const text = findings.map((f) => `${f.rule} (${f.impact}): ${f.help}\n  ${f.nodes.join('\n  ')}`).join('\n\n');
  expect(findings, text).toEqual([]);
}
