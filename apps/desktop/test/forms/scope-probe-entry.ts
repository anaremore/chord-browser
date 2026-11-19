/**
 * The formless scope of a page's password field, after a scan, with the roots' index counted on a clock the test
 * chooses: one that jumps past `ROOT_INDEX_MS` cuts the count short (review round 1 of #65). Bundled by
 * scope-probe.spec.ts and run in the page.
 */
import { formlessScope, scanDocument, setRootIndexClock } from '../../src/passwords/agent/scan';

function probe(truncate: boolean): string | null {
  let t = 0;
  setRootIndexClock(truncate ? () => (t += 10) : () => performance.now());
  scanDocument(document);
  const field = document.querySelector('input[type=password]');
  const scope = field ? formlessScope(field) : null;
  return scope ? scope.id || scope.tagName : null;
}

(globalThis as unknown as { chordScopeProbe: typeof probe }).chordScopeProbe = probe;
