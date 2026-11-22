/**
 * Input Chord sends a page for an agent (S18 M2, docs/decisions/S18-agent-mcp.md "M2: plan"): trusted input through
 * `webContents.sendInputEvent`, as the OS would deliver it, so pages treat it as a person's (focus, default actions,
 * user activation). It goes through the same path as yours, so Chord's own listeners see it too: `before-input-event`,
 * `before-mouse-event` and `input-event`. The ones that act on *your* hands ask `isAgentInput` first:
 *
 * - an agent's tab pauses when you press a key there, and a navigation just after your key or click is yours
 *   (agents/chords.ts, `USER_MS`): the agent's own never is;
 * - Chord's shortcuts (keyboard.ts) never run for it;
 * - a split's pane isn't focused by it (browser.ts).
 *
 * Electron emits those events while `sendInputEvent` runs, before it returns (M2a's spike, on each CI OS:
 * agents.spec.ts), so a count of sends under way is exact: no queue to match, nothing left over to mistake a key of
 * yours for one of the agent's.
 */
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, WebContents } from 'electron';

export type AgentInputEvent = KeyboardInputEvent | MouseInputEvent | MouseWheelInputEvent;

const sending = new WeakMap<WebContents, number>();

/** Sends the events, in order, as the agent's. */
export function sendAgentInput(contents: WebContents, events: readonly AgentInputEvent[]): void {
  if (contents.isDestroyed()) return;
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
export const isAgentInput = (contents: WebContents): boolean => (sending.get(contents) ?? 0) > 0;
