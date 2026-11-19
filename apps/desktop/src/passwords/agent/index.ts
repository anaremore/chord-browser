/**
 * The agent's script, as main serves it to the sentinel (`passwords:agent`): built at build time
 * into one self-contained IIFE (electron.vite.config.ts, `passwordsAgent`) and run with
 * `webFrame.executeJavaScriptInIsolatedWorld(4440, …)`. The bridge is the global the sentinel
 * exposed in this world; nothing here is visible to the page's own scripts.
 */
import type { PasswordsBridge } from './agent';
import { startAgents } from './frames';

declare const chordPasswords: PasswordsBridge | undefined;

// Once per document: the sentinel runs it once, and this guards against a second run in the same world.
const flag = '__chordPasswordsAgent';
const world = globalThis as unknown as Record<string, unknown>;
if (typeof chordPasswords !== 'undefined' && !world[flag]) {
  world[flag] = true;
  // The top document's agent, and one for each same-origin frame it may use (phase 3C).
  startAgents(chordPasswords);
}
