/**
 * Round 3's probes of #65, the roots' index counted in full and cut short (past `ROOT_INDEX_MS`, on an injected clock):
 * whether a click on a button submits a formless sign-in, by `submitButtonFor`, against what main gives. Where main has
 * a scope, the answer is main's; in new territory (a field or button main can't see) it's strict, and a cut count keeps
 * to the field's own tree, so it never finds a wider scope than main's. Every page carries 70 roots, so the cut lands.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { bundleAgent } from '../../src/passwords/build';

const here = import.meta.dirname;
const chips = '<x-chip><template shadowrootmode="open"><span><slot></slot></span></template>tag</x-chip>'.repeat(70);
/** A button component labelled through its slot, the `#b` in its root. */
const button = (label: string, id = 'b') => `<x-button><template shadowrootmode="open"><button id="${id}"><slot></slot></button></template>${label}</x-button>`;
/** A wordless icon button component (an eye). */
const icon = (id = 'eye') => `<x-icon><template shadowrootmode="open"><button id="${id}" type="button"><svg width="12" height="12"></svg></button></template></x-icon>`;
/** A text field component: its input in its root, a slot for an eye. */
const xtf = (slotted = '') => `<x-tf><template shadowrootmode="open"><input type="password" name="password" aria-label="Password"><slot></slot></template>${slotted}</x-tf>`;
/** An app shell whose root holds `inner`. */
const shell = (inner: string) => `<x-app><template shadowrootmode="open">${inner}</template></x-app>`;
const LIGHT = '<div class="box"><input type="password" name="password" aria-label="Password"></div>';
const EYE = '<button id="eye" type="button"><svg width="12" height="12"></svg></button>';
const SIGN_IN = '<button id="go" type="button">Sign in</button>';
const COOKIES = '<button id="cookies" type="button">Accept cookies</button>';

/** The probe's answer on `html`, its index counted in full or cut short, for a click on `target` (in any root). */
async function probe(page: Page, html: string, truncate: boolean, target: string) {
  const script = await bundleAgent({ entry: join(here, 'scope-probe-entry.ts'), minify: true });
  await page.setContent(`<!doctype html><html><body>${chips}${html}</body></html>`);
  return ((await page.evaluate(`${script}\n;globalThis.chordScopeProbe(${truncate}, ${JSON.stringify(target)})`)) as { submits: boolean | null }).submits;
}

/** [probe, page, target, submits with the full index, cut short, what main gives]. */
const PROBES: readonly (readonly [string, string, string, boolean, boolean, boolean])[] = [
  ['P1: the page’s Sign in, an x-icon eye beside the field’s box', `<div><div class="row">${LIGHT}${icon()}</div>${SIGN_IN}</div>`, '#go', true, true, true],
  ['P1: …the x-icon eye', `<div><div class="row">${LIGHT}${icon()}</div>${SIGN_IN}</div>`, '#eye', false, false, false],
  ['P2: a wordless button beside a lone field in its own box', `<div>${LIGHT}${EYE}</div>`, '#eye', true, true, true],
  ['P2 in a shell', shell(`<div>${LIGHT}${EYE}</div>`), '#eye', true, true, true],
  ['P3: a slotted eye in the field component', `<div>${xtf(icon())}${SIGN_IN}</div>`, '#eye', false, false, false],
  ['P3: …Sign in beside it', `<div>${xtf(icon())}${SIGN_IN}</div>`, '#go', true, false, false],
  ['P4: a light eye beside a component field, Sign in beside it', `<div>${xtf()}${EYE}${SIGN_IN}</div>`, '#eye', false, false, false],
  ['P4: …Sign in', `<div>${xtf()}${EYE}${SIGN_IN}</div>`, '#go', true, false, false],
  ['P4 in a shell: the eye', shell(`<div>${xtf()}${EYE}${SIGN_IN}</div>`), '#eye', false, false, false],
  ['probe 1: P4 with a Sign in component: the eye', `<div>${xtf()}${EYE}${button('Sign in', 'go')}</div>`, '#eye', false, false, false],
  ['probe 1: …the Sign in component', `<div>${xtf()}${EYE}${button('Sign in', 'go')}</div>`, '#go', true, false, false],
  ['probe 2: a shell field and a Sign in component, Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}${button('Sign in', 'go')}</div>`)}${COOKIES}</div>`, '#cookies', false, false, false],
  ['probe 2: …the Sign in component', `<div>${shell(`<div class="row">${LIGHT}${button('Sign in', 'go')}</div>`)}${COOKIES}</div>`, '#go', true, false, false],
  ['probe 2b: a shell field, a div Sign in, Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}<div tabindex="0">Sign in</div></div>`)}${COOKIES}</div>`, '#cookies', false, false, false],
  ['probe 2c: a shell field (Enter only), Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}</div>`)}${COOKIES}</div>`, '#cookies', false, false, false],
  ['the x-tf cookie probe: a component field, no button near, Accept cookies', `<div><div class="row">${xtf()}</div>${COOKIES}</div>`, '#cookies', false, false, false],
  ['the x-tf cookie probe’s light twin, as main', `<div><div class="row">${LIGHT}</div>${COOKIES}</div>`, '#cookies', true, true, true],
];

for (const [name, html, target, full, cut, main] of PROBES) {
  for (const truncate of [false, true]) {
    const want = truncate ? cut : full;
    test(`${name}, the index ${truncate ? 'cut short' : 'counted in full'}: ${want ? 'submits' : 'no submit'} (main: ${main ? 'submits' : 'no submit'})`, async ({ page }) => {
      // CHORD_TABLE_MAIN=1, with main's scan swapped in, checks the `main` column itself.
      expect(await probe(page, html, truncate, target)).toBe(process.env['CHORD_TABLE_MAIN'] ? main : want);
    });
  }
}

// Cut short, never a submit main doesn't make: where main has none, none.
test('the table keeps to it: no cut-short submit where main has none', () => {
  for (const [name, , , , cut, main] of PROBES) expect({ name, cut: cut && !main }).toEqual({ name, cut: false });
});
