/**
 * What the passwords agent's scan costs on a heavy page, with and without open shadow roots (S17
 * phase 3B; frames come with 3C): measured in Playwright's own headless Chromium, as the corpus
 * is, and reported in test-results/forms/scan-cost.json. The sign-in form sits in the roots of
 * web components, as a design system's text fields put it, under 600 news cards.
 *
 * Reported, not held: headless timings on shared runners vary too much for a budget here.
 * perf.spec.ts (Electron, reference hardware) holds the budgets. Each number is the median of
 * 15 measures, each the mean of 5 runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';
import type { ScanCost } from './scan-cost-entry';

const here = import.meta.dirname;
const RESULTS = resolve(here, '..', '..', 'test-results', 'forms');
const ORIGIN = 'http://cost.test';
const OTHER = 'http://ads.test';

/** About 4,200 elements of news cards: links, words, buttons. */
const cards = () => {
  let out = '';
  for (let i = 0; i < 600; i++) out += `<div class="card"><a href="/a${i}"><span>Story ${i}</span></a><p>Some words <b>here</b> and <i>there</i></p><div class="share">Share</div></div>`;
  return out;
};
/** A web component's text field: its input and label in an open root, declared (the page runs no script). */
const field = (id: string, type: string, label: string) =>
  `<x-text-field id="${id}"><template shadowrootmode="open"><label for="i">${label}</label><input id="i" name="${id}" type="${type}"><slot></slot></template></x-text-field>`;
/** 300 components of the page's own (cards' buttons), each with a small open root. */
const components = () => {
  let out = '';
  for (let i = 0; i < 300; i++) out += `<x-chip><template shadowrootmode="open"><span class="chip"><slot></slot></span></template>Tag ${i}</x-chip>`;
  return out;
};

/** 300 components each with a button in its root (chips with a remove button): every one is in the roots' index. */
const buttonComponents = () => {
  let out = '';
  for (let i = 0; i < 300; i++) out += `<x-chip><template shadowrootmode="open"><span class="chip"><slot></slot><button aria-label="Remove">×</button></span></template>Tag ${i}</x-chip>`;
  return out;
};
/** A button component labelled through its slot (Material's `md-filled-button`). */
const buttonComponent = (label: string) => `<x-button><template shadowrootmode="open"><button><slot></slot></button></template>${label}</x-button>`;

/** A frame's pages: a same-origin frame's sign-in, a same-origin frame of news, and another site's ad. */
const FRAME_PAGES: Record<string, string> = {
  [`${ORIGIN}/frame-sign-in`]: '<form><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>',
  [`${ORIGIN}/frame-news`]: `<div>${'<p>Some words <a href="/x">here</a></p>'.repeat(40)}</div>`,
  [`${OTHER}/ad`]: `<div class="ad"><a href="/buy"><img alt="Buy"></a><p>Buy now</p>${'<span>ad</span>'.repeat(20)}</div>`,
};
const iframe = (src: string) => `<iframe src="${src}" style="width:300px;height:150px"></iframe>`;

const PAGES: Record<string, string> = {
  'no roots, the form in the main tree': `${cards()}<form><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`,
  'the form’s fields in roots, 300 other components': `${cards()}${components()}<form>${field('username', 'text', 'Username')}${field('password', 'password', 'Password')}<button>Sign in</button></form>`,
  'no sign-in, 300 components (what every page would pay)': `${cards()}${components()}`,
  // A formless sign-in inside a big container (a feed of cards, components) with no button in it, the button outside:
  // each of the scope's levels holds the whole feed and finds none, formlessScope's worst case.
  'formless, no button near the field': `<main><div class="feed">${cards()}<div><input name="email" type="email"><input name="password" type="password"></div></div></main><button>Sign in</button>`,
  'formless, no button near the field, 300 components': `<main><div class="feed">${cards()}${components()}<div><input name="email" type="email"><input name="password" type="password"></div></div></main><button>Sign in</button>`,
  // A lone password field in a component, under a feed of 300 components that each have a button in their root, and a
  // button component outside the feed: the field's component, then each level's roots from the index (review round 4
  // of #61, nit 2).
  // Phase 3C: other sites' frames are never reached (their documents are null to the page); same-origin ones are scanned.
  'the form in the main tree, 30 other sites’ ad frames': `${cards()}<form><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>${iframe(`${OTHER}/ad`).repeat(30)}`,
  '5 same-origin frames, the sign-in in one': `${cards()}${iframe(`${ORIGIN}/frame-news`).repeat(4)}${iframe(`${ORIGIN}/frame-sign-in`)}`,
  'formless, a lone field in a component, 300 button components, the button outside': `<main><div class="feed">${cards()}${buttonComponents()}<div>${field('password', 'password', 'Password')}</div></div></main>${buttonComponent('Next')}`,
};

test('the scan, and walking open shadow roots, on a heavy page', async ({ page }) => {
  test.setTimeout(120_000);
  const script = await bundleAgent({ entry: join(here, 'scan-cost-entry.ts'), minify: true });
  let body = '';
  await page.route('**/*', (route) =>
    FRAME_PAGES[route.request().url()] !== undefined
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, body: `<!doctype html><html><body>${FRAME_PAGES[route.request().url()]}</body></html>` })
      : route.request().url().startsWith(ORIGIN)
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': "script-src 'none'" }, body })
        : route.abort(),
  );
  const report: Record<string, Record<string, number>> = {};
  for (const [name, html] of Object.entries(PAGES)) {
    body = `<!doctype html><html><head><meta charset="utf-8"><title>News</title></head><body>${html}</body></html>`;
    await page.goto(`${ORIGIN}/`);
    const runs: ScanCost[] = [];
    for (let i = 0; i < 15; i++) runs.push((await page.evaluate(`${script}\n;globalThis.chordScanCost()`)) as ScanCost);
    const median = (key: keyof ScanCost) => {
      const xs = runs.map((r) => r[key]).sort((a, b) => a - b);
      return Math.round(xs[Math.floor(xs.length / 2)]! * 1000) / 1000;
    };
    report[name] = Object.fromEntries((['elements', 'roots', 'scanMs', 'scanFlatMs', 'lookMs', 'walkAllMs', 'walkTreeMs', 'deepLookMs', 'scopeMs', 'frames', 'framesMs'] as const).map((k) => [k, median(k)]));
    console.log(`[scan-cost] ${name}: ${JSON.stringify(report[name])}`);
  }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'scan-cost.json'), JSON.stringify(report, null, 2));
  // The pages are what they say: roots where there should be.
  expect(report['no roots, the form in the main tree']!['roots']).toBe(0);
  expect(report['the form’s fields in roots, 300 other components']!['roots']).toBe(302);
});
