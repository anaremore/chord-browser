/**
 * Providers' recipes in the agent (S17, phase 3D; packages/core/src/password-recipes.ts): applied to the classifier's
 * result for the recipe of the document's own host, in filling and saving mode alike, and to a click the click rule
 * didn't take. A recipe only adds: its roles go only to fields its selectors match, never to a sign-up's, change's or
 * reset's form; its submit is refused for the same words, states and places the click rule refuses (`safeSubmit`).
 */
import { recipeFor, type PasswordField, type PasswordFieldRole, type PasswordFormClassification, type PasswordRecipe } from '@chord/core';
import { controlType, safeSubmit, type ScannedForm } from './scan';

const urlOf = Object.getOwnPropertyDescriptor(Document.prototype, 'URL')!.get!;

/**
 * The recipe for a document, by its own address's host (a frame's own: a frame's agent runs on its document). Over
 * `https:` only: the providers' pages are (review round 1 of #70).
 */
export function recipeOf(doc: Document): PasswordRecipe | null {
  try {
    const url = new URL(String(urlOf.call(doc)));
    return url.protocol === 'https:' ? recipeFor(url.hostname) : null;
  } catch {
    return null;
  }
}

const matches = (el: Element, selectors: readonly string[] | undefined): boolean =>
  !!selectors?.some((s) => {
    try {
      return Element.prototype.matches.call(el, s);
    } catch {
      return false;
    }
  });

/** Whether a scanned form holds a field one of the recipe's field selectors matches. */
const holdsRecipeField = (scanned: ScannedForm, recipe: PasswordRecipe): boolean =>
  scanned.elements.some((el) => matches(el, recipe.username) || (controlType(el) === 'password' && matches(el, recipe.password)));

/** Kinds a recipe never changes: a recipe is for signing in. */
const NOT_SIGN_IN = new Set(['sign-up', 'change', 'reset']);

/** A field you can see, or typed in or had filled: the classifier's own test for a usable one. */
const shownOrUsed = (f: PasswordField) => f.visible || f.userTyped || f.autofilled;
/** A password field you could type in now (as the agent's `usable` and the classifier's `usablePassword` say). */
const usablePassword = (f: PasswordField) => shownOrUsed(f) && (!f.readOnly || f.userTyped || f.autofilled);

/**
 * The classifier's result for `scanned`, with the recipe's fields given their roles: its username (shown, or carried
 * hidden into a password step), and its password when that's a `type=password` field you could type in now (review
 * round 1 of #70: a hidden one is a later step's, or a decoy). With that password, the form is a sign-in; without it,
 * a shown username makes it a first step. Any other field holding those roles loses them. Nothing the recipe doesn't
 * match changes, and a recipe that finds only a hidden field changes nothing.
 */
export function withRecipe(scanned: ScannedForm, base: PasswordFormClassification | null, recipe: PasswordRecipe | null): PasswordFormClassification | null {
  if (!recipe || (base && NOT_SIGN_IN.has(base.kind))) return base;
  let user = -1;
  let pass = -1;
  const fields = scanned.record.fields;
  scanned.elements.forEach((el, i) => {
    if (user < 0 && matches(el, recipe.username)) user = i;
    if (pass < 0 && controlType(el) === 'password' && matches(el, recipe.password) && fields[i] && usablePassword(fields[i])) pass = i;
  });
  const username = user >= 0 ? fields[user]! : (base?.username ?? null);
  // The recipe's own password; else the classifier's, where it read a sign-in; else a first step, by a shown username.
  const password = pass >= 0 ? fields[pass]! : base?.kind === 'sign-in' ? base.password : null;
  let kind: PasswordFormClassification['kind'];
  if (password && (pass >= 0 || user >= 0)) kind = 'sign-in';
  else if (!password && user >= 0 && shownOrUsed(fields[user]!)) kind = 'username-only';
  else return base;
  const roles = new Map<number, PasswordFieldRole>(base?.roles ?? []);
  for (const [key, role] of roles) {
    if (key === username?.key || key === password?.key || role === 'username' || (role === 'current-password' && password)) roles.delete(key);
  }
  if (username) roles.set(username.key, 'username');
  if (kind === 'sign-in' && password) roles.set(password.key, 'current-password');
  return { kind, roles, username, password: kind === 'sign-in' ? password : null, newPassword: null, confirmation: null };
}

/**
 * A click on (or in) an element a recipe's `submits` selector matches: the form holding the recipe's fields, when the
 * click rule's own refusals let it (`safeSubmit`: never a toggle's, help's or another way in's words, a pressed button,
 * one holding or controlling the field, or the password's own wrapper's).
 */
export function recipeSubmit<T extends { readonly scanned: ScannedForm; readonly classified: PasswordFormClassification | null }>(
  target: Element,
  recipe: PasswordRecipe | null,
  forms: readonly T[],
  anchorOf: (form: T) => Element | null,
): T | null {
  if (!recipe?.submits?.length) return null;
  let button: Element | null = null;
  for (const s of recipe.submits) {
    try {
      button = Element.prototype.closest.call(target, s);
    } catch {
      button = null;
    }
    if (button) break;
  }
  if (!button) return null;
  const k = forms.find((f) => f.classified && !NOT_SIGN_IN.has(f.classified.kind) && holdsRecipeField(f.scanned, recipe));
  const anchor = k ? anchorOf(k) : null;
  return k && anchor && safeSubmit(button, anchor) ? k : null;
}
