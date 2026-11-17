/**
 * The password detector on Bitwarden's test-the-web (GPL-3.0; tested against, never vendored:
 * ttw.ts), in Playwright's own headless Chromium, beside DuckDuckGo's corpus (corpus.spec.ts).
 *
 * Each sign-in page in ttw-pages.ts is loaded from the built site with its own scripts running,
 * and walked step by step as a person would (open the dialog, press Next). At each step:
 * - **detection:** the agent's scan and `classifyPasswordForm(..., 'filling')` against Chord's own
 *   expectations: the username, the current password, every other field nothing, and the form's kind;
 * - **the fill:** the real agent, woken at load with a fake bridge, as the sentinel wakes it. The
 *   expected field is clicked, the agent's `focus` is read as the menu reads it, main's fill for a
 *   fake account is sent, and both values must land, still be there half a second later (a page
 *   that puts its own values back), and no other field may change.
 *
 * **ttw-baseline.json** lists what's wrong today, by page and step. As with the corpus, something
 * right that goes wrong fails, and something newly right fails until the baseline is taken again
 * (`CHORD_FORMS_UPDATE=1 pnpm --filter @chord/desktop test:forms ttw`). The score prints every run.
 *
 * **It never blocks a build:** with no network to fetch and build the site, it skips and says why.
 *
 * Writes test-results/forms/ttw-score.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';
import { compareBaseline } from './score';
import { SITE_COMMIT, ensureSite } from './ttw';
import type { CheckResult, Expected } from './ttw-entry';
import { PAGES, type Action, type Step } from './ttw-pages';
import { SITE_ORIGIN, serveSite } from './ttw-serve';

const here = import.meta.dirname;
const BASELINE = join(here, 'ttw-baseline.json');
const RESULTS = resolve(here, '..', '..', 'test-results', 'forms');
/** A fake account, as the vault would hand main. */
const ACCOUNT = { username: 'ada@example.com', password: 'Correct-Horse-7' };
/** The kinds main opens its menu on (main/passwords/assist.ts, MENU_KINDS). */
const MENU_KINDS = new Set(['sign-in', 'username-only', 'unknown']);
const HIGHLIGHT = { color: 'Highlight', ms: 50, stagger: 0, easing: 'linear' };

export interface SiteBaseline {
  readonly site: string;
  readonly rightSteps: number;
  readonly steps: number;
  readonly failures: Readonly<Record<string, readonly string[]>>;
}

type Message = [string, Record<string, unknown>];
interface Ttw {
  check(expected: Expected): CheckResult;
  start(): void;
  fill(payload: unknown): void;
  messages(): Message[];
  clear(): void;
}
/** Calls the page's `chordTtw` (ttw-entry.ts). */
const call = <M extends keyof Ttw>(page: Page, method: M, arg?: Parameters<Ttw[M]>[0]) =>
  page.evaluate(([m, a]) => (globalThis as unknown as { chordTtw: Record<string, (x: unknown) => unknown> }).chordTtw[m]!(a), [method, arg] as const) as Promise<ReturnType<Ttw[M]>>;
const lastOf = async (page: Page, channel: string) => (await call(page, 'messages')).filter(([c]) => c === channel).at(-1)?.[1];
/** Two animation frames and the agent's fallback timer: anything it coalesces has gone out. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150)))));

async function act(page: Page, action: Action) {
  if ('click' in action) await page.click(action.click, { timeout: 5000 });
  else await page.waitForSelector(action.waitFor, { state: 'visible', timeout: 5000 });
}

/** Every text-like field's value, by its place among the page's inputs: what a fill may and may not change. */
const values = (page: Page) => page.evaluate(() => [...document.querySelectorAll('input, textarea')].map((el) => (el as HTMLInputElement).value));

/** The fill, as the menu and main do it: what's wrong with it, or nothing. */
async function fillStep(page: Page, step: Step): Promise<string[]> {
  const target = step.username ?? step.password;
  if (!target) return [];
  // A field focused as it appeared (autofocus) has its focus already; any other is clicked, as a person would.
  const active = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), target);
  if (active) await page.waitForTimeout(600);
  else {
    await call(page, 'clear');
    await page.click(target, { timeout: 5000 });
  }
  await settle(page);
  // The menu shows for the agent's last `focus` (with the field focused already, the one it sent then).
  const focus = await lastOf(page, 'focus');
  if (!focus) return ['fill: no menu (the agent sent no focus)'];
  const kind = String(focus['kind']);
  if (!MENU_KINDS.has(kind)) return [`fill: no menu (the form reads as ${kind})`];
  const before = await values(page);
  await call(page, 'clear');
  await call(page, 'fill', { formId: focus['formId'], username: ACCOUNT.username, ...(kind === 'username-only' ? {} : { password: ACCOUNT.password }), highlight: HIGHLIGHT });
  await settle(page);
  const filled = await lastOf(page, 'filled');
  if (!filled?.['ok']) return [`fill: refused (${String(filled?.['reason'] ?? 'no answer')})`];
  // Half a second for a page that puts its own values back.
  await page.waitForTimeout(500);
  const problems: string[] = [];
  const valueOf = (sel: string) => page.evaluate((s) => (document.querySelector(s) as HTMLInputElement | null)?.value ?? null, sel);
  if (step.username && (await valueOf(step.username)) !== ACCOUNT.username) problems.push('fill: the username didn’t land');
  if (step.password && (await valueOf(step.password)) !== ACCOUNT.password) problems.push('fill: the password didn’t land');
  // No other field may change (a honeypot, a newsletter's email).
  const expected = await page.evaluate((sels) => sels.map((s) => [...document.querySelectorAll('input, textarea')].indexOf(document.querySelector(s)!)), [step.username, step.password].filter((s): s is string => !!s));
  const after = await values(page);
  after.forEach((v, i) => {
    if (!expected.includes(i) && v !== before[i]) problems.push(`fill: another field changed (input ${i})`);
  });
  return problems;
}

test('test-the-web, held to its baseline', async ({ page, context }) => {
  test.setTimeout(10 * 60_000);
  const site = await ensureSite((line) => console.log(`[ttw] ${line}`));
  if (!site.ok) {
    const message = `test-the-web is unavailable, so its suite is skipped: ${site.reason}`;
    console.log(`[ttw] ${message}`);
    if (process.env['CI']) console.log(`::warning title=Password detector · test-the-web skipped::${message}`);
    test.skip(true, message);
    return;
  }
  await serveSite(context, site.siteDir);
  await page.setViewportSize({ width: 1280, height: 900 });
  const script = await bundleAgent({ entry: join(here, 'ttw-entry.ts'), minify: false });

  const failures: Record<string, string[]> = {};
  let steps = 0;
  let rightSteps = 0;
  let pages = 0;
  let rightPages = 0;
  let fills = 0;
  let rightFills = 0;
  for (const p of PAGES) {
    if (p.skip) continue;
    pages++;
    await page.goto(`${SITE_ORIGIN}/forms/${p.path}/`, { waitUntil: 'networkidle' });
    await page.evaluate(script);
    // Woken at load, as the sentinel wakes it, and left running through the steps.
    await call(page, 'start');
    await settle(page);
    let pageRight = true;
    for (const step of p.steps) {
      steps++;
      const key = `${p.path} › ${step.name}`;
      const wrong: string[] = [];
      try {
        for (const action of step.actions ?? []) await act(page, action);
        await settle(page);
        const result = await call(page, 'check', { username: step.username, password: step.password });
        for (const sel of result.notFound) wrong.push(`no field matches ${sel}`);
        wrong.push(...result.wrong);
        if (step.kind && result.kind !== step.kind) wrong.push(`kind ${result.kind ?? 'none'}, wanted ${step.kind}`);
        if (step.username || step.password) {
          fills++;
          const fill = await fillStep(page, step);
          if (!fill.length) rightFills++;
          wrong.push(...fill);
        }
      } catch (error) {
        wrong.push(`couldn’t reach the step: ${(error as Error).message.split('\n')[0]}`);
      }
      if (wrong.length) {
        failures[key] = wrong;
        pageRight = false;
      } else rightSteps++;
    }
    if (pageRight) rightPages++;
  }

  const score = { site: `bitwarden/test-the-web@${SITE_COMMIT}`, pages, rightPages, steps, rightSteps, fills, rightFills, skipped: PAGES.filter((p) => p.skip).map((p) => `${p.path}: ${p.skip}`), failures };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'ttw-score.json'), JSON.stringify(score, null, 2));
  console.log(
    `[ttw] ${rightPages} of ${pages} pages right; ${rightSteps} of ${steps} steps; ${rightFills} of ${fills} fills; ` +
      `${Object.values(failures).flat().length} things wrong; ${score.skipped.length} pages not scored (a later phase's)`,
  );
  for (const [key, lines] of Object.entries(failures)) for (const line of lines) console.log(`[ttw]   ${key}: ${line}`);
  if (process.env['CHORD_FORMS_UPDATE']) {
    const baseline: SiteBaseline = { site: score.site, rightSteps, steps, failures };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[ttw] baseline written: ${BASELINE}`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as SiteBaseline;
  const { regressed, fixed } = compareBaseline(score, baseline);
  expect(regressed, 'steps that were right and are now wrong').toEqual([]);
  expect(fixed, 'things newly right: take the baseline again (CHORD_FORMS_UPDATE=1)').toEqual([]);
});
