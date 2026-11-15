// Spike S17 M0: the sentinel, as a session-registered, sandboxed frame preload (registered
// as preload/page.ts is, with session.registerPreloadScript). It runs in the preload's world
// (999) and does nothing until a page shows a sign-in field; then it asks main for the
// agent's source once, exposes a bridge in world 4440 and runs the agent there.
// Nothing is added to the page's DOM or its main world.
//
// The fallback, preload-fat.cjs (written by run.mjs): this file with the agent's source compiled
// in ahead of it as __chordAgentMain, run in the preload's own world (999) when woken.
/* eslint-disable @typescript-eslint/no-require-imports -- a sandboxed preload has require only */
/* global require, location, window, document, performance, process, __chordAgentMain */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const started = performance.now();
const WORLD = 4440;
const { protocol } = location;
const web = protocol === 'https:' || protocol === 'http:';
const USERNAMEISH = /user|login|email|e-mail|account|ident/i;
let woken = false;

async function wake(why) {
  if (woken) return;
  woken = true;
  const t0 = performance.now();
  if (typeof __chordAgentMain === 'function') {
    let listener = null;
    ipcRenderer.on('passwords:to-agent', (_event, message) => listener && listener(message));
    __chordAgentMain({ send: (type, payload) => ipcRenderer.send('passwords:from-agent', String(type), payload), onMessage: (cb) => (listener = cb), world: () => 999, since: () => performance.now() - started });
    ipcRenderer.send('passwords:woke', { why, invokeMs: 0, runMs: performance.now() - t0, top: window === window.top, fat: true });
    return;
  }
  const source = await ipcRenderer.invoke('passwords:agent');
  const t1 = performance.now();
  let listener = null;
  ipcRenderer.on('passwords:to-agent', (_event, message) => listener && listener(message));
  // The bridge: four functions, as S17 §8 plans.
  contextBridge.exposeInIsolatedWorld(WORLD, 'chordPasswords', {
    send: (type, payload) => ipcRenderer.send('passwords:from-agent', String(type), payload),
    onMessage: (callback) => {
      listener = callback;
    },
    world: () => WORLD,
    since: () => performance.now() - started,
  });
  webFrame.setIsolatedWorldInfo(WORLD, { name: 'Chord passwords (spike)' });
  await webFrame.executeJavaScriptInIsolatedWorld(WORLD, [{ code: source, url: 'chord://passwords/agent.js' }]);
  const t2 = performance.now();
  ipcRenderer.send('passwords:woke', { why, invokeMs: t1 - t0, runMs: t2 - t1, top: window === window.top });
}

if (web) {
  // Woken when the document has a password field once it's parsed, or when focus or typing
  // lands on one, or on a field that reads as a username or email.
  const looksLikeSignIn = (el) => el && el.tagName === 'INPUT' && (el.type === 'password' || el.type === 'email' || USERNAMEISH.test(`${el.autocomplete} ${el.name} ${el.id}`));
  const onField = (event) => {
    if (looksLikeSignIn(event.target)) {
      window.removeEventListener('focusin', onField, true);
      window.removeEventListener('input', onField, true);
      void wake(event.type);
    }
  };
  window.addEventListener('focusin', onField, { capture: true, passive: true });
  window.addEventListener('input', onField, { capture: true, passive: true });
  // Once parsed, and again once loaded (a framework may render the form in between), here and in
  // every same-origin frame, which this preload can reach and a frame's own preload doesn't run in.
  const look = (when) => {
    if (document.querySelector('input[type=password]')) return void wake(`password-at-${when}`);
    for (const frame of document.querySelectorAll('iframe')) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch {
        // Another site's frame.
      }
      if (!doc) continue;
      if (when === 'load') {
        frame.contentWindow.addEventListener('focusin', onField, { capture: true, passive: true });
        frame.contentWindow.addEventListener('input', onField, { capture: true, passive: true });
      }
      if (doc.querySelector('input[type=password]')) return void wake(`password-in-frame-at-${when}`);
    }
  };
  document.addEventListener('DOMContentLoaded', () => look('parse'), { once: true });
  window.addEventListener('load', () => look('load'), { once: true });
  // Measurement only: how long this preload took to run, sent once per document when asked.
  if (process.argv.includes('--chord-s17-report')) ipcRenderer.send('passwords:preload-ran', { ms: performance.now() - started, top: window === window.top });
}
