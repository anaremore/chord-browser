/**
 * The formless scope of a page's password field after a scan, and whether a click on a button would submit, with the
 * roots' index counted on a clock the test chooses: one that jumps past `ROOT_INDEX_MS` cuts the count short (review
 * rounds 1 and 2 of #65). Bundled by scope-probe.spec.ts and run in the page.
 */
import { formlessScope, scanDocument, setRootIndexClock, submitButtonFor } from '../../src/passwords/agent/scan';

/** The first element matching `selector` in the document or any open root in it. */
function deep(root: Document | ShadowRoot, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) return found;
  for (const el of root.querySelectorAll('*')) {
    const inner = el.shadowRoot && deep(el.shadowRoot, selector);
    if (inner) return inner;
  }
  return null;
}

function probe(truncate: boolean, button: string | null): { scope: string | null; submits: boolean | null } {
  let t = 0;
  setRootIndexClock(truncate ? () => (t += 10) : () => performance.now());
  scanDocument(document);
  const field = deep(document, 'input[type=password]');
  const scope = field ? formlessScope(field) : null;
  const target = button ? deep(document, button) : null;
  return { scope: scope ? scope.id || scope.tagName : null, submits: target && field ? submitButtonFor(target, field, null, 'sign-in') !== null : null };
}

(globalThis as unknown as { chordScopeProbe: typeof probe }).chordScopeProbe = probe;
