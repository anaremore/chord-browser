/**
 * The passwords agent (S17 §4, §6, §8): runs in isolated world 4440 of a tab's main frame,
 * woken by the sentinel preload (preload/passwords.ts) on a page with a sign-in field. Page
 * scripts can't see or change it, nor can the assistant's world (4400). It adds nothing to
 * the page: no attribute, class, element or style, only capturing listeners on the document
 * and, for 10 s after a submit signal, a MutationObserver and a PerformanceObserver.
 *
 * What it tells main, through the bridge, never with a field's value:
 * - `forms`: the page's credential forms by their fields' type, id and name, after a scan that
 *   changes them (the reappeared-form check, S17 §6);
 * - `focus` / `blur`: a sign-in field took or lost focus, with its box (the menu, later);
 * - `candidate`: a form you typed a password in, once per submit signal, or as you left the
 *   field after typing in it (at most once a second);
 *
 * `forms`, `focus` and `blur` go out together, at most once an animation frame (or 100 ms, where
 * frames don't come: a background tab), with the last state only and nothing that's unchanged: a
 * page that moves focus, scrolls or adds fields in a loop sends a message a frame, not one a call.
 * Scans run at most once in `SCAN_GAP_MS`. Main limits each page's rate as well.
 * - `gone` / `still`: after a submit signal, whether the password field went within 10 s;
 * - `hint`: a request to the page's own origin finished after a submit signal, with its status;
 * - `filled`: whether a fill main sent was written, and if not why: the form changed, or the fill would have left a
 *   password field empty (never half a fill).
 *
 * **Filling** (S17 §5): main sends the account you picked in the menu (`onFill`), for the form
 * it was shown for. The page is scanned again, and nothing is written unless that form is still
 * there with a password field that's `type=password`, both fields connected, enabled, shown
 * (`checkVisibility` with opacity, a few pixels at least) and one of them on screen. The values
 * go in with the native setter from this world and `input` and `change`, as the assistant's fill
 * does (§11.6), and each field is outlined for a moment with the Web Animations API: nothing is
 * added to the page.
 *
 * Values are read to classify a form for saving (Chromium's saving mode compares them) and to
 * say whether the username and password are filled in, from that form's own fields. They
 * leave this world once per submit: the candidate sent at a submit signal carries the
 * username and the password to save (`values`), so the save card can keep them. A candidate
 * sent as you leave a field carries none, and nothing else ever does.
 */
import { classifyPasswordForm, PASSWORD_LIMITS, type PasswordField, type PasswordFieldRole, type PasswordFormClassification, type PasswordFormKind } from '@chord/core';
import type { PasswordsAgentChannel, PasswordsAgentMessage, PasswordsFieldSignature, PasswordsFill } from '@chord/ipc';
import { activeElementOf, controlType, isShown, MAX_REPORTED_FORMS, scanDocument, SKIP_TYPES, submitButtonFor, type ScannedForm } from './scan';

/** What the sentinel exposes in this world (contextBridge.exposeInIsolatedWorld). */
export interface PasswordsBridge {
  send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>): void;
  /** Main's fill: the sentinel calls this listener (registered once) with what main sent. */
  onFill?(listener: (payload: unknown) => void): void;
}

/** How long after a submit signal the agent watches for the form to go, and for the page's requests (S17 §6, step 3). */
export const SUBMIT_WATCH_MS = 10_000;
/** At most this many `hint`s per submit: the first few requests say enough. */
const MAX_HINTS = 3;
/** Submit signals for one form within this long are one submit: Enter, then the form's `submit`, then the click a browser makes. */
export const ONE_SUBMIT_MS = 1000;
/** A scan of the page runs at most this often; one wanted sooner runs at the next flush. */
const SCAN_GAP_MS = 50;
/** The flush runs on the next animation frame, or after this long if frames don't come. */
const FLUSH_MS = 100;
/**
 * `focus` goes out at most this often, with a trailing flush: a smooth scroll moves the field every
 * frame, and at 60 a second main's bucket (20 a second) would drop the last box. At 10 a second the
 * last state always gets through.
 */
const FOCUS_GAP_MS = 100;
/** `forms` is cut to stay within this many JSON characters: well under the channel's limit (PASSWORDS_MESSAGE_MAX). */
const FORMS_JSON_MAX = 12_000;

interface KnownForm {
  readonly id: string;
  readonly scanned: ScannedForm;
  readonly classified: PasswordFormClassification | null;
}

/** Something a submit signal can come from: a `<form>`, or the page's fields outside one. */
type FormKey = HTMLFormElement | Document;

/** No control characters: JSON writes each as six, which would undo the size limits. */
const plain = (s: string, n: number) =>
  [...s]
    .filter((c) => {
      const code = c.codePointAt(0)!;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('')
    .slice(0, n);
const signature = (f: PasswordField | null): PasswordsFieldSignature | null => (f ? { type: plain(f.type, 20), id: plain(f.id, 80), name: plain(f.name, 80) } : null);
const isField = (el: EventTarget | null | undefined): el is HTMLInputElement => el instanceof HTMLInputElement;
/** A text-like field: never a checkbox, radio, button or file input, which never hold a credential. */
const isTextField = (el: EventTarget | null | undefined): el is HTMLInputElement => isField(el) && !SKIP_TYPES.has(controlType(el));

export interface AgentOptions {
  readonly document?: Document;
  readonly window?: Window;
}

/** Starts the agent on a document. Returns a stop function (tests; the agent otherwise lives as long as its document). */
export function startAgent(bridge: PasswordsBridge, options: AgentOptions = {}): () => void {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const typed = new WeakSet<Element>();
  const filled = new WeakSet<Element>();
  const keys = new WeakMap<Element, number>();
  const nextKey = { value: 1 };
  const formIds = new WeakMap<FormKey, string>();
  let nextForm = 1;
  let known: KnownForm[] = [];
  let byElement = new WeakMap<Element, KnownForm>();
  /** Fields a scan was run for already: one that isn't in any form isn't looked for again on each focus or keystroke. */
  const lookedFor = new WeakSet<Element>();
  let lastForms = '';
  const stops: (() => void)[] = [];

  const idOf = (key: FormKey) => {
    let id = formIds.get(key);
    if (!id) formIds.set(key, (id = `f${nextForm++}`));
    return id;
  };

  let scannedAt = Number.NEGATIVE_INFINITY;
  let scanWanted = false;
  /** Scans the page again and classifies each form for filling. Main hears of a change at the next flush. */
  function rescan(): void {
    scannedAt = performance.now();
    scanWanted = false;
    const scanned = scanDocument(doc, { typed, filled, keys, nextKey });
    known = scanned.map((s) => ({ id: idOf(s.form ?? doc), scanned: s, classified: classifyPasswordForm(s.record, 'filling') }));
    byElement = new WeakMap();
    for (const k of known) for (const el of k.scanned.elements) byElement.set(el, k);
    schedule();
  }
  /** The credential forms, as main hears of them: at most MAX_REPORTED_FORMS, and FORMS_JSON_MAX characters. */
  const formsReport = () => {
    const forms: PasswordsAgentMessage<'forms'>['forms'] = [];
    let size = 2;
    for (const k of known) {
      if (!k.classified || forms.length >= MAX_REPORTED_FORMS) continue;
      const entry = { formId: k.id, kind: k.classified.kind, username: signature(k.classified.username), password: signature(k.classified.password), newPassword: signature(k.classified.newPassword) };
      size += JSON.stringify(entry).length + 1;
      if (size > FORMS_JSON_MAX) break;
      forms.push(entry);
    }
    return forms;
  };

  /** The known form of a field, scanning the page again the first time a field isn't known (or at the next flush, if a scan just ran). */
  const knownFor = (el: Element): KnownForm | undefined => {
    const k = byElement.get(el);
    if (k || lookedFor.has(el)) return k;
    if (performance.now() - scannedAt < SCAN_GAP_MS) {
      scanWanted = true;
      schedule();
      return undefined;
    }
    lookedFor.add(el);
    rescan();
    return byElement.get(el);
  };
  const roleOf = (k: KnownForm | undefined, el: Element): PasswordFieldRole | undefined => {
    const i = k?.scanned.elements.indexOf(el as HTMLElement) ?? -1;
    return i >= 0 ? k!.classified?.roles.get(k!.scanned.record.fields[i]!.key) : undefined;
  };

  // ----- Focus, where the field is, and the forms: once a frame, the last state only, nothing unchanged -----
  let focused: { ref: WeakRef<HTMLInputElement>; formId: string; kind: PasswordFormKind; role: PasswordFieldRole } | null = null;
  /** A field that took focus while a scan had to wait: looked at again at the flush. */
  let pending: WeakRef<HTMLInputElement> | null = null;
  /** What main was last told: the field it thinks has focus, its form's kind, its role and its box, or null after a blur. */
  let told: { ref: WeakRef<HTMLInputElement>; formId: string; key: string } | null = null;
  let frame = 0;
  let timer = 0;
  let trailing = 0;
  let focusSentAt = Number.NEGATIVE_INFINITY;
  /** Whether the last scan saw field `i` of `k` hidden (neither shown nor focusable): its form was classed without it. */
  const hiddenAt = (k: KnownForm, i: number) => {
    const rec = k.scanned.record.fields[i];
    return !!rec && !rec.visible && !rec.focusable;
  };
  const scannedHidden = (k: KnownForm, el: Element) => hiddenAt(k, k.scanned.elements.indexOf(el as HTMLElement));
  /**
   * A password field of `k` the last scan saw hidden and the page has shown since (on the email's focus, or as you
   * type): the form's kind may have changed (a first step is a sign-in now). Only those fields are looked at.
   */
  const revealed = (k: KnownForm | undefined) => !!k && k.scanned.elements.some((e, i) => hiddenAt(k, i) && controlType(e) === 'password' && e.isConnected && isShown(e));
  /** A scan now, or at the next flush if one just ran. */
  const rescanSoon = () => {
    if (performance.now() - scannedAt >= SCAN_GAP_MS) rescan();
    else {
      scanWanted = true;
      schedule();
    }
  };
  /** `focused` as the last scan has it: a rescan may have changed its form's kind or its role. */
  const refreshFocused = () => {
    const el = focused?.ref.deref();
    if (!focused || !el) return;
    const k = byElement.get(el);
    const role = roleOf(k, el);
    focused = k && role && k.classified ? { ref: focused.ref, formId: k.id, kind: k.classified.kind, role } : null;
  };
  /** `again`: from the flush, for a field whose scan had to wait: never another wait (one rescan per focus). */
  const focusOn = (el: HTMLInputElement, again = false) => {
    let k = knownFor(el);
    // A later step shown in place (a password field hidden until the username is in): classed again, as it is now.
    if (k && !again && scannedHidden(k, el)) {
      if (performance.now() - scannedAt >= SCAN_GAP_MS) {
        rescan();
        k = byElement.get(el);
      } else {
        scanWanted = true;
        pending = new WeakRef(el);
        schedule();
        k = undefined;
      }
    }
    const role = roleOf(k, el);
    focused = k && role && k.classified ? { ref: new WeakRef(el), formId: k.id, kind: k.classified.kind, role } : null;
  };
  const flush = () => {
    if (frame) win.cancelAnimationFrame(frame);
    if (timer) win.clearTimeout(timer);
    frame = timer = 0;
    if (scanWanted) rescan();
    const waiting = pending?.deref();
    pending = null;
    if (waiting && activeElementOf(doc) === waiting) focusOn(waiting, true);
    // The page showed a password field in the focused field's form since the last scan: classed again now.
    const active = activeElementOf(doc);
    if (active && revealed(byElement.get(active))) rescanSoon();
    refreshFocused();
    const forms = formsReport();
    const json = JSON.stringify(forms);
    if (json !== lastForms) {
      lastForms = json;
      bridge.send('forms', { forms });
    }
    const el = focused?.ref.deref();
    if (focused && el && el.isConnected) {
      const r = el.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      const key = `${focused.formId} ${focused.kind} ${focused.role} ${rect.x},${rect.y},${rect.width},${rect.height}`;
      // The same field in the same place, of the same kind: main knows already (a carousel scrolling elsewhere moves nothing).
      if (told?.ref.deref() === el && told.key === key) return;
      // Too soon after the last: the trailing flush sends the state as it is then.
      const wait = FOCUS_GAP_MS - (performance.now() - focusSentAt);
      if (wait > 0) {
        if (!trailing)
          trailing = win.setTimeout(() => {
            trailing = 0;
            flush();
          }, wait);
        return;
      }
      focusSentAt = performance.now();
      bridge.send('focus', { formId: focused.formId, kind: focused.kind, role: focused.role, rect });
      told = { ref: focused.ref, formId: focused.formId, key };
    } else if (told) {
      bridge.send('blur', { formId: told.formId });
      told = null;
    }
  };
  function schedule(): void {
    if (!frame) frame = win.requestAnimationFrame(flush);
    if (!timer) timer = win.setTimeout(flush, FLUSH_MS);
  }
  const onFocusIn = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isTextField(el)) return;
    focusOn(el);
    if (!focused && !byElement.has(el) && scanWanted) pending = new WeakRef(el);
    schedule();
  };
  const onFocusOut = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isTextField(el)) return;
    if (focused && focused.ref.deref() === el) {
      focused = null;
      schedule();
    }
    // Leaving a password field you typed in since: main holds the form in case it's submitted next (S17 §6, step 1).
    const k = byElement.get(el);
    if (k && el.type === 'password' && changed.has(k.id)) candidate(k, 'blur');
  };
  // Scroll and resize may move the field: its box again at the flush, sent only if it moved.
  const onMove = () => {
    if (focused) schedule();
  };

  // ----- Typing -----
  const onInput = (event: Event) => {
    const el = event.composedPath()[0];
    if (!isTextField(el) || !event.isTrusted) return;
    typed.add(el);
    // Typing that made the page show its password field (a first step that's a sign-in after all).
    if (revealed(byElement.get(el))) rescanSoon();
    if (el.type !== 'password') return;
    const k = knownFor(el);
    if (k) changed.add(k.id);
  };

  // ----- Submit signals (S17 §6, step 2) -----
  /** The known form a submit button belongs to: its `<form>`, or the formless fields whose scope holds it. */
  const formOf = (button: Element): KnownForm | undefined => {
    const form = (button as HTMLButtonElement).form ?? button.closest('form');
    return form ? known.find((k) => k.scanned.form === form) : known.find((k) => k.scanned.form === null);
  };
  const passwordOf = (k: KnownForm) => k.scanned.elements.find((e) => controlType(e) === 'password') ?? null;
  const hasTypedPassword = (k: KnownForm) => k.scanned.elements.some((e) => controlType(e) === 'password' && (typed.has(e) || filled.has(e)));
  const onSubmit = (event: Event) => {
    if (!event.isTrusted) return;
    const form = event.composedPath()[0];
    if (form instanceof HTMLFormElement) {
      const k = known.find((x) => x.scanned.form === form);
      if (k) candidate(k, 'submit');
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !event.isTrusted) return;
    const el = event.composedPath()[0];
    if (!isTextField(el)) return;
    const k = byElement.get(el);
    if (k) candidate(k, 'enter');
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) return;
    // A button that submits: in a <form>, its submit buttons; outside one, a button beside the fields.
    // Never a show-password toggle, a "Forgot password?" or one that wraps the field (submitButtonFor).
    const form = target.closest('form');
    const k = form ? known.find((x) => x.scanned.form === form) : known.find((x) => x.scanned.form === null);
    const button = k && submitButtonFor(target, passwordOf(k), k.scanned.form);
    if (k && button && formOf(button) === k) candidate(k, 'button');
  };

  /** Forms whose password you typed in since their last candidate as you left it. */
  const changed = new Set<string>();
  /** When each form's last candidate was sent, by kind of signal: one submit, however many events it makes, is one candidate. */
  const sentAt = new Map<string, number>();
  function candidate(k: KnownForm, signal: PasswordsAgentMessage<'candidate'>['signal']): void {
    if (!hasTypedPassword(k)) return;
    const key = `${k.id} ${signal === 'blur' ? 'blur' : 'submit'}`;
    const now = performance.now();
    const last = sentAt.get(key);
    if (last !== undefined && now - last < ONE_SUBMIT_MS) return;
    sentAt.set(key, now);
    if (signal === 'blur') changed.delete(k.id);
    // Saving mode, with values, for this form's own fields only: they're compared here and never sent.
    const fresh = scanDocument(doc, { values: true, typed, filled, keys, nextKey, only: k.scanned.elements })[0];
    const saving = fresh ? classifyPasswordForm(fresh.record, 'saving') : null;
    const c = saving ?? k.classified;
    if (!c) return;
    const valueOf = (f: PasswordField | null) => (f ? (fresh?.record.fields.find((x) => x.key === f.key)?.value ?? '') : '');
    const hasValue = (f: PasswordField | null) => valueOf(f) !== '';
    // At a submit signal: what to save, the new password where the form has one. Left out when it can't be saved.
    const username = valueOf(c.username);
    const password = valueOf(c.newPassword ?? c.password);
    const values =
      signal !== 'blur' && password && password.length <= PASSWORD_LIMITS.password && username.length <= PASSWORD_LIMITS.username ? { username, password } : undefined;
    bridge.send('candidate', {
      formId: k.id,
      kind: c.kind,
      signal,
      username: signature(c.username),
      password: signature(c.password),
      newPassword: signature(c.newPassword),
      hasUsername: hasValue(c.username),
      hasPassword: hasValue(c.password) || hasValue(c.newPassword),
      ...(values ? { values } : {}),
    });
    if (signal !== 'blur') watch(k, fresh);
  }

  // ----- After a submit signal: did the form go? (S17 §6, step 3) -----
  let watching: (() => void) | null = null;
  function watch(k: KnownForm, fresh: ScannedForm | undefined): void {
    watching?.();
    const passwords = (fresh ?? k.scanned).elements.filter((e) => controlType(e) === 'password').map((e) => new WeakRef(e));
    if (!passwords.length) return;
    let done = false;
    let timer = 0;
    const shown = () =>
      passwords.some((r) => {
        const el = r.deref();
        return !!el && el.isConnected && isShown(el);
      });
    const check = () => {
      timer = 0;
      if (!done && !shown()) finish('gone');
    };
    const observer = new MutationObserver(() => {
      if (!timer) timer = win.setTimeout(check, 100);
    });
    observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
    // A request to the page's own origin finishing: a hint (M0 Q7: seen only once its body is read).
    let hints = 0;
    let resources: PerformanceObserver | null = null;
    try {
      resources = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          if (done || hints >= MAX_HINTS) return;
          if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
          let origin: string;
          try {
            origin = new URL(e.name).origin;
          } catch {
            continue;
          }
          const status = e.responseStatus;
          if (origin !== win.location.origin || !(status >= 100 && status <= 599)) continue;
          hints++;
          bridge.send('hint', { formId: k.id, status });
        }
      });
      resources.observe({ type: 'resource', buffered: false });
    } catch {
      resources = null;
    }
    const deadline = win.setTimeout(() => finish(shown() ? 'still' : 'gone'), SUBMIT_WATCH_MS);
    function finish(how: 'gone' | 'still'): void {
      if (done) return;
      done = true;
      stop();
      bridge.send(how, { formId: k.id });
    }
    function stop(): void {
      done = true;
      observer.disconnect();
      resources?.disconnect();
      win.clearTimeout(deadline);
      if (timer) win.clearTimeout(timer);
      if (watching === stop) watching = null;
    }
    watching = stop;
  }

  // ----- Filling (S17 §5): only the form the menu was shown for, only as it was -----
  const elementOf = (k: KnownForm, f: PasswordField | null): HTMLElement | null => {
    if (!f) return null;
    const i = k.scanned.record.fields.findIndex((x) => x.key === f.key);
    return i >= 0 ? (k.scanned.elements[i] ?? null) : null;
  };
  const usable = (el: HTMLElement | null): el is HTMLInputElement => isTextField(el) && el.isConnected && !el.disabled && !el.readOnly && isShown(el);
  const onScreen = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  };
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  /** What typing sends, so React, Vue and Angular see the value (a framework's own setter lives in the page's world). */
  const put = (el: HTMLInputElement, value: string) => {
    valueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    filled.add(el);
  };
  /** Why a fill wrote nothing (PasswordsFilled's `reason`). */
  type Refused = 'changed' | 'password';
  function fill(p: PasswordsFill): true | Refused {
    // The page as it is now: a field swapped, hidden or re-rendered since the menu opened is seen here.
    rescan();
    const k = known.find((x) => x.id === p.formId);
    const c = k?.classified;
    if (!k || !c) return 'changed';
    const named = elementOf(k, c.username);
    const pass = elementOf(k, c.password);
    // A password step that carries the username from the step before, read-only or hidden, already holding the
    // account you picked: only the password goes in. Holding another account, the form isn't this account's.
    const carried = !!named && !!pass && !usable(named) && (named as HTMLInputElement).value !== '' && ((named as HTMLInputElement).readOnly || !isShown(named));
    if (carried && (named as HTMLInputElement).value.trim().toLowerCase() !== p.username.trim().toLowerCase()) return 'changed';
    const user = carried ? null : named;
    // Never half a fill: a password field you could type in, with a role in this form, that the fill would leave
    // empty (main sent no password, as for a first step, or the field isn't the current password) gets nothing at all.
    const left = k.scanned.elements.filter((el, i) => controlType(el) === 'password' && c.roles.has(k.scanned.record.fields[i]!.key) && usable(el) && (el !== pass || !p.password));
    if (left.length) return 'password';
    if (!user && !pass) return 'changed';
    // Main sent a password: the form had one when the menu showed. One with none now (hidden since) changed.
    if (p.password && !pass) return 'changed';
    if (user && !usable(user)) return 'changed';
    // A password field needs the password: main leaves it out only for a first step, which has none.
    if (pass && (!p.password || !usable(pass) || controlType(pass) !== 'password')) return 'changed';
    if (![user, pass].some((el) => el && onScreen(el))) return 'changed';
    const fields = [user && p.username ? ([user, p.username] as const) : null, pass && p.password ? ([pass, p.password] as const) : null].filter((f) => f !== null);
    for (const [el, value] of fields) put(el, value);
    const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ring = (color: string) => ({ outline: `2px solid ${color}`, outlineOffset: '2px' });
    fields.forEach(([el], i) => {
      el.animate([ring('transparent'), { ...ring(p.highlight.color), offset: 0.1 }, { ...ring(p.highlight.color), offset: 0.7 }, ring('transparent')], {
        duration: p.highlight.ms,
        delay: reduce ? 0 : i * p.highlight.stagger,
        easing: p.highlight.easing,
      });
    });
    return true;
  }
  const onFill = (raw: unknown) => {
    const p = raw as Partial<PasswordsFill> | null;
    const h = p?.highlight as Partial<PasswordsFill['highlight']> | undefined;
    if (!p || typeof p.formId !== 'string' || typeof p.username !== 'string' || (p.password !== undefined && (typeof p.password !== 'string' || !p.password))) return;
    if (!h || typeof h.color !== 'string' || typeof h.ms !== 'number' || typeof h.stagger !== 'number' || typeof h.easing !== 'string') return;
    let done: true | Refused;
    try {
      done = fill(p as PasswordsFill);
    } catch {
      done = 'changed';
    }
    bridge.send('filled', done === true ? { formId: p.formId, ok: true } : { formId: p.formId, ok: false, reason: done });
  };
  bridge.onFill?.(onFill);

  // ----- Listening -----
  const listen = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, passive = true) => {
    // Through the prototype: a <form name="addEventListener"> clobbers the document's own.
    EventTarget.prototype.addEventListener.call(doc, type, fn as EventListener, { capture: true, passive });
    stops.push(() => EventTarget.prototype.removeEventListener.call(doc, type, fn as EventListener, { capture: true }));
  };
  listen('focusin', onFocusIn);
  listen('focusout', onFocusOut);
  listen('input', onInput);
  listen('submit', onSubmit);
  listen('keydown', onKeyDown);
  listen('click', onClick);
  listen('scroll', onMove);
  win.addEventListener('resize', onMove, { passive: true });
  stops.push(() => win.removeEventListener('resize', onMove));
  rescan();
  // A field focused before the agent woke (the sentinel wakes on that focus).
  const active = activeElementOf(doc);
  if (isTextField(active)) onFocusIn({ composedPath: () => [active] } as unknown as FocusEvent);

  return () => {
    for (const stop of stops) stop();
    watching?.();
    if (frame) win.cancelAnimationFrame(frame);
    if (timer) win.clearTimeout(timer);
    if (trailing) win.clearTimeout(trailing);
  };
}
