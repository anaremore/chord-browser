/**
 * A test copy of the sentinel's sandbox record (preload/passwords.ts, phase 3C): run at the document's start, as the
 * preload is, it marks every element whose `sandbox` attribute changes, and answers the agent's bridge `sandboxed(el)`.
 * Installed with `addInitScript` before the page loads (frames.spec.ts, ttw.spec.ts).
 */
const everSandboxed = new WeakSet<object>();
new MutationObserver((records) => {
  for (const r of records) everSandboxed.add(r.target);
}).observe(document, { attributes: true, attributeFilter: ['sandbox'], subtree: true });
(globalThis as unknown as { chordSandboxed: (el: Element) => boolean }).chordSandboxed = (el) => everSandboxed.has(el) || el.hasAttribute('sandbox');
