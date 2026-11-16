/**
 * The agent with a fake bridge, for agent.spec.ts: every message it would send main, recorded
 * in the page (as structured clones, as the bridge copies them).
 */
import { startAgent } from '../../src/passwords/agent/agent';

const messages: [string, unknown][] = [];
let stop: (() => void) | null = null;

(globalThis as unknown as { chordAgentTest: unknown }).chordAgentTest = {
  start() {
    stop?.();
    stop = startAgent({ send: (channel, payload) => void messages.push([channel, structuredClone(payload)]) });
  },
  messages: () => messages.slice(),
  clear: () => void (messages.length = 0),
};
