/**
 * Input Chord sends a page for an agent (S18 M2, docs/decisions/S18-agent-mcp.md "M2: plan"): trusted input through
 * `webContents.sendInputEvent`, as the OS would deliver it, so pages treat it as a person's (focus, default actions,
 * user activation). It goes through the same path as yours, so Chord's own listeners see it too: `before-input-event`,
 * `before-mouse-event` and `input-event`. The ones that act on *your* hands ask `isAgentInput` first:
 *
 * - an agent's tab pauses when you press a key there, and a navigation just after your key or click is yours
 *   (agents/chords.ts, `USER_MS`): the agent's own never is;
 * - Chord's shortcuts (keyboard.ts) and DevTools' keys (devtools.ts) never run for it. A key of press_key's list goes to
 *   the page as it is (an agent's Escape reaches the page, though plain Escape is *Stop loading* too); any other key is
 *   stopped there;
 * - a split's pane isn't focused by it (browser.ts).
 *
 * Before any of that, an event Chord never sends for an agent (core's agentInputAllowed: a modifier, a key off
 * press_key's list, a right-click) is refused, and nothing of its batch is sent.
 *
 * **The menu's accelerators.** Keys a page leaves alone go on to the window's menu accelerators (S8), after the send has
 * returned, so `before-input-event` can't stop them without stopping the page's key too. So a send with keys turns the
 * page's menu shortcuts off (`setIgnoreMenuShortcuts`) and leaves them off until your next key there, which turns them
 * back on in `before-input-event` (keyboard.ts, `yourKey`), before that key reaches the page or the menu. An agent's
 * Escape can't stop the page loading; your Escape after it can. (A key of yours pressed in the few milliseconds while
 * an agent's key is still on its way turns them on early: that agent key could then reach the menu, as yours would.)
 *
 * Electron emits those events for clicks and keys while `sendInputEvent` runs, before it returns (M2a's spike, on
 * each CI OS: agents.spec.ts), so for them a count of sends under way is exact: no queue to match, nothing left over
 * to mistake a key of yours for one of the agent's. The wheel is seen inside too, but the scroll it starts comes
 * after (`gestureScroll*`, and `input-event`'s `mouseWheel` once the page has handled it): none of the listeners
 * above acts on those, and the one that does (history's scroll save) is right to.
 */
import { agentInputAllowed } from '@chord/core';
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, WebContents } from 'electron';

export type AgentInputEvent = KeyboardInputEvent | MouseInputEvent | MouseWheelInputEvent;

/** What sendAgentInput needs of a page: a WebContents, or a stand-in in the units. */
type Page = Pick<WebContents, 'isDestroyed' | 'sendInputEvent' | 'setIgnoreMenuShortcuts'>;

const sending = new WeakMap<Page, number>();
/** Pages whose menu shortcuts an agent's keys turned off, until your next key there. */
const menuOff = new WeakSet<Page>();

/** An event Chord never sends for an agent (core's agentInputAllowed): nothing of the batch was sent. */
export class AgentInputRefused extends Error {
  constructor(readonly event: AgentInputEvent) {
    super(`Chord never sends ${event.type}${'keyCode' in event ? ` ${event.keyCode}` : ''} for an agent`);
  }
}

const isKey = (event: AgentInputEvent) => event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char';

/**
 * Sends the events, in order, as the agent's: all of them, or, if any is one Chord never sends for an agent (a
 * modifier, a key off the list, a right-click), none (AgentInputRefused). `unchecked` is for the E2E hook alone, to
 * show Chord's shortcuts stop such a key a second time.
 */
export function sendAgentInput(contents: Page, events: readonly AgentInputEvent[], unchecked = false): void {
  if (!unchecked) for (const event of events) if (!agentInputAllowed(event)) throw new AgentInputRefused(event);
  if (contents.isDestroyed()) return;
  if (events.some(isKey) && !menuOff.has(contents)) {
    contents.setIgnoreMenuShortcuts(true);
    menuOff.add(contents);
  }
  sending.set(contents, (sending.get(contents) ?? 0) + 1);
  try {
    for (const event of events) contents.sendInputEvent(event);
  } finally {
    const left = (sending.get(contents) ?? 1) - 1;
    if (left > 0) sending.set(contents, left);
    else sending.delete(contents);
  }
}

/** The input event being handled now is one Chord is sending for an agent, not yours. */
export const isAgentInput = (contents: Page): boolean => (sending.get(contents) ?? 0) > 0;

/** Your key in this page (keyboard.ts, before the page or the menu sees it): its menu shortcuts are yours again. */
export function yourKey(contents: Page): void {
  if (!menuOff.delete(contents) || contents.isDestroyed()) return;
  contents.setIgnoreMenuShortcuts(false);
}
