/**
 * Whether a click on a button submits a page's formless password field, by `submitButtonFor`, after a scan. Bundled by
 * scope-probe.spec.ts and run in the page.
 */
import { scanDocument, submitButtonFor } from '../../src/passwords/agent/scan';

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

function probe(button: string): boolean | null {
  scanDocument(document);
  const field = deep(document, 'input[type=password]');
  const target = deep(document, button);
  return target && field ? submitButtonFor(target, field, null, 'sign-in') !== null : null;
}

(globalThis as unknown as { chordScopeProbe: typeof probe }).chordScopeProbe = probe;
