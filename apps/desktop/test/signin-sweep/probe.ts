/**
 * The sign-in sweep's script in each page (scripts/dev/signin-sweep): bundled with the agent as
 * the agent is built (src/passwords/build.ts) and run in isolated world 4440 of the page's main
 * frame, as Chord runs the agent, with a fake bridge that records what the agent would send main.
 *
 * Beside the agent it holds the sweep's own look at the page, made without the classifier: the
 * fields a person can see that look like a username or a password, the buttons that would move a
 * sign-in on, and the links that lead to one. The sweep compares the two. It only reads the page
 * and moves focus; the agent's fill is the only write, and nothing is ever submitted from here.
 */
import { classifyPasswordForm, type PasswordFieldRole } from '@chord/core';
import { startAgent } from '../../src/passwords/agent/agent';
import { controlType, isShown, scanDocument, SKIP_TYPES } from '../../src/passwords/agent/scan';

type Message = [string, Record<string, unknown>];

/** One field of the page as the sweep reports it: attributes and what the agent's classifier made of it, never a value. */
export interface ProbeField {
  /** Its index in `fields()` for `focus` and `valueOf`. */
  readonly i: number;
  /** The agent's form it's in (index among the scan's forms), or -1 when the scan didn't take it (shadow root, frame). */
  readonly form: number;
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly autocomplete: string;
  readonly label: string;
  readonly placeholder: string;
  readonly visible: boolean;
  readonly focusable: boolean;
  readonly readOnly: boolean;
  readonly inShadow: boolean;
  /** The classifier's role for it in filling mode, or null. */
  readonly role: PasswordFieldRole | null;
  /** The sweep's own guess, by type and words: a field a person would type a username or a password in. */
  readonly looks: 'password' | 'username' | 'code' | 'search' | 'other';
}

export interface ProbeForm {
  readonly i: number;
  readonly formless: boolean;
  readonly kind: string | null;
  readonly words: { submits: string[]; buttons: string[]; headings: string[]; title: string };
}

export interface ProbeSnapshot {
  readonly url: string;
  readonly title: string;
  readonly forms: ProbeForm[];
  readonly fields: ProbeField[];
  /** Visible text of the page, cut short: for the bot-wall and "sends a code" checks. */
  readonly text: string;
  /** Iframes on screen, with their address (the sweep looks inside them through Playwright). */
  readonly frames: { src: string; width: number; height: number }[];
}

const USERNAME_WORDS = /e-?mail|user|login|log in|sign in|account|phone|mobile|identifier|identity|member|customer|nickname|benutzer|courriel|correo|usuario|utilisateur|telefon|почт|логин|телефон|账号|帐号|用户|手机|邮箱|ユーザー|メール|아이디|이메일/i;
const CODE_WORDS = /\b(otp|one.?time|verification|captcha|code|pin|cvv|cvc|zip|postal)\b|验证码|код/i;
const SEARCH_WORDS = /search|query|\bq\b|suche|recherche|buscar|поиск|搜索|検索/i;

const shown = (el: Element) => {
  try {
    return isShown(el);
  } catch {
    return false;
  }
};

/** Every input of the document, open shadow roots included (the agent's scan leaves them for phase 3). */
function allInputs(root: Document | ShadowRoot, out: { el: HTMLInputElement | HTMLTextAreaElement; inShadow: boolean }[] = [], inShadow = false) {
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) out.push({ el, inShadow });
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) allInputs(sr, out, true);
    if (out.length > 3000) break;
  }
  return out;
}

function looksOf(el: HTMLInputElement | HTMLTextAreaElement, label: string): ProbeField['looks'] {
  const type = controlType(el);
  const ac = String(el.getAttribute('autocomplete') ?? '').toLowerCase();
  const words = `${el.id} ${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${label}`;
  if (type === 'password') return CODE_WORDS.test(words) && !/password|passwort|contraseña|mot de passe|пароль|密码/i.test(words) ? 'code' : 'password';
  if (/one-time-code/.test(ac) || (CODE_WORDS.test(words) && !USERNAME_WORDS.test(words))) return 'code';
  if (type === 'search' || SEARCH_WORDS.test(words)) return 'search';
  if (/\b(username|email|tel)\b/.test(ac)) return 'username';
  if (type === 'email' || type === 'tel') return 'username';
  if ((type === 'text' || type === 'textarea' || type === 'number') && USERNAME_WORDS.test(words)) return 'username';
  return 'other';
}

const messages: Message[] = [];
let onFill: ((payload: unknown) => void) | null = null;
let started = false;
let elements: (HTMLInputElement | HTMLTextAreaElement)[] = [];

function snapshot(): ProbeSnapshot {
  const scanned = scanDocument(document);
  const byElement = new Map<Element, { form: number; role: PasswordFieldRole | null; label: string }>();
  const forms: ProbeForm[] = scanned.map((s, i) => {
    const c = classifyPasswordForm(s.record, 'filling');
    s.elements.forEach((el, j) => {
      const rec = s.record.fields[j]!;
      byElement.set(el, { form: i, role: c?.roles.get(rec.key) ?? null, label: rec.label });
    });
    const w = s.record.words;
    return { i, formless: s.form === null, kind: c?.kind ?? null, words: { submits: [...w.submits], buttons: w.buttons.slice(0, 12), headings: w.headings.slice(0, 4), title: w.title } };
  });
  const inputs = allInputs(document).filter(({ el }) => !SKIP_TYPES.has(controlType(el)));
  elements = inputs.map(({ el }) => el);
  const fields: ProbeField[] = inputs.map(({ el, inShadow }, i) => {
    const known = byElement.get(el);
    const label = known?.label ?? String(el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? '');
    return {
      i,
      form: known?.form ?? -1,
      type: controlType(el),
      id: el.id.slice(0, 80),
      name: String(el.getAttribute('name') ?? '').slice(0, 80),
      autocomplete: String(el.getAttribute('autocomplete') ?? '').slice(0, 80),
      label: label.slice(0, 80),
      placeholder: String(el.getAttribute('placeholder') ?? '').slice(0, 80),
      visible: shown(el),
      focusable: !el.disabled && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true })),
      readOnly: el.readOnly,
      inShadow,
      role: known?.role ?? null,
      looks: looksOf(el, label),
    };
  });
  const frames = [...document.querySelectorAll('iframe')]
    .filter(shown)
    .map((f) => {
      const r = f.getBoundingClientRect();
      return { src: String(f.src).slice(0, 200), width: Math.round(r.width), height: Math.round(r.height) };
    })
    .slice(0, 20);
  const text = String(document.body?.innerText ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 4000);
  return { url: location.href, title: document.title.slice(0, 200), forms, fields, text, frames };
}

/** Words of links and buttons that lead to a sign-in, in the languages of the list's top sites. */
const SIGN_IN_LINK =
  /^(sign ?in|sign on|log ?in|log on|login|signin|sign in \/ register|log in \/ sign up|sign in or register|log in or sign up|my account|account|anmelden|einloggen|connexion|se connecter|s'identifier|iniciar sesi[oó]n|acceder|entrar|accedi|inloggen|zaloguj( się)?|войти|вход|giriş yap|ログイン|登录|登入|로그인|đăng nhập|masuk|เข้าสู่ระบบ)$/i;
const SIGN_IN_HREF = /(log-?in|sign-?in|signon|auth|account|sso|passport|session\/new)/i;

/** The page's way to its sign-in: a link's address, or where to click a button. */
function signInLink(): { href: string | null; x: number; y: number; text: string } | null {
  const found: { el: Element; score: number; text: string }[] = [];
  for (const el of document.querySelectorAll('a, button, [role=button], [role=link]')) {
    if (!shown(el)) continue;
    // Never a form's own button: pressing it could submit what's in the form.
    const form = el.closest('form');
    if (!(el instanceof HTMLAnchorElement) && (form?.querySelector('input:not([type=hidden])') || (el as HTMLButtonElement).type === 'submit')) continue;
    const text = String((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || text.length > 40) continue;
    const href = el instanceof HTMLAnchorElement ? el.href : '';
    let score = 0;
    if (SIGN_IN_LINK.test(text)) score += 10;
    else if (/\b(sign ?in|log ?in|login)\b/i.test(text) && !/sign ?up|register|create/i.test(text)) score += 6;
    if (href && SIGN_IN_HREF.test(href)) score += 3;
    if (/google|apple|facebook|microsoft|github/i.test(text)) score -= 20;
    if (score >= 6) found.push({ el, score, text });
  }
  found.sort((a, b) => b.score - a.score);
  const best = found[0];
  if (!best) return null;
  const r = best.el.getBoundingClientRect();
  const href = best.el instanceof HTMLAnchorElement && /^https?:/.test(best.el.href) ? best.el.href : null;
  return { href, x: r.left + r.width / 2, y: r.top + r.height / 2, text: best.text };
}

const NEXT_WORDS = /^(next|continue|weiter|suivant|continuer|siguiente|continuar|avanti|continua|volgende|doorgaan|dalej|далее|продолжить|devam|次へ|下一步|继续|다음|tiếp|lanjut|sign in|log ?in|login)\b/i;

/** The button that moves a first step on (Next, Continue), near field `i`: where to click it. */
function nextButton(i: number): { x: number; y: number; text: string } | null {
  const field = elements[i];
  if (!field) return null;
  let scope: Element | null = field.form ?? field.parentElement;
  for (let depth = 0; scope && depth < 14; depth++) {
    const buttons = [...scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(shown);
    for (const b of buttons) {
      const text = String(b instanceof HTMLInputElement ? b.value : (b as HTMLElement).innerText || b.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (NEXT_WORDS.test(text) && !/google|apple|facebook|microsoft|github|passkey|code|link/i.test(text)) {
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text };
      }
    }
    if (field.form) break;
    scope = scope.parentElement;
  }
  return null;
}

(globalThis as unknown as { chordSweep: unknown }).chordSweep = {
  start() {
    if (started) return;
    started = true;
    startAgent({
      send: (channel, payload) => void messages.push([channel, structuredClone(payload) as Record<string, unknown>]),
      onFill: (listener) => void (onFill ??= listener),
    });
  },
  messages: () => messages.slice(),
  clear: () => void (messages.length = 0),
  snapshot,
  signInLink,
  nextButton,
  /** Focus as a click would give it: scrolled into view first, as the browser does. */
  focus(i: number) {
    const el = elements[i];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    return document.activeElement === el;
  },
  blur() {
    (document.activeElement as HTMLElement | null)?.blur();
  },
  /** Where the fake values ended up after a fill: indexes of fields holding them. */
  holding(username: string, password: string) {
    return {
      username: elements.flatMap((el, i) => (el.value === username ? [i] : [])),
      password: elements.flatMap((el, i) => (el.value === password ? [i] : [])),
    };
  },
  /** Main's fill, as assist.ts sends it. */
  fill: (payload: unknown) => onFill?.(structuredClone(payload)),
};
