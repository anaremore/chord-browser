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
 * - `step`: a first step's submit, with its username (S17 §4, phase 3), for a password step with none;
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
import { recipeOf, recipeSubmit, withRecipe } from './recipes';
import { activeElementOf, controlType, isElementNode, isShadowRootNode, isShown, isTag, MAX_REPORTED_FORMS, rootOf, scanDocument, setControlValue, SKIP_TYPES, submittedBy, valueOfControl, type ScannedForm } from './scan';

/** What the sentinel exposes in this world (contextBridge.exposeInIsolatedWorld). */
export interface PasswordsBridge {
  send<C extends PasswordsAgentChannel>(channel: C, payload: PasswordsAgentMessage<C>): void;
  /** Main's fill: the sentinel calls this listener (registered once) with what main sent. */
  onFill?(listener: (payload: unknown) => void): void;
  /**
   * Whether a frame element of the top document may be used (phase 3C): the sentinel, watching from the document's
   * start, saw no `sandbox` attribute on it ever, and heard its current document's `load` in the document's own tree
   * (never in a shadow root, whose attributes nothing watches). Absent: no frame is used.
   */
  vouched?(el: Element): boolean;
}

/** How long after a submit signal the agent watches for the form to go, and for the page's requests (S17 §6, step 3). */
const SUBMIT_WATCH_MS = 10_000;
/**
 * After a submit, with the password field gone and nothing drawing it again, how long the page must stay quiet before
 * the agent says `gone`: no change to the document, no request answered (a `hint`), no busy marker shown. A spinner
 * standing in for the form while the request runs mustn't read as a sign-in (review rounds 2 and 3 of #59). A hint never
 * shortens it: a beacon's 200 says nothing of the sign-in's answer.
 */
const GONE_QUIET_MS = 1500;
/** While waiting for quiet, a scan for a field drawn again runs at most this often, and only when an input was added. */
const REDRAW_SCAN_GAP_MS = 500;
/** A busy marker shown on the page: a request may still be running (the agent can't see one until it's answered). */
const BUSY = '[aria-busy="true"], [role="progressbar"]';
/** At most this many `hint`s per submit: the first few requests say enough. */
const MAX_HINTS = 3;
/**
 * Errors (400 or more) have a cap of their own: a page answering its polls with 200s can't use up the hints, so a sign-in's
 * 401 always reaches main (review round 4 of #59).
 */
const MAX_ERROR_HINTS = 10;
/**
 * After a `gone` at the watch's deadline, how long the agent still reports the page's errors: a request started before it
 * may answer just after (review round 4 of #59). An earlier `gone` reports them until the deadline.
 */
const DEADLINE_TAIL_MS = 3000;
/** Submit signals for one form within this long are one submit: Enter, then the form's `submit`, then the click a browser makes. */
const ONE_SUBMIT_MS = 1000;
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
export const FORMS_JSON_MAX = 12_000;

interface KnownForm {
  readonly id: string;
  readonly scanned: ScannedForm;
  readonly classified: PasswordFormClassification | null;
}

/** What describes a held password field after a submit, to know it drawn again: never its value. */
type Described = Pick<PasswordField, 'id' | 'name' | 'autocomplete' | 'label' | 'placeholder'>;

/** A watch's password fields: what describes them, and the elements by WeakRef. */
interface HeldFields {
  readonly held: readonly Described[];
  readonly passwords: WeakRef<HTMLElement>[];
}

/**
 * The password fields a submit was about, for its watch (S17 §6 step 3): the classification's, not every one in the form
 * (a formless page's fields are one form, and a sign-up panel's beside the sign-in's isn't this sign-in's; review round 1
 * of #59). Only their descriptions are kept, never their values, and the elements by WeakRef. Outside the agent's
 * closures, so the watch keeps nothing of the scan that read the values (review rounds 2 and 3 of #59).
 */
function heldFields(from: ScannedForm, c: PasswordFormClassification): HeldFields {
  const roles = new Set([c.password, c.newPassword, c.confirmation].flatMap((f) => (f ? [f.key] : [])));
  const all = from.elements.flatMap((el, i) => (controlType(el) === 'password' ? [{ el, f: from.record.fields[i]! }] : []));
  const own = all.filter((h) => roles.has(h.f.key));
  const fields = own.length ? own : all;
  return {
    held: fields.map(({ f }) => ({ id: f.id, name: f.name, autocomplete: f.autocomplete, label: f.label, placeholder: f.placeholder })),
    passwords: fields.map(({ el }) => new WeakRef(el)),
  };
}

/** Whether any element matching `selector` is shown on the page. */
const allShown = (doc: Document, selector: string) => [...Document.prototype.querySelectorAll.call(doc, selector)].some((el) => isShown(el));

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
/** An `<input>`, of any realm (a same-origin frame's own, phase 3C). */
const isField = (el: EventTarget | null | undefined): el is HTMLInputElement => isTag(el, 'INPUT');
/** The roles a generated password goes into (S17 §6). */
const NEW_ROLES: ReadonlySet<PasswordFieldRole> = new Set(['new-password', 'confirmation-password']);
const getAttribute = Element.prototype.getAttribute;
/** What a new password's field says of the passwords it takes, for main's generator: never its value. */
const rulesOf = (el: HTMLInputElement) => ({
  passwordrules: plain(String(getAttribute.call(el, 'passwordrules') ?? ''), 2000),
  minLength: Math.max(-1, Math.min(1_000_000, Math.trunc(el.minLength))),
  maxLength: Math.max(-1, Math.min(1_000_000, Math.trunc(el.maxLength))),
});
/** A text-like field: never a checkbox, radio, button or file input, which never hold a credential. */
const isTextField = (el: EventTarget | null | undefined): el is HTMLInputElement => isField(el) && !SKIP_TYPES.has(controlType(el));

/**
 * A same-origin frame's document, run by its own agent from the top frame's world (phase 3C). Checked at every use:
 * `allowed` is false once the frame isn't the one it was (navigated, sandboxed, another origin, gone), and then the agent
 * answers no event, sends no focus and fills nothing; a watch already running ends as at the top (the late window holds).
 */
export interface FrameContext {
  allowed(): boolean;
  /**
   * Where the frame's content is in the tab's CSS pixels, through every frame up to the top, and its scale there (a CSS
   * transform or zoom on a frame): a field's box is `x + r.left * scale`. Null when it isn't allowed.
   */
  offset(): { x: number; y: number; scale: number } | null;
  /** The documents and windows above it, the top's last: their scrolls and resizes move its fields. */
  readonly ancestors: readonly { readonly document: Document; readonly window: Window }[];
}

export interface AgentOptions {
  readonly document?: Document;
  readonly window?: Window;
  /** A same-origin frame's: see FrameContext. */
  readonly frame?: FrameContext;
  /** Form ids shared by the top's agent and its frames': one id space, so main can tell forms apart. */
  readonly ids?: { value: number };
  /** Whose timers to use: the top window's, so a frame that navigates away doesn't take a watch's timers with it. */
  readonly timers?: Window;
}
const inputDisabled = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'disabled')!.get!;
const inputReadOnly = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'readOnly')!.get!;
const rectOf = (el: Element) => Element.prototype.getBoundingClientRect.call(el);
const connected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected')!.get!;
const isConnectedNode = (n: Node) => connected.call(n) === true;
/**
 * An event's path, through the top realm's `composedPath` (a frame's own can be patched). The agent's own start-up
 * stand-in for a focus (the field focused before it woke) isn't an Event: its own path, then.
 */
const pathOf = (event: Event): EventTarget[] => {
  try {
    return Event.prototype.composedPath.call(event);
  } catch {
    return event.composedPath();
  }
};

/**
 * A running agent's stop function (tests; the agent otherwise lives as long as its document), and `release`: its
 * listeners and timers go, and nothing is sent again but what a watch already running says as it ends (a frame's
 * agent whose frame went: its `gone` still comes, phase 3C).
 */
export type AgentStop = (() => void) & { release(): void };

/** Starts the agent on a document. */
export function startAgent(bridge: PasswordsBridge, options: AgentOptions = {}): AgentStop {
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const inFrame = options.frame ?? null;
  const clock = options.timers ?? win;
  /** The top window: a frame's field must be on screen there too. */
  const top = inFrame?.ancestors.at(-1)?.window ?? win;
  /** Whether this document may still be used (a frame's, at every event; the top's always). */
  /** Released (its frame went): nothing more, but a running watch's end. */
  let released = false;
  const live = () => !released && (!inFrame || inFrame.allowed());
  const typed = new WeakSet<Element>();
  const filled = new WeakSet<Element>();
  /** Fields seen as `type=password` (S17 §4): one that's text now (a show-password toggle) means the form changed, for a generated password. */
  const wasPassword = new WeakSet<Element>();
  const keys = new WeakMap<Element, number>();
  const nextKey = { value: 1 };
  const formIds = new WeakMap<FormKey, string>();
  const ids = options.ids ?? { value: 1 };
  let known: KnownForm[] = [];
  let byElement = new WeakMap<Element, KnownForm>();
  /** Fields a scan was run for already: one that isn't in any form isn't looked for again on each focus or keystroke. */
  const lookedFor = new WeakSet<Element>();
  let lastForms = '';
  const stops: (() => void)[] = [];

  /** The provider's recipe for this document's host (S17, phase 3D), or null: read once, as the document's address is. */
  const recipe = recipeOf(doc);
  /** The classifier's result, with the recipe's fields given their roles. */
  const classify = (s: ScannedForm, mode: 'filling' | 'saving') => withRecipe(s, classifyPasswordForm(s.record, mode), recipe);
  const idOf = (key: FormKey) => {
    let id = formIds.get(key);
    if (!id) formIds.set(key, (id = `f${ids.value++}`));
    return id;
  };

  let scannedAt = Number.NEGATIVE_INFINITY;
  let scanWanted = false;
  /**
   * Whether scans walk into open shadow roots (phase 3B). The first one does; it stays on where that found a root, and
   * comes on again (for good) when an event's path starts inside one: a component rendered after the first scan.
   */
  let deep = true;
  let rootsSeen = false;
  /** An event that started inside an open shadow root: its target is the host, its path's first entry the field. */
  const fromRoot = (event: Event) => {
    if (rootsSeen) return;
    const first = pathOf(event)[0];
    if (first !== event.target && isElementNode(first) && isShadowRootNode(rootOf(first))) {
      rootsSeen = deep = true;
      // The field isn't known yet, and the last scan skipped roots: the next lookup scans again.
      scanWanted = true;
    }
  };
  /** Scans the page again and classifies each form for filling. Main hears of a change at the next flush. */
  function rescan(): void {
    scannedAt = performance.now();
    scanWanted = false;
    const roots: { count: number; stopped?: boolean } = { count: 0 };
    const scanned = scanDocument(doc, { typed, filled, keys, nextKey, deep, roots });
    // A page with no open root at its first scan, and no event from inside one since, is scanned without the walk. Only
    // after a walk that went all the way: one cut short (the cap, the deadline) proves nothing (review round 2 of #61).
    if (deep && roots.count === 0 && !roots.stopped && !rootsSeen) deep = false;
    else if (roots.count > 0) rootsSeen = true;
    known = scanned.map((s) => ({ id: idOf(s.form ?? doc), scanned: s, classified: classify(s, 'filling') }));
    for (const s of scanned) for (const el of s.elements) if (controlType(el) === 'password') wasPassword.add(el);
    byElement = new WeakMap();
    for (const k of known) for (const el of k.scanned.elements) byElement.set(el, k);
    // A form inside an open shadow root: its `submit` doesn't cross the root, so the agent listens there too (phase 3B).
    for (const s of scanned) {
      const root = s.form ? rootOf(s.form) : null;
      if (root && isShadowRootNode(root) && !listenedRoots.has(root)) {
        listenedRoots.add(root);
        EventTarget.prototype.addEventListener.call(root, 'submit', onSubmit as EventListener, { capture: true, passive: true });
        stops.push(() => EventTarget.prototype.removeEventListener.call(root, 'submit', onSubmit as EventListener, { capture: true }));
      }
    }
    schedule();
  }
  /** The open shadow roots the agent listens for `submit` in (a form there). */
  const listenedRoots = new WeakSet<ShadowRoot>();
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
  /** Whether the last scan saw field `i` of `k` not shown (hidden, or focusable but out of sight): its form may have been classed without it. */
  const hiddenAt = (k: KnownForm, i: number) => {
    const rec = k.scanned.record.fields[i];
    return !!rec && !rec.visible;
  };
  const scannedHidden = (k: KnownForm, el: Element) => hiddenAt(k, k.scanned.elements.indexOf(el as HTMLElement));
  /**
   * A password field of `k` the last scan saw hidden and the page has shown since (on the email's focus, or as you
   * type): the form's kind may have changed (a first step is a sign-in now). Only those fields are looked at.
   */
  const revealed = (k: KnownForm | undefined) => !!k && k.scanned.elements.some((e, i) => hiddenAt(k, i) && controlType(e) === 'password' && isConnectedNode(e) && isShown(e));
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
    if (frame) clock.cancelAnimationFrame(frame);
    if (timer) clock.clearTimeout(timer);
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
    const at = live() ? (inFrame ? inFrame.offset() : { x: 0, y: 0, scale: 1 }) : null;
    if (focused && el && isConnectedNode(el) && at) {
      const r = rectOf(el);
      const rect = { x: at.x + r.left * at.scale, y: at.y + r.top * at.scale, width: r.width * at.scale, height: r.height * at.scale };
      const key = `${focused.formId} ${focused.kind} ${focused.role} ${rect.x},${rect.y},${rect.width},${rect.height}`;
      // The same field in the same place, of the same kind: main knows already (a carousel scrolling elsewhere moves nothing).
      if (told?.ref.deref() === el && told.key === key) return;
      // Too soon after the last: the trailing flush sends the state as it is then.
      const wait = FOCUS_GAP_MS - (performance.now() - focusSentAt);
      if (wait > 0) {
        if (!trailing)
          trailing = clock.setTimeout(() => {
            trailing = 0;
            flush();
          }, wait);
        return;
      }
      focusSentAt = performance.now();
      bridge.send('focus', { formId: focused.formId, kind: focused.kind, role: focused.role, rect, ...(NEW_ROLES.has(focused.role) ? { rules: rulesOf(el) } : {}) });
      told = { ref: focused.ref, formId: focused.formId, key };
    } else if (told) {
      bridge.send('blur', { formId: told.formId });
      told = null;
    }
  };
  function schedule(): void {
    if (released) return;
    if (!frame) frame = clock.requestAnimationFrame(flush);
    if (!timer) timer = clock.setTimeout(flush, FLUSH_MS);
  }
  const onFocusIn = (event: FocusEvent) => {
    if (!live()) return;
    fromRoot(event);
    const el = pathOf(event)[0];
    if (!isTextField(el)) return;
    focusOn(el);
    if (!focused && !byElement.has(el) && scanWanted) pending = new WeakRef(el);
    schedule();
  };
  const onFocusOut = (event: FocusEvent) => {
    const el = pathOf(event)[0];
    if (!isTextField(el)) return;
    if (focused && focused.ref.deref() === el) {
      focused = null;
      schedule();
    }
    // Leaving a password field you typed in since: main holds the form in case it's submitted next (S17 §6, step 1).
    const k = byElement.get(el);
    if (k && live() && controlType(el) === 'password' && changed.has(k.id)) candidate(k, 'blur');
  };
  // Scroll and resize may move the field: its box again at the flush, sent only if it moved.
  const onMove = () => {
    if (focused) schedule();
  };

  // ----- Typing -----
  const onInput = (event: Event) => {
    if (!live()) return;
    fromRoot(event);
    const el = pathOf(event)[0];
    if (!isTextField(el) || !event.isTrusted) return;
    typed.add(el);
    // Typing that made the page show its password field (a first step that's a sign-in after all).
    if (revealed(byElement.get(el))) rescanSoon();
    if (controlType(el) !== 'password') return;
    const k = knownFor(el);
    if (k) changed.add(k.id);
  };

  // ----- Submit signals (S17 §6, step 2) -----
  const passwordOf = (k: KnownForm) => k.scanned.elements.find((e) => controlType(e) === 'password') ?? null;
  /** Where a submit button must be, for a form: near its password field, or a first step's username. */
  const anchorOf = (k: KnownForm) => passwordOf(k) ?? (k.classified?.kind === 'username-only' ? elementOf(k, k.classified.username) : null);
  const hasTypedPassword = (k: KnownForm) => k.scanned.elements.some((e) => controlType(e) === 'password' && (typed.has(e) || filled.has(e)));
  const onSubmit = (event: Event) => {
    if (!event.isTrusted || !live()) return;
    const form = pathOf(event)[0];
    if (isTag(form, 'FORM')) {
      const k = known.find((x) => x.scanned.form === form);
      if (k) candidate(k, 'submit');
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!live()) return;
    fromRoot(event);
    if (event.key !== 'Enter' || !event.isTrusted) return;
    const el = pathOf(event)[0];
    if (!isTextField(el)) return;
    const k = byElement.get(el);
    if (k) candidate(k, 'enter');
  };
  const onClick = (event: MouseEvent) => {
    if (!live()) return;
    fromRoot(event);
    if (!event.isTrusted) return;
    const target = pathOf(event)[0];
    if (!isElementNode(target)) return;
    // A button that submits: in a <form>, its submit buttons; outside one, a button beside the fields; and an element
    // whose words say so (a script's `div`). Never a show-password toggle, a "Forgot password?" or one that wraps the
    // field (submitButtonFor).
    let k = submittedBy(target, known, anchorOf);
    // Nothing known for a click inside an open root: a component added since the last scan (or with deep scans off) may
    // hold its form. Scanned afresh once and asked again, only then, and not right after a scan (review rounds 3 and 4
    // of #61).
    if (!k && isShadowRootNode(rootOf(target)) && performance.now() - scannedAt >= SCAN_GAP_MS) {
      rescan();
      k = submittedBy(target, known, anchorOf);
    }
    // A provider's own submit the click rule doesn't see (its recipe, S17 phase 3D): through the click rule's refusals.
    if (!k) k = recipeSubmit(target, recipe, known, anchorOf);
    if (k) candidate(k, 'button');
  };

  /** Forms whose password you typed in since their last candidate as you left it. */
  const changed = new Set<string>();
  /** When each form's last candidate was sent, by kind of signal: one submit, however many events it makes, is one candidate. */
  const sentAt = new Map<string, number>();
  function candidate(k: KnownForm, signal: PasswordsAgentMessage<'candidate'>['signal']): void {
    // A first step, unless a password was typed in it: a form whose password field is still hidden to the last scan (a
    // transparent one), but typed in, is a sign-in, and its candidate goes as one (review round 1 of #59).
    if (signal !== 'blur' && k.classified?.kind === 'username-only' && !hasTypedPassword(k)) return firstStep(k, signal);
    if (!hasTypedPassword(k)) return;
    const key = `${k.id} ${signal === 'blur' ? 'blur' : 'submit'}`;
    const now = performance.now();
    const last = sentAt.get(key);
    if (last !== undefined && now - last < ONE_SUBMIT_MS) return;
    sentAt.set(key, now);
    if (signal === 'blur') changed.delete(k.id);
    // Saving mode, with values, for this form's own fields only: they're compared here and never sent.
    const fresh = scanDocument(doc, { values: true, typed, filled, keys, nextKey, only: k.scanned.elements })[0];
    const saving = fresh ? classify(fresh, 'saving') : null;
    const c = saving ?? k.classified;
    if (!c) return;
    const valueOf = (f: PasswordField | null) => (f ? (fresh?.record.fields.find((x) => x.key === f.key)?.value ?? '') : '');
    const hasValue = (f: PasswordField | null) => valueOf(f) !== '';
    // At a submit signal: what to save, the new password where the form has one. Left out when it can't be saved.
    const username = valueOf(c.username);
    const password = valueOf(c.newPassword ?? c.password);
    // A change form's current password, beside its new one: how main finds the account it's for (S17 §6).
    const current = c.newPassword && c.password ? valueOf(c.password) : '';
    const values =
      signal !== 'blur' && password && password.length <= PASSWORD_LIMITS.password && username.length <= PASSWORD_LIMITS.username
        ? { username, password, ...(current && current.length <= PASSWORD_LIMITS.password ? { current } : {}) }
        : undefined;
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
    if (signal !== 'blur') watch(k, heldFields(fresh ?? k.scanned, c));
  }

  /**
   * A first step's submit (S17 §4, phase 3): its username goes to main (`step`), for the password step after it, which
   * may have no username of its own. Only at a trusted submit signal, from a form the classifier reads as
   * `username-only` for saving too (so it holds a value), never one or two digits (Chromium's rule), and once per
   * submit. Typed or not, at your own Enter or click: an email the site remembered is yours too, and a person often
   * types before the agent has woken (the sentinel wakes it on that focus). A form's `submit` alone can be a script's
   * (`button.click()` makes a trusted one), so then only a username typed or filled counts. It goes only to the save
   * card, for the same site, where you can edit it.
   */
  function firstStep(k: KnownForm, signal: PasswordsAgentMessage<'step'>['signal']): void {
    const field = elementOf(k, k.classified?.username ?? null);
    if (!field || (signal === 'submit' && !typed.has(field) && !filled.has(field))) return;
    const key = `${k.id} step`;
    const now = performance.now();
    const last = sentAt.get(key);
    if (last !== undefined && now - last < ONE_SUBMIT_MS) return;
    const fresh = scanDocument(doc, { values: true, typed, filled, keys, nextKey, only: k.scanned.elements })[0];
    const saving = fresh ? classify(fresh, 'saving') : null;
    if (saving?.kind !== 'username-only' || !saving.username) return;
    const username = (fresh!.record.fields.find((f) => f.key === saving.username!.key)?.value ?? '').trim();
    if (!username || /^\d{1,2}$/.test(username) || username.length > PASSWORD_LIMITS.username) return;
    sentAt.set(key, now);
    bridge.send('step', { formId: k.id, signal, username });
  }

  // ----- After a submit signal: did the form go? (S17 §6, step 3) -----
  let watching: (() => void) | null = null;
  /**
   * After a submit, watch for the form's password fields to go (`gone`) or stay (`still`). `fields` is what describes
   * them and the elements by WeakRef only (`heldFields`, outside: no closure here keeps the scan that read the values).
   */
  function watch(k: KnownForm, fields: HeldFields): void {
    watching?.();
    const { held } = fields;
    let passwords = fields.passwords;
    if (!passwords.length) return;
    // Every password field shown at the submit, this form's or another's, from a scan made now (a panel added since the
    // last one counts): none of them can be this one drawn again (a sign-up panel's beside the sign-in's stays shown
    // when the sign-in works; review rounds 1 and 2 of #59).
    rescan();
    const before = new WeakSet<Element>();
    for (const x of known) x.scanned.elements.forEach((e) => controlType(e) === 'password' && isConnectedNode(e) && isShown(e) && before.add(e));
    // The submitted <form>, for a field that has nothing else to be known by.
    const formRef = k.scanned.form ? new WeakRef(k.scanned.form) : null;
    const formless = !k.scanned.form;
    let done = false;
    let timer = 0;
    /** Waiting, with the field gone, for the page to be quiet before saying so: a spinner may stand in for the form. */
    let quiet = 0;
    /** An input was added since the last scan for a redraw: the next check scans (at most every REDRAW_SCAN_GAP_MS). */
    let inputsAdded = false;
    let scannedAt = Number.NEGATIVE_INFINITY;
    const shown = () =>
      passwords.some((r) => {
        const el = r.deref();
        return !!el && isConnectedNode(el) && isShown(el);
      });
    /**
     * The held password field drawn again in a new element (a framework re-rendering the form after a wrong password,
     * with an error banner): a password field shown now that wasn't at the submit, never a new password's where the held
     * one wasn't (an app's *New password* view), and
     * - its id and name are the held one's; or else
     * - its words are (autocomplete, label and placeholder, where the held one has any): a framework's generated id
     *   (`mat-input-1` to `mat-input-3`, React's `:r1:` to `:r5:`) or a name dropped in the redraw doesn't hide it; or else
     * - where the held field had no id, name or words at all: inside the submitted <form> while that's in the page, or,
     *   on a formless page, any new one (nothing else can tell; review round 3 of #59).
     */
    const sameAs = (h: Described, f: PasswordField, el: Element) => {
      if (f.autocomplete === 'new-password' && h.autocomplete !== 'new-password') return false;
      const hasWords = h.autocomplete !== '' || h.label !== '' || h.placeholder !== '';
      if ((h.id !== '' || h.name !== '') && h.id === f.id && h.name === f.name) return true;
      if (hasWords && h.autocomplete === f.autocomplete && h.label === f.label && h.placeholder === f.placeholder) return true;
      if (h.id !== '' || h.name !== '' || hasWords) return false;
      const form = formRef?.deref();
      return form ? isConnectedNode(form) && form.contains(el) : formless;
    };
    const redrawn = (): WeakRef<HTMLElement>[] => {
      scannedAt = performance.now();
      inputsAdded = false;
      rescan();
      const out: WeakRef<HTMLElement>[] = [];
      for (const x of known)
        x.scanned.elements.forEach((e, i) => {
          const f = x.scanned.record.fields[i]!;
          if (f.type !== 'password' || before.has(e) || !isConnectedNode(e) || !isShown(e)) return;
          if (held.some((h) => sameAs(h, f, e))) out.push(new WeakRef(e));
        });
      return out;
    };
    const busy = () => allShown(doc, BUSY);
    const unquiet = () => {
      if (quiet) clock.clearTimeout(quiet);
      quiet = 0;
    };
    /**
     * The field is gone and nothing has drawn it again: `gone` once the page has been quiet for `GONE_QUIET_MS` (no change
     * to the document, no request answered) with no busy marker shown. Anything else starts the wait again; the watch's
     * deadline decides at the end. A spinner, then the form back with *Wrong password*, is `still`.
     */
    const settle = () => {
      unquiet();
      quiet = clock.setTimeout(() => {
        quiet = 0;
        if (done || shown()) return;
        if (busy()) return settle();
        const again = redrawn();
        if (again.length) passwords = again;
        else finish('gone');
      }, GONE_QUIET_MS);
    };
    const check = () => {
      timer = 0;
      if (done) return;
      if (shown()) return unquiet();
      // A full scan only for a change that added an input, and not more often than REDRAW_SCAN_GAP_MS: a dashboard that
      // keeps rendering only starts the quiet wait again (review round 3 of #59). The wait's end scans once anyway.
      if (inputsAdded) {
        const wait = REDRAW_SCAN_GAP_MS - (performance.now() - scannedAt);
        if (wait > 0) {
          timer = clock.setTimeout(check, wait);
          return settle();
        }
        const again = redrawn();
        if (again.length) {
          passwords = again;
          return unquiet();
        }
      }
      settle();
    };
    const addsInput = (records: MutationRecord[]) =>
      records.some((r) => [...r.addedNodes].some((n) => isElementNode(n) && (isTag(n, 'INPUT') || !!Element.prototype.querySelector.call(n, 'input'))));
    const observer = new MutationObserver((records) => {
      if (addsInput(records)) inputsAdded = true;
      if (!timer) timer = clock.setTimeout(check, 100);
    });
    const watched = { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] };
    observer.observe(doc, watched);
    // A frame's page that goes (the frame navigated after the submit): no mutation comes from a document that's gone, so
    // its going starts the check, and the quiet wait decides as for any form gone (phase 3C).
    const onHide = () => {
      if (!timer && !done) timer = clock.setTimeout(check, 100);
    };
    if (inFrame) win.addEventListener('pagehide', onHide);
    // A field in an open shadow root: the document's observer doesn't see inside it, so each root it's in is watched too.
    for (const r of passwords) {
      const el = r.deref();
      let root = el ? rootOf(el) : null;
      for (let depth = 0; root && isShadowRootNode(root) && depth < 32; depth++, root = rootOf(root.host)) observer.observe(root, watched);
    }
    // A request to the page's own origin finishing: a hint (M0 Q7: seen only once its body is read). Any answer is
    // activity, which starts the quiet wait again. Hints keep coming after `gone` until the deadline, so a late error (a
    // slow 401 the quiet wait didn't see coming) still reaches main, which takes the sign-in back (review round 3 of #59).
    let hints = 0;
    let errorHints = 0;
    /** When the watch began (the submit) and when it said `gone`: a request is this sign-in's only if it started between. */
    const submittedAt = performance.now();
    let goneAt: number | null = null;
    let resources: PerformanceObserver | null = null;
    try {
      // A frame's requests are in its own window's timeline.
      const Observer = (inFrame ? (win as unknown as { PerformanceObserver: typeof PerformanceObserver }).PerformanceObserver : PerformanceObserver) ?? PerformanceObserver;
      resources = new Observer((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
          // Only requests started at or after the submit (a poll that began before it says nothing of the sign-in), and,
          // after `gone`, only those started before it: what the app asks once signed in isn't the sign-in's answer.
          if (e.startTime < submittedAt || (goneAt !== null && e.startTime > goneAt)) continue;
          // Any request answered, the page's own or another site's, is activity: the quiet wait starts again.
          if (!done && quiet) settle();
          let origin: string;
          try {
            origin = new URL(e.name).origin;
          } catch {
            continue;
          }
          const status = e.responseStatus;
          if (origin !== win.location.origin || !(status >= 100 && status <= 599)) continue;
          if (status >= 400 ? errorHints++ >= MAX_ERROR_HINTS : hints++ >= MAX_HINTS) continue;
          bridge.send('hint', { formId: k.id, status });
        }
      });
      resources.observe({ type: 'resource', buffered: false });
    } catch {
      resources = null;
    }
    let tail = 0;
    const deadline = clock.setTimeout(() => {
      if (done) return end();
      // The deadline decides: the field still there (or drawn again), or a busy marker still shown (the request may not
      // have answered), is no sign-in (review round 4 of #59).
      const how = shown() || redrawn().length || busy() ? 'still' : 'gone';
      finish(how);
      // A `gone` decided here: the page's errors are reported a little longer, for a request that answers just after.
      if (how === 'gone') tail = clock.setTimeout(end, DEADLINE_TAIL_MS);
    }, SUBMIT_WATCH_MS);
    function finish(how: 'gone' | 'still'): void {
      if (done) return;
      done = true;
      if (how === 'gone') goneAt = performance.now();
      observer.disconnect();
      if (timer) clock.clearTimeout(timer);
      unquiet();
      bridge.send(how, { formId: k.id });
      // `still` is the end; after `gone`, only the hints go on, until the deadline (or its tail).
      if (how === 'still') end();
    }
    function end(): void {
      done = true;
      if (inFrame) win.removeEventListener('pagehide', onHide);
      observer.disconnect();
      resources?.disconnect();
      clock.clearTimeout(deadline);
      if (tail) clock.clearTimeout(tail);
      if (timer) clock.clearTimeout(timer);
      unquiet();
      if (watching === end) watching = null;
    }
    watching = end;
  }

  // ----- Filling (S17 §5): only the form the menu was shown for, only as it was -----
  const elementOf = (k: KnownForm, f: PasswordField | null): HTMLElement | null => {
    if (!f) return null;
    const i = k.scanned.record.fields.findIndex((x) => x.key === f.key);
    return i >= 0 ? (k.scanned.elements[i] ?? null) : null;
  };
  const usable = (el: HTMLElement | null): el is HTMLInputElement => isTextField(el) && isConnectedNode(el) && !inputDisabled.call(el) && !inputReadOnly.call(el) && isShown(el);
  /** In its own viewport and, for a frame's field, in the tab's too (its box offset through the frames above). */
  const onScreen = (el: HTMLElement) => {
    const r = rectOf(el);
    if (!(r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth)) return false;
    if (!inFrame) return true;
    const at = inFrame.offset();
    return !!at && at.y + r.bottom * at.scale > 0 && at.x + r.right * at.scale > 0 && at.y + r.top * at.scale < top.innerHeight && at.x + r.left * at.scale < top.innerWidth;
  };
  /**
   * What typing sends, so React, Vue and Angular see the value (a framework's own setter lives in the page's world). The
   * top realm's native setter and `dispatchEvent`, for a frame's field too: a frame's script can patch its own (phase 3C).
   */
  const put = (el: HTMLInputElement, value: string) => {
    setControlValue(el, value);
    EventTarget.prototype.dispatchEvent.call(el, new Event('input', { bubbles: true, composed: true }));
    EventTarget.prototype.dispatchEvent.call(el, new Event('change', { bubbles: true }));
    filled.add(el);
  };
  /** Why a fill wrote nothing (PasswordsFilled's `reason`). */
  type Refused = 'changed' | 'password';
  const outline = (fields: readonly HTMLInputElement[], highlight: PasswordsFill['highlight']) => {
    const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ring = (color: string) => ({ outline: `2px solid ${color}`, outlineOffset: '2px' });
    fields.forEach((el, i) => {
      el.animate([ring('transparent'), { ...ring(highlight.color), offset: 0.1 }, { ...ring(highlight.color), offset: 0.7 }, ring('transparent')], {
        duration: highlight.ms,
        delay: reduce ? 0 : i * highlight.stagger,
        easing: highlight.easing,
      });
    });
  };
  /**
   * A generated password (S17 §6): into the form's new password's field and its confirmation's, and nothing else
   * (never the username or the current password). Only a visible `type=password` field you could type in gets it: a
   * confirmation that isn't one yet (a later step's) is left for its own menu; a new password's field that isn't
   * one is the form changed.
   */
  function fillGenerated(p: PasswordsFill & { generated: string }): true | Refused {
    // The new password's field as the agent last knew it (the menu was shown from that scan): it must still be the one.
    const before = known.find((x) => x.id === p.formId);
    const was = before?.classified ? elementOf(before, before.classified.newPassword) : null;
    rescan();
    const k = known.find((x) => x.id === p.formId);
    const c = k?.classified;
    if (!k || !c) return 'changed';
    // A password field of the form shown as text now: the form isn't as the menu showed it.
    if (k.scanned.elements.some((el) => wasPassword.has(el) && controlType(el) !== 'password')) return 'changed';
    const fresh = elementOf(k, c.newPassword);
    if (!fresh || !usable(fresh) || controlType(fresh) !== 'password' || (was && was !== fresh)) return 'changed';
    const confirm = elementOf(k, c.confirmation);
    const fields = [fresh, ...(confirm && usable(confirm) && controlType(confirm) === 'password' ? [confirm] : [])];
    if (!fields.some(onScreen)) return 'changed';
    for (const el of fields) put(el, p.generated);
    outline(fields, p.highlight);
    return true;
  }
  function fill(p: PasswordsFill): true | Refused {
    if (p.generated !== undefined) return fillGenerated(p as PasswordsFill & { generated: string });
    // The page as it is now: a field swapped, hidden or re-rendered since the menu opened is seen here.
    rescan();
    const k = known.find((x) => x.id === p.formId);
    const c = k?.classified;
    if (!k || !c) return 'changed';
    const named = elementOf(k, c.username);
    const pass = elementOf(k, c.password);
    // A password step that carries the username from the step before, read-only or hidden, already holding the
    // account you picked: only the password goes in. Holding another account, the form isn't this account's.
    const carried = !!named && !!pass && !usable(named) && valueOfControl(named) !== '' && ((isField(named) && inputReadOnly.call(named) === true) || !isShown(named));
    if (carried && valueOfControl(named).trim().toLowerCase() !== p.username.trim().toLowerCase()) return 'changed';
    const user = carried ? null : named;
    // No current password's field, and the account picked in the menu of the new password's field itself (`intoNew`:
    // a sign-in read as a sign-up, S17 §9): its password goes into that field and its confirmation, visible
    // `type=password` ones. Picked anywhere else, such a form gets nothing (never half a fill, below).
    // (A current password's field is checked below, as before: usable and `type=password`, or the form changed.)
    const into: HTMLInputElement[] = pass
      ? [pass as HTMLInputElement]
      : p.password && p.intoNew
        ? [elementOf(k, c.newPassword), elementOf(k, c.confirmation)].filter((el): el is HTMLInputElement => !!el && usable(el) && controlType(el) === 'password')
        : [];
    // Never half a fill: a password field you could type in, with a role in this form, that the fill would leave
    // empty (main sent no password, as for a first step, or the field isn't the current password) gets nothing at all.
    // A change form's new password and its confirmation are yours to choose: the account's password goes into its
    // current field, and they stay empty (review round 1 of #53).
    const intoCurrent = !!pass && !!p.password;
    const left = k.scanned.elements.filter((el, i) => {
      const role = c.roles.get(k.scanned.record.fields[i]!.key);
      if (controlType(el) !== 'password' || !role || !usable(el)) return false;
      if (intoCurrent && (role === 'new-password' || role === 'confirmation-password')) return false;
      return !p.password || !into.includes(el);
    });
    if (left.length) return 'password';
    if (!user && !into.length) return 'changed';
    // Main sent a password: the form had one when the menu showed. One with none now (hidden since) changed.
    if (p.password && !into.length) return 'changed';
    if (user && !usable(user)) return 'changed';
    // A password field needs the password: main leaves it out only for a first step, which has none.
    if (pass && (!p.password || !usable(pass) || controlType(pass) !== 'password')) return 'changed';
    if (![user, ...into].some((el) => el && onScreen(el))) return 'changed';
    const fields = [user && p.username ? ([user, p.username] as const) : null, ...into.map((el) => (p.password ? ([el, p.password] as const) : null))].filter((f) => f !== null);
    for (const [el, value] of fields) put(el, value);
    outline(
      fields.map(([el]) => el),
      p.highlight,
    );
    return true;
  }
  const onFill = (raw: unknown) => {
    const p = raw as { formId?: unknown; username?: unknown; password?: unknown; generated?: unknown; intoNew?: unknown; highlight?: unknown } | null;
    const h = p?.highlight as Partial<PasswordsFill['highlight']> | undefined;
    if (!p || typeof p.formId !== 'string') return;
    if (p.generated !== undefined) {
      // A generated password: that alone, never with an account's username or password.
      if (typeof p.generated !== 'string' || !p.generated || p.generated.length > PASSWORD_LIMITS.password || p.username !== undefined || p.password !== undefined) return;
    } else if (typeof p.username !== 'string' || (p.password !== undefined && (typeof p.password !== 'string' || !p.password)) || (p.intoNew !== undefined && p.intoNew !== true)) return;
    if (!h || typeof h.color !== 'string' || typeof h.ms !== 'number' || typeof h.stagger !== 'number' || typeof h.easing !== 'string') return;
    let done: true | Refused;
    try {
      // A frame's: checked again right before anything is written (navigated, sandboxed or another origin since the menu).
      done = live() ? fill(p as PasswordsFill) : 'changed';
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
  for (const up of inFrame?.ancestors ?? []) {
    EventTarget.prototype.addEventListener.call(up.document, 'scroll', onMove, { capture: true, passive: true });
    EventTarget.prototype.addEventListener.call(up.window, 'resize', onMove, { passive: true });
    stops.push(() => {
      EventTarget.prototype.removeEventListener.call(up.document, 'scroll', onMove, { capture: true });
      EventTarget.prototype.removeEventListener.call(up.window, 'resize', onMove);
    });
  }
  rescan();
  // A field focused before the agent woke (the sentinel wakes on that focus).
  const active = activeElementOf(doc);
  if (isTextField(active)) onFocusIn({ composedPath: () => [active] } as unknown as FocusEvent);

  const release = () => {
    released = true;
    for (const stop of stops.splice(0)) stop();
    if (frame) clock.cancelAnimationFrame(frame);
    if (timer) clock.clearTimeout(timer);
    if (trailing) clock.clearTimeout(trailing);
    frame = timer = trailing = 0;
    known = [];
    byElement = new WeakMap();
    focused = told = pending = null;
  };
  return Object.assign(
    () => {
      release();
      watching?.();
    },
    { release },
  );
}
