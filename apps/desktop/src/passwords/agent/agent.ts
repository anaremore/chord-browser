/**
 * The passwords agent (S17 §4, §6, §8): runs in isolated world 4440 of a tab's main frame,
 * woken by the sentinel preload (preload/passwords.ts) on a page with a sign-in field. Page
 * scripts can't see or change it, nor can the assistant's world (4400). It adds nothing to
 * the page: no attribute, class, element or style, only capturing listeners on the document
 * and, for 10 s after a submit signal, a MutationObserver and a PerformanceObserver.
 *
 * What it tells main, through the bridge, never with a field's value:
 * - `forms`: the page's credential forms by their fields' type, id and name, after each scan
 *   that changes them (the reappeared-form check, S17 §6);
 * - `focus` / `blur`: a sign-in field took or lost focus, with its box (the menu, later). At
 *   most once an animation frame, the last state only: a page that moves focus in a loop
 *   sends one message a frame, not one a call (main limits each page's rate as well);
 * - `candidate`: a form you typed a password in, once per submit signal or as you left the field;
 * - `gone` / `still`: after a submit signal, whether the password field went within 10 s;
 * - `hint`: a request to the page's own origin finished after a submit signal, with its status.
 *
 * Values are read only to classify a form for saving (Chromium's saving mode compares them)
 * and to say whether the username and password are filled in, from that form's own fields.
 * They stay in this world.
 */
import { classifyPasswordForm, type PasswordField, type PasswordFieldRole, type PasswordFormClassification, type PasswordFormKind } from '@chord/core';
import type { PasswordsAgentChannel, PasswordsAgentMessage, PasswordsFieldSignature } from '@chord/ipc';
import { controlType, isShown, MAX_REPORTED_FORMS, scanDocument, SKIP_TYPES, submitButtonFor, type ScannedForm } from './scan';

/** What the sentinel exposes in this world (contextBridge.exposeInIsolatedWorld). */
export interface PasswordsBridge {
  send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>): void;
}

/** How long after a submit signal the agent watches for the form to go, and for the page's requests (S17 §6, step 3). */
export const SUBMIT_WATCH_MS = 10_000;
/** At most this many `hint`s per submit: the first few requests say enough. */
const MAX_HINTS = 3;
/** Submit signals for one form within this long are one submit: Enter, then the form's `submit`, then the click a browser makes. */
const ONE_SUBMIT_MS = 1000;

interface KnownForm {
  readonly id: string;
  readonly scanned: ScannedForm;
  readonly classified: PasswordFormClassification | null;
}

/** Something a submit signal can come from: a `<form>`, or the page's fields outside one. */
type FormKey = HTMLFormElement | Document;

const signature = (f: PasswordField | null): PasswordsFieldSignature | null => (f ? { type: f.type.slice(0, 20), id: f.id.slice(0, 80), name: f.name.slice(0, 80) } : null);
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

  /** Scans the page again and classifies each form for filling; tells main when its credential forms changed. */
  function rescan(): void {
    const scanned = scanDocument(doc, { typed, filled, keys, nextKey });
    known = scanned.map((s) => ({ id: idOf(s.form ?? doc), scanned: s, classified: classifyPasswordForm(s.record, 'filling') }));
    byElement = new WeakMap();
    for (const k of known) for (const el of k.scanned.elements) byElement.set(el, k);
    const forms = known
      .filter((k) => k.classified)
      .slice(0, MAX_REPORTED_FORMS)
      .map((k) => ({ formId: k.id, kind: k.classified!.kind, username: signature(k.classified!.username), password: signature(k.classified!.password), newPassword: signature(k.classified!.newPassword) }));
    const json = JSON.stringify(forms);
    if (json !== lastForms) {
      lastForms = json;
      bridge.send('forms', { forms });
    }
  }

  /** The known form of a field, scanning the page again the first time a field isn't known. */
  const knownFor = (el: Element): KnownForm | undefined => {
    const k = byElement.get(el);
    if (k || lookedFor.has(el)) return k;
    lookedFor.add(el);
    rescan();
    return byElement.get(el);
  };
  const roleOf = (k: KnownForm | undefined, el: Element): PasswordFieldRole | undefined => {
    const i = k?.scanned.elements.indexOf(el as HTMLElement) ?? -1;
    return i >= 0 ? k!.classified?.roles.get(k!.scanned.record.fields[i]!.key) : undefined;
  };

  // ----- Focus, and where the field is: once a frame, the last state only -----
  let focused: { ref: WeakRef<HTMLInputElement>; formId: string; kind: PasswordFormKind; role: PasswordFieldRole } | null = null;
  /** What main was last told: the field it thinks has focus, or null after a blur. */
  let told: { ref: WeakRef<HTMLInputElement>; formId: string } | null = null;
  let moved = false;
  let frame = 0;
  const flush = () => {
    frame = 0;
    const el = focused?.ref.deref();
    if (focused && el && el.isConnected) {
      // The same field again, unmoved: main knows already.
      if (told?.ref.deref() === el && !moved) return;
      const r = el.getBoundingClientRect();
      bridge.send('focus', { formId: focused.formId, kind: focused.kind, role: focused.role, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
      told = { ref: focused.ref, formId: focused.formId };
    } else if (told) {
      bridge.send('blur', { formId: told.formId });
      told = null;
    }
    moved = false;
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(flush);
  };
  const onFocusIn = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isTextField(el)) return;
    const k = knownFor(el);
    const role = roleOf(k, el);
    focused = k && role && k.classified ? { ref: new WeakRef(el), formId: k.id, kind: k.classified.kind, role } : null;
    schedule();
  };
  const onFocusOut = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isTextField(el)) return;
    if (focused && focused.ref.deref() === el) {
      focused = null;
      schedule();
    }
    // Leaving a password field you typed in: main holds the form in case it's submitted next (S17 §6, step 1).
    const k = byElement.get(el);
    if (k && el.type === 'password' && typed.has(el)) candidate(k, 'blur');
  };
  // Scroll and resize move the field: its box again, once a frame.
  const onMove = () => {
    if (!focused) return;
    moved = true;
    schedule();
  };

  // ----- Typing -----
  const onInput = (event: Event) => {
    const el = event.composedPath()[0];
    if (!isTextField(el) || !event.isTrusted) return;
    typed.add(el);
    if (el.type === 'password') knownFor(el);
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
    const button = k && submitButtonFor(target, passwordOf(k), k.scanned.form !== null);
    if (k && button && formOf(button) === k) candidate(k, 'button');
  };

  /** When each form's last submit signal was sent: one submit, however many events it makes, is one candidate. */
  const submittedAt = new Map<string, number>();
  function candidate(k: KnownForm, signal: PasswordsAgentMessage<'candidate'>['signal']): void {
    if (!hasTypedPassword(k)) return;
    if (signal !== 'blur') {
      const now = performance.now();
      const last = submittedAt.get(k.id);
      if (last !== undefined && now - last < ONE_SUBMIT_MS) return;
      submittedAt.set(k.id, now);
    }
    // Saving mode, with values, for this form's own fields only: they're compared here and never sent.
    const fresh = scanDocument(doc, { values: true, typed, filled, keys, nextKey, only: k.scanned.elements })[0];
    const saving = fresh ? classifyPasswordForm(fresh.record, 'saving') : null;
    const c = saving ?? k.classified;
    if (!c) return;
    const hasValue = (f: PasswordField | null) => !!f && !!fresh?.record.fields.find((x) => x.key === f.key)?.value;
    bridge.send('candidate', {
      formId: k.id,
      kind: c.kind,
      signal,
      username: signature(c.username),
      password: signature(c.password),
      newPassword: signature(c.newPassword),
      hasUsername: hasValue(c.username),
      hasPassword: hasValue(c.password) || hasValue(c.newPassword),
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

  // ----- Listening -----
  const listen = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, passive = true) => {
    doc.addEventListener(type, fn as EventListener, { capture: true, passive });
    stops.push(() => doc.removeEventListener(type, fn as EventListener, { capture: true }));
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
  const active = doc.activeElement;
  if (isTextField(active)) onFocusIn({ composedPath: () => [active] } as unknown as FocusEvent);

  return () => {
    for (const stop of stops) stop();
    watching?.();
    if (frame) win.cancelAnimationFrame(frame);
  };
}
