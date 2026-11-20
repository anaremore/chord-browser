/**
 * Recipes for named providers' sign-in pages (S17, phase 3D): where the generic detector struggles, a provider's own
 * fields and submit buttons, by CSS selector. The agent applies the recipe of its document's own host, after its scan
 * and classifier, and only adds to them:
 * - a field a recipe's `username` or `password` selector matches, in a form the scan found, gets that role (a password
 *   only on a `type=password` field); the form reads as a sign-in with a visible password, a first step without one;
 * - an element a recipe's `submits` selector matches (or holds the click) submits the form holding the recipe's fields,
 *   but only through the click rule's own refusals: never a button that reads as a toggle, help or another way in,
 *   never a pressed one, one holding the field or controlling it, or the password's own wrapper's (`recipeSubmit`);
 * - a recipe never makes a frame usable (the frames' rules come first) and never reaches past its host's documents.
 * A selector that matches nothing changes nothing: a provider's redesign falls back to the generic detector.
 *
 * Each recipe says when its selectors were last checked against the provider's public sign-in page (`verified`), by
 * scripts/dev/signin-sweep/providers.mjs, read only. Only the selectors a recipe needs come from those pages.
 */

export interface PasswordRecipe {
  /** The provider, for people. */
  readonly name: string;
  /** Hosts, exact, or `*.example.com` for any host under it (never `example.com` itself). Lower case. */
  readonly hosts: readonly string[];
  /** The day the selectors were last checked against the provider's public pages (YYYY-MM-DD). */
  readonly verified: string;
  /** The username's or email's field, on any step. */
  readonly username?: readonly string[];
  /** The current password's field. */
  readonly password?: readonly string[];
  /** What submits a step (a Next or Sign in the click rule doesn't see as one). */
  readonly submits?: readonly string[];
}

export const PASSWORD_RECIPES: readonly PasswordRecipe[] = [
  {
    name: 'Google',
    hosts: ['accounts.google.com'],
    verified: '2026-11-19',
    // The identifier step's email, and the password step's (the identifier carried, hidden).
    username: ['#identifierId', 'input[type="email"][name="identifier"]'],
    password: ['input[type="password"][name="Passwd"]'],
    // Next is a button outside the <form>, in its own wrapper: the click rule never sees it as the form's.
    submits: ['#identifierNext button', '#passwordNext button'],
  },
  {
    name: 'Microsoft',
    hosts: ['login.microsoftonline.com', 'login.live.com'],
    verified: '2026-11-19',
    username: ['input[name="loginfmt"]', '#usernameEntry'],
    password: ['input[name="passwd"]'],
    submits: ['#idSIButton9'],
  },
  {
    name: 'Okta',
    hosts: ['*.okta.com', '*.oktapreview.com', '*.okta-emea.com'],
    verified: '2026-11-19',
    // The Identity Engine's widget, and the classic one.
    username: ['input[name="identifier"]', '#okta-signin-username'],
    password: ['input[name="credentials.passcode"]', '#okta-signin-password'],
    submits: ['#okta-signin-submit'],
  },
  {
    name: 'Auth0',
    hosts: ['*.auth0.com'],
    verified: '2026-11-19',
    // Universal Login: one form per step, its submit `name="action"`, the step's own `value="default"`.
    username: ['input#username[name="username"]'],
    password: ['input#password[name="password"]'],
    submits: ['button[type="submit"][name="action"][value="default"]'],
  },
];

/** Whether `host` is one of a recipe's hosts. */
export const recipeHostMatches = (pattern: string, host: string): boolean => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern);

/** The recipe for a document's host, or null. */
export function recipeFor(host: string, recipes: readonly PasswordRecipe[] = PASSWORD_RECIPES): PasswordRecipe | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  return recipes.find((r) => r.hosts.some((p) => recipeHostMatches(p, h))) ?? null;
}
