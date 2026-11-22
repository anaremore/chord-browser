/**
 * What input Chord ever sends a page for an agent (S18 M2; docs/decisions/S18-agent-mcp.md, "M2: plan"): the pure
 * rule main's `sendAgentInput` checks every event against before it's sent (apps/desktop/src/main/control/input.ts).
 *
 * - **Keys:** only the plan's list (press_key's): no letters (a web app's shortcuts), and no Ctrl, Alt, ⌘ or function
 *   keys, so an agent can never press a shortcut of Chord's, the OS's or a page's. Shift only with Tab. Text goes in
 *   by `insertText`, never as keys.
 * - **Mouse:** the left button, moves and the wheel, with no modifier: no right-click (the context menu), no
 *   Ctrl+click (a new tab), no middle button.
 *
 * Chord's own shortcuts stop an agent's key a second time (keyboard.ts), should one ever get past this.
 */

/** press_key's keys, by Electron's names for them (accelerator names, as `sendInputEvent` takes them). */
export const AGENT_KEYS = ['Return', 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** A `char` event's character, for the keys that type one (Enter's keypress, which submits a form; Space; Tab). */
const AGENT_CHARS = new Set(['\r', ' ', '\t']);

const MOUSE_TYPES = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'mouseEnter', 'mouseLeave', 'mouseWheel']);

/** An input event as `webContents.sendInputEvent` takes it (Electron's InputEvent and its kinds), loosely. */
export interface AgentInputLike {
  type: string;
  modifiers?: readonly string[];
  keyCode?: string;
  button?: string;
}

/** Modifiers that aren't a key held (Electron lists these with them): never a reason to refuse. */
const NOT_HELD = new Set(['isKeypad', 'isAutoRepeat', 'leftButtonDown', 'capsLock', 'numLock']);
const held = (event: AgentInputLike): string[] => (event.modifiers ?? []).filter((m) => !NOT_HELD.has(m)).map((m) => m.toLowerCase());

/** Whether Chord may send this event for an agent; anything else is refused before it's sent. */
export function agentInputAllowed(event: AgentInputLike): boolean {
  const mods = held(event);
  if (event.type === 'keyDown' || event.type === 'keyUp') {
    if (!(AGENT_KEYS as readonly string[]).includes(event.keyCode ?? '')) return false;
    return mods.length === 0 || (event.keyCode === 'Tab' && mods.length === 1 && mods[0] === 'shift');
  }
  if (event.type === 'char') return AGENT_CHARS.has(event.keyCode ?? '') && (mods.length === 0 || (event.keyCode === '\t' && mods.length === 1 && mods[0] === 'shift'));
  if (MOUSE_TYPES.has(event.type)) {
    if (mods.length > 0) return false;
    return event.type === 'mouseMove' || event.type === 'mouseWheel' || event.type === 'mouseEnter' || event.type === 'mouseLeave' || (event.button ?? 'left') === 'left';
  }
  return false;
}
