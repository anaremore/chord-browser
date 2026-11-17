/**
 * The test-the-web suite's script in each page (ttw.spec.ts bundles it, as corpus.spec.ts does
 * page.ts): the agent's own scan and `classifyPasswordForm(..., 'filling')`, held to Chord's
 * expectations for the page (ttw-pages.ts), and the agent itself with a fake bridge, for the
 * real fill path.
 */
import { classifyPasswordForm, type PasswordFieldRole } from '@chord/core';
import { startAgent } from '../../src/passwords/agent/agent';
import { scanDocument } from '../../src/passwords/agent/scan';

/** What a step expects: the username's and the current password's fields, by selector. */
export interface Expected {
  readonly username?: string;
  readonly password?: string;
}

export interface CheckResult {
  /** A selector that matched nothing: the page isn't as its expectation was written. */
  readonly notFound: string[];
  /** The kind of form the expected fields are in, or null if the detector gave it none. */
  readonly kind: string | null;
  /** Every field whose role isn't the one expected: `what field → role`. */
  readonly wrong: string[];
}

const name = (el: Element) => {
  const i = el as HTMLInputElement;
  return `${String(i.type || el.tagName).toLowerCase()}#${el.id || '-'}[${el.getAttribute('name') || '-'}]`;
};

function check(expected: Expected): CheckResult {
  const notFound: string[] = [];
  const want = new Map<Element, PasswordFieldRole>();
  for (const [role, selector] of [
    ['username', expected.username],
    ['current-password', expected.password],
  ] as const) {
    if (!selector) continue;
    const el = document.querySelector(selector);
    if (el) want.set(el, role);
    else notFound.push(selector);
  }
  const wrong: string[] = [];
  let kind: string | null = null;
  const seen = new Set<Element>();
  for (const form of scanDocument(document)) {
    const classified = classifyPasswordForm(form.record, 'filling');
    form.elements.forEach((el, i) => {
      seen.add(el);
      const role = classified?.roles.get(form.record.fields[i]!.key) ?? null;
      const wanted = want.get(el) ?? null;
      if (wanted) kind = classified?.kind ?? null;
      if (role !== wanted) wrong.push(`${wanted ?? 'other'} ${name(el)} → ${role ?? 'none'}`);
    });
  }
  // An expected field the scan never took (in a shadow root, say).
  for (const [el, role] of want) if (!seen.has(el)) wrong.push(`${role} ${name(el)} → not scanned`);
  return { notFound, kind, wrong };
}

type Message = [string, Record<string, unknown>];
const messages: Message[] = [];
let stop: (() => void) | null = null;
let onFill: ((payload: unknown) => void) | null = null;

(globalThis as unknown as { chordTtw: unknown }).chordTtw = {
  check,
  /** The agent on this document, as the sentinel wakes it, with a bridge that records what it sends. */
  start() {
    stop?.();
    onFill = null;
    messages.length = 0;
    stop = startAgent({
      send: (channel, payload) => void messages.push([channel, structuredClone(payload) as Record<string, unknown>]),
      onFill: (listener) => void (onFill ??= listener),
    });
  },
  stop() {
    stop?.();
    stop = null;
  },
  /** A fill as main sends it, through the bridge. */
  fill: (payload: unknown) => onFill?.(structuredClone(payload)),
  messages: () => messages.slice(),
  clear: () => void (messages.length = 0),
};
