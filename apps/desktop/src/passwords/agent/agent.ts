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
 * - `focus` / `blur`: a sign-in field took or lost focus, with its box (the menu, later);
 * - `candidate`: a form you typed a password in, at a submit signal or as you left the field;
 * - `gone` / `still`: after a submit signal, whether the password field went within 10 s;
 * - `hint`: a request to the page's own origin finished after a submit signal, with its status.
 *
 * Values are read only to classify a form for saving (Chromium's saving mode compares them)
 * and to say whether the username and password are filled in. They stay in this world.
 */
import { classifyPasswordForm, type PasswordField, type PasswordFieldRole, type PasswordFormClassification, type PasswordFormKind } from '@chord/core';
import type { PasswordsAgentChannel, PasswordsAgentMessage, PasswordsFieldSignature } from '@chord/ipc';
import { controlType, formlessScope, isShown, scanDocument, type ScannedForm } from './scan';

/** What the sentinel exposes in this world (contextBridge.exposeInIsolatedWorld). */
export interface PasswordsBridge {
  send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>): void;
}

/** How long after a submit signal the agent watches for the form to go, and for the page's requests (S17 §6, step 3). */
export const SUBMIT_WATCH_MS = 10_000;
/** At most this many `hint`s per submit: the first few requests say enough. */
const MAX_HINTS = 3;

interface KnownForm {
  readonly id: string;
  readonly scanned: ScannedForm;
  readonly classified: PasswordFormClassification | null;
}

/** Something a submit signal can come from: a `<form>`, or the page's fields outside one. */
type FormKey = HTMLFormElement | Document;

const signature = (f: PasswordField | null): PasswordsFieldSignature | null => (f ? { type: f.type.slice(0, 20), id: f.id.slice(0, 80), name: f.name.slice(0, 80) } : null);
const isField = (el: EventTarget | null | undefined): el is HTMLInputElement => el instanceof HTMLInputElement;
const SUBMIT_BUTTON = 'button, input[type=submit], input[type=button], input[type=image], [role=button]';

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
      .slice(0, 50)
      .map((k) => ({ formId: k.id, kind: k.classified!.kind, username: signature(k.classified!.username), password: signature(k.classified!.password), newPassword: signature(k.classified!.newPassword) }));
    const json = JSON.stringify(forms);
    if (json !== lastForms) {
      lastForms = json;
      bridge.send('forms', { forms });
    }
  }

  const knownFor = (el: Element) => byElement.get(el) ?? (rescan(), byElement.get(el));
  const roleOf = (k: KnownForm | undefined, el: Element): PasswordFieldRole | undefined => {
    const i = k?.scanned.elements.indexOf(el as HTMLElement) ?? -1;
    return i >= 0 ? k!.classified?.roles.get(k!.scanned.record.fields[i]!.key) : undefined;
  };

  // ----- Focus, and where the field is -----
  let focused: { ref: WeakRef<HTMLInputElement>; formId: string; kind: PasswordFormKind; role: PasswordFieldRole } | null = null;
  let frame = 0;
  const reportFocus = () => {
    frame = 0;
    const el = focused?.ref.deref();
    if (!focused || !el || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    bridge.send('focus', { formId: focused.formId, kind: focused.kind, role: focused.role, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  };
  const onFocusIn = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isField(el)) return;
    const k = knownFor(el);
    const role = roleOf(k, el);
    if (!k || !role || !k.classified) return void (focused = null);
    focused = { ref: new WeakRef(el), formId: k.id, kind: k.classified.kind, role };
    reportFocus();
  };
  const onFocusOut = (event: FocusEvent) => {
    const el = event.composedPath()[0];
    if (!isField(el)) return;
    const k = byElement.get(el);
    if (focused && focused.ref.deref() === el) {
      bridge.send('blur', { formId: focused.formId });
      focused = null;
    }
    // Leaving a password field you typed in: main holds the form in case the page navigates (S17 §6, step 1).
    if (k && el.type === 'password' && typed.has(el)) candidate(k, 'blur');
  };
  // Scroll and resize move the field: its box again, once a frame.
  const onMove = () => {
    if (focused && !frame) frame = win.requestAnimationFrame(reportFocus);
  };

  // ----- Typing -----
  const onInput = (event: Event) => {
    const el = event.composedPath()[0];
    if (!isField(el) || !event.isTrusted) return;
    typed.add(el);
    if (el.type === 'password' && !byElement.has(el)) rescan();
  };

  // ----- Submit signals (S17 §6, step 2) -----
  /** The known form a submit signal from `el` belongs to: its `<form>`, or the formless fields whose scope holds it. */
  const formFor = (el: Element): KnownForm | undefined => {
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    if (form) return known.find((k) => k.scanned.form === form);
    const formless = known.find((k) => k.scanned.form === null);
    const password = formless?.scanned.elements.find((e) => controlType(e) === 'password');
    const scope = password && formlessScope(password);
    return scope?.contains(el) ? formless : undefined;
  };
  const hasTypedPassword = (k: KnownForm) => k.scanned.elements.some((e) => controlType(e) === 'password' && (typed.has(e) || filled.has(e)));
  const onSubmit = (event: Event) => {
    const form = event.composedPath()[0];
    if (form instanceof HTMLFormElement) {
      const k = known.find((x) => x.scanned.form === form);
      if (k) candidate(k, 'submit');
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !event.isTrusted) return;
    const el = event.composedPath()[0];
    if (!isField(el)) return;
    const k = byElement.get(el);
    if (k) candidate(k, 'enter');
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element)) return;
    const button = target.closest(SUBMIT_BUTTON);
    const k = button && formFor(button);
    if (k) candidate(k, 'button');
  };

  /** Recent candidates by form and signal: a submit sends `enter`, `submit` and a click within a moment, and main needs one. */
  const sentAt = new Map<string, number>();
  function candidate(k: KnownForm, signal: PasswordsAgentMessage<'candidate'>['signal']): void {
    if (!hasTypedPassword(k)) return;
    const now = performance.now();
    const last = sentAt.get(`${k.id} ${signal}`);
    if (last !== undefined && now - last < 250) return;
    sentAt.set(`${k.id} ${signal}`, now);
    // Saving mode, with values, for this form only: they're compared here and never sent.
    const fresh = scanDocument(doc, { values: true, typed, filled, keys, nextKey }).find((s) => s.form === k.scanned.form);
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
    const shown = () => passwords.some((r) => {
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
  if (isField(active)) onFocusIn({ composedPath: () => [active] } as unknown as FocusEvent);

  return () => {
    for (const stop of stops) stop();
    watching?.();
    if (frame) win.cancelAnimationFrame(frame);
  };
}
