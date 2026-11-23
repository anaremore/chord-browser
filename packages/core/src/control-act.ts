/**
 * Acting on pages (S18 M2c; docs/decisions/S18-agent-mcp.md, "M2: plan"): the pure parts. What each acting tool asks
 * for, the keys press_key may send and how they're sent, the words the bar, the site card and the activity line use,
 * and what an agent hears when an action can't be done. Main's half is apps/desktop/src/main/control/act.ts.
 *
 * - **Elements, not pixels.** Every action names a `ref` from the tab's latest snapshot (control-snapshot.ts), checked
 *   again in the page before anything is sent; nothing takes a position or a selector.
 * - **Trusted input.** Clicks and keys go through `sendInputEvent` (main's control/input.ts, which refuses anything off
 *   agentInputAllowed); text goes in by `insertText`, never as keys.
 * - **Every action is `act` in M2c:** the first on a site asks (the site card); M2d adds the risky steps.
 */
import type { AGENT_KEYS, AgentInputLike } from './agent-input';

/** The acting tools (navigate and back need no element). */
export type ActTool = 'click' | 'type' | 'press_key' | 'select_option' | 'hover' | 'navigate' | 'back';
/** Tools that act on an element by its ref, and so on a site: they ask the site card first. */
export const ELEMENT_TOOLS = ['click', 'type', 'press_key', 'select_option', 'hover'] as const;
export type ElementTool = (typeof ELEMENT_TOOLS)[number];

/** The most text `type` puts in at once. */
export const TYPE_TEXT_MAX = 5000;
/** The longest address `navigate` goes to. */
export const NAVIGATE_URL_MAX = 2048;
/** How long an action waits for what it set off: a navigation's load, at most. */
export const ACT_LOAD_MS = 10_000;
/** How long it waits for the page to settle when nothing navigates: quiet for SETTLE_QUIET_MS, at most this. */
export const ACT_SETTLE_MS = 500;
export const ACT_SETTLE_QUIET_MS = 100;
/** The bar keeps each wording at least this long, so a fast agent doesn't make it flicker. */
export const ACT_BAR_MIN_MS = 600;

/** press_key's keys, as an agent names them (the plan's list). */
export const PRESS_KEYS = ['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

/** The accelerator name sendInputEvent takes for each key, and the character its keypress types, if any. */
const KEY_EVENTS: Record<PressKey, { keyCode: (typeof AGENT_KEYS)[number]; char?: string; shift?: true }> = {
  Enter: { keyCode: 'Return', char: '\r' },
  Tab: { keyCode: 'Tab' },
  'Shift+Tab': { keyCode: 'Tab', shift: true },
  Escape: { keyCode: 'Escape' },
  Backspace: { keyCode: 'Backspace' },
  Delete: { keyCode: 'Delete' },
  Space: { keyCode: 'Space', char: ' ' },
  ArrowUp: { keyCode: 'Up' },
  ArrowDown: { keyCode: 'Down' },
  ArrowLeft: { keyCode: 'Left' },
  ArrowRight: { keyCode: 'Right' },
  Home: { keyCode: 'Home' },
  End: { keyCode: 'End' },
  PageUp: { keyCode: 'PageUp' },
  PageDown: { keyCode: 'PageDown' },
};

export const isPressKey = (key: unknown): key is PressKey => typeof key === 'string' && (PRESS_KEYS as readonly string[]).includes(key);

/** The events a key is sent as: down, its character (Enter's keypress submits a form), up. Every one is agentInputAllowed's. */
export function pressKeyEvents(key: PressKey): (AgentInputLike & { keyCode: string; modifiers?: string[] })[] {
  const k = KEY_EVENTS[key];
  const modifiers = k.shift ? { modifiers: ['shift'] } : {};
  return [{ type: 'keyDown', keyCode: k.keyCode, ...modifiers }, ...(k.char ? [{ type: 'char', keyCode: k.char, ...modifiers }] : []), { type: 'keyUp', keyCode: k.keyCode, ...modifiers }];
}

/** A name from the page, for Chord's own words: cut to 60 characters, in curly quotes. Empty names say what the element is. */
export function quotedName(name: string, role: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!clean) return `the ${role === 'generic' ? 'element' : role}`;
  return `“${clean.length > 60 ? `${clean.slice(0, 59)}…` : clean}”`;
}

/** What an action is, in Chord's words (never the agent's): `click “Start a return”`, for the site card and the activity line. */
export interface ActDescription {
  tool: ElementTool;
  /** The element, as the snapshot named it. */
  name: string;
  role: string;
  /** press_key's key; select_option's choice. */
  key?: PressKey;
  choice?: string;
}

export function actPhrase(a: ActDescription): string {
  const el = quotedName(a.name, a.role);
  switch (a.tool) {
    case 'click':
      return `click ${el}`;
    case 'type':
      return `type in ${el}`;
    case 'press_key':
      return `press ${a.key ?? 'a key'} in ${el}`;
    case 'select_option':
      return `choose ${quotedName(a.choice ?? '', 'option')} in ${el}`;
    case 'hover':
      return `point at ${el}`;
  }
}

/** The same, done: the activity line (*Clicked “Start a return”*). */
export function actDone(a: ActDescription): string {
  const phrase = actPhrase(a);
  const [verb, ...rest] = phrase.split(' ');
  const past: Record<string, string> = { click: 'Clicked', type: 'Typed', press: 'Pressed', choose: 'Chose', point: 'Pointed' };
  return `${past[verb!] ?? verb} ${rest.join(' ')}`;
}

/** What the bar says while an agent acts (present tense, after its name): `is clicking “Start a return”`. */
export type BarDoing = { tool: ElementTool; name: string; role: string; key?: PressKey; choice?: string } | { tool: 'navigate'; to: string } | { tool: 'back' };

export function barDoing(d: BarDoing): string {
  switch (d.tool) {
    case 'navigate':
      return `is going to ${d.to}`;
    case 'back':
      return 'is going back';
    case 'click':
      return `is clicking ${quotedName(d.name, d.role)}`;
    case 'type':
      return `is typing in ${quotedName(d.name, d.role)}`;
    case 'press_key':
      return `is pressing ${d.key ?? 'a key'}`;
    case 'select_option':
      return `is choosing ${quotedName(d.choice ?? '', 'option')} in ${quotedName(d.name, d.role)}`;
    case 'hover':
      return `is pointing at ${quotedName(d.name, d.role)}`;
  }
}

/** A navigation's target for the bar: host and path, no query or fragment, cut to 60 characters. */
export function barAddress(url: string): string {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  const text = m ? `${m[1]}${m[2] === '/' ? '' : m[2]}` : url;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** What an agent hears when an action can't be done, one sentence each, as the plan has them. */
export const ACT_REFUSALS = {
  changed: 'That element changed since the snapshot (it’s gone, hidden, or now says something else). Call snapshot again.',
  covered: (what: string) => `Something is covering that element: ${what}. Deal with it first, or call snapshot again.`,
  disabled: 'That element is disabled.',
  notEditable: 'That element doesn’t take text.',
  notSelect: 'That element isn’t a list of choices. Use click for it.',
  // Never the agent's words back (a choice that isn't on the page isn't quoted): the page's own options are in a snapshot.
  noChoice: 'That list has no such choice. Call snapshot for its choices.',
  twoChoices: 'That list has more than one choice by that name, so nothing was chosen. Ask the user to choose.',
  sensitive: 'That field is now a password, code or card field: the user fills it. Ask them to.',
  focusMoved: 'The page moved the focus away from that field, so nothing was typed. Call snapshot again.',
  // The focus went where Chord can't see (into a frame) while text or a key went in: some of it may have gone there.
  focusLost: 'The focus moved while that went in, so some of it may not have reached the field. Call snapshot and check it.',
  closed: 'Chord can’t see inside that element (it hides what’s in it from other scripts), so it doesn’t type or press keys in it. Ask the user to.',
  unsecured: 'A frame on this page couldn’t be secured, so Chord won’t act here. Try another page, or ask the user.',
  noCheck: 'Chord couldn’t check that page right now (is its DevTools window busy?), so nothing was done. Try again in a moment.',
  file: 'That opens a file picker: agents never choose files. Ask the user to.',
  noMove: 'The page didn’t see the pointer arrive, so nothing was clicked. Call snapshot again, then try once more.',
  sharedReadOnly: 'That tab is shared with you to read, not to act on. Ask the user if they want you to act in your own tab.',
  siteDenied: (site: string) => `The user didn’t let you act on ${site}. Don’t act there again unless the user asks you to.`,
  noSite: 'Chord can’t act on this page (it isn’t a web page).',
  key: `press_key takes one of: ${PRESS_KEYS.join(', ')}. Put text in with type.`,
  text: `type takes text of at most ${TYPE_TEXT_MAX} characters.`,
  noBack: 'That tab has nowhere to go back to.',
} as const;
