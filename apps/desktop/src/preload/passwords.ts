/**
 * The passwords sentinel (S17 §8; M0 §1): a session-registered, sandboxed frame preload,
 * registered only while passwords are on (main/passwords/detector.ts,
 * `registerPreloadScript` / `unregisterPreloadScript`). It runs in the preload's own world,
 * in a tab's main frame only (Chord's tabs don't set `nodeIntegrationInSubFrames`), and adds
 * nothing to the page's DOM or its main world.
 *
 * It does nothing until the page shows a sign-in field: a password field once the document is
 * parsed or loaded, or focus or typing in a password field or one that reads as a username or
 * email, in an open shadow root too (phase 3B: the event's path, the focus's chain of roots; no
 * walk), or in a same-origin frame the agent may use (phase 3C: no `sandbox`, an http(s) address of the top's origin, 3
 * levels and 20 frames at most), which it looks into at parse and load, listens in, and looks at again when a frame
 * loads. Then, once, it asks main for the agent's script, exposes the agent's bridge in
 * isolated world 4440 (`contextBridge.exposeInIsolatedWorld`) and runs the agent there. Two
 * passive capturing listeners and a `querySelector` at each of two moments are its whole cost
 * on any other page (M0 §6: nothing measurable).
 *
 * Main talks to the agent one way only: `passwords:fill` (the account you picked in the menu,
 * sent to this frame alone), handed to the one listener the agent registered (`onFill`).
 *
 * Only types come from `@chord/ipc`, so no schema library lands in every page's preload; main
 * checks every message.
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { PasswordsAgentChannel } from '@chord/ipc';

/** The agent's world: its own, so neither the page nor the assistant's (4400) can see it (S17 §8). */
const WORLD = 4440;
/** The channels the bridge forwards, each as `passwords:<name>`; anything else is dropped here. */
const CHANNELS = ['focus', 'blur', 'forms', 'candidate', 'step', 'gone', 'still', 'hint', 'filled'] as const satisfies readonly PasswordsAgentChannel[];
// Every channel of the contract is here (a type error otherwise).
const _every: Exclude<PasswordsAgentChannel, (typeof CHANNELS)[number]> extends never ? true : never = true;
void _every;

/** The page's globals this reads (the preload's project has no DOM types). */
interface Field {
  tagName?: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
}
/** An event as the sentinel reads it: its first target through open shadow roots, where the page gives one. */
interface PageEvent {
  target: unknown;
  composedPath?(): unknown[];
}
interface PageDocument {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<PageFrame>;
  addEventListener(type: string, fn: (event: PageEvent) => void, options: { once: boolean } | { capture: boolean; passive: boolean }): void;
  readyState: string;
  activeElement: unknown;
  URL: string;
  defaultView: PageGlobals | null;
}
interface PageFrame {
  tagName: string;
  hasAttribute(name: string): boolean;
  contentDocument: PageDocument | null;
}
interface PageGlobals {
  location: { protocol: string; origin: string };
  document: PageDocument;
  addEventListener(type: string, fn: (event: PageEvent) => void, options: { capture: boolean; passive: boolean } | { once: boolean }): void;
  removeEventListener(type: string, fn: (event: PageEvent) => void, options: { capture: boolean }): void;
}

const page = globalThis as unknown as PageGlobals;
const USERNAMEISH = /user|login|e-?mail|account|ident/i;

/** A field that says sign-in: a password field, an email field, or one whose autocomplete, name or id reads as a username. */
const signInField = (target: unknown) => {
  const el = target as Field | null;
  if (!el || el.tagName !== 'INPUT') return false;
  return el.type === 'password' || el.type === 'email' || USERNAMEISH.test(`${el.autocomplete ?? ''} ${el.name ?? ''} ${el.id ?? ''}`);
};

let woken = false;
async function wake(): Promise<void> {
  if (woken) return;
  woken = true;
  stopListening();
  // Main answers only a tab's page in a chord where passwords are on; anywhere else there's no agent.
  const source: unknown = await ipcRenderer.invoke('passwords:agent').catch(() => null);
  if (typeof source !== 'string' || !source) return;
  // Main's fill, to the agent's one listener: registered once, by the agent as it starts.
  let onFill: ((payload: unknown) => void) | null = null;
  ipcRenderer.on('passwords:fill', (_event, payload: unknown) => onFill?.(payload));
  contextBridge.exposeInIsolatedWorld(WORLD, 'chordPasswords', {
    send: (channel: unknown, payload: unknown) => {
      if (typeof channel === 'string' && (CHANNELS as readonly string[]).includes(channel)) ipcRenderer.send(`passwords:${channel}`, payload);
    },
    onFill: (listener: unknown) => {
      if (!onFill && typeof listener === 'function') onFill = listener as (payload: unknown) => void;
    },
  });
  webFrame.setIsolatedWorldInfo(WORLD, { name: 'Chord passwords' });
  await webFrame.executeJavaScriptInIsolatedWorld(WORLD, [{ code: source, url: 'chord://passwords/agent.js' }]).catch(() => undefined);
}

const fieldOf = (event: PageEvent) => event.composedPath?.()[0] ?? event.target;
const onField = (event: PageEvent) => {
  if (signInField(fieldOf(event))) void wake();
};
const activeField = () => {
  type Focused = { shadowRoot?: { activeElement?: unknown } | null } | null;
  let el = page.document.activeElement as Focused;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as Focused;
  return el;
};
/**
 * The same-origin frames the agent may use (phase 3C, as frames.ts has them): no `sandbox`, an http(s) address of the
 * top's origin, 3 levels and 20 frames at most. The preload runs in the top frame only, so it looks into them itself.
 */
const frameDocuments = () => {
  const out: PageDocument[] = [];
  let seen = 0;
  const walk = (d: PageDocument, depth: number) => {
    if (depth > 2) return;
    for (const f of Array.from(d.querySelectorAll('iframe,frame'))) {
      if (++seen > 20) return;
      let fd: PageDocument | null;
      try {
        fd = f.hasAttribute('sandbox') ? null : f.contentDocument;
        if (fd && (!/^https?:/.test(fd.URL) || new URL(fd.URL).origin !== page.location.origin)) fd = null;
      } catch {
        fd = null;
      }
      if (fd) {
        out.push(fd);
        walk(fd, depth + 1);
      }
    }
  };
  walk(page.document, 0);
  return out;
};
const listened = new WeakSet<object>();
const look = () => {
  if (page.document.querySelector('input[type=password]') || signInField(activeField())) return void wake();
  // A frame's sign-in field, and focus or typing in one later (the frame's own window hears those).
  for (const d of frameDocuments()) {
    if (d.querySelector('input[type=password]') || signInField(d.activeElement)) return void wake();
    // By document: a frame's window is the same object across its navigations, its listeners not.
    const w = d.defaultView;
    if (w && !listened.has(d)) {
      listened.add(d);
      w.addEventListener('focusin', onField, { capture: true, passive: true });
      w.addEventListener('input', onField, { capture: true, passive: true });
    }
  }
};
/** A frame that loaded (added later, or navigated): looked into, once the agent isn't awake. */
const onLoad = (event: PageEvent) => {
  const t = event.target as { tagName?: string } | null;
  if (!woken && (t?.tagName === 'IFRAME' || t?.tagName === 'FRAME')) look();
};
function stopListening(): void {
  page.removeEventListener('focusin', onField, { capture: true });
  page.removeEventListener('input', onField, { capture: true });
}

// Web pages only: not an extension's pages, which share the session, nor a blank frame's.
const { protocol } = page.location;
if (protocol === 'https:' || protocol === 'http:') {
  page.addEventListener('focusin', onField, { capture: true, passive: true });
  page.addEventListener('input', onField, { capture: true, passive: true });
  // Once parsed, and again once loaded: a framework may render the form in between (M0 §1: React 19 had by parse).
  page.document.addEventListener('DOMContentLoaded', look, { once: true });
  page.addEventListener('load', look, { once: true });
  page.document.addEventListener('load', onLoad, { capture: true, passive: true });
}
