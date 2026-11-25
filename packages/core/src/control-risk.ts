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

declare const URL: new (url: string) => { pathname: string; search: string };

/** Why a step asks: the card's title says what will happen. */
/** `leave`: the assistant taking your tab to another site, or a page it asked for sending it on to one (S18 M2e-2c, B3). */
export type RiskWhy = 'submit' | 'pay' | 'send' | 'delete' | 'sign-out' | 'sign-up' | 'sign-in' | 'confirm' | 'leave';

/** A form, as the page's isolated world describes it (never a field's value). */
export interface RiskForm {
  /** `get`, `post`, `dialog` (lowercase; a form with none is `get`). */
  method: string;
  /** Inside (or itself) `role=search`. */
  search: boolean;
  /** Its visible `type=search` fields, and its hidden ones (`type=hidden`: they go with it unseen). */
  searchFields: number;
  hidden: number;
  /** More fields than the page described (past its cap): never a search, whatever it looks like. */
  overflow: boolean;
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
  /** What it shows, when that isn't its name (an `aria-label` that says *Save draft* on a button that reads *Pay $500*): both count. */
  text?: string;
  /** A link's address's words (its path and query), else empty. */
  href: string;
  /** A link whose address couldn't be read (too long, not decodable): asked, as unknown (#112 review 1). */
  hrefUnknown?: boolean;
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

/**
 * Words that make a click ask, by why; phrases as written. US English first, then German, French, Spanish, Portuguese,
 * Italian and Japanese (#112 review 1). Japanese is matched within the text (it has no spaces between words); the
 * rest as whole words and whole phrases.
 */
export const RISK_WORDS: Readonly<Record<Exclude<RiskWhy, 'submit' | 'sign-in' | 'leave'>, readonly string[]>> = {
  pay: [
    'pay', 'buy', 'purchase', 'place order', 'order', 'checkout', 'check out', 'complete order', 'donate', 'subscribe', 'upgrade', 'book', 'reserve', 'confirm purchase', 'transfer', 'withdraw',
    // de
    'bezahlen', 'zahlen', 'kaufen', 'bestellen', 'kasse', 'spenden', 'abonnieren', 'buchen', 'reservieren', 'überweisen', 'abheben',
    // fr
    'payer', 'acheter', 'commander', 'commande', 'abonner', 'réserver', 'virement', 'retirer',
    // es
    'pagar', 'comprar', 'pedido', 'donar', 'suscribirse', 'suscribir', 'reservar', 'transferir', 'retirar',
    // pt
    'finalizar compra', 'doar', 'assinar',
    // it
    'paga', 'pagare', 'acquista', 'compra', 'ordina', 'ordine', 'dona', 'abbonati', 'prenota', 'bonifico', 'preleva',
    // ja
    '支払', '購入', '注文', '決済', '寄付', '予約', '申し込', '振込', '送金',
  ],
  send: [
    'send', 'post', 'publish', 'reply', 'comment', 'share', 'invite', 'tweet', 'submit',
    // de
    'senden', 'absenden', 'abschicken', 'posten', 'veröffentlichen', 'antworten', 'kommentieren', 'teilen', 'einladen',
    // fr
    'envoyer', 'publier', 'répondre', 'commenter', 'partager', 'inviter',
    // es, pt
    'enviar', 'publicar', 'responder', 'comentar', 'compartir', 'invitar', 'compartilhar', 'convidar',
    // it
    'invia', 'inviare', 'pubblica', 'rispondi', 'commenta', 'condividi', 'invita',
    // ja
    '送信', '投稿', '返信', '共有', '招待',
  ],
  delete: [
    'delete', 'remove', 'trash', 'discard', 'erase', 'cancel subscription', 'close account', 'unsubscribe', 'revoke', 'destroy', 'archive',
    // de
    'löschen', 'entfernen', 'kündigen', 'abbestellen', 'archivieren',
    // fr
    'supprimer', 'effacer', 'résilier', 'désabonner', 'archiver',
    // es, pt
    'eliminar', 'borrar', 'quitar', 'excluir', 'apagar', 'remover', 'archivar', 'arquivar',
    // it
    'elimina', 'cancella', 'rimuovi', 'disiscriviti', 'archivia',
    // ja
    '削除', '消去', '解約', '退会',
  ],
  'sign-out': [
    'sign out', 'log out', 'logout', 'signout', 'sign off',
    // de, fr, es, pt, it
    'abmelden', 'ausloggen', 'déconnecter', 'déconnexion', 'cerrar sesión', 'terminar sessão', 'esci', 'disconnetti',
    // ja
    'ログアウト', 'サインアウト',
  ],
  'sign-up': [
    'sign up', 'signup', 'create account', 'register', 'accept', 'agree',
    // de
    'registrieren', 'konto erstellen', 'zustimmen', 'akzeptieren',
    // fr
    'inscrire', 'créer un compte', 'accepter',
    // es, pt
    'registrarse', 'crear cuenta', 'aceptar', 'cadastrar', 'criar conta', 'aceitar',
    // it
    'registrati', 'crea account', 'accetta',
    // ja
    '登録', '同意',
  ],
  confirm: [
    'confirm', 'continue', 'approve', 'proceed',
    // de
    'bestätigen', 'weiter', 'fortfahren', 'genehmigen',
    // fr
    'confirmer', 'continuer', 'valider', 'approuver',
    // es, pt
    'confirmar', 'continuar', 'aprobar', 'aprovar',
    // it
    'conferma', 'continua', 'approva',
    // ja
    '確認', '確定', '承認', '次へ',
  ],
};

/** Which why wins when words of more than one are there: the costliest first. */
const ORDER: readonly RiskWhy[] = ['pay', 'delete', 'sign-out', 'sign-up', 'sign-in', 'send', 'confirm', 'submit'];

/** A phrase written in Japanese (kana or kanji): matched within the text, which has no spaces between words. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff]/u;

/** The words a text has, lowercase, split on anything that isn't a letter or a digit (camelCase split too). */
function wordsOf(text: string): string[] {
  return text
    // Format and control characters first: `P\u200Bay` is pay (#112 review 1).
    // Stray combining marks too (U+034F, Neon's review 2 of #112), after composing what composes (NFKC: full-width and other compatibility forms read as plain letters).
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Mn}]/gu, '')
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
/**
 * Words a button or a step's name counts, but an address doesn't: `/archive/2024` is a page of old posts, not a
 * delete (the final pass of #112).
 */
const NOT_IN_ADDRESSES: ReadonlySet<string> = new Set(['archive', 'archiver']);

export function riskWordsWhy(text: string, only: readonly (keyof typeof RISK_WORDS)[] = ['pay', 'delete', 'sign-out', 'sign-up', 'send', 'confirm'], skip: ReadonlySet<string> = new Set()): RiskWhy | null {
  const words = wordsOf(text);
  const lower = text.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Mn}]/gu, '').toLowerCase();
  for (const why of ORDER) {
    if (!(only as readonly string[]).includes(why)) continue;
    if (RISK_WORDS[why as keyof typeof RISK_WORDS].some((w) => !skip.has(w) && (CJK.test(w) ? lower.includes(w) : has(words, w)))) return why;
  }
  return null;
}

/**
 * A form that's a search: GET, one visible text field and nothing else, hidden fields included (#112 review 1: a
 * one-field GET form with a hidden `action=delete` is no search), and that field a search field or the form inside (or
 * itself) `role=search`. `role=search` never exempts more than that (Neon's review 2: a multi-field GET form, or one
 * with hidden fields, isn't a search for saying it is). A form described only in part (past the page's cap) is never one.
 */
function isSearch(form: RiskForm): boolean {
  if (form.method !== 'get' || form.overflow) return false;
  if (form.textFields !== 1 || form.otherFields !== 0 || form.hidden !== 0) return false;
  return form.search || form.searchFields === 1;
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
  const named = `${el.name} ${el.text ?? ''}`;
  if (el.submits) return el.form ? formSubmit(el.form, { ...el, name: named }) : risky('submit');
  // A link: its name, and its address for deleting and signing out only (a link to /items/7/delete deletes, whatever
  // it's called; one to /checkout or /post/12 is still reading until a button there is pressed).
  if (el.tag === 'a' && el.hrefUnknown) return risky('confirm');
  if (el.tag === 'a' && el.href !== '') {
    const byName = riskWordsWhy(named);
    const byAddress = riskWordsWhy(el.href, ['delete', 'sign-out'], NOT_IN_ADDRESSES);
    const why = [byName, byAddress].filter((w): w is RiskWhy => w !== null).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
    return why ? risky(why) : ACT;
  }
  const why = riskWordsWhy(named);
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
        // Enter in a form's other inputs (a box, a radio, a read-only field) submits it too (implicit submission).
        if (el.tag === 'input' && el.form && !el.submits) return formSubmit(el.form, el);
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
    confirm: 'Confirm this',
    leave: 'Go to',
  };
  if (why === 'leave') return `Go to ${site}?`;
  return `${what[why]} on ${site}?`;
}

/**
 * The card when an action sends data (the owner's default, 2026-11-23; mocks/agents-s18-m2.html §2b): *Send data to
 * mail.example?*, or *Send data to 3 sites?*.
 */
export function sendTitle(sites: readonly string[]): string {
  return sites.length === 1 ? `Send data to ${sites[0]}?` : `Send data to ${sites.length} sites?`;
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

/**
 * An address an agent goes to (navigate, back): its path and query's words for deleting and signing out, as a link's
 * (#112 review 1: `navigate('/account/logout')` signs you out as clicking a link there would).
 */
export function addressWhy(url: string): RiskWhy | null {
  let u: { pathname: string; search: string };
  try {
    u = new URL(url);
  } catch {
    // One that can't be read is unknown: it asks (Neon's review 2 of #112).
    return 'confirm';
  }
  // An address that can't be read (not decodable, or past what's read of it) is unknown: it asks (#112 review 1).
  if (url.length > 2048) return 'confirm';
  try {
    return riskWordsWhy(`${decodeURIComponent(u.pathname)} ${decodeURIComponent(u.search)}`, ['delete', 'sign-out'], NOT_IN_ADDRESSES);
  } catch {
    return 'confirm';
  }
}

/**
 * An address a page sends to or goes to itself (control/sends.ts: a request, a frame, a redirect): its words for
 * deleting and signing out, as addressWhy's, but never *unknown*. Pages load long and oddly escaped addresses all the
 * time (an ad frame's), and asking for each would be noise (Claude's review 4 of #112): one too long is read up to
 * its first 2,048 characters, one that can't be decoded is read as written. Only the agent's own addresses (navigate,
 * back, open_tab) ask when they can't be read (addressWhy).
 */
export function pageAddressWhy(url: string): RiskWhy | null {
  let u: { pathname: string; search: string };
  try {
    u = new URL(url.slice(0, 2048));
  } catch {
    return null;
  }
  const decoded = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  return riskWordsWhy(`${decoded(u.pathname)} ${decoded(u.search)}`, ['delete', 'sign-out'], NOT_IN_ADDRESSES);
}

/** How long an Allow given after the agent heard *waiting* counts for that same step (tab, page, ref, action). */
export const STEP_LATE_MS = 120_000;
