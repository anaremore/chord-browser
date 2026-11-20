/**
 * Providers' recipes in the agent (S17, phase 3D; packages/core/src/password-recipes.ts): applied to the classifier's
 * result for the recipe of the document's own host, in filling and saving mode alike, and to a click the click rule
 * didn't take. A recipe only adds: its roles go only to fields its selectors match, never to a sign-up's, change's or
 * reset's form; its submit is refused for the same words, states and places the click rule refuses (`safeSubmit`).
 */
import { recipeFor, type PasswordFieldRole, type PasswordFormClassification, type PasswordRecipe } from '@chord/core';
import { controlType, safeSubmit, type ScannedForm } from './scan';

const urlOf = Object.getOwnPropertyDescriptor(Document.prototype, 'URL')!.get!;

/** The recipe for a document, by its own address's host (a frame's own: a frame's agent runs on its document). */
export function recipeOf(doc: Document): PasswordRecipe | null {
  try {
    const url = new URL(String(urlOf.call(doc)));
    return url.protocol === 'https:' || url.protocol === 'http:' ? recipeFor(url.hostname) : null;
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
export const holdsRecipeField = (scanned: ScannedForm, recipe: PasswordRecipe): boolean =>
  scanned.elements.some((el) => matches(el, recipe.username) || (controlType(el) === 'password' && matches(el, recipe.password)));

/** Kinds a recipe never changes: a recipe is for signing in. */
const NOT_SIGN_IN = new Set(['sign-up', 'change', 'reset']);

/**
 * The classifier's result for `scanned`, with the recipe's fields given their roles: its username, and its password
 * when that's a `type=password` field. Shown, the password makes it a sign-in; without one shown, the username makes it
 * a first step. Any other field holding those roles loses them. Nothing the recipe doesn't match changes.
 */
export function withRecipe(scanned: ScannedForm, base: PasswordFormClassification | null, recipe: PasswordRecipe | null): PasswordFormClassification | null {
  if (!recipe || (base && NOT_SIGN_IN.has(base.kind))) return base;
  let user = -1;
  let pass = -1;
  scanned.elements.forEach((el, i) => {
    if (user < 0 && matches(el, recipe.username)) user = i;
    if (pass < 0 && controlType(el) === 'password' && matches(el, recipe.password)) pass = i;
  });
  if (user < 0 && pass < 0) return base;
  const fields = scanned.record.fields;
  const username = user >= 0 ? fields[user]! : (base?.username ?? null);
  const password = pass >= 0 ? fields[pass]! : (base?.password ?? null);
  const kind = password?.visible ? 'sign-in' : username ? 'username-only' : (base?.kind ?? 'sign-in');
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
