/**
 * The formless scope when the roots' index is cut short (review round 1 of #65): a partial index could miss a near
 * component's button and find a far one, a wider scope and more submits. Cut short, the scope ignores roots, as main's.
 */
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

const here = import.meta.dirname;
const chip = '<x-chip><template shadowrootmode="open"><span><slot></slot></span></template>tag</x-chip>';
const button = (label: string) => `<x-button><template shadowrootmode="open"><button><slot></slot></button></template>${label}</x-button>`;
// A far Sign in component first (the first root), then 70 roots, then a near one in the field's row.
const PAGE = `<div id="outer">${button('Sign in')}<div id="feed">${chip.repeat(70)}<div id="row"><div class="box"><input type="password" name="password" aria-label="Password"></div>${button('Next')}</div></div></div>`;

test('the roots’ index cut short (past ROOT_INDEX_MS): the scope ignores roots, never a wider one from part of them', async ({ page }) => {
  const script = await bundleAgent({ entry: join(here, 'scope-probe-entry.ts'), minify: true });
  await page.setContent(`<!doctype html><html><body>${PAGE}</body></html>`);
  expect(await page.evaluate(`${script}\n;globalThis.chordScopeProbe(false)`)).toBe('row');
  expect(await page.evaluate(`${script}\n;globalThis.chordScopeProbe(true)`)).toBeNull();
});
