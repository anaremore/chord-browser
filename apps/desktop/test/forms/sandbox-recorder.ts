/**
 * A test copy of the sentinel's sandbox record (preload/passwords.ts, phase 3C): run at the document's start, as the
 * preload is, it marks every element whose `sandbox` attribute changes, keeps each frame's document as of its last `load` heard in the
 * document's own tree, and answers the agent's bridge `vouched(el)`.
 * Installed with `addInitScript` before the page loads (frames.spec.ts, ttw.spec.ts).
 */
const everSandboxed = new WeakSet<object>();
new MutationObserver((records) => {
  for (const r of records) everSandboxed.add(r.target);
}).observe(document, { attributes: true, attributeFilter: ['sandbox'], subtree: true });
// Each frame's document as of its last `load` heard in this document's own tree (a frame's `load` isn't composed).
const loaded = new WeakMap<object, Document | null>();
document.addEventListener(
  'load',
  (event) => {
    const t = event.target as HTMLIFrameElement | null;
    if (t?.tagName === 'IFRAME' || t?.tagName === 'FRAME') loaded.set(t, t.contentDocument);
  },
  { capture: true, passive: true },
);
(globalThis as unknown as { chordVouched: (el: Element) => boolean }).chordVouched = (el) =>
  !everSandboxed.has(el) && !el.hasAttribute('sandbox') && loaded.get(el) === (el as HTMLIFrameElement).contentDocument;
