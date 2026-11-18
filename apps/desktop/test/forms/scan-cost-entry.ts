/**
 * The scan's cost on a heavy page (scan-cost.spec.ts): the agent's own scan and classifier, and
 * the ways phase 3B and 3C could find what the main tree hides (open shadow roots, same-origin
 * frames), each timed in the page. Nothing here is the agent's code but `scanDocument`.
 */
import { classifyPasswordForm } from '@chord/core';
import { scanDocument } from '../../src/passwords/agent/scan';

export interface ScanCost {
  readonly elements: number;
  readonly roots: number;
  /** The agent's scan and classifier, as `rescan` runs them. */
  readonly scanMs: number;
  /** The sentinel's look today: one `querySelector` for a password field in the main tree. */
  readonly lookMs: number;
  /** Every element visited, its `shadowRoot` read, roots inside roots too: what a deep scan pays before reading a field. */
  readonly walkAllMs: number;
  /** The same with a TreeWalker. */
  readonly walkTreeMs: number;
  /** A deep look for a password field: the main tree's `querySelector` first, then each open root's. */
  readonly deepLookMs: number;
}

/** Every open shadow root under `root`, roots inside roots too, by visiting every element. */
function rootsByAll(root: Document | ShadowRoot, out: ShadowRoot[] = []): ShadowRoot[] {
  for (const el of root.querySelectorAll('*')) {
    const inner = el.shadowRoot;
    if (inner) {
      out.push(inner);
      rootsByAll(inner, out);
    }
  }
  return out;
}

function rootsByWalker(root: Document | ShadowRoot, out: ShadowRoot[] = []): ShadowRoot[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const inner = (n as Element).shadowRoot;
    if (inner) {
      out.push(inner);
      rootsByWalker(inner, out);
    }
  }
  return out;
}

function time(run: () => unknown, times = 5): number {
  const t = performance.now();
  for (let i = 0; i < times; i++) run();
  return (performance.now() - t) / times;
}

function measure(): ScanCost {
  const roots = rootsByAll(document);
  return {
    elements: document.querySelectorAll('*').length + roots.reduce((n, r) => n + r.querySelectorAll('*').length, 0),
    roots: roots.length,
    scanMs: time(() => {
      for (const f of scanDocument(document)) classifyPasswordForm(f.record, 'filling');
    }),
    lookMs: time(() => document.querySelector('input[type=password]')),
    walkAllMs: time(() => rootsByAll(document)),
    walkTreeMs: time(() => rootsByWalker(document)),
    deepLookMs: time(() => document.querySelector('input[type=password]') ?? rootsByWalker(document).find((r) => r.querySelector('input[type=password]'))),
  };
}

(globalThis as unknown as { chordScanCost: typeof measure }).chordScanCost = measure;
