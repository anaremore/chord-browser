/**
 * The sign-in box's keyboard, as the popover wires it (Popover.tsx `AuthCard`, #47): the form's
 * `onKeyDownCapture` and `onKeyUpCapture` hold back a key's default (submitting, pressing the focused
 * button) by PromptKeys' rules, `isTextField` lets Space type in the username and password, and
 * `isCancel` lets Cancel work at once. A held key is played as the browser sends it: its first keydown,
 * then repeats, then its keyup; a key's default ran when its event wasn't `defaultPrevented`.
 */
import type { AuthPrompt } from '@chord/ipc';
import { parseHTML } from 'linkedom';
import { createElement } from 'react';
import { act } from 'react';
import type { createRoot as CreateRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const respond = vi.fn(async () => undefined);

const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
const globals = globalThis as unknown as Record<string, unknown>;

let AuthCard: (props: { prompt: AuthPrompt }) => unknown;
let createRoot: typeof CreateRoot;
beforeAll(async () => {
  // React DOM checks for `oninput` as it loads; without it, it falls back to an old-IE polyfill linkedom can't run.
  (dom.document as unknown as { oninput: null }).oninput = null;
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLButtonElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent']) {
    if (!(name in globals) || name === 'window' || name === 'document') globals[name] = (dom as unknown as Record<string, unknown>)[name] ?? (dom.window as unknown as Record<string, unknown>)[name];
  }
  globals['IS_REACT_ACT_ENVIRONMENT'] = true;
  (dom.window as unknown as { chord: unknown }).chord = { auth: { respond, unlock: vi.fn() } };
  ({ createRoot } = await import('react-dom/client'));
  ({ AuthCard } = (await import('../../src/renderer/popover/Popover')) as unknown as { AuthCard: typeof AuthCard });
});

const PROMPT: AuthPrompt = { id: 7, origin: 'http://router.test:8080', realm: 'Router admin', proxy: false, insecure: true, retry: false, accounts: [], locked: false, remember: null, fill: false, embedded: null };

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  respond.mockClear();
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

function show(prompt: Partial<AuthPrompt> = {}) {
  act(() => root.render(createElement(AuthCard as never, { prompt: { ...PROMPT, ...prompt } })));
  const form = container.querySelector('form')!;
  const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!;
  const fields = [...container.querySelectorAll('input')].filter((input) => input.getAttribute('type') !== 'checkbox');
  return { form, fields, username: fields[0]!, signIn: button('Sign in'), cancel: button('Cancel') };
}

/** One key event at `target`, bubbling and cancelable as the browser's: whether its default runs. */
function key(target: Element, type: 'keydown' | 'keyup', name: string, repeat = false): boolean {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  Object.defineProperties(event, { key: { value: name }, repeat: { value: repeat } });
  let ran = true;
  act(() => {
    ran = target.dispatchEvent(event);
  });
  return ran;
}

const arm = () => act(() => vi.advanceTimersByTime(500));
const submit = (form: HTMLFormElement) => act(() => void form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event));

describe('AuthCard’s keyboard', () => {
  it('an Enter held through the delay never signs in; pressed afresh, it does', () => {
    const { form, username } = show();
    expect(key(username, 'keydown', 'Enter')).toBe(false);
    expect(key(username, 'keydown', 'Enter', true)).toBe(false);
    arm();
    expect(key(username, 'keydown', 'Enter', true)).toBe(false);
    expect(key(username, 'keyup', 'Enter')).toBe(false);
    // Let go and pressed again: its default (the form's submission) runs, and the submission answers.
    expect(key(username, 'keydown', 'Enter')).toBe(true);
    submit(form);
    expect(respond).toHaveBeenCalledOnce();
  });

  it('nothing answers the box before the delay, even a submission that got through', () => {
    const { form } = show();
    submit(form);
    expect(respond).not.toHaveBeenCalled();
  });

  it('a Space held through the delay on a filled box doesn’t press Sign in; a fresh press does', () => {
    const { form, signIn } = show({ fill: true, accounts: ['ada'], remember: true });
    // Held from before: its keydown on the box, its repeats and its release on Sign in once that has the focus.
    expect(key(form, 'keydown', ' ')).toBe(false);
    arm();
    expect(key(signIn, 'keydown', ' ', true)).toBe(false);
    expect(key(signIn, 'keyup', ' ')).toBe(false);
    expect(key(signIn, 'keydown', ' ')).toBe(true);
    expect(key(signIn, 'keyup', ' ')).toBe(true);
  });

  it('Space typed in the username or the password is only typing, before the delay too', () => {
    const { fields } = show();
    expect(fields.map((f) => f.getAttribute('type') ?? 'text')).toEqual(['text', 'password']);
    for (const field of fields) {
      expect(key(field, 'keydown', ' ')).toBe(true);
      expect(key(field, 'keydown', ' ', true)).toBe(true);
      expect(key(field, 'keyup', ' ')).toBe(true);
    }
  });

  it('Cancel works at once, by Enter or Space', () => {
    const { cancel } = show();
    expect(key(cancel, 'keydown', 'Enter')).toBe(true);
    expect(key(cancel, 'keydown', ' ')).toBe(true);
    expect(key(cancel, 'keyup', ' ')).toBe(true);
  });
});
