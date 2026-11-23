/**
 * Risky steps (S18 M2d; docs/decisions/S18-agent-mcp.md, "What counts as risky"). Every action an agent takes on a
 * page is classified before it's sent, from what Chord's isolated world sees of the element (never from the agent's
 * words): `act` (the site card's yes covers it), `risky` with a why (asks every time, the step card), or `refused`.
 * Generous on purpose: a step that asks needlessly costs a click; one that doesn't ask costs much more. Pages never
 * lower the bar: their hints can only make a step ask.
 *
 * Words are matched as whole words (and whole phrases), whatever their case, in US English; other languages fall back
 * on the structure (a form's submit asks whatever its words; payment and password fields need none).
 */
import type { PressKey } from './control-act';

/** Why a step asks: the card's title says what will happen. */
export type RiskWhy = 'submit' | 'pay' | 'send' | 'delete' | 'sign-out' | 'sign-up' | 'sign-in';

/** A form, as the page's isolated world describes it (never a field's value). */
export interface RiskForm {
  /** `get`, `post`, `dialog` (lowercase; a form with none is `get`). */
  method: string;
  /** Inside `role=search`, or with a `type=search` field. */
  search: boolean;
  /** Its text fields (text, email, search, url, tel, number, a text area) and its other fields (a select, a box, a radio). */
  textFields: number;
  otherFields: number;
  /** A payment field (`autocomplete` `cc-*` or `transaction-amount`, or forms' payment words). */
  payment: boolean;
  /** A password field. */
  password: boolean;
  /** Its fields' labels, in order (the page's words, for the card: never values). */
  labels: string[];
  /** Words of its action address (its path and query), for a delete or sign-out address. */
  action: string;
}

/** An element an agent acts on, as the page's isolated world describes it. */
export interface RiskElement {
  tag: string;
  role: string;
  /** An input's or a button's type, lowercase (`submit`, `button`, `text`…), else empty. */
  type: string;
  /** Its name, as the snapshot gave it. */
  name: string;
  /** A link's address's words (its path and query), else empty. */
  href: string;
  /** It takes text: a text field, a text area, an editor. */
  editable: boolean;
  /** It takes lines (a text area, an editor), where Enter is a newline or a send. */
  multiline: boolean;
  /** Clicking it submits its form (a submit button, an image input). */
  submits: boolean;
  /** Its form (a field's, a submit button's), if any. */
  form: RiskForm | null;
}

/** The action, as the tool was asked for. */
export type RiskAction =
  | { tool: 'click' | 'hover' | 'select_option' }
  | { tool: 'type'; submit: boolean }
  | { tool: 'press_key'; key: PressKey };

export type RiskClass = { class: 'act' } | { class: 'risky'; why: RiskWhy };

const ACT: RiskClass = { class: 'act' };
const risky = (why: RiskWhy): RiskClass => ({ class: 'risky', why });

/** Words that make a click ask, by why; phrases as written. */
export const RISK_WORDS: Readonly<Record<Exclude<RiskWhy, 'submit' | 'sign-in'>, readonly string[]>> = {
  pay: ['pay', 'buy', 'purchase', 'place order', 'checkout', 'check out', 'complete order', 'donate', 'subscribe', 'upgrade', 'book', 'reserve', 'confirm purchase'],
  send: ['send', 'post', 'publish', 'reply', 'comment', 'share', 'invite', 'tweet', 'submit'],
  delete: ['delete', 'remove', 'trash', 'discard', 'erase', 'cancel subscription', 'close account', 'unsubscribe', 'revoke', 'destroy'],
  'sign-out': ['sign out', 'log out', 'logout', 'signout', 'sign off'],
  'sign-up': ['sign up', 'signup', 'create account', 'register', 'accept', 'agree'],
};

/** Which why wins when words of more than one are there: the costliest first. */
const ORDER: readonly RiskWhy[] = ['pay', 'delete', 'sign-out', 'sign-up', 'sign-in', 'send', 'submit'];

/** The words a text has, lowercase, split on anything that isn't a letter or a digit (camelCase split too). */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether `words` has `phrase` (one word, or several in a row). */
function has(words: readonly string[], phrase: string): boolean {
  const parts = phrase.split(' ');
  for (let i = 0; i + parts.length <= words.length; i++) if (parts.every((p, j) => words[i + j] === p)) return true;
  return false;
}

/** The costliest why the words of `text` name, or null. `only`: the whys to look for. */
export function riskWordsWhy(text: string, only: readonly (keyof typeof RISK_WORDS)[] = ['pay', 'delete', 'sign-out', 'sign-up', 'send']): RiskWhy | null {
  const words = wordsOf(text);
  for (const why of ORDER) {
    if (!(only as readonly string[]).includes(why)) continue;
    if (RISK_WORDS[why as keyof typeof RISK_WORDS].some((w) => has(words, w))) return why;
  }
  return null;
}

/** A form that's a search: GET, and inside `role=search`, or with a search field, or one text field and nothing else. */
function isSearch(form: RiskForm): boolean {
  return form.method === 'get' && (form.search || (form.textFields === 1 && form.otherFields === 0));
}

/**
 * What submitting `form` (by `el`, its button or a field in it) is. Its fields first (payment, a password), then a
 * search (reading), then the costliest why its button's words or its action address give (a form's own `send` word
 * isn't stronger than *submit*: the mock's *Submit this form* for *Send return request*), else *submit*.
 */
function formSubmit(form: RiskForm, el: RiskElement): RiskClass {
  if (form.payment) return risky('pay');
  if (form.password) return risky('sign-in');
  const named = riskWordsWhy(`${el.submits ? el.name : ''} ${form.action}`, ['pay', 'delete', 'sign-out', 'sign-up']);
  if (named) return risky(named);
  if (isSearch(form)) return ACT;
  return risky('submit');
}

/** Clicking `el` (or Enter or Space on a button or a link, which is the same). */
function click(el: RiskElement): RiskClass {
  if (el.submits) return el.form ? formSubmit(el.form, el) : risky('submit');
  // A link: its name, and its address for deleting and signing out only (a link to /items/7/delete deletes, whatever
  // it's called; one to /checkout or /post/12 is still reading until a button there is pressed).
  if (el.tag === 'a' && el.href !== '') {
    const byName = riskWordsWhy(el.name);
    const byAddress = riskWordsWhy(el.href, ['delete', 'sign-out']);
    const why = [byName, byAddress].filter((w): w is RiskWhy => w !== null).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
    return why ? risky(why) : ACT;
  }
  const why = riskWordsWhy(el.name);
  return why ? risky(why) : ACT;
}

/** The step an action is: act, or risky and why. Refusals (a password field, a file input, a frame) come before this. */
export function classifyStep(action: RiskAction, el: RiskElement): RiskClass {
  switch (action.tool) {
    case 'hover':
    case 'select_option':
      return ACT;
    case 'click':
      return click(el);
    case 'type':
      if (!action.submit) return ACT;
      // Enter after text: its form's submit; in no form, how a chat box sends.
      return el.form && !el.multiline ? formSubmit(el.form, el) : risky('send');
    case 'press_key': {
      const key = action.key;
      if (key === 'Enter') {
        if (el.editable) return el.multiline || !el.form ? risky('send') : formSubmit(el.form, el);
        return click(el);
      }
      if (key === 'Space' && !el.editable) return click(el);
      if ((key === 'Delete' || key === 'Backspace') && !el.editable) return risky('delete');
      return ACT;
    }
  }
}

/** The step card's title, for the why and the site: *Place the order on shop.example?* */
export function stepTitle(why: RiskWhy, site: string): string {
  const what: Record<RiskWhy, string> = {
    submit: 'Submit this form',
    pay: 'Place the order',
    send: 'Send this',
    delete: 'Delete this',
    'sign-out': 'Sign out',
    'sign-up': 'Create an account',
    'sign-in': 'Sign in',
  };
  return `${what[why]} on ${site}?`;
}

/** Allow in the danger color: paying and deleting. */
export function stepDanger(why: RiskWhy): boolean {
  return why === 'pay' || why === 'delete';
}

/** What goes with a form, by label, for the card: up to 6, then how many more (never values). */
export function stepFields(labels: readonly string[]): { fields: string[]; more: number } {
  const clean = labels.map((l) => l.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()).filter(Boolean).map((l) => (l.length > 60 ? `${l.slice(0, 59)}…` : l));
  return { fields: clean.slice(0, 6), more: Math.max(0, clean.length - 6) };
}

/** How long an Allow given after the agent heard *waiting* counts for that same step (tab, page, ref, action). */
export const STEP_LATE_MS = 120_000;
