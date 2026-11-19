/**
 * The formless scope when the roots' index is cut short (review rounds 1 and 2 of #65): a partial index could miss a
 * near component's button and find a far one, a wider scope and more submits. Cut short, the scope keeps to the field's
 * own tree, as main's, and a wordless button isn't taken for the submit on a guess.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

const here = import.meta.dirname;
const chip = '<x-chip><template shadowrootmode="open"><span><slot></slot></span></template>tag</x-chip>';
const button = (label: string) => `<x-button><template shadowrootmode="open"><button><slot></slot></button></template>${label}</x-button>`;
// A far Sign in component first (the first root), then 70 roots, then a near one in the field's row.
const PAGE = `<div id="outer">${button('Sign in')}<div id="feed">${chip.repeat(70)}<div id="row"><div class="box"><input type="password" name="password" aria-label="Password"></div>${button('Next')}</div></div></div>`;

/** The probe's answer on `html`, its index counted in full or cut short, and for a click on `target`. */
async function probe(page: Page, html: string, truncate: boolean, target: string | null = null) {
  const script = await bundleAgent({ entry: join(here, 'scope-probe-entry.ts'), minify: true });
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  return (await page.evaluate(`${script}\n;globalThis.chordScopeProbe(${truncate}, ${JSON.stringify(target)})`)) as { scope: string | null; submits: boolean | null };
}

test('the roots’ index cut short (past ROOT_INDEX_MS): the scope ignores roots, never a wider one from part of them', async ({ page }) => {
  expect((await probe(page, PAGE, false)).scope).toBe('row');
  expect((await probe(page, PAGE, true)).scope).toBeNull();
});

// Review round 2 of #65, probe 1: P4's layout (a wordless eye beside the field's box, Sign in beside it) under 70 roots.
// Sign in as the page's own button, or as a component (whose words a cut-short index never read).
const EYE = (signIn: string) =>
  `<div id="page">${chip.repeat(70)}<div id="row"><div class="box"><input type="password" name="password" aria-label="Password"></div><button id="eye" type="button"><svg width="12" height="12"></svg></button>${signIn}</div></div>`;
for (const [what, signIn] of [
  ['the page’s Sign in', '<button id="go" type="button">Sign in</button>'],
  ['a Sign in component', button('Sign in')],
] as const) {
  for (const truncate of [false, true]) {
    test(`probe 1, ${what}, the index ${truncate ? 'cut short' : 'counted in full'}: the wordless eye beside it isn’t a submit`, async ({ page }) => {
      expect((await probe(page, EYE(signIn), truncate, '#eye')).submits).toBe(false);
    });
  }
}

// Probe 2: a field and a Sign in component in an app shell's root, and the page's own Accept cookies beside the shell.
const SHELL = `<div id="page"><x-app><template shadowrootmode="open"><div id="row"><div class="box"><input type="password" name="password" aria-label="Password"></div>${button('Sign in')}</div></template></x-app><button id="cookies" type="button">Accept cookies</button>${chip.repeat(70)}</div>`;
test('probe 2: the scope stays in the shell’s root (none when cut short), so Accept cookies beside the shell isn’t a submit', async ({ page }) => {
  expect(await probe(page, SHELL, false, '#cookies')).toEqual({ scope: 'row', submits: false });
  expect(await probe(page, SHELL, true, '#cookies')).toEqual({ scope: null, submits: false });
});
