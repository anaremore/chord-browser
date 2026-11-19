/**
 * Formless submits with a component in the way (#65's review rounds), by `submitButtonFor`: every probe gives main's
 * answer. A field or button main can't see (in a component's root) gets none: component-button submits are a known gap,
 * deferred to their own issue, with round 4's three blockers (B1 to B3) kept here as rows.
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
/** An open root holding `inner`: an app shell, or a component around the field. */
const shell = (inner: string) => `<x-app><template shadowrootmode="open">${inner}</template></x-app>`;
const LIGHT = '<div class="box"><input type="password" name="password" aria-label="Password"></div>';
const EYE = '<button id="eye" type="button"><svg width="12" height="12"></svg></button>';
const SIGN_IN = '<button id="go" type="button">Sign in</button>';
const COOKIES = '<button id="cookies" type="button">Accept cookies</button>';

async function probe(page: Page, html: string, target: string) {
  const script = await bundleAgent({ entry: join(here, 'scope-probe-entry.ts'), minify: true });
  await page.setContent(`<!doctype html><html><body>${chips}${html}</body></html>`);
  return (await page.evaluate(`${script}\n;globalThis.chordScopeProbe(${JSON.stringify(target)})`)) as boolean | null;
}

/** [probe, page, target, main's answer: submits or not]. `gap`: a component submit main doesn't make, deferred. */
const PROBES: readonly (readonly [string, string, string, boolean, ('gap' | '')?])[] = [
  ['P1: the page’s Sign in, an x-icon eye beside the field’s box', `<div><div class="row">${LIGHT}${icon()}</div>${SIGN_IN}</div>`, '#go', true],
  ['P1: …the x-icon eye', `<div><div class="row">${LIGHT}${icon()}</div>${SIGN_IN}</div>`, '#eye', false],
  ['P2: a wordless button beside a lone field in its own box', `<div>${LIGHT}${EYE}</div>`, '#eye', true],
  ['P2 in a shell', shell(`<div>${LIGHT}${EYE}</div>`), '#eye', true],
  ['P3: a slotted eye in the field component', `<div>${xtf(icon())}${SIGN_IN}</div>`, '#eye', false],
  ['P3: …Sign in beside it', `<div>${xtf(icon())}${SIGN_IN}</div>`, '#go', false, 'gap'],
  ['P4: a light eye beside a component field', `<div>${xtf()}${EYE}${SIGN_IN}</div>`, '#eye', false],
  ['P4: …Sign in', `<div>${xtf()}${EYE}${SIGN_IN}</div>`, '#go', false, 'gap'],
  ['P4’s light twin: the eye, as main', `<div>${LIGHT}${EYE}${SIGN_IN}</div>`, '#eye', true],
  ['probe 1: P4 with a Sign in component', `<div>${xtf()}${EYE}${button('Sign in', 'go')}</div>`, '#go', false, 'gap'],
  ['probe 2: a shell field, a Sign in component, Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}${button('Sign in', 'go')}</div>`)}${COOKIES}</div>`, '#cookies', false],
  ['probe 2: …the Sign in component', `<div>${shell(`<div class="row">${LIGHT}${button('Sign in', 'go')}</div>`)}${COOKIES}</div>`, '#go', false, 'gap'],
  ['probe 2b: a shell field, a div Sign in, Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}<div tabindex="0">Sign in</div></div>`)}${COOKIES}</div>`, '#cookies', false],
  ['probe 2c: a shell field (Enter only), Accept cookies beside the shell', `<div>${shell(`<div class="row">${LIGHT}</div>`)}${COOKIES}</div>`, '#cookies', false],
  ['the x-tf cookie probe', `<div><div class="row">${xtf()}</div>${COOKIES}</div>`, '#cookies', false],
  ['the x-tf cookie probe’s light twin, as main', `<div><div class="row">${LIGHT}</div>${COOKIES}</div>`, '#cookies', true],
  // Round 4's blockers (B1 to B3), as rows: none, as main.
  ...(
    [
      ['an svg', '<svg id="eye" width="12" height="12"></svg>'],
      ['an aria-hidden button', '<button id="eye" type="button" aria-hidden="true"><svg width="12" height="12"></svg></button>'],
      ['a tabindex=-1 button', '<button id="eye" type="button" tabindex="-1"><svg width="12" height="12"></svg></button>'],
      ['a span[role=button]', '<span id="eye" role="button"><svg width="12" height="12"></svg></span>'],
    ] as const
  ).flatMap(([what, eye]) => [
    [`B1: ${what} eye in a .pw-wrap beside x-tf`, `<div><div class="pw-wrap">${xtf()}${eye}</div>${SIGN_IN}</div>`, '#eye', false] as const,
    [`B1: …Sign in outside the wrapper (${what})`, `<div><div class="pw-wrap">${xtf()}${eye}</div>${SIGN_IN}</div>`, '#go', false, 'gap'] as const,
  ]),
  ...['Sign in another way', 'Sign in using Google', 'Sign in with Amazon', 'Sign in with a code', 'Sign in with email link', 'Sign in instead'].map(
    (label) => [`B2: “${label}” beside a component field`, `<div>${xtf()}<button id="go" type="button">${label}</button></div>`, '#go', false] as const,
  ),
  ['B3: a div Sign in, the field two roots deep', `<div>${shell(`<div>${xtf()}</div>`)}<div id="go" tabindex="0">Sign in</div></div>`, '#go', false],
  ['B3: a div Sign in, the field three roots deep', `<div>${shell(shell(`<div>${xtf()}</div>`))}<div id="go" tabindex="0">Sign in</div></div>`, '#go', false],
  ['B3: a div Sign in beside a field in a 100-element root', `<div>${shell(`<div>${'<span></span>'.repeat(100)}${LIGHT}</div>`)}<div id="go" tabindex="0">Sign in</div></div>`, '#go', false],
];

for (const [name, html, target, main, gap] of PROBES) {
  test(`${name}: ${main ? 'submits' : 'no submit'}, as main${gap ? ' (a component submit main doesn’t make: a known gap, deferred)' : ''}`, async ({ page }) => {
    expect(await probe(page, html, target)).toBe(main);
  });
}
